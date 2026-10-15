"""Pipecat LLMService backed by the native Workers AI binding."""

import asyncio
import json
import time
import uuid
from datetime import datetime, timedelta, timezone

from pipecat.adapters.base_llm_adapter import BaseLLMAdapter
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    FunctionCallFromLLM,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings
from pipecat.utils.errors import ErrorCategory
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

from agent.speech_history import SpeechHistory
from server.observability import exception_fields, log
from services.inference import InferenceError, run_inference
from services.models import TextReply, ToolReply, WorkersAIModel


class WorkersAIAdapter(BaseLLMAdapter):
    @property
    def id_for_llm_specific_messages(self):
        return "workers-ai"

    def to_provider_tools_format(self, tools_schema):
        return [
            {"type": "function", "function": tool.to_default_dict()}
            for tool in tools_schema.standard_tools
        ]

    def get_messages_for_logging(self, context):
        # Framework debug logging must not retain callers' conversation text.
        return [
            {"role": message.get("role")}
            for message in context.get_messages()
            if isinstance(message, dict)
        ]

    def get_llm_invocation_params(self, context, **kwargs):
        messages = context.get_messages()
        if not messages:
            raise ValueError("A conversation requires at least one message.")
        # Preserve tool_calls and tool_call_id: the assistant aggregator owns
        # these messages and needs them for the next inference after a tool.
        for message in messages:
            if not isinstance(message, dict) or message.get("role") not in {
                "system",
                "developer",
                "user",
                "assistant",
                "tool",
            }:
                raise ValueError("This service accepts text and tool messages.")
            if message.get("content") is not None and not isinstance(message["content"], str):
                raise ValueError("Multimodal messages require another LLM service.")
        serialized = json.loads(json.dumps(messages))
        instructions = [
            message.get("content") or "" for message in serialized if message["role"] == "system"
        ]
        # Normalize the request without modifying Pipecat's shared history.
        serialized = [message for message in serialized if message["role"] != "system"]
        if instructions:
            serialized.insert(0, {"role": "system", "content": "\n\n".join(instructions)})
        for message in serialized:
            if message.get("role") == "assistant" and message.get("tool_calls"):
                # Pipecat omits content on tool-only assistant messages. Keep
                # the native binding's text field explicit on the wire.
                message.setdefault("content", "")
        result = {"messages": serialized}
        if isinstance(context.tools, ToolsSchema) and context.tools.standard_tools:
            result["tools"] = self.to_provider_tools_format(context.tools)
        return result


class WorkersAILLM(LLMService):
    """Full replies keep tokenizer dependencies out of the audio pipeline.

    Inference runs in a managed task so incoming speech can interrupt it.
    Function calls use LLMService's normal runner and the shared context pair.
    """

    adapter_class = WorkersAIAdapter

    def __init__(
        self,
        env,
        summary,
        control,
        *,
        model: WorkersAIModel,
        speech_history: SpeechHistory,
        call_id=None,
        utc_offset_minutes=0,
    ):
        super().__init__(
            name="WorkersAILLM",
            settings=LLMSettings(model=model.model_id),
            function_call_timeout_secs=10,
            group_parallel_tools=True,
        )
        self.env = env
        self.model = model
        self.summary = summary
        self.control = control
        self.speech_history = speech_history
        self.log = log.bind(call_id=call_id, provider="llm", model=model.model_id)
        self._request_options = {
            "extraHeaders": {"x-session-affinity": call_id or uuid.uuid4().hex}
        }
        self._request_task = None
        self._closing = False
        self._tool_calls = {}
        self._timezone = timezone(timedelta(minutes=utc_offset_minutes))
        self._last_date = None
        self._text_filter = MarkdownTextFilter(
            MarkdownTextFilter.InputParams(filter_repeated_sequences=False)
        )
        self._register_event_handler("on_response_text", sync=True)

    async def _cancel_request(self):
        task, self._request_task = self._request_task, None
        if task and not task.done() and task is not asyncio.current_task():
            await self.cancel_task(task, timeout=2)

    async def process_frame(self, frame, direction):
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            self.speech_history.interrupt(self.control.generation)
            self.control.generation += 1
            self.summary["interruptions"] += 1
            await self._cancel_request()
        elif isinstance(frame, (CancelFrame, EndFrame)):
            self._closing = True
            await self._cancel_request()
        # The base service registers schema handlers and cancels tools on a
        # user interruption. Do this even for upstream tool-result context.
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            if not self._closing:
                await self._cancel_request()
                self.speech_history.start(frame.context, self.control.generation)
                self._request_task = self.create_task(
                    self._complete(frame.context, self.control.generation), "workers-ai-reply"
                )
            return
        await self.push_frame(frame, direction)

    async def _complete(self, context, generation):
        started = time.monotonic()
        record = {"generation": generation, "outcome": "pending"}
        try:
            local_date = datetime.now(self._timezone).date()
            if local_date != self._last_date:
                context.add_message(
                    {
                        "role": "user",
                        "content": "<runtime_context>\n"
                        f"Current local date: {local_date.isoformat()}.\n"
                        "</runtime_context>",
                    }
                )
                self._last_date = local_date
            used = self._tool_calls.get(generation, 0)
            remaining = self.model.max_tool_calls - used
            parameters = self.get_llm_adapter().get_llm_invocation_params(context)
            if remaining <= 0:
                # This instruction belongs to this request, not future user turns.
                parameters["messages"].append(
                    {
                        "role": "user",
                        "content": "<runtime_context>\n"
                        "The tool-call limit for this turn has been reached. "
                        "Answer from the available evidence and explain anything you could not verify.\n"
                        "</runtime_context>",
                    }
                )
            params = self.model.build_request(
                parameters,
                allow_tools=remaining > 0,
            )
            self.summary["requests"].append(record)
            start = LLMFullResponseStartFrame()
            start.workers_generation = generation
            await self.push_frame(start)
            self.control.llm_pending = True
            try:
                result = await run_inference(
                    self.env.AI,
                    self.model.model_id,
                    params,
                    self._request_options,
                    log=self.log.bind(generation=generation),
                    is_current=lambda: not self._closing and generation == self.control.generation,
                )
                usage = self.model.get_usage(result)
                if usage:
                    self.log.info(
                        "llm_usage",
                        generation=generation,
                        elapsed_ms=round((time.monotonic() - started) * 1000, 1),
                        **usage,
                    )
                reply = self.model.parse_response(result)
                if isinstance(reply, TextReply):
                    # Preview, speech, and spoken context share the same plain text.
                    text = (await self._text_filter.filter(reply.text)).strip()
                    if not text:
                        raise ValueError("Model returned an empty plain-text reply")
                    reply = TextReply(text)
                if isinstance(reply, ToolReply) and remaining <= 0:
                    raise ValueError("Tool call limit reached")
            except Exception as exc:
                record["outcome"] = "fallback"
                self.summary["errors"].append({"type": type(exc).__name__})
                fields = exception_fields(exc.__cause__ or exc)
                if isinstance(exc, InferenceError):
                    fields.update(
                        status=exc.status,
                        error_code=exc.category.value,
                        provider_error_code=exc.code,
                    )
                self.log.error("provider_failed", generation=generation, **fields)
                if (
                    isinstance(exc, InferenceError)
                    and (exc.category.is_permanent or exc.category == ErrorCategory.QUOTA)
                    and fields["error_category"] != "context_limit"
                ):
                    record["outcome"] = "error"
                    await self.push_error(
                        "The language model is unavailable.",
                        exception=exc,
                        category=exc.category,
                        force_treat_as_permanent=True,
                    )
                    return
                fallbacks = {
                    "context_limit": "This conversation is too long for the model. Please start a new call.",
                    "reply_limit": "That answer got too long. Could you ask me to focus on one part?",
                }
                reply = TextReply(
                    fallbacks.get(
                        fields["error_category"],
                        "I couldn't finish that response. Please try again.",
                    )
                )
            self.control.llm_pending = False
            if self._closing or generation != self.control.generation:
                self.summary["stale_dropped"] += 1
                return
            if isinstance(reply, ToolReply):
                # Parallel lookups consume the same per-turn budget. Only
                # dispatched calls enter Pipecat's tool-call/result history.
                calls = reply.calls[:remaining]
                self._tool_calls[generation] = used + len(calls)
                functions = [
                    FunctionCallFromLLM(
                        function_name=call.name,
                        tool_call_id=call.id,
                        arguments=call.arguments,
                        context=context,
                    )
                    for call in calls
                ]
                for function in functions:
                    # Pipecat runs on_function_calls_started handlers as tasks,
                    # which can start after the user begins another turn.
                    function.workers_generation = generation
                await self._end_response(generation)
                await self.run_function_calls(functions)
                record["outcome"] = "tools"
                record["tool_count"] = len(functions)
                return
            text = reply.text
            self.speech_history.set_text(generation, text)
            await self._call_event_handler("on_response_text", text, generation)
            speech = TTSSpeakFrame(text=text, append_to_context=True)
            speech.workers_generation = generation
            await self.push_frame(speech)
            await self._end_response(generation)
            if record["outcome"] == "pending":
                record["outcome"] = "emitted"
            self.summary["responses"].append({"generation": generation, "characters": len(text)})
        except asyncio.CancelledError:
            record["outcome"] = "cancelled"
            self.summary["cancelled"] += 1
            raise
        except Exception as exc:
            record["outcome"] = "error"
            self.summary["errors"].append({"type": type(exc).__name__})
            self.log.error("provider_failed", generation=generation, **exception_fields(exc))
            await self.push_error(
                "The language model could not finish this response.",
                exception=exc,
                force_treat_as_permanent=True,
            )
        finally:
            record["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
            self.control.llm_pending = False

    async def _end_response(self, generation):
        frame = LLMFullResponseEndFrame()
        frame.workers_generation = generation
        await self.push_frame(frame)

    async def cleanup(self):
        self._closing = True
        await self._cancel_request()
        await super().cleanup()

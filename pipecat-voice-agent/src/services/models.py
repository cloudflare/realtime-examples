"""Workers AI model adapters: wire formats stop at this boundary."""

import json
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from agent.config import MAX_REPLY_TOKENS, MAX_TOOL_CALLS


@dataclass(frozen=True)
class TextReply:
    text: str


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolReply:
    calls: list[ToolCall]


type ModelReply = TextReply | ToolReply


class WorkersAIModel(ABC):
    model_id: str
    max_tool_calls: int

    @abstractmethod
    def build_request(self, parameters: dict, *, allow_tools: bool) -> dict:
        """Adapt the Pipecat messages/tools and request a bounded completion."""

    @abstractmethod
    def parse_response(self, response: Any) -> ModelReply:
        """Return speech or complete tool calls; never return reasoning as speech."""

    def get_usage(self, response: Any) -> dict[str, int]:
        """Return available token counters without making metadata mandatory."""
        return {}


def _reply(text, calls) -> ModelReply:
    if calls:
        if not isinstance(calls, list) or len(calls) > MAX_TOOL_CALLS:
            raise ValueError("Tool call limit reached")
        normalized = []
        for call in calls:
            function = call.get("function", call)
            arguments = function.get("arguments", {})
            if isinstance(arguments, str):
                if len(arguments) > 4096:
                    raise ValueError("Invalid tool arguments")
                arguments = json.loads(arguments)
            if not isinstance(arguments, dict) or len(json.dumps(arguments)) > 4096:
                raise ValueError("Invalid tool arguments")
            name = function.get("name")
            if not isinstance(name, str) or not name:
                raise ValueError("Invalid tool name")
            call_id = call.get("id") or uuid.uuid4().hex
            if not isinstance(call_id, str):
                raise ValueError("Invalid tool call ID")
            normalized.append(ToolCall(id=call_id, name=name, arguments=arguments))
        return ToolReply(normalized)
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Model returned an empty reply")
    return TextReply(text.strip())


class _ChatMessage(BaseModel):
    role: Literal["assistant"]
    content: str | None = None
    tool_calls: list[dict] | None = None


class _Choice(BaseModel):
    finish_reason: Literal["stop", "tool_calls", "length", "content_filter", "function_call"]
    message: _ChatMessage


class _Completion(BaseModel):
    choices: list[_Choice] = Field(min_length=1, max_length=1)


@dataclass(frozen=True)
class ChatCompletionsModel(WorkersAIModel):
    model_id: str
    request_options: dict = field(default_factory=dict)
    max_tool_calls: int = MAX_TOOL_CALLS

    def build_request(self, parameters, *, allow_tools):
        request = {
            **parameters,
            "stream": False,
            "max_completion_tokens": MAX_REPLY_TOKENS,
            "temperature": 0.3,
            **self.request_options,
        }
        if request.get("tools") and not allow_tools:
            # Keep declarations for the preceding tool history, but finish
            # this turn with a spoken answer after the lookup/refinement budget.
            request["tool_choice"] = "none"
        return request

    def parse_response(self, response):
        choice = _Completion.model_validate(response).choices[0]
        if choice.finish_reason not in {"stop", "tool_calls"}:
            raise ValueError(f"Incomplete model reply: {choice.finish_reason}")
        # The response can contain separate reasoning fields. Only the final
        # message content and structured function calls cross into the pipeline.
        return _reply(choice.message.content, choice.message.tool_calls)

    def get_usage(self, response):
        usage = response.get("usage") if isinstance(response, dict) else None
        if not isinstance(usage, dict):
            return {}
        details = usage.get("prompt_tokens_details")
        counters = {
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "cached_prompt_tokens": details.get("cached_tokens")
            if isinstance(details, dict)
            else None,
        }
        return {key: value for key, value in counters.items() if type(value) is int and value >= 0}


_MODELS: dict[str, WorkersAIModel] = {
    model.model_id: model
    for model in (
        ChatCompletionsModel(
            "@cf/google/gemma-4-26b-a4b-it",
            request_options={"chat_template_kwargs": {"enable_thinking": False}},
        ),
        ChatCompletionsModel(
            "@cf/deepseek-ai/deepseek-v4-flash-0731",
            request_options={"reasoning_effort": "none"},
        ),
    )
}


def get_model(model_id: str) -> WorkersAIModel:
    try:
        return _MODELS[model_id]
    except KeyError:
        raise ValueError("Add a model adapter before selecting this Workers AI model") from None

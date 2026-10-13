import asyncio
import copy
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import InterruptionFrame, LLMContextFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from agent.config import LLM_MODEL
from agent.fillers import PHRASES, speak_fillers
from agent.speech_history import SpeechHistory
from agent.tools import build_tools
from services.llm import WorkersAIAdapter, WorkersAILLM
from services.models import get_model
from services.web_search import WEB_SEARCH_TOOL

logger.disable("pipecat")


class Model:
    def __init__(
        self,
        *,
        tool_name="get_current_time",
        arguments=None,
        rounds=1,
        text="Here is the current time.",
    ):
        self.requests = []
        self.options = []
        self.tool_name = tool_name
        self.arguments = arguments if arguments is not None else {"utc_offset_minutes": 0}
        self.rounds = rounds
        self.text = text

    async def run(self, model, parameters, options):
        self.requests.append(copy.deepcopy(parameters))
        self.options.append(copy.deepcopy(options))
        if len(self.requests) <= self.rounds:
            arguments = (
                self.arguments[len(self.requests) - 1]
                if isinstance(self.arguments, list)
                else self.arguments
            )
            tool_name = (
                self.tool_name[len(self.requests) - 1]
                if isinstance(self.tool_name, list)
                else self.tool_name
            )
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": f"lookup-{len(self.requests)}",
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(arguments),
                        },
                    }
                ],
            }
            finish_reason = "tool_calls"
        else:
            message = {"role": "assistant", "content": self.text}
            finish_reason = "stop"
        return {"choices": [{"index": 0, "finish_reason": finish_reason, "message": message}]}


class Speech(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.replies = []
        self.frames = []
        self.received = asyncio.Event()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSSpeakFrame):
            self.replies.append(frame.text)
            self.frames.append(frame)
            self.received.set()
        await self.push_frame(frame, direction)


async def pipeline(
    tools, *, model=None, messages=None, adapter=None, utc_offset_minutes=0, fillers=False
):
    model = model or Model()
    summary = {
        "requests": [],
        "responses": [],
        "errors": [],
        "cancelled": 0,
        "stale_dropped": 0,
        "interruptions": 0,
    }
    control = SimpleNamespace(
        generation=0,
        llm_pending=False,
        tts_pending=False,
    )
    llm = WorkersAILLM(
        SimpleNamespace(AI=model),
        summary,
        control,
        model=adapter or get_model(LLM_MODEL),
        speech_history=SpeechHistory(),
        utc_offset_minutes=utc_offset_minutes,
    )
    messages = messages or [{"role": "user", "content": "What time is it in UTC?"}]
    if not any(message["role"] == "system" for message in messages):
        messages = [{"role": "system", "content": "You are a voice assistant."}, *messages]
    context = LLMContext(messages=messages, tools=tools)
    pair = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(),
            vad_analyzer=None,
            empty_user_turn=None,
        ),
    )
    speech = Speech()
    previews = []
    if fillers:
        speak_fillers(llm, speech, control)

    @llm.event_handler("on_response_text")
    async def on_response_text(_service, text, generation):
        previews.append(
            {"text": text, "generation": generation, "speech_received": bool(speech.replies)}
        )

    worker = PipelineWorker(
        Pipeline([pair.user(), llm, speech, pair.assistant()]),
        params=PipelineParams(),
        app_resources=SimpleNamespace(owner_id="test-owner"),
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False, force_gc=False)
    started = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def on_started(*_):
        started.set()

    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    await asyncio.wait_for(started.wait(), 5)
    await worker.queue_frame(LLMContextFrame(context))
    return SimpleNamespace(
        model=model,
        context=context,
        speech=speech,
        previews=previews,
        worker=worker,
        runner=runner,
        task=task,
        control=control,
        summary=summary,
    )


async def close(run):
    await run.runner.cancel(reason="test_finished")
    await asyncio.wait_for(run.task, 5)


async def test_reply_preview_and_tts_share_plain_text_before_context_is_updated():
    run = await pipeline(
        [],
        model=Model(
            rounds=0,
            text="**Muse** has 100000 users. See [the docs](https://example.com/).",
        ),
    )
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        expected = "Muse has 100000 users. See the docs."
        assert run.previews == [{"text": expected, "generation": 0, "speech_received": False}]
        assert run.speech.replies == [expected]
        assert not any(message.get("role") == "assistant" for message in run.context.get_messages())
    finally:
        await close(run)


@pytest.mark.parametrize(
    "model_id",
    [
        "@cf/google/gemma-4-26b-a4b-it",
        "@cf/deepseek-ai/deepseek-v4-flash-0731",
    ],
)
async def test_native_service_uses_pipecat_tool_results_to_resume_inference(model_id):
    class BlipModel(Model):
        failed = False

        async def run(self, model, parameters, options):
            if len(self.requests) == 1 and not self.failed:
                self.failed = True
                raise ConnectionError("Temporary model connection failure")
            return await super().run(model, parameters, options)

    events = []
    adapter = get_model(model_id)
    run = await pipeline(build_tools(events.append), model=BlipModel(), adapter=adapter)
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        assert len(run.model.requests) == 2
        assert run.model.failed
        affinity = run.model.options[0]["extraHeaders"]["x-session-affinity"]
        assert affinity
        assert run.model.options[1]["extraHeaders"]["x-session-affinity"] == affinity
        assert "tools" in run.model.requests[0]
        assert "tools" in run.model.requests[1]
        messages = run.model.requests[1]["messages"]
        call = next(message for message in messages if message.get("tool_calls"))
        assert call["content"] == ""
        result = next(message for message in messages if message.get("role") == "tool")
        assert call["tool_calls"][0]["id"] == result["tool_call_id"]
        assert "datetime" in result["content"]
        assert [event["type"] for event in events] == ["tool_started", "tool_finished"]
        assert run.speech.replies == ["Here is the current time."]
        assert not run.summary["errors"]
    finally:
        await close(run)


async def test_interruption_cancels_a_pending_tool_and_drops_its_reply():
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def long_tool(params):
        assert params.app_resources.owner_id == "test-owner"
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    run = await pipeline(
        [
            FunctionSchema(
                name="get_current_time",
                description="Read time",
                properties={},
                required=[],
                handler=long_tool,
            )
        ]
    )
    try:
        await asyncio.wait_for(started.wait(), 5)
        await run.worker.queue_frame(InterruptionFrame())
        await asyncio.wait_for(cancelled.wait(), 5)
        await asyncio.sleep(0.05)
        assert not run.speech.replies
        assert len(run.model.requests) == 1
        assert run.control.generation == 1
    finally:
        await close(run)


async def test_lookups_queue_one_filler_that_stays_out_of_the_conversation():
    async def search(params):
        await params.result_callback({"status": "found", "results": []})

    tool = FunctionSchema(
        name=WEB_SEARCH_TOOL, description="Search", properties={}, required=[], handler=search
    )
    model = Model(tool_name=WEB_SEARCH_TOOL, arguments={}, rounds=2)
    run = await pipeline([tool], model=model, fillers=True)
    try:
        async with asyncio.timeout(5):
            while len(run.speech.frames) < 2:
                await asyncio.sleep(0.01)
        filler, reply = run.speech.frames
        assert filler.text in PHRASES[WEB_SEARCH_TOOL]
        assert not filler.append_to_context
        assert filler.workers_generation == 0
        assert reply.text == "Here is the current time."
        assert reply.append_to_context
        # Two lookup rounds in one turn share a single filler.
        assert len(run.model.requests) == 3
    finally:
        await close(run)


async def test_search_retry_and_page_read_preserve_history_with_tool_headroom(monkeypatch):
    source = {
        "title": "WebSocket adapters",
        "url": "https://developers.cloudflare.com/realtime/sfu/features/media-transport-adapters/websocket-adapter/",
        "excerpt": "Audio is 48 kHz stereo PCM.",
    }
    empty = {"status": "empty", "query": "SFU audio format"}
    found = {"status": "found", "query": "SFU WebSocket PCM", "sources": [source]}
    lookup = AsyncMock(side_effect=[empty, found])
    monkeypatch.setattr("agent.tools.search_docs", lookup)
    page = {"status": "found", "section": "Audio", "sources": [source]}
    read_page = AsyncMock(return_value=page)
    monkeypatch.setattr("agent.tools.read_docs_page", read_page)
    events = []
    history = [
        {"role": "user", "content": "My favorite fruit is mango."},
        {"role": "assistant", "content": "I'll remember that."},
        {"role": "user", "content": "What audio format does the SFU WebSocket adapter use?"},
    ]
    run = await pipeline(
        build_tools(events.append),
        model=Model(
            tool_name=[
                "search_cloudflare_documentation",
                "search_cloudflare_documentation",
                "read_cloudflare_documentation",
            ],
            arguments=[
                {"query": empty["query"]},
                {"query": found["query"]},
                {"url": source["url"], "section": "Audio"},
            ],
            rounds=3,
        ),
        messages=copy.deepcopy(history),
    )
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        assert len(run.model.requests) == 4
        assert "tools" in run.model.requests[1]
        assert run.model.requests[3].get("tool_choice") != "none"
        messages = run.model.requests[3]["messages"]
        assert messages[1:4] == history
        calls = [call for message in messages for call in message.get("tool_calls", [])]
        results = [message for message in messages if message.get("role") == "tool"]
        assert [result["tool_call_id"] for result in results] == [call["id"] for call in calls]
        assert len(results) == 3
        assert [json.loads(result["content"]) for result in results] == [empty, found, page]
        assert [event["type"] for event in events] == [
            "tool_started",
            "tool_empty",
            "tool_started",
            "tool_finished",
            "tool_started",
            "tool_finished",
        ]
        assert events[-1]["sources"] == [{"title": source["title"], "url": source["url"]}]
        assert events[-1]["call_id"] == results[-1]["tool_call_id"]
        assert not run.summary["errors"]
        assert lookup.await_count == 2
        read_page.assert_awaited_once()
        assert [call.args[0].query for call in lookup.call_args_list] == [
            empty["query"],
            found["query"],
        ]
    finally:
        await close(run)


async def test_parallel_calls_share_the_budget_and_a_new_user_turn_resets_it():
    class ParallelModel(Model):
        async def run(self, model, parameters, options):
            self.requests.append(copy.deepcopy(parameters))
            # A model ignoring tool_choice must still obey the execution limit.
            message = {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": f"batch-{len(self.requests)}-{index}",
                        "type": "function",
                        "function": {
                            "name": "get_current_time",
                            "arguments": '{"utc_offset_minutes":0}',
                        },
                    }
                    for index in range(4)
                ],
            }
            return {"choices": [{"finish_reason": "tool_calls", "message": message}]}

    events = []
    run = await pipeline(build_tools(events.append), model=ParallelModel())
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        assert len([event for event in events if event["type"] == "tool_started"]) == 5
        assert run.model.requests[-1]["tool_choice"] == "none"
        last_messages = run.model.requests[-1]["messages"]
        assert [m["role"] for m in last_messages].count("system") == 1
        assert last_messages[0] == run.model.requests[0]["messages"][0]
        assert "tool-call limit" in last_messages[-1]["content"]
        run.speech.received.clear()
        run.context.add_message({"role": "user", "content": "Check again."})
        await run.worker.queue_frame(InterruptionFrame())
        await run.worker.queue_frame(LLMContextFrame(run.context))
        await asyncio.wait_for(run.speech.received.wait(), 5)
        assert len([event for event in events if event["type"] == "tool_started"]) == 10
        assert len(run.model.requests) == 6
        assert run.model.requests[3].get("tool_choice") != "none"
        assert all(
            "tool-call limit" not in (message.get("content") or "")
            for message in run.model.requests[3]["messages"]
        )
        assert run.speech.replies == ["I couldn't finish that response. Please try again."] * 2
        messages = run.model.requests[-1]["messages"]
        calls = [call["id"] for message in messages for call in message.get("tool_calls", [])]
        results = [message["tool_call_id"] for message in messages if message.get("role") == "tool"]
        assert sorted(calls) == sorted(results)
    finally:
        await close(run)


async def test_local_date_uses_one_initial_system_message_without_rewriting_history(monkeypatch):
    clock = SimpleNamespace(now=datetime(2026, 10, 7, 21, 59, tzinfo=UTC))
    monkeypatch.setattr(
        "services.llm.datetime", SimpleNamespace(now=lambda tz: clock.now.astimezone(tz))
    )
    history = [
        {"role": "system", "content": "Stable instructions."},
        {"role": "system", "content": "More instructions."},
        {"role": "user", "content": "Check the time."},
    ]
    run = await pipeline(
        build_tools(lambda event: None), messages=copy.deepcopy(history), utc_offset_minutes=120
    )
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        for request in run.model.requests:
            assert request["messages"][0]["role"] == "system"
            assert [m["content"] for m in request["messages"] if m["role"] == "system"] == [
                "Stable instructions.\n\nMore instructions."
            ]
            assert [
                m["content"]
                for m in request["messages"]
                if (m.get("content") or "").startswith("<runtime_context>")
            ] == ["<runtime_context>\nCurrent local date: 2026-10-07.\n</runtime_context>"]
        assert run.context.get_messages()[: len(history)] == history
        prefix = copy.deepcopy(run.context.get_messages())
        clock.now = datetime(2026, 10, 7, 22, 1, tzinfo=UTC)
        run.speech.received.clear()
        run.context.add_message({"role": "user", "content": "Check again."})
        await run.worker.queue_frame(InterruptionFrame())
        await run.worker.queue_frame(LLMContextFrame(run.context))
        await asyncio.wait_for(run.speech.received.wait(), 5)
        messages = run.context.get_messages()
        assert messages[: len(prefix)] == prefix
        assert run.model.requests[-1]["messages"][0] == run.model.requests[0]["messages"][0]
        assert messages[-1] == {
            "role": "user",
            "content": "<runtime_context>\nCurrent local date: 2026-10-08.\n</runtime_context>",
        }
    finally:
        await close(run)


@pytest.mark.parametrize("failure", ["api", "incomplete", "context_limit"])
async def test_model_failure_speaks_a_fallback_and_accepts_the_next_turn(failure):
    class FailOnceModel(Model):
        async def run(self, model, parameters, options):
            if not self.requests:
                self.requests.append(copy.deepcopy(parameters))
                if failure == "api":
                    raise RuntimeError("Private upstream error details")
                if failure == "context_limit":
                    raise RuntimeError("400: This model's maximum context length was exceeded")
                return {
                    "choices": [
                        {
                            "finish_reason": "length",
                            "message": {"role": "assistant", "content": "Unfinished answer"},
                        }
                    ]
                }
            return await super().run(model, parameters, options)

    run = await pipeline([], model=FailOnceModel(rounds=0))
    try:
        await asyncio.wait_for(run.speech.received.wait(), 5)
        expected = {
            "api": "I couldn't finish that response. Please try again.",
            "incomplete": "That answer got too long. Could you ask me to focus on one part?",
            "context_limit": "This conversation is too long for the model. Please start a new call.",
        }[failure]
        assert run.speech.replies == [expected]
        assert run.previews[0]["text"] == run.speech.replies[0]
        assert run.summary["requests"][0]["outcome"] == "fallback"
        assert not run.task.done()
        run.speech.received.clear()
        run.context.add_message({"role": "user", "content": "Try again."})
        await run.worker.queue_frame(InterruptionFrame())
        await run.worker.queue_frame(LLMContextFrame(run.context))
        await asyncio.wait_for(run.speech.received.wait(), 5)
        assert run.speech.replies[-1] == "Here is the current time."
        assert len(run.model.requests) == 2
    finally:
        await close(run)


def test_adapter_keeps_tool_messages_and_rejects_multimodal_content():
    adapter = WorkersAIAdapter()
    context = LLMContext(messages=[{"role": "user", "content": [{"type": "image"}]}])
    with pytest.raises(ValueError, match="Multimodal"):
        adapter.get_llm_invocation_params(context)


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("get_current_time", {"utc_offset_minutes": 0}),
        ("get_current_weather", {"location": "London"}),
        ("get_weather_forecast", {"location": "London", "start_day": 1}),
        ("search_cloudflare_documentation", {"query": "Workers limits"}),
        ("read_cloudflare_documentation", {"url": "https://developers.cloudflare.com/workers/"}),
        ("get_cloudflare_status", {"product": "Workers"}),
    ],
)
async def test_each_tool_reports_interruption_during_result_delivery(monkeypatch, name, arguments):
    monkeypatch.setattr("agent.tools.current_weather", AsyncMock(return_value={"temperature": 15}))
    monkeypatch.setattr("agent.tools.search_docs", AsyncMock(return_value={"sources": []}))
    monkeypatch.setattr("agent.tools.read_docs_page", AsyncMock(return_value={"sources": []}))
    monkeypatch.setattr("agent.tools.weather_forecast", AsyncMock(return_value={"days": []}))
    monkeypatch.setattr("agent.tools.cloudflare_status", AsyncMock(return_value={"sources": []}))
    delivering = asyncio.Event()

    async def callback(_result):
        delivering.set()
        await asyncio.Event().wait()

    events = []
    tool = next(tool for tool in build_tools(events.append) if tool.name == name)
    task = asyncio.create_task(
        tool.handler(
            SimpleNamespace(arguments=arguments, tool_call_id="lookup", result_callback=callback)
        )
    )
    await asyncio.wait_for(delivering.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert [event["type"] for event in events] == ["tool_started", "tool_cancelled"]
    assert all(event["call_id"] == "lookup" and event["name"] == name for event in events)

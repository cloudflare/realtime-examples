import asyncio
import copy
import time
from collections import deque
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
from pipecat.utils.errors import ErrorCategory
from pipecat.workers.runner import WorkerRunner

import services.inference as inference_module
import services.tts as tts_module
from agent.config import LLM_MODEL, AgentConfig
from agent.pipeline import handle_pipeline_error
from agent.speech_history import SpeechHistory
from server.observability import log
from services.llm import WorkersAILLM
from services.models import get_model
from services.tts import WorkersAura
from transport.output import NativeVoiceOutput
from transport.playback import FRAME_BYTES, FRAME_MS, MAX_AUDIO_AHEAD_MS, SAMPLE_RATE


class AudioReader:
    def __init__(self, pcm, *, status=200, error=None):
        self.pcm = pcm
        self.status = status
        self.error = error
        self.cancelled = False
        self.released = False

    async def read(self):
        if self.pcm is None:
            if self.error:
                raise self.error
            return SimpleNamespace(done=True)
        pcm, self.pcm = self.pcm, None
        return SimpleNamespace(done=False, value=SimpleNamespace(to_bytes=lambda: pcm))

    async def cancel(self):
        self.cancelled = True

    def releaseLock(self):
        self.released = True


class StalledReader(AudioReader):
    async def read(self):
        await asyncio.Event().wait()


class Sink(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.text = []
        self.completed = asyncio.Event()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TTSTextFrame):
            self.text.append(frame.text)
        if isinstance(frame, TTSStoppedFrame):
            self.completed.set()
        await self.push_frame(frame, direction)


@pytest.fixture
async def output_pipeline(monkeypatch):
    responses = deque()
    run = SimpleNamespace(
        responses=responses,
        sent=[],
        ahead=[],
        can_play=asyncio.Event(),
        blocked=asyncio.Event(),
        pause_next=False,
        pause_after=None,
        notifications=[],
        pipeline_errors=[],
        terminal_errors=[],
        replies=deque(),
        model_requests=[],
        tts_texts=[],
    )

    async def synthesize(model, parameters, _options):
        if model == LLM_MODEL:
            run.model_requests.append(copy.deepcopy(parameters))
            return {
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": run.replies.popleft()},
                    }
                ]
            }
        run.tts_texts.append(parameters["text"])
        reader = responses.popleft()
        return SimpleNamespace(
            status=reader.status,
            headers={"Content-Type": "audio/pcm"},
            body=SimpleNamespace(getReader=lambda: reader, cancel=reader.cancel),
        )

    summary = dict(requests=[], errors=[], completed=0, cancelled=0, stale_dropped=0)
    control = SimpleNamespace(
        generation=0, context_generations={}, tts_pending=False, llm_pending=False
    )
    env = SimpleNamespace(AI=SimpleNamespace(run=synthesize))
    history = SpeechHistory()
    llm = WorkersAILLM(
        env,
        dict(requests=[], responses=[], errors=[], cancelled=0, stale_dropped=0, interruptions=0),
        control,
        model=get_model(LLM_MODEL),
        speech_history=history,
    )
    tts = WorkersAura(env, summary, control, time.monotonic())

    @tts.event_handler("on_speech_failed")
    async def on_speech_failed(_service, generation):
        history.failed(generation)
        run.notifications.append(
            ({"type": "speech_failed", "generation": generation}, len(run.sent))
        )

    def publish(pcm, generation):
        if any(pcm):
            generated = sum(r["audio_frames"] for r in summary["requests"])
            run.ahead.append(generated - len(run.sent))
            run.sent.append((generation, pcm))
            if run.pause_next or len(run.sent) == run.pause_after:
                run.pause_next = False
                run.can_play.clear()
                run.blocked.set()
        return True

    owner = SimpleNamespace(
        publish_pcm=publish,
        notify=lambda event: run.notifications.append((event, len(run.sent))),
        stats={"pipeline": {"error_count": 0}},
        pipeline_ready=True,
        log=log,
        fail_call=lambda stage, exc, **fields: run.terminal_errors.append((stage, fields)),
    )
    output = NativeVoiceOutput(
        owner,
        {},
        control,
        playback_budget=tts.playback_budget,
        speech_history=history,
    )

    async def pace():
        await run.can_play.wait()
        # Keep a real timer boundary, but make long-audio tests finish quickly.
        await asyncio.sleep(0.001)

    monkeypatch.setattr(output, "_pace", pace)
    sink = Sink()
    context = LLMContext(messages=[{"role": "system", "content": AgentConfig().system_prompt()}])
    pair = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(),
            vad_analyzer=None,
            empty_user_turn=None,
        ),
        realtime_service_mode=False,
    )
    worker = PipelineWorker(
        Pipeline([pair.user(), llm, tts, output, sink, pair.assistant()]),
        params=PipelineParams(audio_out_sample_rate=SAMPLE_RATE),
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False, force_gc=False)
    started = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def on_started(*_):
        started.set()

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame):
        run.pipeline_errors.append(frame)
        handle_pipeline_error(owner, frame)

    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    await asyncio.wait_for(started.wait(), 5)
    run.tts, run.output, run.sink = tts, output, sink
    run.worker, run.control, run.summary = worker, control, summary
    run.runner, run.task = runner, task
    run.context = context
    run.history = history
    run.owner = owner
    try:
        yield run
    finally:
        if not task.done():
            await runner.cancel(reason="test_complete")
        await asyncio.wait_for(task, 5)


async def speak(run, text):
    run.history.start(run.context, run.control.generation)
    run.history.set_text(run.control.generation, text)
    await run.worker.queue_frames(
        [
            LLMFullResponseStartFrame(),
            TTSSpeakFrame(text, append_to_context=True),
            LLMFullResponseEndFrame(),
        ]
    )


async def say_filler(run, text):
    speech = TTSSpeakFrame(text, append_to_context=False)
    speech.workers_generation = run.control.generation
    await run.worker.queue_frame(speech)


async def wait_for(condition):
    async with asyncio.timeout(5):
        while not condition():
            await asyncio.sleep(0.001)


async def ask(run, question, answer):
    run.replies.append(answer)
    await run.worker.queue_frames(
        [
            ProposedUserStartedSpeakingFrame(),
            TranscriptionFrame(question, "test-user", "", finalized=True),
            ProposedUserStoppedSpeakingFrame(),
        ]
    )


def interruption_notes(messages):
    return [
        message["content"]
        for message in messages
        if message.get("role") == "user"
        and message.get("content", "").startswith("<runtime_context>\n")
        and "previous assistant response" in message["content"]
    ]


async def test_repeated_barge_in_retains_only_estimated_output_in_next_model_request(
    output_pipeline,
):
    run = output_pipeline
    tools = "I can look up weather and search documentation for you. Tools also provide current information."
    planets = "Planets orbit stars and our solar system has eight planets with very different environments."
    stopped = "Sure, we can stay with planets."
    pcm = b"\x01\0" * (FRAME_BYTES // 2)
    old = AudioReader(pcm * 400)
    run.responses.append(old)
    run.pause_after = 65  # 2.6 seconds sent, despite 16 seconds generated.
    run.can_play.set()
    await ask(run, "Tell me about tools.", tools)
    await asyncio.wait_for(run.blocked.wait(), 5)
    assert not any(message.get("role") == "assistant" for message in run.context.get_messages())

    run.blocked.clear()
    run.pause_after = 105  # Another 1.6 seconds, belonging only to the next reply.
    second = AudioReader(pcm * 300)
    run.responses.append(second)
    await ask(run, "Tell me about planets.", planets)
    await wait_for(lambda: len(run.model_requests) == 2 and old.released)
    messages = run.model_requests[1]["messages"]
    notes = interruption_notes(messages)
    assert len(notes) == 1
    assert {"role": "assistant", "content": "I can look up weather"} in messages
    assert "cutoff is approximate" in notes[0]
    assert "Tools also provide" not in str(messages)
    assert messages[-1] == {"role": "user", "content": "Tell me about planets."}
    run.can_play.set()
    await asyncio.wait_for(run.blocked.wait(), 5)

    run.responses.append(AudioReader(pcm * 30))
    await ask(run, "Stop talking about tools.", stopped)
    await wait_for(lambda: len(run.model_requests) == 3 and second.released)
    messages = run.model_requests[2]["messages"]
    notes = interruption_notes(messages)
    assert len(notes) == 2
    assert {"role": "assistant", "content": "Planets orbit stars"} in messages
    assert messages[-1] == {"role": "user", "content": "Stop talking about tools."}
    # A late full-text frame from cancelled speech must not enter the aggregator.
    await run.output.push_frame(
        TTSTextFrame(
            tools, aggregated_by="sentence", context_id=run.summary["requests"][0]["context_id"]
        )
    )
    run.can_play.set()
    await wait_for(lambda: {"role": "assistant", "content": stopped} in run.context.get_messages())
    assert run.tts_texts == [tools, planets, stopped]  # One complete synthesis request per reply.
    assert run.sink.text == [stopped]
    assert run.summary["errors"] == []
    assert run.pipeline_errors == []

    # Starting a new user turn after completion adds no spurious interruption.
    run.responses.append(AudioReader(pcm * 10))
    await ask(run, "Thanks.", "You're welcome.")
    await wait_for(lambda: len(run.model_requests) == 4)
    assert interruption_notes(run.model_requests[3]["messages"]) == notes
    assert run.model_requests[3]["messages"].count({"role": "assistant", "content": stopped}) == 1


async def test_barge_in_before_output_keeps_status_without_unspoken_text(output_pipeline):
    run = output_pipeline
    pcm = b"\x01\0" * (FRAME_BYTES // 2)
    old = AudioReader(pcm * 100)
    run.responses.append(old)
    await ask(run, "Tell me about tools.", "The unspoken answer must stay out of history.")
    await wait_for(
        lambda: run.summary["requests"] and run.summary["requests"][0]["audio_frames"] >= 5
    )
    assert not run.sent
    run.responses.append(AudioReader(pcm * 10))
    await ask(run, "Tell me about planets.", "Planets orbit stars.")
    await wait_for(lambda: len(run.model_requests) == 2 and old.released)
    messages = run.model_requests[1]["messages"]
    assert len(interruption_notes(messages)) == 1
    assert "No spoken prefix could be estimated" in interruption_notes(messages)[0]
    assert "unspoken answer" not in str(messages)
    assert messages[-1]["content"] == "Tell me about planets."
    run.can_play.set()
    await wait_for(lambda: "Planets orbit stars." in run.sink.text)


async def test_filler_is_heard_but_stays_out_of_the_replys_spoken_prefix(output_pipeline):
    run = output_pipeline
    reply = "I can look up weather and search documentation for you."
    pcm = b"\x01\0" * (FRAME_BYTES // 2)
    run.responses.extend([AudioReader(pcm * 25), AudioReader(pcm * 400)])
    run.pause_after = 65  # One second of filler, then 1.6 seconds of the reply.
    run.can_play.set()
    await say_filler(run, "One sec, let me check.")
    await speak(run, reply)
    await asyncio.wait_for(run.blocked.wait(), 5)
    # Each start unmutes the browser; only the reply finishes the response.
    assert [(event["type"], sent) for event, sent in run.notifications] == [
        ("audio_started", 1),
        ("filler_finished", 25),
        ("audio_started", 26),
    ]

    run.responses.append(AudioReader(pcm * 10))
    await ask(run, "Tell me about planets.", "Planets orbit stars.")
    await wait_for(lambda: len(run.model_requests) == 1)
    messages = run.model_requests[0]["messages"]
    # Counting the filler's second would retain "I can look up weather".
    assert {"role": "assistant", "content": "I can look"} in messages
    assert "One sec" not in str(messages)
    run.can_play.set()
    await wait_for(lambda: "Planets orbit stars." in run.sink.text)
    assert "One sec" not in str(run.context.get_messages())


async def test_buffered_speech_waits_for_playback_without_provider_timeout(
    output_pipeline, monkeypatch
):
    run = output_pipeline
    # One minute of PCM arrives in one read, independent of playback speed.
    chunks = [i.to_bytes(2, "little") * (FRAME_BYTES // 2) for i in range(1, 1501)]
    reader = AudioReader(b"".join(chunks))
    run.responses.append(reader)
    monkeypatch.setattr(tts_module, "TTS_TIMEOUT_SECONDS", 0.03)
    await speak(run, "A long response.")
    await wait_for(
        lambda: (
            run.summary["requests"]
            and run.summary["requests"][0]["audio_frames"] >= MAX_AUDIO_AHEAD_MS // FRAME_MS
        )
    )
    # The event loop keeps advancing beyond the provider timeout while playback
    # is held. Production must remain bounded and the reader must stay open.
    await asyncio.sleep(0.06)
    record = run.summary["requests"][0]
    assert record["audio_frames"] * FRAME_MS <= MAX_AUDIO_AHEAD_MS
    assert record["outcome"] == "pending"
    assert not reader.cancelled
    assert not any(event["type"] == "assistant_response_finished" for event, _ in run.notifications)
    run.can_play.set()
    await asyncio.wait_for(run.sink.completed.wait(), 5)
    assert [pcm for _, pcm in run.sent] == chunks
    assert max(run.ahead) * FRAME_MS <= MAX_AUDIO_AHEAD_MS
    assert run.sink.text == ["A long response."]
    assert record["outcome"] == "generated"
    assert reader.released
    assert run.summary["errors"] == []
    assert [
        (event["generation"], sent)
        for event, sent in run.notifications
        if event["type"] == "assistant_response_finished"
    ] == [(0, len(chunks))]


async def test_interrupting_a_full_window_cancels_reader_and_allows_next_reply(output_pipeline):
    run = output_pipeline
    old = AudioReader(b"\x01\0" * (FRAME_BYTES // 2) * 100)
    run.responses.append(old)
    run.pause_next = True
    run.can_play.set()
    await speak(run, "The interrupted response.")
    await asyncio.wait_for(run.blocked.wait(), 5)
    await wait_for(
        lambda: run.summary["requests"][0]["audio_frames"] >= MAX_AUDIO_AHEAD_MS // FRAME_MS
    )
    await run.worker.queue_frame(InterruptionFrame())
    await wait_for(lambda: old.cancelled and old.released)
    assert run.summary["requests"][0]["outcome"] == "cancelled"
    sent_before = len(run.sent)
    fresh = b"\x02\0" * (FRAME_BYTES // 2)
    next_reader = AudioReader(fresh * 10 + b"\x02\0")
    run.responses.append(next_reader)
    await speak(run, "The next response.")
    run.can_play.set()
    await asyncio.wait_for(run.sink.completed.wait(), 5)
    assert run.sent[sent_before:] == [(1, fresh)] * 10 + [(1, b"\x02\0".ljust(FRAME_BYTES, b"\0"))]
    assert run.sink.text == ["The next response."]
    assert next_reader.released
    assert run.summary["errors"] == []
    assert [
        event["generation"]
        for event, _ in run.notifications
        if event["type"] == "assistant_response_finished"
    ] == [1]

    # Ending the call must also cancel a producer blocked on a full window.
    run.can_play.clear()
    stopped = AudioReader(fresh * 100)
    run.responses.append(stopped)
    await speak(run, "The stopped response.")
    await wait_for(
        lambda: (
            len(run.summary["requests"]) == 3
            and run.summary["requests"][2]["audio_frames"] >= MAX_AUDIO_AHEAD_MS // FRAME_MS
        )
    )
    await run.runner.cancel(reason="user_left")
    await asyncio.wait_for(run.task, 5)
    assert stopped.cancelled and stopped.released


@pytest.mark.parametrize("failure", ["server", "stream_timeout", "empty"])
async def test_temporary_speech_failure_allows_next_reply(output_pipeline, failure):
    run = output_pipeline
    pcm = b"\x01\0" * (FRAME_BYTES // 2)
    # A successful reply (including a transient retry) must precede the failure:
    # Pipecat retains completion state that a failure on the first reply misses.
    run.responses.extend([AudioReader(None, status=503), AudioReader(pcm * 10)])
    run.can_play.set()
    await speak(run, "The first reply succeeds after a brief platform blip.")
    await asyncio.wait_for(run.sink.completed.wait(), 5)
    assert not any(event["type"] == "speech_failed" for event, _ in run.notifications)
    assert len(run.tts_texts) == 2
    run.sink.completed.clear()
    run.sink.text.clear()
    run.notifications.clear()
    failed = {
        "server": AudioReader(None, status=500),
        "stream_timeout": AudioReader(pcm * 10, error=TimeoutError()),
        "empty": AudioReader(None),
    }[failure]
    run.responses.append(failed)
    if failure == "server":
        run.responses.append(AudioReader(None, status=500))
    await speak(run, "The failed response must not enter history.")
    await wait_for(lambda: any(event["type"] == "clear" for event, _ in run.notifications))
    assert failed.released or failed.cancelled
    assert [
        (event["type"], event["generation"])
        for event, _ in run.notifications
        if event["type"] != "audio_started"
    ] == [("speech_failed", 0), ("clear", 1)]
    assert run.control.generation == 1
    assert not run.sink.text
    assert not run.pipeline_errors
    assert not run.terminal_errors and run.owner.pipeline_ready
    assert not any(event["type"] == "assistant_response_finished" for event, _ in run.notifications)

    notes = interruption_notes(run.context.get_messages())
    assert len(notes) == 1
    assert "Speech synthesis failed" in notes[0]
    assert "user interrupted" not in notes[0]

    sent_before = len(run.sent)
    fresh = b"\x02\0" * (FRAME_BYTES // 2)
    next_reader = AudioReader(fresh * 10)
    run.responses.append(next_reader)
    await speak(run, "The next response.")
    await asyncio.wait_for(run.sink.completed.wait(), 5)
    assert run.sent[sent_before:] == [(1, fresh)] * 10
    assert run.sink.text == ["The next response."]
    assert next_reader.released
    assert [r["outcome"] for r in run.summary["requests"]] == ["generated", "error", "generated"]
    assert not run.pipeline_errors


@pytest.mark.parametrize("failure", ["rate_limit", "stream_timeout", "stalled"])
async def test_failed_filler_is_skipped_and_the_reply_still_plays(
    output_pipeline, monkeypatch, failure
):
    run = output_pipeline
    monkeypatch.setattr(tts_module, "FILLER_TIMEOUT_SECONDS", 0.05)
    pcm = b"\x01\0" * (FRAME_BYTES // 2)
    filler = {
        "rate_limit": AudioReader(None, status=429),
        "stream_timeout": AudioReader(pcm * 10, error=TimeoutError()),
        "stalled": StalledReader(None),
    }[failure]
    fresh = b"\x02\0" * (FRAME_BYTES // 2)
    run.responses.extend([filler, AudioReader(fresh * 10)])
    run.can_play.set()
    await say_filler(run, "One sec, let me check.")
    await speak(run, "The reply still plays.")
    reply = {"role": "assistant", "content": "The reply still plays."}
    await wait_for(lambda: reply in run.context.get_messages())
    assert "One sec" not in str(run.context.get_messages())
    expected = ["filler_finished", "audio_started", "assistant_response_finished"]
    if failure == "stream_timeout":
        expected.insert(0, "audio_started")
    assert [event["type"] for event, _ in run.notifications] == expected
    assert run.sent[-10:] == [(0, fresh)] * 10
    assert run.control.generation == 0
    assert [(r["filler"], r["outcome"]) for r in run.summary["requests"]] == [
        (True, "error"),
        (False, "generated"),
    ]
    assert not run.pipeline_errors


async def test_rejected_speech_credentials_reach_the_pipeline_error_handler(output_pipeline):
    run = output_pipeline
    await run.tts.push_error("A temporary service diagnostic", category=ErrorCategory.SERVER)
    await wait_for(lambda: bool(run.pipeline_errors))
    assert not run.terminal_errors and run.owner.pipeline_ready
    run.pipeline_errors.clear()
    reader = AudioReader(None, status=401)
    run.responses.append(reader)
    run.can_play.set()
    await speak(run, "This response cannot be synthesized.")
    await wait_for(lambda: bool(run.pipeline_errors))
    assert reader.cancelled
    assert not run.sink.text
    assert not any(event["type"] == "clear" for event, _ in run.notifications)
    assert len(run.tts_texts) == 1
    assert run.pipeline_errors[0].category == ErrorCategory.AUTHENTICATION
    assert run.terminal_errors and not run.owner.pipeline_ready


@pytest.mark.parametrize("stop", ["interruption", "deadline"])
async def test_retry_backoff_respects_interruption_and_original_deadline(monkeypatch, stop):
    monkeypatch.setattr(inference_module, "RETRY_DELAY_SECONDS", 1)
    calls = []

    async def unavailable(*args):
        calls.append(True)
        raise ConnectionError("Unavailable")

    task = asyncio.create_task(
        inference_module.run_inference(
            SimpleNamespace(run=unavailable),
            "model",
            {},
            {},
            log=log,
            is_current=lambda: True,
            timeout=0.03,
        )
    )
    await wait_for(lambda: bool(calls))
    if stop == "interruption":
        task.cancel()
    with pytest.raises(
        asyncio.CancelledError if stop == "interruption" else inference_module.InferenceError
    ):
        await task
    assert len(calls) == 1

import asyncio
from collections import OrderedDict
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pipecat.frames.frames import InputAudioRawFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.workers.runner import WorkerRunner

from agent.config import AgentConfig
from agent.engine import VoiceEngine
from agent.pipeline import provider_event
from services.flux import FluxBridge
from services.stt import MAX_PENDING_AUDIO_BYTES, AudioInputBacklog, FluxInput

PCM = bytes(640)  # 20 ms of silence at 16 kHz, mono, PCM16.


class Sink(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.audio = []
        self.text = []
        self.received_text = asyncio.Event()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.audio.append(frame.audio)
        if isinstance(frame, TranscriptionFrame):
            self.text.append(frame.text)
            self.received_text.set()
        await self.push_frame(frame, direction)


@pytest.fixture
async def input_pipeline():
    sent = []
    stats = {
        "pipeline": dict.fromkeys(
            ["input_frames", "input_bytes", "input_while_llm_pending", "input_while_tts_pending"], 0
        )
    }
    control = SimpleNamespace(llm_pending=True, tts_pending=False)
    source = FluxInput(SimpleNamespace(send_audio=sent.append), stats, control)
    sink = Sink()
    worker = PipelineWorker(Pipeline([source, sink]), enable_rtvi=False, idle_timeout_secs=None)
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False, force_gc=False)
    started = asyncio.Event()

    @worker.event_handler("on_pipeline_started")
    async def on_started(*_):
        started.set()

    await runner.add_workers(worker)
    task = asyncio.create_task(runner.run())
    await asyncio.wait_for(started.wait(), 5)
    try:
        yield SimpleNamespace(source=source, sink=sink, sent=sent, worker=worker, stats=stats)
    finally:
        await runner.cancel(reason="test_complete")
        await asyncio.wait_for(task, 5)


async def drain(source):
    async with asyncio.timeout(5):
        while source.pending_bytes:
            await asyncio.sleep(0)


async def test_delayed_audio_can_drain_without_elapsed_time_credit(input_pipeline):
    run = input_pipeline
    timer_progress = []

    def send(pcm):
        run.sent.append(pcm)
        if len(run.sent) == 1:
            asyncio.get_running_loop().call_later(0, lambda: timer_progress.append(len(run.sent)))

    run.source.flux.send_audio = send
    for _ in range(150):  # Three seconds delivered together, no artificial pacing.
        await run.source.queue_audio(PCM)
    await drain(run.source)
    assert run.sent == [PCM] * 150
    assert timer_progress and timer_progress[0] < 150
    assert run.stats["pipeline"]["input_while_llm_pending"] == 150
    assert run.source.pending_bytes == 0
    assert run.sink.audio == []
    await run.worker.queue_frame(TranscriptionFrame("hello", "test-user", ""))
    await asyncio.wait_for(run.sink.received_text.wait(), 5)
    assert run.sink.text == ["hello"]


async def test_long_transcript_reaches_pipeline_and_client_events(input_pipeline):
    run = input_pipeline
    owner = VoiceEngine(None, None, AgentConfig(), None, None, call_id="test", owner_id="test")
    owner.worker = run.worker
    owner.pipeline_ready = True
    owner.stats["pipeline"] = {"provider_end_events": 0}
    owner._provider_event_lock = asyncio.Lock()
    owner._provider_turns = OrderedDict()
    text = "文" * 5000

    await provider_event(owner, {"event": "EndOfTurn", "turn_index": 1, "transcript": text})
    await asyncio.wait_for(run.sink.received_text.wait(), 5)

    assert run.sink.text == [text]
    assert owner.client_events[0]["type"] == "user_transcript"
    assert owner.client_events[0]["text"] == text


async def test_a_stalled_consumer_hits_the_real_queue_limit_then_recovers(input_pipeline):
    run = input_pipeline
    await run.source.pause_processing_system_frames()
    for _ in range(MAX_PENDING_AUDIO_BYTES // len(PCM)):
        await run.source.queue_audio(PCM)
    assert run.source.pending_bytes == MAX_PENDING_AUDIO_BYTES
    with pytest.raises(AudioInputBacklog):
        await run.source.queue_audio(PCM)
    assert run.source.pending_bytes == MAX_PENDING_AUDIO_BYTES
    await run.source.resume_processing_system_frames()
    await drain(run.source)
    await run.source.queue_audio(PCM)
    await drain(run.source)
    assert len(run.sent) == MAX_PENDING_AUDIO_BYTES // len(PCM) + 1


async def test_invalid_chunks_and_failed_enqueue_do_not_consume_budget(input_pipeline, monkeypatch):
    source = input_pipeline.source
    for value in (b"x", bytes(64002), "not bytes"):
        with pytest.raises(ValueError):
            await source.queue_audio(value)
    monkeypatch.setattr(source, "queue_frame", AsyncMock(side_effect=ConnectionError("closed")))
    with pytest.raises(ConnectionError):
        await source.queue_audio(PCM)
    assert source.pending_bytes == 0


def test_flux_accepts_valid_bursts_without_a_second_cadence_guard():
    sent = []
    bridge = FluxBridge(None, AsyncMock())
    bridge._state = "open"
    bridge._ws = SimpleNamespace(readyState=1, send=sent.append)
    for _ in range(150):
        bridge.send_audio(PCM)
    assert sent == [PCM] * 150
    assert bridge.is_open
    with pytest.raises(ValueError):
        bridge.send_audio(b"x")
    with pytest.raises(ValueError):
        bridge.send_audio(bytes(64002))


@pytest.mark.parametrize("terms", [(), ("Cloudflare", "SFU", "UTC")])
async def test_flux_opens_with_vocabulary_without_waiting_for_control_messages(terms):
    sent = []

    class Socket:
        readyState = 1

        def __init__(self):
            self.listeners = {}

        def addEventListener(self, name, proxy):
            self.listeners[name] = proxy.task

        def removeEventListener(self, name, _proxy):
            self.listeners.pop(name, None)

        def accept(self):
            pass

        def send(self, message):
            sent.append(message)

        def close(self, code, _reason):
            self.readyState = 3
            self.listeners["close"](SimpleNamespace(code=code, reason=""))

    socket = Socket()
    env = SimpleNamespace(
        AI=SimpleNamespace(
            run=AsyncMock(return_value=SimpleNamespace(status=101, webSocket=socket))
        )
    )
    bridge = FluxBridge(env, AsyncMock(), keyterms=terms)
    try:
        # This socket sends no events. A successful upgrade is enough to start
        # streaming; vocabulary travels in that request, not a later handshake.
        await asyncio.wait_for(bridge.start(), 1)
        assert bridge.is_open
        parameters = env.AI.run.call_args.args[1]
        assert parameters.get("keyterm", []) == list(terms)
        assert sent == []
    finally:
        await bridge.stop()
    assert socket.readyState == 3

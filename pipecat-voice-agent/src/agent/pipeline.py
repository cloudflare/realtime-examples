"""Pipecat pipeline and Flux turn events for a voice call."""

import asyncio
import datetime
import time
from collections import OrderedDict

from pipecat.frames.frames import (
    LLMContextFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies
from pipecat.utils.errors import ErrorCategory
from pipecat.workers.runner import WorkerRunner

from agent.config import LLM_MODEL
from agent.fillers import SILENT, speak_fillers
from agent.speech_history import SpeechHistory
from agent.tools import build_tools
from services.flux import MAX_TRANSCRIPT_CHARS
from services.llm import WorkersAILLM
from services.models import get_model
from services.stt import FluxInput
from services.tts import WorkersAura
from transport.output import NativeVoiceOutput
from transport.thinking import ThinkingSound

MAX_RECENT_PROVIDER_TURNS = 64


def _make_services(env, stats, control, config, *, call_id, speech_history):
    stats["llm"] = {
        "requests": [],
        "responses": [],
        "errors": [],
        "cancelled": 0,
        "stale_dropped": 0,
        "interruptions": 0,
    }
    stats["tts"] = {
        "requests": [],
        "errors": [],
        "completed": 0,
        "cancelled": 0,
        "stale_dropped": 0,
    }
    return (
        WorkersAILLM(
            env,
            stats["llm"],
            control,
            model=get_model(LLM_MODEL),
            call_id=call_id,
            utc_offset_minutes=config.utc_offset_minutes,
            speech_history=speech_history,
        ),
        WorkersAura(
            env, stats["tts"], control, time.monotonic(), voice=config.voice, call_id=call_id
        ),
    )


async def _notify(owner, kind, **data):
    """Record a bounded lifecycle event and notify the authenticated client."""
    owner.event(kind, **data)
    owner.notify({"type": kind, **data})


def _set_state(owner, state):
    owner.pipeline_ready = state == "running"
    owner.stats["pipeline"]["state"] = state


def _remember_context(owner, context):
    messages = context.get_messages()
    owner.stats["pipeline"]["context_message_count"] = len(messages)
    owner.stats["pipeline"]["user_context_count"] = sum(
        isinstance(message, dict) and message.get("role") == "user" for message in messages
    )
    owner.stats["pipeline"]["assistant_context_count"] = sum(
        isinstance(message, dict) and message.get("role") == "assistant" for message in messages
    )


def handle_pipeline_error(owner, frame):
    """Service adapters recover replies; only an unusable pipeline ends the call."""
    owner.stats["pipeline"]["error_count"] += 1
    processor = frame.processor
    category = frame.category or ErrorCategory.UNKNOWN
    usable = processor is None or processor.is_usable
    fatal = bool(
        frame.fatal
        or not usable
        or (category == ErrorCategory.UNKNOWN and frame.exception is not None)
    )
    fields = {
        "processor": processor.name if processor else "unknown",
        "error_category": category.value,
        "fatal": fatal,
        "processor_usable": usable,
    }
    if fatal:
        _set_state(owner, "error")
        owner.fail_call(
            "pipecat_pipeline", frame.exception or RuntimeError("Pipeline unavailable"), **fields
        )
    else:
        # A nonfatal ErrorFrame is a diagnostic, not a browser hang-up command.
        owner.log.warning("pipeline_warning", **fields)


async def start_pipeline(owner):
    """Create and start the real context/LLM/TTS/output pipeline for one owner.

    The owner must start Flux before admitting audio. It owns shutdown, calls
    runner.cancel() outside pipeline callbacks, and monitors pipeline_ready.
    """
    existing = getattr(owner, "runner_task", None)
    if existing is not None and not existing.done():
        raise RuntimeError("A Pipecat pipeline is already running for this session")

    owner.stats["pipeline"] = {
        "state": "starting",
        "started": False,
        "finished": False,
        "context_message_count": 0,
        "user_context_count": 0,
        "assistant_context_count": 0,
        "user_turns": 0,
        "assistant_turns": 0,
        "assistant_interruptions": 0,
        "provider_start_events": 0,
        "provider_end_events": 0,
        "duplicate_provider_events": 0,
        "empty_provider_transcripts": 0,
        "input_frames": 0,
        "input_bytes": 0,
        "input_while_llm_pending": 0,
        "input_while_tts_pending": 0,
        "error_count": 0,
    }
    owner._provider_turns = OrderedDict()
    owner._provider_event_lock = asyncio.Lock()
    _set_state(owner, "starting")
    started_at = time.monotonic()
    started = asyncio.Event()

    class ContextEvents(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
                _remember_context(owner, frame.context)
                await _notify(
                    owner,
                    "context_updated",
                    messages=owner.stats["pipeline"]["context_message_count"],
                    assistant_messages=owner.stats["pipeline"]["assistant_context_count"],
                )
            await self.push_frame(frame, direction)

    context = LLMContext(
        messages=[{"role": "system", "content": owner.config.system_prompt()}],
        tools=build_tools(owner.notify, ai=owner.env.AI) if owner.config.tools_enabled else [],
    )
    pair = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(),
            vad_analyzer=None,
            empty_user_turn=None,
        ),
        realtime_service_mode=False,
    )
    speech_history = SpeechHistory()
    llm, tts = _make_services(
        owner.env,
        owner.stats,
        owner.control,
        owner.config,
        call_id=owner.resources.call_id,
        speech_history=speech_history,
    )

    @llm.event_handler("on_response_text")
    async def on_response_text(_service, text, generation):
        # UI preview only. The assistant aggregator owns completed-reply history.
        owner.notify({"type": "assistant_response", "text": text, "generation": generation})

    @tts.event_handler("on_speech_failed")
    async def on_speech_failed(_service, generation):
        speech_history.failed(generation)
        owner.notify({"type": "speech_failed", "generation": generation})

    speak_fillers(llm, tts, owner.control)
    thinking = ThinkingSound(quiet_tools=SILENT)

    @llm.event_handler("on_function_calls_started")
    async def on_lookups_started(_service, function_calls):
        # Lookup frames reach the output only after the filler is synthesized,
        # so typing starts its wait from the event that queues the filler.
        for call in function_calls:
            thinking.tool_started(
                call.tool_call_id, call.function_name, call.workers_generation, time.monotonic()
            )

    output = NativeVoiceOutput(
        owner,
        owner.stats,
        owner.control,
        playback_budget=tts.playback_budget,
        speech_history=speech_history,
        thinking=thinking,
    )
    audio_input = FluxInput(owner.flux, owner.stats, owner.control)
    worker = PipelineWorker(
        Pipeline(
            [
                audio_input,
                pair.user(),
                llm,
                tts,
                output,
                pair.assistant(),
                ContextEvents(name="SessionContextEvents"),
            ]
        ),
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=48000),
        app_resources=owner.resources,
        enable_rtvi=False,
        idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False, handle_sigterm=False, force_gc=False)
    owner.worker = worker
    owner.runner = runner
    owner.pipeline_input = audio_input

    @worker.event_handler("on_pipeline_started")
    async def on_started(_worker, _frame):
        owner.stats["pipeline"]["started"] = True
        _set_state(owner, "running")
        started.set()
        await _notify(owner, "pipeline_started")

    @worker.event_handler("on_pipeline_finished")
    async def on_finished(_worker, _frame):
        owner.stats["pipeline"]["finished"] = True
        owner.stats["pipeline"]["duration_ms"] = round((time.monotonic() - started_at) * 1000)
        _remember_context(owner, context)
        _set_state(owner, "finished")
        await _notify(owner, "pipeline_finished")

    @worker.event_handler("on_pipeline_error")
    async def on_error(_worker, frame):
        handle_pipeline_error(owner, frame)

    @pair.user().event_handler("on_user_turn_started")
    async def on_user_started(_aggregator, _strategy):
        await _notify(owner, "user_turn_started", generation=owner.control.generation)

    @pair.user().event_handler("on_user_turn_stopped")
    async def on_user_stopped(_aggregator, _strategy, message):
        owner.stats["pipeline"]["user_turns"] += 1
        _remember_context(owner, context)
        await _notify(owner, "user_turn_stopped", text=str(message.content)[:MAX_TRANSCRIPT_CHARS])

    @pair.assistant().event_handler("on_assistant_turn_started")
    async def on_assistant_started(_aggregator):
        # Thinking/turn lifecycle; native_output separately signals actual audio.
        await _notify(owner, "assistant_turn_started", generation=owner.control.generation)

    @pair.assistant().event_handler("on_assistant_turn_stopped")
    async def on_assistant_stopped(_aggregator, message):
        record = owner.stats["pipeline"]
        record["assistant_turns"] += 1
        record["assistant_interruptions"] += int(message.interrupted)
        _remember_context(owner, context)
        await _notify(
            owner,
            "assistant_turn_stopped",
            text=str(message.content)[:MAX_TRANSCRIPT_CHARS],
            interrupted=bool(message.interrupted),
            generation=owner.control.generation,
        )

    try:
        await runner.add_workers(worker)
        owner.runner_task = owner.background(runner.run(), "pipecat-session-runner")
        await asyncio.wait_for(started.wait(), timeout=15)
    except Exception:
        _set_state(owner, "error")
        raise


async def provider_event(owner, payload):
    """Translate only actual Flux start/end events into existing Pipecat frames."""
    if not isinstance(payload, dict):
        raise TypeError("Flux event must be a mapping")
    kind = payload.get("event") or payload.get("type")
    if kind not in ("StartOfTurn", "EndOfTurn"):
        return
    if not getattr(owner, "pipeline_ready", False) or getattr(owner, "worker", None) is None:
        owner.event("provider_turn_ignored", reason="pipeline_not_ready", provider_event=kind)
        return

    async with owner._provider_event_lock:
        turn_index = payload.get("turn_index")
        turn = None
        if isinstance(turn_index, int) and not isinstance(turn_index, bool):
            turn = owner._provider_turns.setdefault(turn_index, {"started": False, "ended": False})
            owner._provider_turns.move_to_end(turn_index)
            while len(owner._provider_turns) > MAX_RECENT_PROVIDER_TURNS:
                owner._provider_turns.popitem(last=False)
        if kind == "StartOfTurn":
            if turn is not None and (turn["started"] or turn["ended"]):
                owner.stats["pipeline"]["duplicate_provider_events"] += 1
                return
            if turn is not None:
                turn["started"] = True
            owner.stats["pipeline"]["provider_start_events"] += 1
            owner.event("FluxStartOfTurn", turn=turn_index)
            await owner.worker.queue_frame(ProposedUserStartedSpeakingFrame())
            return

        if turn is not None and turn["ended"]:
            owner.stats["pipeline"]["duplicate_provider_events"] += 1
            return
        text = payload.get("transcript", "")
        if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT_CHARS:
            raise ValueError("Flux transcript is invalid or exceeds the session limit")
        if turn is not None:
            turn["ended"] = True
        owner.stats["pipeline"]["provider_end_events"] += 1
        owner.event("FluxEndOfTurn", turn=turn_index)
        frames = []
        if text:
            frames.append(
                TranscriptionFrame(
                    text=text,
                    user_id="session-participant",
                    timestamp=datetime.datetime.now(datetime.UTC).isoformat(),
                    finalized=True,
                )
            )
            await _notify(owner, "user_transcript", text=text, turn_index=turn_index, final=True)
        else:
            owner.stats["pipeline"]["empty_provider_transcripts"] += 1
        # A real provider end proposal follows its final transcript. No start or
        # transcript is invented when the provider omitted one.
        frames.append(ProposedUserStoppedSpeakingFrame())
        await owner.worker.queue_frames(frames)

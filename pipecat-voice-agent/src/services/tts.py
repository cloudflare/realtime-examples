"""Native Workers AI speech synthesis using Pipecat's TTSService."""

import asyncio
import time

from pipecat.frames.frames import (
    CancelFrame,
    InterruptionWorkerFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TextAggregationMode, TTSService
from pipecat.utils.errors import ErrorCategory

from agent.config import TTS_MODEL
from server.observability import exception_fields, log
from services.inference import InferenceError, inference_error, run_inference
from transport.playback import FRAME_BYTES as TTS_FRAME_BYTES
from transport.playback import SAMPLE_RATE as TTS_SAMPLE_RATE
from transport.playback import PlaybackBudget

TTS_TIMEOUT_SECONDS = 25
# A stalled filler holds back the reply queued behind it.
FILLER_TIMEOUT_SECONDS = 2
TEMPORARY_ERRORS = frozenset(
    {ErrorCategory.CONNECTIVITY, ErrorCategory.RATE_LIMIT, ErrorCategory.SERVER}
)


def _record_error(summary, stage, exc):
    summary["errors"].append({"stage": stage, "type": type(exc).__name__})
    del summary["errors"][:-8]


class WorkersAura(TTSService):
    """Pipecat speech contexts with native Workers AI PCM streaming."""

    def __init__(self, env, summary, control, started_at, *, voice="arcas", call_id=None):
        super().__init__(
            name="WorkersAuraNative",
            text_aggregation_mode=TextAggregationMode.SENTENCE,
            push_start_frame=True,
            push_stop_frames=True,
            # Let our provider deadline and cleanup run before Pipecat's idle cutoff.
            stop_frame_timeout_s=TTS_TIMEOUT_SECONDS + 5,
            push_text_frames=True,
            sample_rate=TTS_SAMPLE_RATE,
            settings=TTSSettings(model=TTS_MODEL, voice=voice, language=None),
        )
        self._env = env
        self._voice = voice
        self._summary = summary
        self._control = control
        self._started_at = started_at
        self._frame_generation = None
        self._frame_filler = False
        self._filler_contexts = set()
        self._failed_generation = None
        self._pending_count = 0
        self.playback_budget = PlaybackBudget()
        self.log = log.bind(call_id=call_id, provider="tts")
        self._register_event_handler("on_speech_failed", sync=True)

    async def process_frame(self, frame, direction):
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, (TTSSpeakFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame)
        ):
            generation = getattr(frame, "workers_generation", self._control.generation)
            if generation != self._control.generation or generation == self._failed_generation:
                self._summary["stale_dropped"] += 1
                return
            old = self._frame_generation, self._frame_filler
            self._frame_generation = generation
            # Fillers are the only speech kept out of conversation history.
            self._frame_filler = isinstance(frame, TTSSpeakFrame) and not frame.append_to_context
            try:
                await super().process_frame(frame, direction)
            except InferenceError as exc:
                if exc.category not in TEMPORARY_ERRORS:
                    await self.push_error(
                        "Speech synthesis is unavailable.",
                        exception=exc,
                        category=exc.category,
                        force_treat_as_permanent=True,
                    )
                    return
                if generation == self._control.generation:
                    # Reject queued completion frames before the interruption returns.
                    # Otherwise they can finish a failed context as "no audio".
                    self._failed_generation = generation
                    await self._call_event_handler("on_speech_failed", generation)
                    await self.push_frame(InterruptionWorkerFrame(), FrameDirection.UPSTREAM)
            finally:
                self._frame_generation, self._frame_filler = old
            return
        await super().process_frame(frame, direction)

    async def on_turn_context_created(self, context_id):
        generation = self._frame_generation
        if generation is None:
            generation = self._control.generation
        self._control.context_generations[context_id] = generation
        if self._frame_filler:
            self._filler_contexts.add(context_id)
        await super().on_turn_context_created(context_id)

    async def on_audio_context_interrupted(self, context_id):
        self.playback_budget.close(context_id)
        await super().on_audio_context_interrupted(context_id)

    async def cancel(self, frame: CancelFrame):
        self.playback_budget.clear()
        await super().cancel(frame)

    async def cleanup(self):
        self.playback_budget.clear()
        await super().cleanup()

    async def run_tts(self, text, context_id):
        if not text.strip():
            raise ValueError("TTS text is empty")
        generation = self._control.context_generations.setdefault(
            context_id, self._control.generation
        )
        filler = context_id in self._filler_contexts
        timeout = FILLER_TIMEOUT_SECONDS if filler else TTS_TIMEOUT_SECONDS
        record = {
            "index": len(self._summary["requests"]) + 1,
            "generation": generation,
            "context_id": context_id,
            "filler": filler,
            "model": TTS_MODEL,
            "text_characters": len(text),
            "sample_rate": TTS_SAMPLE_RATE,
            "channels": 1,
            "started_at_ms": round((time.monotonic() - self._started_at) * 1000, 1),
            "outcome": "pending",
            "bytes_received": 0,
            "bytes_yielded": 0,
            "padding_bytes": 0,
            "audio_frames": 0,
            "reader_cancelled": False,
        }
        self._summary["requests"].append(record)
        started = time.monotonic()
        reader = None
        exhausted = False
        self._pending_count += 1
        self._control.tts_pending = True
        try:
            if generation != self._control.generation:
                self._summary["stale_dropped"] += 1
                raise asyncio.CancelledError()
            self.playback_budget.open(context_id)
            response = await run_inference(
                self._env.AI,
                TTS_MODEL,
                {
                    "text": text,
                    "encoding": "linear16",
                    "sample_rate": TTS_SAMPLE_RATE,
                    "container": "none",
                    "speaker": self._voice,
                },
                {"returnRawResponse": True},
                log=self.log.bind(generation=generation),
                is_current=lambda: generation == self._control.generation,
                timeout=timeout,
            )
            native = getattr(response, "js_response", response)
            record["http_status"] = int(native.status)
            record["content_type"] = str(native.headers.get("Content-Type"))[:100]
            if native.body is None:
                raise InferenceError(ErrorCategory.SERVER)
            reader = native.body.getReader()
            pending = bytearray()
            checked_prefix = False
            while True:
                # Provider inactivity is bounded independently of intentional
                # waits for playback capacity below.
                remaining = timeout
                if not record["audio_frames"]:
                    remaining -= time.monotonic() - started
                async with asyncio.timeout(remaining):
                    part = await reader.read()
                if part.done:
                    exhausted = True
                    break
                data = part.value.to_bytes()
                record["bytes_received"] += len(data)
                pending.extend(data)
                if not checked_prefix and len(pending) >= 4:
                    if pending[:4] in (b"RIFF", b"OggS", b"fLaC") or pending[:3] == b"ID3":
                        raise ValueError("Aura returned an unexpected encoded audio envelope")
                    checked_prefix = True
                while len(pending) >= TTS_FRAME_BYTES:
                    await self.playback_budget.reserve(context_id)
                    if generation != self._control.generation:
                        self._summary["stale_dropped"] += 1
                        raise asyncio.CancelledError()
                    audio = bytes(pending[:TTS_FRAME_BYTES])
                    del pending[:TTS_FRAME_BYTES]
                    if not record["audio_frames"]:
                        record["first_audio_ms"] = round((time.monotonic() - started) * 1000, 1)
                    record["bytes_yielded"] += len(audio)
                    record["audio_frames"] += 1
                    yield TTSAudioRawFrame(audio, TTS_SAMPLE_RATE, 1, context_id=context_id)
            if len(pending) % 2:
                raise ValueError("Aura PCM ended with an unaligned sample")
            if pending:
                await self.playback_budget.reserve(context_id)
                if generation != self._control.generation:
                    self._summary["stale_dropped"] += 1
                    raise asyncio.CancelledError()
                if not record["audio_frames"]:
                    record["first_audio_ms"] = round((time.monotonic() - started) * 1000, 1)
                # Finish on the same 40 ms boundary as earlier frames.
                # Otherwise BaseOutputTransport can retain a short PCM tail
                # until TTSStoppedFrame, after TTSTextFrame has passed it.
                # Track these zeroes separately from provider audio bytes.
                record["padding_bytes"] = TTS_FRAME_BYTES - len(pending)
                audio = bytes(pending).ljust(TTS_FRAME_BYTES, b"\0")
                record["bytes_yielded"] += len(audio)
                record["audio_frames"] += 1
                yield TTSAudioRawFrame(audio, TTS_SAMPLE_RATE, 1, context_id=context_id)
            if not record["bytes_yielded"]:
                raise InferenceError(ErrorCategory.SERVER)
            record["outcome"] = "generated"
            self._summary["completed"] += 1
        except asyncio.CancelledError:
            record["outcome"] = "cancelled"
            self._summary["cancelled"] += 1
            raise
        except Exception as exc:
            record["outcome"] = "error"
            _record_error(self._summary, "run_tts", exc)
            error = inference_error(exc)
            fields = exception_fields(exc.__cause__ or exc)
            self.log.error(
                "provider_failed",
                stage="synthesize",
                generation=generation,
                status=error.status or record.get("http_status"),
                error_code=error.category.value,
                text_characters=len(text),
                filler=filler,
                **fields,
            )
            if filler and error.category in TEMPORARY_ERRORS:
                # Skip the filler without failing the turn, which would cancel
                # its lookup. Pipecat closes an HTTP speech context only after
                # audio, so end a silent one with a single frame of silence.
                if not record["audio_frames"]:
                    await self.playback_budget.reserve(context_id)
                    yield TTSAudioRawFrame(
                        bytes(TTS_FRAME_BYTES), TTS_SAMPLE_RATE, 1, context_id=context_id
                    )
                return
            if error is exc:
                raise
            raise error from exc
        finally:
            self._filler_contexts.discard(context_id)
            if record["outcome"] != "generated":
                self.playback_budget.close(context_id)
            try:
                if reader is not None:
                    if not exhausted:
                        try:
                            await asyncio.wait_for(reader.cancel(), timeout=2)
                            record["reader_cancelled"] = True
                        except Exception as exc:
                            _record_error(self._summary, "reader_cancel", exc)
                    try:
                        reader.releaseLock()
                    except Exception as exc:
                        _record_error(self._summary, "reader_release", exc)
            finally:
                record["elapsed_ms"] = round((time.monotonic() - started) * 1000, 1)
                self._pending_count -= 1
                self._control.tts_pending = self._pending_count > 0

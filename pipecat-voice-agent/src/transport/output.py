"""Pipecat output ordering over the owner's native WebSocket connections.

BaseOutputTransport owns the only media queue. Its supported mixer path supplies
idle silence; the owner encodes PCM for the SFU WebSocket adapter.
Counts describe submitted audio, not browser rendering or physical audibility.
"""

import asyncio
import time
from typing import Any

from pipecat.audio.mixers.base_audio_mixer import BaseAudioMixer
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    MixerControlFrame,
    OutputAudioRawFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from agent.speech_history import SpeechHistory
from transport.playback import FRAME_BYTES, FRAME_SECONDS, SAMPLE_RATE, PlaybackBudget

SILENCE = bytes(FRAME_BYTES)


class _ClockedSilenceMixer(BaseAudioMixer):
    """Keep speech unchanged and let BaseOutput generate silence while idle."""

    async def start(self, sample_rate: int) -> None:
        if sample_rate != SAMPLE_RATE:
            raise ValueError("Native output requires mono PCM at 48 kHz")

    async def stop(self) -> None:
        pass

    async def process_frame(self, frame: MixerControlFrame) -> None:
        pass

    async def mix(self, audio: bytes) -> bytes:
        return audio


class NativeVoiceOutput(BaseOutputTransport):
    """Submit one PCM chunk per media tick from Pipecat's output queue."""

    def __init__(
        self,
        owner: Any,
        stats: dict[str, Any],
        control: Any,
        *,
        playback_budget: PlaybackBudget,
        speech_history: SpeechHistory,
    ):
        super().__init__(
            TransportParams(
                audio_out_enabled=True,
                audio_out_sample_rate=SAMPLE_RATE,
                audio_out_channels=1,
                audio_out_10ms_chunks=4,
                audio_out_auto_silence=True,
                audio_out_end_silence_secs=0,
                audio_out_mixer=_ClockedSilenceMixer(),
                video_out_enabled=False,
            ),
            name="WorkersNativeVoiceOutput",
        )
        self.owner = owner
        self.control = control
        self.playback_budget = playback_budget
        self.speech_history = speech_history
        self._context_id = None
        self._context_generation = None
        self._context_filler = False
        self._last_clear = None
        self._started = None
        self._unavailable_generation = None
        self._origin = time.monotonic()
        self._deadline = None
        self.record = {
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "frame_ms": 40,
            "attempted_chunks": 0,
            "accepted_chunks": 0,
            "accepted_pcm_bytes": 0,
            "accepted_speech_chunks": 0,
            "accepted_nonzero_chunks": 0,
            "idle_silence_chunks": 0,
            "not_ready_silence_chunks": 0,
            "unavailable_speech_chunks": 0,
            "stale_speech_chunks_dropped": 0,
            "unknown_generation_speech_chunks_dropped": 0,
            "interruption_events": 0,
            "completed_ticks": 0,
            "cancelled_ticks": 0,
            "cadence_resets": 0,
            "first_audio_by_generation": {},
            "boundaries": [],
        }
        stats["output"] = self.record

    def _now(self) -> int:
        return round((time.monotonic() - self._origin) * 1000)

    def _boundary(self, frame: Frame, stage: str) -> None:
        name = type(frame).__name__
        if name not in {
            "TTSStartedFrame",
            "TTSStoppedFrame",
            "TTSTextFrame",
            "LLMFullResponseStartFrame",
            "LLMFullResponseEndFrame",
            "BotStartedSpeakingFrame",
            "BotStoppedSpeakingFrame",
            "InterruptionFrame",
        }:
            return
        context_id = getattr(frame, "context_id", None)
        event = {
            "stage": stage,
            "frame": name,
            "at_output_ms": self._now(),
            "generation": self.control.context_generations.get(context_id),
            "current_generation": self.control.generation,
            "accepted_speech_chunks": self.record["accepted_speech_chunks"],
        }
        if isinstance(frame, TTSTextFrame):
            event["text_characters"] = len(frame.text)
            event["append_to_context"] = frame.append_to_context
        self.record["boundaries"].append(event)
        del self.record["boundaries"][:-64]

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, InterruptionFrame) and direction == FrameDirection.DOWNSTREAM:
            generation = self.control.generation
            self.record["interruption_events"] += 1
            if generation != self._last_clear:
                self._last_clear = generation
                self.owner.notify({"type": "clear", "generation": generation})
        await super().process_frame(frame, direction)

    async def write_transport_frame(self, frame: Frame) -> None:
        if isinstance(frame, TTSStartedFrame):
            # BaseOutput's PCM rechunking omits context_id. The preceding start
            # marker is serialized through that same queue and identifies its run.
            self._context_id = frame.context_id
            self._context_generation = self.control.context_generations.get(frame.context_id)
            # Fillers are the only speech kept out of conversation history.
            self._context_filler = not frame.append_to_context
        self._boundary(frame, "queue_reached")

    async def push_frame(
        self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM
    ) -> None:
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TTSTextFrame):
                generation = self.control.context_generations.get(frame.context_id)
                if generation is not None and generation != self.control.generation:
                    return
                if generation is not None and frame.append_to_context:
                    # The text follows all of this reply's paced audio. Normal
                    # completed history remains the assistant aggregator's job.
                    self.speech_history.complete(generation)
            self._boundary(frame, "forwarded")
            if isinstance(frame, TTSStoppedFrame):
                # This marker has passed the paced audio queue. Closing on
                # receipt in process_frame() would cut off its queued tail.
                self.playback_budget.close(frame.context_id)
                generation = self.control.context_generations.get(frame.context_id)
                if generation is not None and generation == self.control.generation:
                    # A filler plays before its turn's reply, which finishes the response.
                    filler = frame.context_id == self._context_id and self._context_filler
                    kind = "filler_finished" if filler else "assistant_response_finished"
                    self.owner.notify({"type": kind, "generation": generation})
        await super().push_frame(frame, direction)

    async def _pace(self) -> None:
        now = time.monotonic()
        if self._deadline is None:
            self._deadline = now
        elif now - self._deadline > FRAME_SECONDS:
            # Resume from the current clock after a missed tick instead of
            # replaying an accumulated burst of overdue media writes.
            self._deadline = now
            self.record["cadence_resets"] += 1
        self._deadline += FRAME_SECONDS
        try:
            await asyncio.sleep(max(0, self._deadline - time.monotonic()))
        except asyncio.CancelledError:
            self.record["cancelled_ticks"] += 1
            raise
        self.record["completed_ticks"] += 1

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        if (
            frame.sample_rate != SAMPLE_RATE
            or frame.num_channels != 1
            or len(frame.audio) != FRAME_BYTES
        ):
            raise ValueError("Native output expects complete 40 ms mono PCM48k frames")
        current = self.control.generation
        speech = isinstance(frame, TTSAudioRawFrame)
        audio = frame.audio
        generation = current
        valid = True
        context_id = None
        filler = False
        if speech:
            context_id = getattr(frame, "context_id", None) or self._context_id
            generation = self.control.context_generations.get(context_id)
            if generation is None and context_id == self._context_id:
                generation = self._context_generation
            filler = context_id == self._context_id and self._context_filler
            if generation is None:
                self.record["unknown_generation_speech_chunks_dropped"] += 1
                valid = False
            elif generation != current:
                self.record["stale_speech_chunks_dropped"] += 1
                valid = False
            if not valid:
                audio = SILENCE
                generation = current
        else:
            self.record["idle_silence_chunks"] += 1

        try:
            self.record["attempted_chunks"] += 1
            accepted = bool(self.owner.publish_pcm(audio, generation))
            nonzero = any(audio)
            if accepted:
                self.record["accepted_chunks"] += 1
                self.record["accepted_pcm_bytes"] += len(audio)
                self.record["accepted_speech_chunks"] += int(speech and valid)
                self.record["accepted_nonzero_chunks"] += int(nonzero)
                self.record["last_accepted_at_output_ms"] = self._now()
                if speech and valid and not filler:
                    # A filler is not part of the reply whose spoken prefix this estimates.
                    self.speech_history.sent(generation, FRAME_SECONDS)
                if speech and valid and nonzero:
                    # The browser unmutes on the first audio of a generation. A
                    # filler and its turn's reply each report their own start.
                    if (generation, filler) != self._started:
                        self._started = (generation, filler)
                        first = self.record["first_audio_by_generation"]
                        first.setdefault(str(generation), self._now())
                        if len(first) > 24:
                            del first[next(iter(first))]
                        self.owner.notify({"type": "audio_started", "generation": generation})
            elif speech and valid:
                self.record["unavailable_speech_chunks"] += 1
                if generation != self._unavailable_generation:
                    self._unavailable_generation = generation
                    self.owner.notify({"type": "output_unavailable", "generation": generation})
            else:
                # Output callbacks may attach after the actual pipeline starts.
                self.record["not_ready_silence_chunks"] += 1
            await self._pace()
            # Invalid speech was replaced with current-generation silence for the
            # media clock, but must not be forwarded as successfully written speech.
            return accepted and valid
        finally:
            if speech:
                self.playback_budget.consumed(context_id)

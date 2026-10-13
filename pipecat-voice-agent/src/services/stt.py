"""Pipecat's input queue with a byte budget for audio awaiting Flux."""

import asyncio

from pipecat.frames.frames import InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from services.flux import MAX_AUDIO_CHUNK_BYTES, SAMPLE_RATE

MAX_PENDING_AUDIO_BYTES = 128_000  # Four seconds of 16 kHz mono PCM16.
DRAIN_BATCH_FRAMES = 8


class AudioInputBacklog(BufferError):
    """The recognizer input queue reached its application memory limit."""


class FluxInput(FrameProcessor):
    def __init__(self, flux, stats, control):
        super().__init__(name="NativeFluxAudioInput")
        self.flux, self.stats, self.control = flux, stats, control
        self.pending_bytes = 0
        self._drained_frames = 0
        self._closed = False

    async def queue_audio(self, pcm):
        if self._closed:
            raise RuntimeError("Audio input is closed")
        if not isinstance(pcm, bytes) or len(pcm) % 2 or len(pcm) > MAX_AUDIO_CHUNK_BYTES:
            raise ValueError("Expected a bounded, aligned mono PCM16 chunk")
        if not pcm:
            return
        if self.pending_bytes + len(pcm) > MAX_PENDING_AUDIO_BYTES:
            raise AudioInputBacklog("Recognizer input queue is full")
        frame = InputAudioRawFrame(audio=pcm, sample_rate=SAMPLE_RATE, num_channels=1)
        self.pending_bytes += len(pcm)
        try:
            # Use the processor's existing queue. Completion, not elapsed wall
            # time, releases the budget; delayed delivery can drain normally.
            await self.queue_frame(frame, callback=self._consumed)
        except BaseException:
            self.pending_bytes -= len(pcm)
            raise

    async def _consumed(self, _processor, frame, _direction):
        self.pending_bytes -= len(frame.audio)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            if frame.sample_rate != SAMPLE_RATE or frame.num_channels != 1:
                raise ValueError("Flux input requires 16 kHz mono PCM16")
            self.flux.send_audio(frame.audio)
            record = self.stats["pipeline"]
            record["input_frames"] += 1
            record["input_bytes"] += len(frame.audio)
            record["input_while_llm_pending"] += int(self.control.llm_pending)
            record["input_while_tts_pending"] += int(self.control.tts_pending)
            self._drained_frames += 1
            if self._drained_frames >= DRAIN_BATCH_FRAMES:
                self._drained_frames = 0
                # A positive sleep gives timers and incoming requests a turn
                # even while Pipecat's queue still contains buffered audio.
                await asyncio.sleep(0.001)
            # Flux supplies transcripts and turn events. With external turn
            # detection and no local VAD, raw PCM ends here instead of building
            # up in additional LLM/TTS/output queues.
            return
        await self.push_frame(frame, direction)

    async def cleanup(self):
        self._closed = True
        await super().cleanup()
        self.pending_bytes = 0

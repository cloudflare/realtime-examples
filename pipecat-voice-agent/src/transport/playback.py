"""Limit speech queued ahead of the paced output, without another audio queue."""

import asyncio

SAMPLE_RATE = 48000
FRAME_MS = 40
FRAME_SECONDS = FRAME_MS / 1000
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2
MAX_AUDIO_AHEAD_MS = 200


class PlaybackBudget:
    """One producer per speech context; each consumed PCM frame returns a slot."""

    def __init__(self):
        self._contexts: dict[str, asyncio.BoundedSemaphore] = {}

    def open(self, context_id: str):
        if context_id not in self._contexts:
            self._contexts[context_id] = asyncio.BoundedSemaphore(MAX_AUDIO_AHEAD_MS // FRAME_MS)

    async def reserve(self, context_id: str):
        slots = self._contexts.get(context_id)
        if slots is None:
            raise asyncio.CancelledError()
        await slots.acquire()
        if self._contexts.get(context_id) is not slots:
            raise asyncio.CancelledError()

    def consumed(self, context_id: str | None):
        slots = self._contexts.get(context_id)
        if slots is not None:
            slots.release()

    def close(self, context_id: str | None):
        slots = self._contexts.pop(context_id, None)
        if slots is not None and slots.locked():
            # Wake a producer that cannot finish because its queued audio was
            # discarded. It checks context identity before producing again.
            slots.release()

    def clear(self):
        for context_id in list(self._contexts):
            self.close(context_id)

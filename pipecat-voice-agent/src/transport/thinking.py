"""Quiet keyboard typing under the wait for a lookup.

The sound plays only on idle output ticks: after a lookup has run for a short
grace period, once any filler phrase has finished, and until the reply starts.
The loop is a public-domain recording (see NOTICE.md); any mono PCM16 48 kHz
WAV can replace it.
"""

import wave
from functools import cache
from pathlib import Path

import numpy as np

from transport.playback import SAMPLE_RATE

CLIP = Path(__file__).with_name("keyboard-typing.wav")
# Level of the loudest keystroke, as a share of full scale.
# Set it to 0 to turn the sound off.
VOLUME = 0.24
# Fast lookups finish inside this window and stay silent.
GRACE_SECONDS = 0.5
FADE_SECONDS = 0.25
# A safety stop if a reply never arrives.
MAX_SECONDS = 30


@cache
def keyboard_loop():
    """Returns the recorded typing loop as mono PCM16 at 48 kHz."""
    with wave.open(str(CLIP)) as clip:
        if (clip.getnchannels(), clip.getsampwidth(), clip.getframerate()) != (1, 2, SAMPLE_RATE):
            raise ValueError(f"{CLIP.name} must be mono PCM16 at {SAMPLE_RATE} Hz")
        return clip.readframes(clip.getnframes())


class ThinkingSound:
    """Decides, one idle tick at a time, whether to play typing."""

    def __init__(self, clip=None, *, quiet_tools=frozenset(), volume=VOLUME):
        clip = keyboard_loop() if clip is None else clip
        self._clip = np.frombuffer(clip, dtype="<i2").astype(np.float32) * (volume / 32767)
        self._quiet_tools = quiet_tools
        self._volume = volume
        self._position = 0
        self._gain = 0.0
        self._generation = None
        self._since = 0.0
        self._running = set()

    def tool_started(self, tool_call_id, name, generation, now):
        if name in self._quiet_tools:
            return
        if generation != self._generation:
            self._generation, self._since, self._running = generation, now, set()
        self._running.add(tool_call_id)

    def tool_finished(self, tool_call_id):
        self._running.discard(tool_call_id)

    def reply_started(self, generation):
        # Speech while lookups still run, such as a preamble, only pauses typing.
        if generation == self._generation and not self._running:
            self._generation = None

    def fill(self, audio, generation, now):
        """Returns the idle chunk with typing mixed in, or unchanged when quiet."""
        elapsed = now - self._since
        if generation != self._generation or elapsed >= MAX_SECONDS:
            self._generation = None
        if self._generation is None or elapsed < GRACE_SECONDS or not self._volume:
            # Speech or silence cuts the sound; the next start fades in again.
            self._gain = 0.0
            return audio
        samples = len(audio) // 2
        step = samples / (FADE_SECONDS * SAMPLE_RATE)
        gains = np.linspace(self._gain, min(1.0, self._gain + step), samples, dtype=np.float32)
        self._gain = float(gains[-1])
        indices = np.arange(self._position, self._position + samples) % len(self._clip)
        self._position = (self._position + samples) % len(self._clip)
        mixed = np.frombuffer(audio, dtype="<i2") + self._clip[indices] * gains * 32767
        return np.clip(mixed, -32768, 32767).astype("<i2").tobytes()

import numpy as np

from transport.thinking import GRACE_SECONDS, ThinkingSound

TICK = bytes(3840)  # One idle 40 ms output chunk.


def typed(sound, generation, now):
    return sound.fill(TICK, generation, now) is not TICK


def test_typing_waits_for_slow_lookups_and_stops_at_the_reply():
    sound = ThinkingSound(quiet_tools={"get_current_time"})
    sound.tool_started("clock", "get_current_time", 1, 0.0)
    assert not typed(sound, 1, 5.0)
    sound.tool_started("search", "search_web", 1, 0.0)
    assert not typed(sound, 1, GRACE_SECONDS / 2)
    assert typed(sound, 1, GRACE_SECONDS)
    # Speech while the lookup still runs, such as a preamble, only pauses typing.
    sound.reply_started(1)
    assert typed(sound, 1, 1.0)
    sound.tool_finished("search")
    sound.reply_started(1)
    assert not typed(sound, 1, 1.1)
    # A new user turn stops a pending lookup's typing.
    sound.tool_started("again", "search_web", 2, 2.0)
    assert not typed(sound, 3, 3.0)


def test_typing_fades_in():
    loud = (np.full(4800, 32767, dtype="<i2")).tobytes()
    sound = ThinkingSound(loud, volume=0.5)
    sound.tool_started("search", "search_web", 1, 0.0)
    first = np.frombuffer(sound.fill(TICK, 1, 1.0), dtype="<i2")
    second = np.frombuffer(sound.fill(TICK, 1, 1.04), dtype="<i2")
    assert first[0] == 0 and first[-1] < second[-1] < 0.5 * 32767

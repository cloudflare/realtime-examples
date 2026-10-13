from agent.fillers import GENERIC, PHRASES, Fillers
from services.docs import DOCS_TOOL
from services.web_search import WEB_SEARCH_TOOL


def test_one_filler_per_turn_matches_its_lookups():
    fillers = Fillers()
    assert fillers.pick(1, [DOCS_TOOL]) in PHRASES[DOCS_TOOL]
    # A follow-up lookup in the same turn stays quiet.
    assert fillers.pick(1, [DOCS_TOOL]) is None
    weather = ["get_current_weather", "get_current_weather"]
    assert fillers.pick(2, weather) in PHRASES["get_current_weather"]
    assert fillers.pick(3, ["get_current_weather", WEB_SEARCH_TOOL]) in GENERIC
    assert fillers.pick(4, ["new_tool"]) in GENERIC


def test_time_lookups_stay_quiet_without_using_the_turns_filler():
    fillers = Fillers()
    assert fillers.pick(1, ["get_current_time"]) is None
    assert fillers.pick(1, ["get_current_time", WEB_SEARCH_TOOL]) in PHRASES[WEB_SEARCH_TOOL]


def test_fillers_vary_without_repeating_back_to_back():
    fillers = Fillers()
    picks = [fillers.pick(generation, [WEB_SEARCH_TOOL]) for generation in range(200)]
    assert all(previous != current for previous, current in zip(picks, picks[1:]))
    assert set(picks) == set(PHRASES[WEB_SEARCH_TOOL])
    # The reply waits for a filler that is still playing.
    phrases = [phrase for options in (*PHRASES.values(), GENERIC) for phrase in options]
    assert all(len(phrase.split()) <= 8 and phrase.isascii() for phrase in phrases)

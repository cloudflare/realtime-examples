from pipecat.processors.aggregators.llm_context import LLMContext

from agent.speech_history import SpeechHistory

TEXT = " ".join(f"word{index}" for index in range(30))


def context():
    return LLMContext(messages=[{"role": "user", "content": "Tell me something."}])


def estimated_prefix(messages):
    assert messages[-2]["role"] == "assistant"
    assert "the cutoff is approximate" in messages[-1]["content"]
    return messages[-2]["content"]


def test_completed_replies_adjust_rate_but_interrupted_and_stale_replies_do_not():
    history = SpeechHistory()
    messages = context()
    history.start(messages, 1)
    history.set_text(1, TEXT)
    history.sent(1, 15)  # Thirty words over fifteen seconds: a slower voice.
    history.complete(1)
    history.interrupt(1)
    assert len(messages.get_messages()) == 1  # Normal history belongs to Pipecat.

    history.start(messages, 2)
    history.set_text(2, TEXT)
    history.sent(1, 100)  # Late audio from the completed generation.
    history.sent(2, 8)
    history.complete(1)
    history.interrupt(1)
    history.interrupt(2)
    first_prefix = estimated_prefix(messages.get_messages())
    assert first_prefix == " ".join(f"word{index}" for index in range(18))

    history.start(messages, 3)
    history.set_text(3, TEXT)
    history.sent(3, 8)
    history.interrupt(3)
    assert estimated_prefix(messages.get_messages()) == first_prefix
    history.interrupt(3)
    assert len(messages.get_messages()) == 5


def test_interruption_note_stays_after_tool_results_and_before_next_user_transcript():
    history = SpeechHistory()
    messages = context()
    history.start(messages, 0)
    date = {"role": "user", "content": "<runtime_context>\nCurrent local date: 2026-10-07"}
    call = {"role": "assistant", "tool_calls": [{"id": "lookup"}]}
    result = {"role": "tool", "tool_call_id": "lookup", "content": "Sunny"}
    question = {"role": "user", "content": "Tell me about planets instead."}
    messages.add_messages([date, call, result, question])
    history.set_text(0, "It is sunny today with some clouds expected later.")
    history.sent(0, 2)
    history.interrupt(0)
    stored = messages.get_messages()
    assert stored[1:4] == [date, call, result]
    assert stored[4] == {"role": "assistant", "content": "It is sunny today"}
    assert "estimated spoken prefix" in stored[5]["content"]
    assert stored[6] == question


def test_unusually_fast_estimate_never_labels_the_entire_interrupted_reply_as_spoken():
    history = SpeechHistory()
    messages = context()
    history.interrupt(0)  # The first user turn has no previous response.
    assert len(messages.get_messages()) == 1
    history.start(messages, 1)
    history.set_text(1, "Keep café names intact.")
    history.sent(1, 100)
    history.interrupt(1)
    assert estimated_prefix(messages.get_messages()) == "Keep café names"

import pytest

from services.models import TextReply, get_model


def completion(*, content="Hello.", finish_reason="stop", **message):
    return {
        "choices": [
            {
                "finish_reason": finish_reason,
                "message": {"role": "assistant", "content": content, **message},
            }
        ]
    }


def test_chat_completion_speech_uses_final_content_only():
    model = get_model("@cf/google/gemma-4-26b-a4b-it")
    text = "A complete answer with more detail. " * 40
    response = completion(content=text, reasoning_content="This separate field is not speech.")
    assert model.parse_response(response) == TextReply(text.strip())
    with pytest.raises(ValueError, match="empty reply"):
        model.parse_response(completion(content=None, reasoning_content="No final answer."))


@pytest.mark.parametrize("finish_reason", ["length", "content_filter"])
def test_incomplete_completion_cannot_execute_a_tool(finish_reason):
    model = get_model("@cf/google/gemma-4-26b-a4b-it")
    response = completion(
        content=None,
        finish_reason=finish_reason,
        tool_calls=[
            {
                "id": "incomplete",
                "function": {"name": "get_current_weather", "arguments": '{"location":'},
            }
        ],
    )
    with pytest.raises(ValueError, match="Incomplete model reply"):
        model.parse_response(response)

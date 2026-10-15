import json
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

from conftest import Request

from entry import Default
from server import observability

CALL = "b" * 32


def records(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_log_fields_exclude_conversation_credentials_and_exception_payloads(capsys):
    observability.log.bind(call_id=CALL, transcript="private-transcript").info(
        "operation_finished",
        operation="agent_prepare",
        elapsed_ms=12.5,
        headers={"Authorization": "Bearer private-token"},
        error_code="https://example.test?token=private-token",
    )
    observability.log.info("private transcript: do not emit arbitrary messages")
    observability.logger.info("unbound_log")
    assert records(capsys) == [
        {
            "event": "operation_finished",
            "level": "info",
            "call_id": CALL,
            "operation": "agent_prepare",
            "elapsed_ms": 12.5,
        }
    ]

    try:
        raise RuntimeError("internal error; reference = " + "a" * 32 + "; token=private-token")
    except RuntimeError as exc:
        request_id = observability.failure("request_failed", exc, call_id=CALL)
    (row,) = records(capsys)
    assert re.fullmatch(r"[a-f0-9]{32}", request_id)
    assert row["request_id"] == request_id
    assert row["error_category"] == "internal"
    assert row["error_type"] == "RuntimeError"
    assert row["error_reference"] == "a" * 32
    assert row["error_location"].startswith("test_observability.py:")
    assert "private-token" not in json.dumps(row)


async def test_unexpected_failure_correlates_the_503_with_its_safe_log(
    ctx, env, owner_cookie, capsys
):
    stub = SimpleNamespace(fetch=AsyncMock(side_effect=RuntimeError("private-transcript")))
    env.CALLS = SimpleNamespace(getByName=lambda _: stub)
    response = await Default(ctx, env).fetch(
        Request(f"/api/calls/{CALL}/events?after=29", cookie=owner_cookie)
    )
    (row,) = records(capsys)
    assert response.status == 503
    assert response.data["error"] == "service_unavailable"
    assert row["request_id"] == response.data["request_id"]
    assert row["call_id"] == CALL
    assert row["operation"] == "events"
    assert row["scope"] == "entrypoint"
    assert row["status"] == response.status
    assert "private-transcript" not in json.dumps([row, response.data])

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from agent.tools import build_tools
from services import web_search


def binding_response(body, status=200):
    reader = SimpleNamespace(
        read=AsyncMock(
            side_effect=[
                SimpleNamespace(done=False, value=SimpleNamespace(to_bytes=lambda: body)),
                SimpleNamespace(done=True),
            ]
        ),
        cancel=AsyncMock(),
        releaseLock=Mock(),
    )
    response = SimpleNamespace(status=status, body=SimpleNamespace(getReader=lambda: reader))
    return SimpleNamespace(websearch=AsyncMock(return_value=response)), reader


async def test_web_tool_uses_server_configuration_and_bounds_public_sources(monkeypatch):
    monkeypatch.setattr("agent.tools.WEB_SEARCH_PROVIDER", "linkup")
    monkeypatch.setattr("agent.tools.WEB_SEARCH_GATEWAY_ID", "test-gateway")
    items = [
        {"url": "javascript:alert(1)", "title": "unsafe"},
        {"url": "https://user:password@example.com/", "title": "credentials"},
        {"url": "https://example.com:8443/", "title": "nonstandard port"},
        *[
            {
                "url": f"https://www.nasa.gov/{i}/",
                "title": "NASA &amp; Artemis",
                "description": "文" * 8000,
            }
            for i in (1, 1, 2, 3)
        ],
    ]
    ai, reader = binding_response(json.dumps({"items": items}).encode())
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append, ai=ai) if tool.name == "search_web")
    await tool.handler(
        SimpleNamespace(
            tool_call_id="search", arguments={"query": "NASA Artemis"}, result_callback=callback
        )
    )
    ai.websearch.assert_awaited_once_with(
        {"gatewayId": "test-gateway", "provider": "linkup", "query": "NASA Artemis", "limit": 3}
    )
    result = callback.call_args.args[0]
    assert result["status"] == "found" and len(result["sources"]) == 3
    assert len(json.dumps(result)) <= web_search.MAX_RESULT_CHARS
    assert [source["url"] for source in result["sources"]] == [
        f"https://www.nasa.gov/{i}/" for i in (1, 2, 3)
    ]
    assert all(source["excerpt"] for source in result["sources"])
    reader.releaseLock.assert_called_once()


async def test_payment_setup_error_reaches_model_without_retry_or_upstream_details():
    ai, reader = binding_response(b"private upstream error", status=402)
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append, ai=ai) if tool.name == "search_web")
    await tool.handler(
        SimpleNamespace(
            tool_call_id="search", arguments={"query": "NASA Artemis"}, result_callback=callback
        )
    )
    result = callback.call_args.args[0]
    assert result["status"] == "error" and result["code"] == "web_search_payment_required"
    assert "AI Gateway credits" in result["error"] and "provider key" in result["error"]
    assert "Retrying" in result["error"] and "private upstream" not in result["error"]
    assert events[-1]["type"] == "tool_failed"
    ai.websearch.assert_awaited_once()
    reader.cancel.assert_awaited_once()
    reader.releaseLock.assert_called_once()

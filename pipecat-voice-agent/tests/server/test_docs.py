import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx2
import pytest
from pydantic import ValidationError

from agent.tools import build_tools
from services import docs

SOURCE = {
    "title": "Cloudflare Realtime · café",
    "url": "https://developers.cloudflare.com/realtime/sfu/",
    "text": "The WebSocket adapter carries 48 kHz stereo PCM audio.",
}
QUERY = docs.DocsArguments(query="SFU WebSocket adapter audio format")


def reply(*, result=None, request_id=1):
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result
            if result is not None
            else {"content": [], "structuredContent": {"results": [SOURCE]}},
        },
        ensure_ascii=False,
    ).encode()


class Chunks(httpx2.AsyncByteStream):
    def __init__(self, body):
        self.body = body
        self.closed = False

    async def __aiter__(self):
        # Split UTF-8 characters and SSE delimiters across transport chunks.
        for byte in self.body:
            yield bytes([byte])

    async def aclose(self):
        self.closed = True


class PendingBody(httpx2.AsyncByteStream):
    def __init__(self):
        self.started = asyncio.Event()
        self.closed = False

    async def __aiter__(self):
        self.started.set()
        await asyncio.Event().wait()
        yield b""

    async def aclose(self):
        self.closed = True


def mock_client(monkeypatch, response):
    clients, requests = [], []
    original = httpx2.AsyncClient

    def receive(request):
        requests.append(request)
        return response

    def factory(**kwargs):
        client = original(transport=httpx2.MockTransport(receive), **kwargs)
        clients.append(client)
        return client

    monkeypatch.setattr(docs.httpx2, "AsyncClient", factory)
    return clients, requests


@pytest.mark.parametrize(
    ("mime", "records"),
    [("application/json", [SOURCE]), ("text/event-stream", [SOURCE]), ("application/json", [])],
)
async def test_docs_search_accepts_fragmented_json_and_sse(monkeypatch, mime, records):
    body = reply(result={"content": [], "structuredContent": {"results": records}})
    if mime == "text/event-stream":
        notification = b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
        body = notification + b"event: message\ndata: " + body + b"\n\n"
    stream = Chunks(body)
    response = httpx2.Response(200, headers={"content-type": mime}, stream=stream)
    clients, requests = mock_client(monkeypatch, response)

    result = await docs.search_docs(QUERY)

    if records:
        assert result == {
            "status": "found",
            "query": QUERY.query,
            "sources": [
                {"title": SOURCE["title"], "url": SOURCE["url"], "excerpt": SOURCE["text"]}
            ],
        }
    else:
        assert result == {"status": "empty", "query": QUERY.query}
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == docs.ENDPOINT and request.method == "POST"
    assert "authorization" not in request.headers
    assert request.headers["mcp-protocol-version"] == "2025-06-18"
    assert json.loads(request.content) == {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": docs.DOCS_TOOL, "arguments": {"query": QUERY.query}},
    }
    assert stream.closed and response.is_closed and clients[0].is_closed
    assert not clients[0].follow_redirects


@pytest.mark.parametrize(
    ("status", "mime", "body", "code"),
    [
        (503, "application/json", b"{}", "docs_http_503"),
        (302, "application/json", b"{}", "docs_http_302"),
        (200, "text/html", b"<html>Login</html>", "docs_content_type"),
        (200, "application/json", b"broken JSON", "docs_protocol"),
        (200, "application/json", reply(request_id=2), "docs_request_id"),
        (
            200,
            "application/json",
            b'{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"failed"}}',
            "docs_rpc_error",
        ),
        (
            200,
            "application/json",
            reply(result={"content": [], "isError": True}),
            "docs_tool_error",
        ),
        (200, "application/json", reply(result={"content": []}), "docs_protocol"),
        (200, "text/event-stream", b"", "docs_empty_response"),
        (200, "application/json", b" " * (docs.MAX_RESPONSE_BYTES + 1), "docs_response_too_large"),
        (
            200,
            "text/event-stream",
            b"data: " + b"x" * (docs.MAX_RESPONSE_BYTES + 1) + b"\n\n",
            "docs_sse_error",
        ),
        (200, "text/event-stream", b"event: ping\ndata: {}\n\n" * 17, "docs_event_limit"),
    ],
)
async def test_docs_failures_are_bounded_and_close_http(monkeypatch, status, mime, body, code):
    response = httpx2.Response(status, headers={"content-type": mime}, content=body)
    clients, requests = mock_client(monkeypatch, response)
    with pytest.raises(docs.DocsUnavailable) as error:
        await docs.search_docs(QUERY)
    assert error.value.code == code
    assert len(requests) == 1
    assert response.is_closed and clients[0].is_closed


async def test_docs_result_keeps_unique_trusted_sources_within_context_budget(monkeypatch):
    records = [
        {**SOURCE, "url": "https://developers.cloudflare.com@other.example/"},
        {**SOURCE, "url": "javascript:alert(1)"},
        {**SOURCE, "url": "https://developers.cloudflare.com:8443/"},
        *[
            {**SOURCE, "title": "文" * 160, "text": "文" * 3000, "url": SOURCE["url"] + str(i)}
            for i in range(5)
            for _ in range(2)
        ],
    ]
    response = httpx2.Response(
        200,
        headers={"content-type": "application/json"},
        content=reply(result={"content": [], "structuredContent": {"results": records}}),
    )
    mock_client(monkeypatch, response)
    result = await docs.search_docs(QUERY)
    assert len(result["sources"]) == 5
    assert [source["url"] for source in result["sources"]] == [
        SOURCE["url"] + str(i) for i in range(5)
    ]
    assert len(json.dumps(result)) <= docs.MAX_RESULT_CHARS
    assert all(source["excerpt"] for source in result["sources"])


def test_docs_packing_preserves_product_page_and_distinct_matching_passages():
    records = [
        {
            "title": "Media updates",
            "url": f"https://developers.cloudflare.com/changelog/{i}/",
            "text": "A collection of release notes. " * 80,
        }
        for i in range(5)
    ]
    records.extend(
        [
            {**SOURCE, "text": "WebRTC media routing. " * 100},
            {**SOURCE, "text": "WebSocket adapters carry PCM audio. " * 100},
        ]
    )
    result = docs._compact_result(
        docs.CallToolResult.model_validate(
            {"content": [], "structuredContent": {"results": records}}
        ),
        QUERY.query,
    )
    product = result["sources"][0]
    assert product["url"] == SOURCE["url"]
    assert "WebRTC media routing" in product["excerpt"]
    assert "WebSocket adapters" in product["excerpt"]
    assert len({source["url"] for source in result["sources"]}) == len(result["sources"])
    assert len(json.dumps(result)) <= docs.MAX_RESULT_CHARS


@pytest.mark.parametrize("cancel", [True, False], ids=["interruption", "timeout"])
async def test_pending_lookup_closes_stream_and_client(monkeypatch, cancel):
    stream = PendingBody()
    response = httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)
    clients, _ = mock_client(monkeypatch, response)
    if not cancel:
        monkeypatch.setattr(docs, "DOCS_TIMEOUT_SECONDS", 0.05)
    task = asyncio.create_task(docs.search_docs(QUERY))
    await asyncio.wait_for(stream.started.wait(), 1)
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(docs.DocsUnavailable) as failure:
            await asyncio.wait_for(task, 1)
        assert failure.value.code == "docs_timeout"
    assert stream.closed and response.is_closed and clients[0].is_closed


@pytest.mark.parametrize(
    ("arguments", "failure", "code"),
    [
        ({"query": " "}, None, "invalid_arguments"),
        ({"query": QUERY.query}, docs.DocsUnavailable("docs_timeout"), "docs_timeout"),
    ],
)
async def test_docs_tool_failure_returns_a_result_without_ending_call(
    monkeypatch, arguments, failure, code
):
    lookup = AsyncMock(side_effect=failure)
    monkeypatch.setattr("agent.tools.search_docs", lookup)
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append) if tool.name == docs.DOCS_TOOL)
    await tool.handler(
        SimpleNamespace(arguments=arguments, tool_call_id="docs-1", result_callback=callback)
    )
    callback.assert_awaited_once()
    assert callback.call_args.args[0]["status"] == "error"
    assert callback.call_args.args[0]["code"] == code
    assert [event["type"] for event in events] == ["tool_started", "tool_failed"]
    assert all(event["call_id"] == "docs-1" for event in events)
    if failure is None:
        lookup.assert_not_awaited()


async def test_docs_handler_reports_lookup_cancellation(monkeypatch):
    started = asyncio.Event()

    async def pending(_):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr("agent.tools.search_docs", pending)
    events, callback = [], AsyncMock()
    tool = next(tool for tool in build_tools(events.append) if tool.name == docs.DOCS_TOOL)
    task = asyncio.create_task(
        tool.handler(
            SimpleNamespace(
                arguments=QUERY.model_dump(), tool_call_id="docs-1", result_callback=callback
            )
        )
    )
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    callback.assert_not_awaited()
    assert [event["type"] for event in events] == ["tool_started", "tool_cancelled"]


@pytest.mark.parametrize(
    "arguments",
    [{"query": 123}, {"query": "x" * 501}, {"query": "test", "url": "https://example.com"}],
)
def test_docs_arguments_reject_invalid_queries_and_endpoint_overrides(arguments):
    with pytest.raises(ValidationError):
        docs.DocsArguments.model_validate(arguments)

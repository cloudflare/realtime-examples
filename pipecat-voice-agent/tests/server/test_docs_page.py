import asyncio
import json

import httpx2
import pytest
from pydantic import ValidationError

from services import docs_page
from services.docs import DocsUnavailable

URL = "https://developers.cloudflare.com/realtime/sfu/"
MARKDOWN = "---\ntitle: SFU\n---\n# Realtime SFU\nOverview.\n## Audio\n48 kHz stereo PCM.\n```python\n# Not a heading\n```\n## Recovery\nReconnect instructions.\n"


def client(monkeypatch, handler):
    original = httpx2.AsyncClient
    monkeypatch.setattr(
        docs_page.httpx2,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx2.MockTransport(handler), **kwargs),
    )


async def test_page_redirect_preserves_origin_and_extracts_the_requested_section(monkeypatch):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        if len(requests) == 1:
            return httpx2.Response(301, headers={"location": "/realtime/sfu/"})
        return httpx2.Response(200, text=MARKDOWN, headers={"content-type": "text/markdown"})

    client(monkeypatch, respond)
    result = await docs_page.read_docs_page(
        docs_page.ReadDocsArguments(url="https://developers.cloudflare.com/old/#audio")
    )
    assert requests == ["https://developers.cloudflare.com/old/index.md", URL + "index.md"]
    assert result["status"] == "found"
    source = result["sources"][0]
    assert source["url"] == URL and source["title"] == "Realtime SFU"
    assert "48 kHz stereo" in source["excerpt"]
    assert (
        "Not a heading" in source["excerpt"] and "Reconnect instructions" not in source["excerpt"]
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://developers.cloudflare.com/",
        "https://developers.cloudflare.com@evil.example/",
        "https://developers.cloudflare.com:8443/",
        "https://user@developers.cloudflare.com/",
        "https://developers.cloudflare.com/?url=elsewhere",
    ],
)
def test_page_url_is_not_an_arbitrary_fetch_target(url):
    with pytest.raises(ValidationError):
        docs_page.ReadDocsArguments(url=url)


async def test_external_redirect_is_rejected_before_a_second_request(monkeypatch):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx2.Response(302, headers={"location": "https://another.example/"})

    client(monkeypatch, respond)
    with pytest.raises(DocsUnavailable):
        await docs_page.read_docs_page(docs_page.ReadDocsArguments(url=URL))
    assert len(requests) == 1


def test_missing_headings_and_large_unicode_excerpts_do_not_misrepresent_page_content():
    missing = docs_page._page_result(MARKDOWN, URL, "Absent")
    assert missing["status"] == "empty"
    assert missing["available_sections"] == ["Realtime SFU", "Audio", "Recovery"]
    found = docs_page._page_result("# Realtime SFU\n" + "文" * 12000, URL, "")
    assert found["truncated"] and len(json.dumps(found)) <= 6000
    assert found["sources"][0]["excerpt"]


async def test_page_cancellation_closes_a_pending_body(monkeypatch):
    started = asyncio.Event()

    class Pending(httpx2.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            started.set()
            await asyncio.Event().wait()
            yield b""

        async def aclose(self):
            self.closed = True

    stream = Pending()
    client(
        monkeypatch,
        lambda _: httpx2.Response(200, headers={"content-type": "text/markdown"}, stream=stream),
    )
    task = asyncio.create_task(docs_page.read_docs_page(docs_page.ReadDocsArguments(url=URL)))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert stream.closed


async def test_page_response_byte_limit_is_enforced(monkeypatch):
    response = httpx2.Response(
        200,
        headers={"content-type": "text/markdown"},
        content=b"x" * (docs_page.MAX_PAGE_BYTES + 1),
    )
    client(monkeypatch, lambda _: response)
    with pytest.raises(DocsUnavailable):
        await docs_page.read_docs_page(docs_page.ReadDocsArguments(url=URL))
    assert response.is_closed

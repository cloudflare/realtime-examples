"""Bounded web lookups through the native Workers AI binding and AI Gateway."""

import asyncio
import html
import json

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, TypeAdapter, ValidationError

from services.http import LookupUnavailable

WEB_SEARCH_TOOL = "search_web"
WEB_SEARCH_TIMEOUT_SECONDS = 8
MAX_RESPONSE_BYTES = 262144
MAX_RESULT_CHARS = 6000
MAX_SOURCES = 3
_url = TypeAdapter(HttpUrl)


class WebSearchArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    query: str = Field(min_length=3, max_length=500, description="Focused web search keywords.")


class WebSearchUnavailable(LookupUnavailable):
    def __init__(self, code):
        super().__init__(
            code,
            (
                "Web search is unavailable because AI Gateway requires payment setup. "
                "Tell the user that the app owner needs to check AI Gateway credits or "
                "configure a provider key on the selected Gateway. Retrying this search "
                "will not resolve the setup issue."
                if code == "web_search_payment_required"
                else "Web search could not be completed. The requested information has not been verified."
            ),
        )


class _Item(BaseModel):
    model_config = ConfigDict(strict=True)
    title: str = ""
    url: str
    description: str = ""


class _Results(BaseModel):
    items: list[_Item] = Field(max_length=10)


def _compact(results: _Results, query: str):
    sources = []
    seen = set()
    for item in results.items:
        try:
            url = _url.validate_python(item.url)
        except ValidationError:
            continue
        if url.scheme != "https" or url.username or url.password or url.port != 443:
            continue
        address = str(url)
        if len(address) > 2048 or address in seen:
            continue
        seen.add(address)
        sources.append(
            {
                "title": html.unescape(item.title).strip()[:160] or url.host,
                "url": address,
                "excerpt": html.unescape(item.description).strip()[:1200],
            }
        )
        if len(sources) == MAX_SOURCES:
            break
    if not sources:
        return {"status": "empty", "query": query}
    result = {"status": "found", "query": query, "sources": sources}
    # These excerpts enter the LLM's existing context, including JSON escaping.
    while len(json.dumps(result)) > MAX_RESULT_CHARS:
        longest = max(sources, key=lambda source: len(json.dumps(source["excerpt"])))
        if longest["excerpt"]:
            longest["excerpt"] = longest["excerpt"][: len(longest["excerpt"]) // 2]
        elif len(sources) > 1:
            sources.pop()
        else:
            raise WebSearchUnavailable("web_search_result_too_large")
    return result


async def _read_response(response):
    reader = response.body.getReader() if response.body is not None else None
    exhausted = False
    try:
        if response.status == 402:
            raise WebSearchUnavailable("web_search_payment_required")
        if response.status != 200:
            raise WebSearchUnavailable(f"web_search_http_{response.status}")
        if reader is None:
            raise WebSearchUnavailable("web_search_protocol")
        body = bytearray()
        while True:
            part = await reader.read()
            if part.done:
                exhausted = True
                break
            chunk = part.value.to_bytes()
            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                raise WebSearchUnavailable("web_search_response_too_large")
            body.extend(chunk)
        return _Results.model_validate_json(body)
    finally:
        if reader is not None:
            try:
                if not exhausted:
                    await asyncio.wait_for(reader.cancel(), timeout=1)
            finally:
                reader.releaseLock()


async def search_web(arguments: WebSearchArguments, *, ai, provider: str, gateway_id: str):
    try:
        async with asyncio.timeout(WEB_SEARCH_TIMEOUT_SECONDS):
            response = await ai.websearch(
                {
                    "gatewayId": gateway_id,
                    "provider": provider,
                    "query": arguments.query,
                    "limit": MAX_SOURCES,
                }
            )
            results = await _read_response(response)
        return _compact(results, arguments.query)
    except TimeoutError as exc:
        raise WebSearchUnavailable("web_search_timeout") from exc
    except ValidationError as exc:
        raise WebSearchUnavailable("web_search_protocol") from exc

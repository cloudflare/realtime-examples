"""Search the public, stateless Cloudflare Docs MCP server on demand."""

import asyncio
import json
from typing import Literal, TypedDict
from urllib.parse import urlparse

import httpx2
from mcp_types import (
    CallToolRequestParams,
    CallToolResult,
    JSONRPCError,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    jsonrpc_message_adapter,
)
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from services.http import LookupUnavailable

DOCS_TOOL = "search_cloudflare_documentation"
DOCS_TIMEOUT_SECONDS = 12
ENDPOINT = "https://docs.mcp.cloudflare.com/mcp"
MAX_RESPONSE_BYTES = 262144
MAX_RESULT_CHARS = 6000
MAX_SOURCES = 6


class DocsSource(TypedDict):
    title: str
    url: str
    excerpt: str


class DocsFound(TypedDict):
    status: Literal["found"]
    query: str
    sources: list[DocsSource]


class DocsEmpty(TypedDict):
    status: Literal["empty"]
    query: str


class DocsArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    query: str = Field(min_length=3, max_length=500)


class DocsUnavailable(LookupUnavailable):
    def __init__(self, code: str):
        super().__init__(
            code,
            "The documentation lookup could not be completed. This gives no evidence about whether the product or feature exists.",
        )


class _Document(BaseModel):
    model_config = ConfigDict(strict=True)
    title: str
    url: str = Field(max_length=2048)
    text: str


class _SearchResults(BaseModel):
    results: list[_Document]


def _excerpt(matches: list[_Document], limit: int) -> str:
    passages = list(dict.fromkeys(match.text.strip() for match in matches))[:3]
    per_passage = (limit - 2 * (len(passages) - 1)) // len(passages)
    if per_passage < 1:
        return ""
    return "\n\n".join(passage[:per_passage] for passage in passages)


def _compact_result(result: CallToolResult, query: str) -> DocsFound | DocsEmpty:
    if result.is_error:
        raise DocsUnavailable("docs_tool_error")
    documents = _SearchResults.model_validate(result.structured_content).results
    grouped: dict[str, list[_Document]] = {}
    for document in documents:
        url = urlparse(document.url)
        if (
            url.scheme != "https"
            or url.netloc != "developers.cloudflare.com"
            or not document.text.strip()
        ):
            continue
        grouped.setdefault(document.url, []).append(document)
    if not grouped:
        return {"status": "empty", "query": query}

    def is_changelog_listing(url: str) -> bool:
        path = urlparse(url).path
        return path.startswith("/changelog/") and not path.startswith("/changelog/post/")

    # Changelog listing pages repeat the same product descriptions. Prefer
    # individual pages, retaining the search engine's order within each group.
    selected = sorted(grouped, key=is_changelog_listing)[:MAX_SOURCES]
    sources: list[DocsSource] = []
    for url in selected:
        matches = grouped[url]
        sources.append(
            {
                "title": matches[0].title.strip()[:160] or "Cloudflare documentation",
                "url": url,
                "excerpt": _excerpt(matches, 1200),
            }
        )
    payload: DocsFound = {"status": "found", "query": query, "sources": sources}
    # Count JSON escaping too: these results enter the shared conversation.
    while len(json.dumps(payload)) > MAX_RESULT_CHARS:
        longest = max(sources, key=lambda item: len(json.dumps(item["excerpt"])))
        if longest["excerpt"]:
            longest["excerpt"] = _excerpt(grouped[longest["url"]], len(longest["excerpt"]) // 2)
        elif len(sources) > 1:
            sources.pop()
        else:
            raise DocsUnavailable("docs_result_too_large")
    return payload


def _decode_reply(payload: str | bytes) -> CallToolResult | None:
    reply = jsonrpc_message_adapter.validate_json(payload, by_name=False)
    if isinstance(reply, JSONRPCNotification):
        return None
    if reply.id != 1:
        raise DocsUnavailable("docs_request_id")
    if isinstance(reply, JSONRPCError):
        raise DocsUnavailable("docs_rpc_error")
    if not isinstance(reply, JSONRPCResponse):
        raise DocsUnavailable("docs_protocol")
    return CallToolResult.model_validate(reply.result)


async def _read_result(response: httpx2.Response) -> CallToolResult:
    if response.status_code != 200:
        raise DocsUnavailable(f"docs_http_{response.status_code}")
    mime = response.headers.get("content-type", "").partition(";")[0].strip().lower()
    if mime == "application/json":
        body = bytearray()
        async for chunk in response.aiter_bytes():
            if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                raise DocsUnavailable("docs_response_too_large")
            body.extend(chunk)
        result = _decode_reply(bytes(body))
        if result is not None:
            return result
    elif mime == "text/event-stream":
        count = 0
        async for event in httpx2.EventSource(response, max_event_size=MAX_RESPONSE_BYTES):
            count += 1
            if count > 16:
                raise DocsUnavailable("docs_event_limit")
            if event.event != "message" or not event.data:
                continue
            result = _decode_reply(event.data)
            if result is not None:
                return result
    else:
        raise DocsUnavailable("docs_content_type")
    raise DocsUnavailable("docs_empty_response")


async def search_docs(arguments: DocsArguments) -> DocsFound | DocsEmpty:
    # This server accepts stateless tools/call requests; no discovery, OAuth,
    # or persistent MCP session needs to delay voice-call startup.
    params = CallToolRequestParams(name=DOCS_TOOL, arguments=arguments.model_dump())
    request = JSONRPCRequest(
        jsonrpc="2.0",
        id=1,
        method="tools/call",
        params=params.model_dump(mode="json", by_alias=True, exclude_none=True),
    )
    try:
        async with asyncio.timeout(DOCS_TIMEOUT_SECONDS):
            async with httpx2.AsyncClient(
                timeout=httpx2.Timeout(6, read=DOCS_TIMEOUT_SECONDS),
                follow_redirects=False,
            ) as client:
                async with client.stream(
                    "POST",
                    ENDPOINT,
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream",
                        "MCP-Protocol-Version": "2025-06-18",
                    },
                    content=request.model_dump_json(by_alias=True, exclude_none=True),
                ) as response:
                    return _compact_result(await _read_result(response), arguments.query)
    except (TimeoutError, httpx2.TimeoutException) as exc:
        raise DocsUnavailable("docs_timeout") from exc
    except httpx2.SSEError as exc:
        raise DocsUnavailable("docs_sse_error") from exc
    except (ValidationError, ValueError) as exc:
        raise DocsUnavailable("docs_protocol") from exc
    except httpx2.HTTPError as exc:
        raise DocsUnavailable("docs_network") from exc

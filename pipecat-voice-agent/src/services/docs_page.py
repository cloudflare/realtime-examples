"""Read bounded Markdown sections from Cloudflare's public documentation."""

import asyncio
import json
import re
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpx2
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.docs import DocsUnavailable
from services.http import read_limited

READ_DOCS_TOOL = "read_cloudflare_documentation"
PAGE_TIMEOUT_SECONDS = 8
MAX_PAGE_BYTES = 262144
MAX_EXCERPT_CHARS = 3500


def canonical_url(value: str) -> str:
    url = urlsplit(value)
    if (
        url.scheme != "https"
        or url.netloc != "developers.cloudflare.com"
        or url.query
        or "\\" in value
        or any(ord(char) < 32 for char in value)
    ):
        raise ValueError("Use an HTTPS Cloudflare documentation URL without query parameters")
    path = url.path.removesuffix("index.md").rstrip("/") + "/"
    return urlunsplit((url.scheme, url.netloc, path, "", ""))


class ReadDocsArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    url: str = Field(min_length=1, max_length=2048)
    section: str = Field(
        default="",
        max_length=160,
        description="A heading or heading fragment to read. Omit for the page overview.",
    )

    @field_validator("url")
    @classmethod
    def trusted_url(cls, value):
        canonical_url(value)
        return value


def _sections(markdown):
    headings = []
    offset, fence = 0, ""
    for line in markdown.splitlines(keepends=True):
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if marker:
            found = marker[1]
            if not fence:
                fence = found
            elif found[0] == fence[0] and len(found) >= len(fence):
                fence = ""
        elif not fence and (heading := re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", line)):
            headings.append((offset, len(heading[1]), heading[2].strip("` ")))
        offset += len(line)
    return headings


def _page_result(markdown, url, section):
    # Exclude front matter from the model's excerpt.
    if markdown.startswith("---\n"):
        _, separator, body = markdown[4:].partition("\n---\n")
        if separator:
            markdown = body.lstrip()
    headings = _sections(markdown)
    title = next((name for _, level, name in headings if level == 1), "Cloudflare documentation")
    start = next((pos for pos, level, _ in headings if level == 1), 0)
    excerpt = markdown[start:]
    if section:
        wanted = section.casefold().replace("-", " ")
        match = next(
            (item for item in headings if wanted in item[2].casefold().replace("-", " ")), None
        )
        if match is None:
            return {
                "status": "empty",
                "url": url,
                "section": section,
                "available_sections": [name[:160] for _, _, name in headings][:20],
                "detail": "The page exists, but that heading was not found. Choose a listed heading or omit section.",
            }
        start, level, _ = match
        end = next(
            (pos for pos, depth, _ in headings if pos > start and depth <= level), len(markdown)
        )
        excerpt = markdown[start:end]
    if not excerpt.strip():
        raise DocsUnavailable("docs_page_empty")
    # JSON escaping can expand non-ASCII text, so budget the actual tool result.
    result = {
        "status": "found",
        "section": section,
        "truncated": len(excerpt) > MAX_EXCERPT_CHARS,
        "sources": [{"title": title[:160], "url": url, "excerpt": excerpt[:MAX_EXCERPT_CHARS]}],
    }
    while len(json.dumps(result)) > 6000:
        current = result["sources"][0]["excerpt"]
        if not current:
            raise DocsUnavailable("docs_page_result_too_large")
        result["sources"][0]["excerpt"] = current[: len(current) // 2]
        result["truncated"] = True
    return result


async def read_docs_page(arguments: ReadDocsArguments):
    url = canonical_url(arguments.url)
    section = arguments.section or unquote(urlsplit(arguments.url).fragment)[:160]
    try:
        async with asyncio.timeout(PAGE_TIMEOUT_SECONDS):
            async with httpx2.AsyncClient(
                timeout=PAGE_TIMEOUT_SECONDS, follow_redirects=False
            ) as client:
                for _ in range(3):
                    async with client.stream(
                        "GET", url + "index.md", headers={"Accept": "text/markdown"}
                    ) as response:
                        if response.is_redirect:
                            # Old documentation paths redirect. Revalidate each hop before fetching.
                            location = response.headers.get("location")
                            if not location:
                                raise DocsUnavailable("docs_page_redirect")
                            url = canonical_url(urljoin(url, location))
                            continue
                        if response.status_code != 200:
                            raise DocsUnavailable(f"docs_page_http_{response.status_code}")
                        mime = response.headers.get("content-type", "").partition(";")[0].strip()
                        if mime not in {"text/markdown", "text/plain"}:
                            raise DocsUnavailable("docs_page_content_type")
                        body = await read_limited(response, MAX_PAGE_BYTES)
                        return _page_result(body.decode("utf-8"), url, section)
                raise DocsUnavailable("docs_page_redirect_limit")
    except TimeoutError, httpx2.TimeoutException:
        raise DocsUnavailable("docs_page_timeout") from None
    except httpx2.HTTPError, ValueError:
        raise DocsUnavailable("docs_page_unavailable") from None

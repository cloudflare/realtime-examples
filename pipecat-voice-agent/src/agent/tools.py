"""Validated lookup registration; Pipecat owns execution and cancellation."""

import asyncio
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import partial

from pipecat.adapters.schemas.direct_function import tool_options
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from agent.config import WEB_SEARCH_GATEWAY_ID, WEB_SEARCH_PROVIDER
from server.observability import exception_fields, log
from services.docs import DOCS_TIMEOUT_SECONDS, DOCS_TOOL, DocsArguments, search_docs
from services.docs_page import READ_DOCS_TOOL, ReadDocsArguments, read_docs_page
from services.http import LookupUnavailable
from services.status import STATUS_TOOL, StatusArguments, cloudflare_status
from services.weather import ForecastArguments, WeatherArguments, current_weather, weather_forecast
from services.web_search import (
    WEB_SEARCH_TIMEOUT_SECONDS,
    WEB_SEARCH_TOOL,
    WebSearchArguments,
    search_web,
)


class CurrentTimeArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    utc_offset_minutes: int = Field(ge=-840, le=840)


async def current_time(arguments: CurrentTimeArguments):
    now = datetime.now(timezone(timedelta(minutes=arguments.utc_offset_minutes)))
    return {"datetime": now.isoformat(timespec="seconds"), "day_of_week": now.strftime("%A")}


@dataclass(frozen=True)
class LookupTool:
    name: str
    description: str
    arguments: type[BaseModel]
    lookup: Callable[..., Awaitable[dict]]
    timeout_seconds: float = 10


@asynccontextmanager
async def tool_call(params: FunctionCallParams, notify, name: str):
    """Report a tool's lifecycle through lookup and result delivery."""
    event = {"name": name, "call_id": params.tool_call_id}
    context = getattr(params, "app_resources", None)
    tool_log = log.bind(
        call_id=getattr(context, "call_id", None), tool=name, tool_call_id=params.tool_call_id
    )
    notify({"type": "tool_started", **event})

    async def complete(result: dict, *, sources=None):
        await params.result_callback(result)
        if "error" in result:
            outcome = "tool_failed"
        elif result.get("status") == "empty":
            outcome = "tool_empty"
        else:
            outcome = "tool_finished"
        update = {
            "type": outcome,
            "code": result.get("code"),
            **event,
        }
        if sources:
            update["sources"] = sources
        notify(update)
        if "error" in result:
            tool_log.warning("tool_failed", error_code=result.get("code"))

    try:
        yield complete
    except asyncio.CancelledError:
        notify({"type": "tool_cancelled", **event})
        raise
    except Exception as exc:
        notify({"type": "tool_failed", **event})
        tool_log.error("tool_failed", **exception_fields(exc))
        raise


def _register(definition: LookupTool, notify) -> FunctionSchema:
    @tool_options(timeout_secs=definition.timeout_seconds)
    async def execute(params: FunctionCallParams):
        async with tool_call(params, notify, definition.name) as complete:
            try:
                arguments = definition.arguments.model_validate(params.arguments)
            except ValidationError:
                await complete(
                    {
                        "status": "error",
                        "code": "invalid_arguments",
                        "error": "Arguments did not match this tool's schema. Check required fields and limits.",
                    }
                )
                return
            try:
                result = await definition.lookup(arguments)
            except LookupUnavailable as exc:
                result = {"status": "error", "code": exc.code, "error": str(exc)}
            except TimeoutError:
                result = {
                    "status": "error",
                    "code": "lookup_timeout",
                    "error": "The lookup timed out. Its result is unknown.",
                }
            except Exception as exc:
                result = {
                    "status": "error",
                    "code": type(exc).__name__,
                    "error": "The lookup failed. The requested information has not been verified.",
                }
            await complete(
                result,
                sources=[
                    {"title": source["title"], "url": source["url"]}
                    for source in result.get("sources", [])
                ],
            )

    schema = definition.arguments.model_json_schema()
    return FunctionSchema(
        name=definition.name,
        description=definition.description,
        properties=schema["properties"],
        required=schema.get("required", []),
        handler=execute,
    )


def build_tools(notify, *, ai=None):
    definitions = (
        LookupTool(
            "get_current_time",
            "Read the current date and time. Use the user's UTC offset unless they request another time zone.",
            CurrentTimeArguments,
            current_time,
        ),
        LookupTool(
            "get_current_weather",
            "Look up current weather for a named city using Open-Meteo. Ask for a city if it is unknown. This tool returns current conditions, not forecasts. State the returned location and temperature unit.",
            WeatherArguments,
            current_weather,
        ),
        LookupTool(
            "get_weather_forecast",
            "Get daily forecasts for a named city, including rain probability and temperature range. start_day uses the location's local date: 0 today, 1 tomorrow. Returns up to seven days within a 16-day horizon. Ask for a city if unknown. State the returned location and temperature unit. Null values mean unavailable data.",
            ForecastArguments,
            weather_forecast,
        ),
        LookupTool(
            DOCS_TOOL,
            "Search Cloudflare documentation for product, API, and configuration questions. Supply focused product or feature keywords. Returns found (source excerpts and links), empty (no matches), or error (lookup unavailable).",
            DocsArguments,
            search_docs,
            # Leave time to deliver the service's error result before Pipecat's deadline.
            timeout_seconds=DOCS_TIMEOUT_SECONDS + 3,
        ),
        LookupTool(
            READ_DOCS_TOOL,
            "Read a documentation page found by search or supplied by the user when excerpts omit needed detail. Supply a developers.cloudflare.com URL and optionally a heading fragment. A missing heading returns available sections; a truncated excerpt is only part of the page.",
            ReadDocsArguments,
            read_docs_page,
        ),
        LookupTool(
            STATUS_TOOL,
            "Check Cloudflare's public status page for a product, active incidents, and maintenance. Omit product for an overall summary. Reports published information, not an individual customer's health. An unmatched component or failed lookup is not evidence of healthy services.",
            StatusArguments,
            cloudflare_status,
        ),
        LookupTool(
            WEB_SEARCH_TOOL,
            "Search the public web for current or unfamiliar information outside the dedicated weather, time, Cloudflare documentation, and status tools. Returns source excerpts and links, or an empty or error status.",
            WebSearchArguments,
            partial(
                search_web,
                ai=ai,
                provider=WEB_SEARCH_PROVIDER,
                gateway_id=WEB_SEARCH_GATEWAY_ID,
            ),
            timeout_seconds=WEB_SEARCH_TIMEOUT_SECONDS + 2,
        ),
    )
    return [_register(definition, notify) for definition in definitions]

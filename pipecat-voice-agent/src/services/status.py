"""Read published Cloudflare status, scoped to a product when requested."""

import asyncio
from datetime import UTC, datetime

import httpx2
from pydantic import BaseModel, ConfigDict, Field

from services.http import LookupUnavailable, read_limited

STATUS_TOOL = "get_cloudflare_status"
STATUS_URL = "https://www.cloudflarestatus.com"
STATUS_TIMEOUT_SECONDS = 8


class StatusArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    product: str = Field(
        default="",
        max_length=80,
        description="Product name, such as Workers, Workers AI, or Realtime SFU. Omit for an overall summary.",
    )


class StatusUnavailable(LookupUnavailable):
    def __init__(self, code):
        super().__init__(
            code,
            "Cloudflare's public status could not be checked. Do not infer that services are healthy or unavailable.",
        )


class _Component(BaseModel):
    id: str
    name: str
    status: str
    group_id: str | None = None
    group: bool = False


class _Update(BaseModel):
    body: str
    created_at: str


class _Incident(BaseModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")
    name: str
    status: str
    updated_at: str
    components: list[_Component]
    incident_updates: list[_Update] = Field(default_factory=list)
    scheduled_for: str | None = None
    scheduled_until: str | None = None


class _Summary(BaseModel):
    status: dict[str, str]
    components: list[_Component]
    incidents: list[_Incident]
    scheduled_maintenances: list[_Incident]


def _compact(summary: _Summary, product: str):
    query = product.casefold().removeprefix("cloudflare ").strip()
    if query == "cloudflare":
        query = ""
    exact = [component for component in summary.components if component.name.casefold() == query]
    selected = exact or [
        component for component in summary.components if query in component.name.casefold()
    ]
    if query and not selected:
        return {
            "status": "empty",
            "product": product,
            "detail": "No matching public status component was found. This does not establish that the product is healthy.",
        }
    ids = {component.id for component in selected}
    if query:
        selected.extend(
            component
            for component in summary.components
            if component.group_id in ids and component.id not in ids
        )
        ids.update(component.id for component in selected)
    else:
        selected = [
            component
            for component in selected
            if not component.group and component.status != "operational"
        ]

    def relevant(items):
        return [
            item
            for item in items
            if not query or any(component.id in ids for component in item.components)
        ]

    def incident(item):
        result = {
            "name": item.name[:180],
            "status": item.status,
            "updated_at": item.updated_at,
            "url": f"{STATUS_URL}/incidents/{item.id}",
            "latest_update": max(item.incident_updates, key=lambda update: update.created_at).body[
                :500
            ]
            if item.incident_updates
            else "",
        }
        if item.scheduled_for:
            result.update(scheduled_for=item.scheduled_for, scheduled_until=item.scheduled_until)
        return result

    incidents = relevant(summary.incidents)
    maintenance = relevant(summary.scheduled_maintenances)
    result = {
        "status": "found",
        "product": product if query else "All Cloudflare services",
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "scope": "Published status-page information; not a check of an individual account or request.",
        "components": [{"name": item.name[:160], "status": item.status} for item in selected[:10]],
        "component_count": len(selected),
        "incidents": [incident(item) for item in incidents[:3]],
        "incident_count": len(incidents),
        "maintenance": [incident(item) for item in maintenance[:2]],
        "maintenance_count": len(maintenance),
        "sources": [
            {"title": "Cloudflare Status", "url": STATUS_URL},
            *[
                {"title": item.name[:160], "url": f"{STATUS_URL}/incidents/{item.id}"}
                for item in [*incidents[:3], *maintenance[:2]]
            ],
        ],
    }
    if not query:
        result["overall"] = summary.status
    # Unscoped incidents may apply beyond the explicitly matched components.
    result["unscoped_incident_count"] = sum(not item.components for item in summary.incidents)
    return result


async def cloudflare_status(arguments: StatusArguments):
    try:
        async with asyncio.timeout(STATUS_TIMEOUT_SECONDS):
            async with httpx2.AsyncClient(
                timeout=STATUS_TIMEOUT_SECONDS, follow_redirects=False
            ) as client:
                async with client.stream(
                    "GET",
                    STATUS_URL + "/api/v2/summary.json",
                    headers={
                        "Accept": "application/json",
                        "User-Agent": "realtime-pipecat-voice-agent/0.1 (+https://developers.cloudflare.com/realtime/sfu/)",
                    },
                ) as response:
                    if response.status_code != 200:
                        raise StatusUnavailable(f"status_http_{response.status_code}")
                    body = await read_limited(response, 1048576)
                    return _compact(_Summary.model_validate_json(body), arguments.product)
    except TimeoutError, httpx2.TimeoutException:
        raise StatusUnavailable("status_timeout") from None
    except httpx2.HTTPError, ValueError:
        raise StatusUnavailable("status_unavailable") from None

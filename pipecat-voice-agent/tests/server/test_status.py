import httpx2
import pytest

from services import status

WORKERS = {"id": "workers", "name": "Workers", "status": "operational"}
AI = {"id": "ai", "name": "Workers AI", "status": "degraded_performance"}


def summary():
    return {
        "status": {"indicator": "minor", "description": "Partial degradation"},
        "components": [WORKERS, AI],
        "incidents": [
            {
                "id": "ai-incident",
                "name": "AI inference delays",
                "status": "investigating",
                "updated_at": "2026-10-07T08:00:00Z",
                "components": [AI],
                "incident_updates": [
                    {
                        "body": "Investigating delayed inference.",
                        "created_at": "2026-10-07T08:00:00Z",
                    }
                ],
            }
        ],
        "scheduled_maintenances": [],
    }


async def test_exact_product_status_does_not_inherit_an_unrelated_outage(monkeypatch):
    original = httpx2.AsyncClient
    requests = []

    def respond(request):
        requests.append(request)
        return httpx2.Response(200, json=summary())

    monkeypatch.setattr(
        status.httpx2,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx2.MockTransport(respond), **kwargs),
    )
    result = await status.cloudflare_status(status.StatusArguments(product="Cloudflare Workers"))
    assert result["components"] == [{"name": "Workers", "status": "operational"}]
    assert result["incidents"] == [] and "overall" not in result
    assert result["checked_at"] and result["sources"][0]["url"] == status.STATUS_URL
    assert len(requests) == 1 and str(requests[0].url) == status.STATUS_URL + "/api/v2/summary.json"
    assert "user-agent" in requests[0].headers and "authorization" not in requests[0].headers


def test_overall_status_and_an_unknown_product_are_distinct():
    data = status._Summary.model_validate(summary())
    overall = status._compact(data, "")
    assert overall["overall"]["indicator"] == "minor"
    assert overall["components"] == [{"name": "Workers AI", "status": "degraded_performance"}]
    assert overall["incidents"][0]["url"] == status.STATUS_URL + "/incidents/ai-incident"
    assert status._compact(data, "Unknown product")["status"] == "empty"


async def test_unavailable_status_is_an_error_instead_of_a_healthy_result(monkeypatch):
    original = httpx2.AsyncClient
    response = httpx2.Response(503, text="Unavailable")
    monkeypatch.setattr(
        status.httpx2,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx2.MockTransport(lambda _: response), **kwargs),
    )
    with pytest.raises(status.StatusUnavailable) as failure:
        await status.cloudflare_status(status.StatusArguments())
    assert failure.value.code == "status_http_503"
    assert response.is_closed

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import server.realtime as realtime_module
from server.http import ApiError
from server.realtime import Realtime


def client(env, resources):
    save = AsyncMock()
    return Realtime(env, resources, save, lambda *_: nullcontext())


async def test_ga_close_is_idempotent_without_byte_counters(env):
    resources = {"adapters": ["input", "output"], "mids": []}
    sfu = client(env, resources)
    sfu.request = AsyncMock(
        return_value={"tracks": [{"adapterId": "input"}, {"adapterId": "output"}]}
    )
    assert await sfu.cleanup()
    assert resources["adapters"] == []


async def test_partial_close_preserves_only_unresolved_resources(env):
    resources = {"adapters": ["input", "output"], "session_id": "session", "mids": ["0", "1"]}
    sfu = client(env, resources)
    sfu.request = AsyncMock(
        side_effect=[
            {
                "errorCode": "batch_error",
                "tracks": [
                    {"adapterId": "input"},
                    {"adapterId": "output", "errorCode": "internal_error"},
                ],
            },
            {
                "tracks": [
                    {"mid": "0", "errorCode": "close_track_error"},
                    {"mid": "1", "errorCode": "internal_error"},
                ]
            },
        ]
    )
    assert not await sfu.cleanup()
    assert resources["adapters"] == ["output"]
    assert resources["mids"] == ["1"]


@pytest.mark.parametrize("status", [404, 410, 500])
async def test_request_error_does_not_prove_owned_tracks_are_absent(env, status):
    resources = {"adapters": ["input"], "session_id": "session", "mids": ["0"]}
    sfu = client(env, resources)
    sfu.request = AsyncMock(side_effect=ApiError("not_found", status))
    assert not await sfu.cleanup()
    assert resources["adapters"] == ["input"] and resources["mids"] == ["0"]


async def test_missing_item_is_retained_for_retry(env):
    resources = {"adapters": ["input", "output"], "mids": []}
    sfu = client(env, resources)
    sfu.request = AsyncMock(return_value={"tracks": [{"adapterId": "input"}]})
    assert not await sfu.cleanup()
    assert resources["adapters"] == ["output"]


# 410: the session is gone. 425: the browser never connected, as after a failed agent setup.
@pytest.mark.parametrize("status", [410, 425])
async def test_gone_session_stops_track_retries_without_dropping_pending_adapters(
    env, monkeypatch, status
):
    resources = {"adapters": ["input", "output"], "session_id": "session", "mids": ["0", "1"]}
    fetch = AsyncMock(
        side_effect=[
            SimpleNamespace(
                status=200,
                json=AsyncMock(
                    return_value={
                        "tracks": [
                            {"adapterId": "input"},
                            {"adapterId": "output", "errorCode": "internal_error"},
                        ]
                    }
                ),
            ),
            SimpleNamespace(
                status=status, json=AsyncMock(return_value={"errorCode": "session_error"})
            ),
            SimpleNamespace(
                status=200, json=AsyncMock(return_value={"tracks": [{"adapterId": "output"}]})
            ),
        ]
    )
    monkeypatch.setattr(realtime_module, "fetch", fetch)
    sfu = client(env, resources)
    assert not await sfu.cleanup()
    assert resources["mids"] == []
    assert resources["adapters"] == ["output"]
    assert await sfu.cleanup()
    assert resources["adapters"] == []
    assert [call.args[0].split("/apps/test-app")[1] for call in fetch.await_args_list] == [
        "/adapters/websocket/close",
        "/sessions/session/tracks/close",
        "/adapters/websocket/close",
    ]


async def test_partial_publish_records_all_known_mids_before_raising(env):
    resources = {"adapters": [], "mids": []}
    sfu = client(env, resources)
    sfu.request = AsyncMock(
        return_value={"tracks": [{"mid": "0"}, {"mid": "1", "errorCode": "track_error"}]}
    )
    with pytest.raises(ApiError):
        await sfu.track_request("/sessions/owned/tracks/new", {})
    assert resources["mids"] == ["0", "1"]
    sfu.save.assert_awaited_once()

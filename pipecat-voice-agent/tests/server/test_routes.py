from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from conftest import Request, Response

from entry import Default

CALL = "b" * 32


@pytest.mark.parametrize(
    "path,method,status",
    [
        (f"/api/calls/{CALL}/unknown", "POST", 404),
        ("/api/calls/not-a-call/events", "GET", 404),
        (f"/api/calls/{CALL}/events", "POST", 405),
        (f"/api/calls/{CALL}/finish", "GET", 405),
        (f"/api/calls/{CALL}/warm", "POST", 405),
        (f"/media/{CALL}/input", "POST", 405),
        (f"/media/{CALL}/input/", "GET", 404),
        (f"/media//{CALL}/output", "GET", 404),
    ],
)
async def test_reserved_routes_reject_invalid_paths_and_methods(ctx, env, path, method, status):
    env.CALLS = SimpleNamespace(getByName=Mock())
    env.ASSETS = SimpleNamespace(fetch=AsyncMock())
    response = await Default(ctx, env).fetch(Request(path, method=method))
    assert response.status == status
    env.CALLS.getByName.assert_not_called()
    env.ASSETS.fetch.assert_not_awaited()


async def test_media_forwarding_preserves_the_native_upgrade(ctx, env):
    upgrade = Response(status=101)
    stub = SimpleNamespace(fetch=AsyncMock(return_value=upgrade))
    env.CALLS = SimpleNamespace(getByName=Mock(return_value=stub))
    request = Request(f"/media/{CALL}/input?token=test-only")
    request.headers["Upgrade"] = "websocket"
    assert await Default(ctx, env).fetch(request) is upgrade
    env.CALLS.getByName.assert_called_once_with(CALL)
    stub.fetch.assert_awaited_once_with(request)


async def test_call_create_checks_origin_and_rate_limit_before_forwarding(ctx, env, owner_cookie):
    stub = SimpleNamespace(fetch=AsyncMock(return_value=Response(status=201)))
    env.CALLS = SimpleNamespace(getByName=lambda _: stub)
    env.CALL_LIMITER = SimpleNamespace(limit=AsyncMock(return_value=SimpleNamespace(success=False)))
    worker = Default(ctx, env)
    path = f"/api/calls/{CALL}/create"
    request = Request(path, {}, cookie=owner_cookie, origin="https://another.example")
    assert (await worker.fetch(request)).status == 403
    env.CALL_LIMITER.limit.assert_not_awaited()
    request = Request(path, {}, cookie=owner_cookie)
    assert (await worker.fetch(request)).status == 429
    stub.fetch.assert_not_awaited()
    env.CALL_LIMITER.limit.return_value.success = True
    assert (await worker.fetch(request)).status == 201
    stub.fetch.assert_awaited_once_with(request)


async def test_warming_forwards_without_spending_the_call_limit(ctx, env, owner_cookie):
    stub = SimpleNamespace(fetch=AsyncMock(return_value=Response(status=200)))
    env.CALLS = SimpleNamespace(getByName=Mock(return_value=stub))
    env.CALL_LIMITER = SimpleNamespace(limit=AsyncMock())
    request = Request(f"/api/calls/{CALL}/warm", cookie=owner_cookie)
    assert (await Default(ctx, env).fetch(request)).status == 200
    env.CALL_LIMITER.limit.assert_not_awaited()
    env.CALLS.getByName.assert_called_once_with(CALL)
    unauthenticated = Request(f"/api/calls/{CALL}/warm")
    assert (await Default(ctx, env).fetch(unauthenticated)).status == 401
    stub.fetch.assert_awaited_once_with(request)


async def test_frontend_paths_use_the_asset_binding(ctx, env):
    response = Response(data="frontend")
    env.ASSETS = SimpleNamespace(fetch=AsyncMock(return_value=response))
    request = Request("/settings")
    assert await Default(ctx, env).fetch(request) is response
    env.ASSETS.fetch.assert_awaited_once_with(request)

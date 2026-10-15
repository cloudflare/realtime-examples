import sys
import uuid
from types import SimpleNamespace

import pytest
from conftest import Request

import entry
import server.call as call_module
import server.routes as routes_module
from server.auth import browser_auth
from server.auth_code import COOKIE, SESSION_SECONDS, AccessCodeAuth
from server.call import VoiceCall
from server.http import ApiError
from transport.auth import AdapterAuth

CALL = "b" * 32


async def test_an_async_identity_provider_preserves_call_ownership(monkeypatch, ctx, env):
    class Provider:
        async def identity(self, request):
            # A provider's verified principal need not be a cookie or a hex ID.
            return request.headers["X-Test-Principal"]

    monkeypatch.setattr(call_module, "browser_auth", lambda _: Provider())
    call = VoiceCall(ctx, env)
    create = Request(f"/api/calls/{CALL}/create", {})
    create.headers["X-Test-Principal"] = "example-idp:user-1"
    assert (await call.fetch(create)).status == 201
    assert call.state["owner"] == "example-idp:user-1"
    for principal, expected in [("example-idp:user-1", 200), ("example-idp:user-2", 404)]:
        status = Request(f"/api/calls/{CALL}/status")
        status.headers["X-Test-Principal"] = principal
        assert (await call.fetch(status)).status == expected


async def test_adapter_routes_skip_browser_auth_without_opening_call_apis(monkeypatch, ctx, env):
    def deny(_env):
        raise ApiError("login_required", 401)

    monkeypatch.setattr(routes_module, "browser_auth", deny)
    env.CALLS = SimpleNamespace(getByName=lambda _: VoiceCall(ctx, env))
    worker = entry.Default(ctx, env)
    # No live call/adapter token: media reaches its own authorization boundary.
    assert (await worker.fetch(Request(f"/media/{CALL}/input"))).status == 403
    assert (await worker.fetch(Request(f"/media/{CALL}/output"))).status == 403
    assert (await worker.fetch(Request(f"/media/{CALL}/status"))).status == 404
    assert (await worker.fetch(Request(f"/api/calls/{CALL}/create", {}))).status == 401


def test_adapter_tokens_are_scoped_revocable_and_allow_reconnects(monkeypatch):
    monkeypatch.setitem(
        sys.modules,
        "js",
        SimpleNamespace(crypto=SimpleNamespace(randomUUID=lambda: str(uuid.uuid4()))),
    )
    first, other = AdapterAuth(), AdapterAuth()
    token = first.issue()
    other.issue()
    assert first.accepts(token)
    assert first.accepts(token)
    assert not first.accepts("")
    assert not first.accepts("wrong")
    assert not other.accepts(token)
    next_token = first.issue()
    assert not first.accepts(token)
    assert first.accepts(next_token)
    first.revoke()
    assert not first.accepts(next_token)


async def test_session_expiry_and_login_rate_limit(env, monkeypatch):
    from itsdangerous import TimestampSigner

    signer = AccessCodeAuth(env).signer()
    token = signer.dumps("a" * 32)
    now = TimestampSigner("key").get_timestamp()
    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda _: now + SESSION_SECONDS + 1)
    request = Request("/api/session", cookie=f"{COOKIE}={token}")
    assert (await browser_auth(env).session(request))["authenticated"] is False
    with pytest.raises(ApiError) as error:
        await browser_auth(env).identity(request)
    assert error.value.status == 401
    env.LOGIN_LIMITER.limit.return_value.success = False
    with pytest.raises(ApiError) as error:
        await browser_auth(env).login(Request("/api/login", {"password": "test-password"}))
    assert error.value.status == 429

import pytest
from conftest import Request

from server.auth import browser_auth
from server.http import ApiError, check_origin


async def test_login_binds_a_signed_owner_to_the_browser(env):
    auth = browser_auth(env)
    request = Request("/api/login", {"password": "test-password"})
    signed = (await auth.login(request)).headers["Set-Cookie"]
    assert "HttpOnly" in signed and "Secure" in signed and "SameSite=Strict" in signed
    authorized = Request("/api/session", cookie=signed)
    owner = await auth.identity(authorized)
    assert len(owner) == 32
    assert owner == await auth.identity(authorized)


async def test_missing_or_forged_sessions_are_rejected(env):
    for cookie in (None, "voice_session=forged"):
        with pytest.raises(ApiError) as error:
            await browser_auth(env).identity(Request("/api/session", cookie=cookie))
        assert error.value.status == 401


async def test_wrong_password_and_missing_configuration_fail_closed(env):
    with pytest.raises(ApiError) as error:
        await browser_auth(env).login(Request("/api/login", {"password": "wrong"}))
    assert error.value.status == 401
    env.SESSION_SECRET = ""
    with pytest.raises(ApiError) as error:
        await browser_auth(env).login(Request("/api/login", {"password": "test-password"}))
    assert error.value.status == 503


def test_mutations_require_same_origin():
    check_origin(Request("/api/calls", {}))
    for origin in ("", "https://attacker.example", "http://voice.example"):
        with pytest.raises(ApiError) as error:
            check_origin(Request("/api/calls", {}, origin=origin))
        assert error.value.status == 403

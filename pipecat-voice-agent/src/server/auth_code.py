"""Shared access codes and signed sessions: the default browser auth provider."""

import hmac
import uuid
from http.cookies import SimpleCookie
from urllib.parse import urlparse

from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, ConfigDict, Field

from server.http import ApiError, check_origin, read_json, reply

COOKIE = "voice_session"
SESSION_SECONDS = 8 * 60 * 60


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    password: str = Field(min_length=1, max_length=256)


def cookie(request, value, max_age=SESSION_SECONDS):
    secure = "; Secure" if urlparse(request.url).scheme == "https" else ""
    return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}"


class AccessCodeAuth:
    def __init__(self, env):
        self.env = env

    @property
    def configured(self):
        return (
            bool(getattr(self.env, "APP_PASSWORD", ""))
            and len(str(getattr(self.env, "SESSION_SECRET", ""))) >= 32
        )

    def signer(self):
        if not self.configured:
            raise ApiError("setup_required", 503)
        return URLSafeTimedSerializer(str(self.env.SESSION_SECRET), salt="realtime-voice-login")

    async def identity(self, request):
        cookies = SimpleCookie()
        try:
            cookies.load(request.headers.get("Cookie", ""))
            token = cookies.get(COOKIE)
            owner = self.signer().loads(token.value, max_age=SESSION_SECONDS) if token else None
            if not isinstance(owner, str) or len(owner) != 32:
                raise ValueError()
            return owner
        except BadSignature, ValueError, AttributeError:
            raise ApiError("login_required", 401) from None

    async def session(self, request):
        authenticated = False
        if self.configured:
            try:
                await self.identity(request)
                authenticated = True
            except ApiError:
                pass
        return {"configured": self.configured, "authenticated": authenticated}

    async def login(self, request):
        check_origin(request)
        limited = await self.env.LOGIN_LIMITER.limit(
            {"key": "voice-login:" + request.headers.get("CF-Connecting-IP", "local")}
        )
        if not limited.success:
            raise ApiError("too_many_attempts", 429)
        body = await read_json(request, Login)
        signer = self.signer()
        if not hmac.compare_digest(body.password.encode(), str(self.env.APP_PASSWORD).encode()):
            raise ApiError("incorrect_password", 401)
        try:
            owner = await self.identity(request)
        except ApiError:
            owner = uuid.uuid4().hex
        return reply(
            {"authenticated": True}, headers={"Set-Cookie": cookie(request, signer.dumps(owner))}
        )

    async def logout(self, request):
        check_origin(request)
        return reply({"authenticated": False}, headers={"Set-Cookie": cookie(request, "", 0)})

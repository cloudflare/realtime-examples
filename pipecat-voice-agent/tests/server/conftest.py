"""Native test doubles for the Workers boundary; media tests use the runtime."""

import json
import sys
from contextlib import nullcontext
from email.message import Message
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock

import pytest


class Response:
    def __init__(self, data=None, status=200, headers=None, **kwargs):
        self.data, self.status, self.headers = data, status, headers or {}

    @classmethod
    def json(cls, data, **kwargs):
        return cls(data, **kwargs)


class DurableObject:
    def __init__(self, ctx, env):
        self.ctx, self.env = ctx, env


class Proxy:
    def __init__(self, task):
        self.task = task

    def destroy(self):
        pass


workers = ModuleType("workers")
workers.Response = Response
workers.DurableObject = DurableObject
workers.WorkerEntrypoint = DurableObject
workers.fetch = None
sys.modules["workers"] = workers
asgi = ModuleType("workers.asgi")
asgi.acquire_js_buffer = nullcontext
sys.modules["workers.asgi"] = asgi
ffi = ModuleType("pyodide.ffi")
ffi.create_proxy = Proxy
sys.modules["pyodide.ffi"] = ffi
js = ModuleType("js")
js.WebSocketPair = None
sys.modules["js"] = js


class Request:
    def __init__(
        self, path, body=None, *, cookie=None, origin="https://voice.example", method=None
    ):
        self.url = "https://voice.example" + path
        self.method = method or ("POST" if body is not None else "GET")
        self.headers = Message()
        self.headers["Origin"] = origin
        self.headers["Content-Type"] = "application/json"
        if cookie:
            self.headers["Cookie"] = cookie
        self.raw = json.dumps(body).encode() if body is not None else b""
        self.body = SimpleNamespace(getReader=lambda: Reader(self.raw))


class Reader:
    def __init__(self, raw):
        self.raw = raw

    async def read(self):
        if self.raw is None:
            return SimpleNamespace(done=True)
        raw, self.raw = self.raw, None
        return SimpleNamespace(done=False, value=raw)

    async def cancel(self):
        self.raw = None

    def releaseLock(self):
        pass


class Storage:
    def __init__(self):
        self.values = {}
        self.alarm = None

    async def get(self, key):
        return self.values.get(key)

    async def put(self, key, value):
        self.values[key] = value

    async def setAlarm(self, value):
        self.alarm = value

    async def deleteAlarm(self):
        self.alarm = None

    async def deleteAll(self):
        self.values.clear()


@pytest.fixture
def env():
    return SimpleNamespace(
        APP_PASSWORD="test-password",
        SESSION_SECRET="test-signing-secret-" * 3,
        REALTIME_APP_ID="test-app",
        REALTIME_AUTH_TOKEN="test-app-token",
        LOGIN_LIMITER=SimpleNamespace(limit=AsyncMock(return_value=SimpleNamespace(success=True))),
    )


@pytest.fixture
def ctx():
    return SimpleNamespace(storage=Storage(), waitUntil=lambda _: None)


@pytest.fixture
def owner_cookie(env):
    from server.auth_code import COOKIE, AccessCodeAuth

    return f"{COOKIE}={AccessCodeAuth(env).signer().dumps('a' * 32)}"

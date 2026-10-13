"""Declarative URL dispatch with native Workers requests and responses."""

from urllib.parse import urlparse

from werkzeug.exceptions import MethodNotAllowed, NotFound
from werkzeug.routing import BaseConverter, Map, Rule

from agent.config import MAX_CALL_SECONDS, AgentConfig
from server.auth import browser_auth
from server.http import ApiError, check_origin, reply


class CallIdConverter(BaseConverter):
    regex = r"[a-f0-9]{32}"


async def session(request, env):
    identity = await browser_auth(env).session(request)
    return reply(
        {
            **identity,
            "configured": identity["configured"]
            and all(getattr(env, key, "") for key in ("REALTIME_APP_ID", "REALTIME_AUTH_TOKEN")),
            "agent": AgentConfig().model_dump(),
            "max_call_seconds": MAX_CALL_SECONDS,
        }
    )


async def login(request, env):
    return await browser_auth(env).login(request)


async def logout(request, env):
    return await browser_auth(env).logout(request)


async def call(request, env, call_id, action):
    owner = await browser_auth(env).identity(request)
    if request.method != "GET":
        check_origin(request)
    if action == "create":
        limited = await env.CALL_LIMITER.limit({"key": "voice-call:" + owner})
        if not limited.success:
            raise ApiError("too_many_calls", 429)
    return await env.CALLS.getByName(call_id).fetch(request)


async def media(request, env, call_id, role):
    # The Durable Object verifies the adapter token independently of browser auth.
    return await env.CALLS.getByName(call_id).fetch(request)


async def assets(request, env):
    return await env.ASSETS.fetch(request)


_map = Map(
    [
        Rule("/api/session", methods=["GET"], endpoint=session),
        Rule("/api/login", methods=["POST"], endpoint=login),
        Rule("/api/logout", methods=["POST"], endpoint=logout),
        Rule(
            "/api/calls/<call_id:call_id>/<any(events,status):action>",
            methods=["GET"],
            endpoint=call,
        ),
        Rule(
            "/api/calls/<call_id:call_id>/<any(create,publish,attach,subscribe,renegotiate,finish):action>",
            methods=["POST"],
            endpoint=call,
        ),
        Rule("/media/<call_id:call_id>/<any(input,output):role>", methods=["GET"], endpoint=media),
    ],
    converters={"call_id": CallIdConverter},
    merge_slashes=False,
)
# WebSocket upgrades must reach the handler without routing redirects.
_router = _map.bind("worker.invalid")


def match(request):
    path = urlparse(request.url).path
    try:
        return _router.match(path_info=path, method=request.method)
    except MethodNotAllowed:
        raise ApiError("method_not_allowed", 405) from None
    except NotFound:
        if path.startswith(("/api/", "/media/")):
            raise ApiError("not_found", 404) from None
        return assets, {}

"""Small HTTP boundary shared by the entrypoint and Durable Object."""

import json
from urllib.parse import urlparse

from pydantic import BaseModel, ValidationError
from workers import Response


class ApiError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def reply(data, status=200, headers=None):
    return Response.json(
        data,
        status=status,
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            **(headers or {}),
        },
    )


async def read_json(request, model: type[BaseModel] | None = None):
    if "application/json" not in request.headers.get("Content-Type", ""):
        raise ApiError("json_required", 415)
    try:
        if int(request.headers.get("Content-Length", "0")) > 65536:
            raise ApiError("request_too_large", 413)
    except ValueError:
        raise ApiError("invalid_request") from None
    native = getattr(request, "js_request", request)
    reader = native.body.getReader() if native.body is not None else None
    body = bytearray()
    if reader:
        try:
            while True:
                chunk = await reader.read()
                if chunk.done:
                    break
                value = chunk.value
                body.extend(value.to_bytes() if hasattr(value, "to_bytes") else bytes(value))
                if len(body) > 65536:
                    await reader.cancel()
                    raise ApiError("request_too_large", 413)
        finally:
            reader.releaseLock()
    try:
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError()
        return model.model_validate(value) if model else value
    except ValueError, TypeError, ValidationError:
        raise ApiError("invalid_request") from None


def check_origin(request):
    target = urlparse(request.url)
    source = urlparse(request.headers.get("Origin", ""))
    local = {"localhost", "127.0.0.1", "::1"}
    if target.hostname in local and source.hostname in local:
        return
    if not source.netloc or (source.scheme, source.netloc) != (target.scheme, target.netloc):
        raise ApiError("origin_not_allowed", 403)

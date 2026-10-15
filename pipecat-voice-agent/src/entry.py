"""Worker routing, structured failure reporting, and Durable Object export."""

from workers import WorkerEntrypoint

from server.call import VoiceCall as VoiceCall
from server.http import ApiError, reply
from server.observability import failure
from server.routes import match


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        call_id, operation = None, "routing"
        try:
            handler, values = match(request)
            call_id = values.get("call_id")
            operation = values.get("action") or values.get("role") or handler.__name__
            return await handler(request, self.env, **values)
        except ApiError as exc:
            body = {"error": exc.code}
            if exc.status >= 500:
                body["request_id"] = failure(
                    "request_failed",
                    exc,
                    call_id=call_id,
                    operation=operation,
                    scope="entrypoint",
                    status=exc.status,
                    error_code=exc.code,
                )
            return reply(body, exc.status)
        except Exception as exc:
            reference = failure(
                "request_failed",
                exc,
                call_id=call_id,
                operation=operation,
                scope="entrypoint",
                status=503,
            )
            return reply({"error": "service_unavailable", "request_id": reference}, 503)

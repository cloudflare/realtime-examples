"""One authenticated call: serialized signaling and durable resource ownership."""

import asyncio
import hashlib
import hmac
import json
import time
from contextlib import contextmanager
from urllib.parse import parse_qs, urlparse

from pyodide.ffi import create_proxy
from workers import DurableObject

from agent.config import MAX_CALL_SECONDS, AgentConfig
from agent.engine import VoiceEngine
from server.auth import browser_auth
from server.http import ApiError, check_origin, read_json, reply
from server.models import CreateCall, Publish, Renegotiate
from server.observability import exception_fields, failure, log
from server.realtime import Realtime

EVENT_WAIT_SECONDS = 20


class VoiceCall(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.state = None
        self.loaded = False
        self.lock = asyncio.Lock()
        self.engine = None
        # Adapter URLs carry a per-call credential, so they stay in memory.
        self.endpoints = None
        self.stopping = False
        self.finish_task = None
        self.last_seen = time.monotonic()

    async def load(self):
        if not self.loaded:
            value = await self.ctx.storage.get("call")
            self.state = json.loads(value) if value else None
            self.loaded = True

    async def save(self):
        await self.ctx.storage.put("call", json.dumps(self.state))

    @contextmanager
    def measure(self, operation, label):
        start = time.monotonic()
        row = {"operation": operation, "label": label, "status": "ok"}
        error = {}
        try:
            yield
        except Exception as exc:
            row["status"] = "failed"
            error = exception_fields(exc)
            raise
        finally:
            row["elapsed_ms"] = round((time.monotonic() - start) * 1000, 1)
            self.state["timings"].append(row)
            del self.state["timings"][:-24]
            log.bind(call_id=self.state["id"]).log(
                "ERROR" if error else "INFO",
                "operation_finished",
                operation=operation,
                elapsed_ms=row["elapsed_ms"],
                phase=self.state["phase"],
                status=row["status"],
                **error,
            )

    def sfu(self):
        return Realtime(self.env, self.state["resources"], self.save, self.measure)

    def authorize(self, owner):
        if not self.state or not hmac.compare_digest(self.state["owner"], owner):
            raise ApiError("call_not_found", 404)

    def summary(self):
        state = self.state or {}
        engine = self.engine
        return {
            "call_id": state.get("id"),
            "phase": state.get("phase", "ended"),
            "active": bool(engine and engine.active),
            "ready": bool(engine and engine._ready()),
            "generation": engine.control.generation if engine and engine.control else 0,
            "expires_at_ms": state.get("expires_at_ms", 0),
            "finish_reason": state.get("finish_reason"),
            "service_errors": state.get("service_errors", []),
            "media_session_id": state.get("resources", {}).get("session_id"),
            "cleanup_complete": state.get("phase") == "ended",
            "cleanup": {
                "engine_complete": bool(not engine or engine.cleanup_complete),
                "adapters_pending": len(state.get("resources", {}).get("adapters", [])),
                "tracks_pending": len(state.get("resources", {}).get("mids", [])),
                "errors": engine.stats.get("cleanup_errors", []) if engine else [],
                "replies": state.get("resources", {}).get("cleanup_replies", {}),
            },
            "timings": state.get("timings", []),
        }

    def events(self, after):
        engine = self.engine
        journal = engine.client_events if engine else []
        sequence = engine.event_sequence if engine else 0
        return {
            **self.summary(),
            "server_time_ms": round(time.time() * 1000),
            "last_sequence": sequence,
            "earliest_sequence": journal[0]["sequence"] if journal else sequence,
            "events": [event for event in journal if event["sequence"] > after],
        }

    async def fetch(self, request):
        parsed = urlparse(request.url)
        action = parsed.path.rstrip("/").split("/")[-1]
        # Only the SFU uses this route. Its per-call credential is verified by
        # the engine, independently of the browser's login cookie.
        if parsed.path.startswith("/media/"):
            if request.method != "GET" or action not in {"input", "output"} or not self.engine:
                return reply({"error": "media_not_available"}, 403)
            return await self.engine.accept_socket(request, parsed, action)
        try:
            owner = await browser_auth(self.env).identity(request)
            if request.method != "GET":
                check_origin(request)
            if request.method == "GET" and action == "warm":
                # The browser calls this before Start so the new object's cold
                # start is not part of creating the call. It reads and writes
                # nothing, so it reveals nothing about a call with this ID.
                return reply({"warm": True})
            if request.method == "POST" and action == "finish":
                # A stop can arrive while setup holds the mutation lock. Only
                # its actual owner may invalidate that in-flight operation.
                if self.state:
                    self.authorize(owner)
                    self.stopping = True
                async with self.lock:
                    await self.load()
                    self.authorize(owner)
                    self.stopping = True
                    await self.finish("user_left")
                    return reply(self.summary())
            async with self.lock:
                await self.load()
                if action == "create" and request.method == "POST":
                    return await self.create(request, owner)
                self.authorize(owner)
                self.last_seen = time.monotonic()
                if self.state["phase"] in {"preparing", "published", "active"} and not self.engine:
                    await self.finish("session_restarted")
                if action in {"events", "status"} and request.method == "GET":
                    try:
                        after = int(parse_qs(parsed.query).get("after", ["0"])[0])
                        if not 0 <= after <= 1000000:
                            raise ValueError()
                    except ValueError:
                        raise ApiError("invalid_cursor") from None
                    if action == "status":
                        return reply(self.summary())
                    engine = self.engine
                else:
                    if request.method != "POST":
                        raise ApiError("method_not_allowed", 405)
                    return await self.mutate(request, action)

            # Waiting must not hold the lock needed by Stop and call setup.
            if engine and engine.active and after >= engine.event_sequence:
                engine.events_changed.clear()
                try:
                    async with asyncio.timeout(EVENT_WAIT_SECONDS):
                        await engine.events_changed.wait()
                except TimeoutError:
                    pass
            return reply(self.events(after))
        except ApiError as exc:
            body = {"error": exc.code}
            if exc.status >= 500:
                body["request_id"] = failure(
                    "request_failed",
                    exc,
                    call_id=parsed.path.split("/")[-2],
                    operation=action,
                    scope="durable_object",
                    status=exc.status,
                    error_code=exc.code,
                )
            return reply(body, exc.status)
        except Exception as exc:
            reference = failure(
                "request_failed",
                exc,
                call_id=parsed.path.split("/")[-2],
                operation=action,
                scope="durable_object",
                status=500,
            )
            if self.state:
                self.request_finish("session_error")
            return reply({"error": "session_error", "request_id": reference}, 500)

    async def create(self, request, owner):
        config = await read_json(request, CreateCall)
        if self.state:
            self.authorize(owner)
            if self.state["agent"] != config.agent.model_dump():
                raise ApiError("call_already_exists", 409)
            return reply(self.summary())
        call_id = urlparse(request.url).path.split("/")[3]
        self.state = {
            "id": call_id,
            "owner": owner,
            "phase": "created",
            "agent": config.agent.model_dump(),
            "expires_at_ms": round((time.time() + 90) * 1000),
            "timings": [],
            "resources": {"session_id": None, "mids": [], "adapters": []},
            "responses": {},
            "finish_reason": None,
        }
        await self.save()
        await self.ctx.storage.setAlarm(self.state["expires_at_ms"])
        log.bind(call_id=call_id).info("call_created")
        return reply(self.summary(), 201)

    async def mutate(self, request, action):
        expected = {
            "publish": "created",
            "attach": "published",
            "subscribe": "active",
            "renegotiate": "active",
        }
        if action not in expected:
            raise ApiError("not_found", 404)
        if self.stopping or self.state["phase"] in {"ending", "ended"}:
            raise ApiError("call_ended", 409)
        model = {"publish": Publish, "renegotiate": Renegotiate}.get(action)
        body = await read_json(request, model)
        value = body.model_dump() if model else body
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        cached = self.state["responses"].get(action)
        if cached:
            if cached["fingerprint"] != fingerprint:
                raise ApiError("negotiation_conflict", 409)
            return reply(cached["response"])
        if self.state["phase"] != expected[action]:
            raise ApiError("invalid_call_state", 409)
        if action == "renegotiate" and "subscribe" not in self.state["responses"]:
            raise ApiError("invalid_call_state", 409)
        sfu = self.sfu()
        try:
            if action == "publish":
                if body.sessionDescription.type != "offer":
                    raise ApiError("offer_required")
                self.state["phase"] = "preparing"
                self.state["expires_at_ms"] = round((time.time() + MAX_CALL_SECONDS) * 1000)
                await self.save()
                await self.ctx.storage.setAlarm(self.state["expires_at_ms"])
                # The agent does not need the media session, so it starts while
                # the SFU negotiates. Neither is cancelled when the other fails:
                # cleanup must see every resource that was actually created.
                outcomes = await asyncio.gather(
                    sfu.publish(self.state["id"], body.sessionDescription.model_dump(), body.mid),
                    self.prepare_agent(request),
                    return_exceptions=True,
                )
                for outcome in outcomes:
                    if isinstance(outcome, BaseException):
                        raise outcome
                result, self.endpoints = outcomes
                self.last_seen = time.monotonic()
                self.state["phase"] = "published"
            elif action == "attach":
                await sfu.attach(self.state["id"], self.endpoints)
                self.endpoints = None
                self.state["phase"] = "active"
                result = {"attached": True}
            elif action == "subscribe":
                result = await sfu.subscribe()
            else:
                if body.sessionDescription.type != "answer":
                    raise ApiError("answer_required")
                result = await sfu.renegotiate(body.sessionDescription.model_dump())
            # Descriptions are scoped to the authenticated owner. Callback
            # URLs, app credentials and provider responses never cross here.
            safe = {
                key: result[key]
                for key in (
                    "sessionDescription",
                    "requiresImmediateRenegotiation",
                    "attached",
                )
                if key in result
            }
            safe["timings"] = list(self.state["timings"])
            self.state["responses"][action] = {"fingerprint": fingerprint, "response": safe}
            await self.save()
            return reply(safe)
        except BaseException:
            await self.finish("setup_failed")
            raise

    async def prepare_agent(self, request):
        with self.measure("agent_prepare", "Prepare voice agent"):
            self.engine = VoiceEngine(
                self.ctx,
                self.env,
                AgentConfig.model_validate(self.state["agent"]),
                self.request_finish,
                lambda: time.monotonic() - self.last_seen < 60,
                call_id=self.state["id"],
                owner_id=self.state["owner"],
            )
            parsed = urlparse(request.url)
            return await self.engine.prepare(f"{parsed.scheme}://{parsed.netloc}", self.state["id"])

    def request_finish(self, reason):
        self.stopping = True
        if self.finish_task and not self.finish_task.done():
            return

        async def finish_locked():
            async with self.lock:
                await self.load()
                if self.state:
                    await self.finish(reason)

        task = asyncio.create_task(finish_locked())
        self.finish_task = task
        proxy = create_proxy(task)
        self.ctx.waitUntil(proxy)
        task.add_done_callback(lambda _: proxy.destroy())

    async def finish(self, reason):
        self.stopping = True
        self.endpoints = None
        if self.state["phase"] == "ended":
            return
        self.state["phase"] = "ending"
        self.state["finish_reason"] = self.state["finish_reason"] or reason
        if self.engine:
            self.state["service_errors"] = [
                {"service": service, **error}
                for service in ("llm", "tts")
                for error in self.engine.stats.get(service, {}).get("errors", [])[-4:]
            ]
        self.state["cleanup_attempts"] = self.state.get("cleanup_attempts", 0) + 1
        call_log = log.bind(
            call_id=self.state["id"],
            reason=self.state["finish_reason"],
            attempt=self.state["cleanup_attempts"],
        )
        call_log.info("call_ending")
        self.state["responses"] = {}
        await self.save()
        # Persist the retry alarm before cleanup. An eviction or failing API
        # call must not strand an adapter between two awaits.
        await self.ctx.storage.setAlarm(round((time.time() + 30) * 1000))
        engine_clean = True
        if self.engine:
            try:
                await self.engine.finish(self.state["finish_reason"])
                engine_clean = self.engine.cleanup_complete
            except Exception as exc:
                engine_clean = False
                call_log.error("cleanup_failed", stage="engine", **exception_fields(exc))
        media_clean = await self.sfu().cleanup()
        if engine_clean and media_clean:
            self.state["phase"] = "ended"
            # Retain authorization briefly for idempotent Stop, then expire the
            # call record. Conversation text is never stored in the DO database.
            self.state["delete_at_ms"] = round((time.time() + 3600) * 1000)
            await self.save()
            await self.ctx.storage.setAlarm(self.state["delete_at_ms"])
            call_log.info("call_ended", engine_complete=True, adapters_pending=0, tracks_pending=0)
        else:
            await self.save()
            delay = min(300, 15 * 2 ** min(self.state["cleanup_attempts"], 5))
            await self.ctx.storage.setAlarm(round((time.time() + delay) * 1000))
            call_log.warning(
                "cleanup_retry",
                engine_complete=engine_clean,
                adapters_pending=len(self.state["resources"]["adapters"]),
                tracks_pending=len(self.state["resources"]["mids"]),
            )

    async def alarm(self):
        async with self.lock:
            await self.load()
            if not self.state:
                return
            if self.state["phase"] == "ended":
                await self.ctx.storage.deleteAll()
                await self.ctx.storage.deleteAlarm()
                return
            await self.finish("session_timeout")

    async def webSocketMessage(self, ws, message):
        if self.engine:
            await self.engine.webSocketMessage(ws, message)
        else:
            ws.close(1011, "Call ended")

    async def webSocketClose(self, ws, code, reason, wasClean):
        if self.engine:
            await self.engine.webSocketClose(ws, code, reason, wasClean)

    async def webSocketError(self, ws, error):
        if self.engine:
            await self.engine.webSocketError(ws, error)

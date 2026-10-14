"""Live Pipecat execution and audio sockets, owned by a VoiceCall."""

import asyncio
import json
import time
from types import SimpleNamespace
from urllib.parse import parse_qs

from js import WebSocketPair
from pyodide.ffi import create_proxy
from workers import Response
from workers.asgi import acquire_js_buffer

from agent.config import MAX_CALL_SECONDS, STT_KEYTERMS
from agent.pipeline import provider_event, start_pipeline
from agent.resources import AgentResources
from server.observability import exception_fields, log
from services.flux import FluxBridge
from services.stt import AudioInputBacklog
from transport.auth import AdapterAuth
from transport.codec import AudioConverter, decode_packet, encode_packet

# Four seconds of 20 ms SFU packets, matching the recognizer's own queue limit.
MAX_QUEUED_PACKETS = 200


class VoiceEngine:
    def __init__(self, ctx, env, config, on_stop, is_present, *, call_id, owner_id):
        self.ctx, self.env, self.config = ctx, env, config
        self.resources = AgentResources(env=env, call_id=call_id, owner_id=owner_id)
        self.log = log.bind(call_id=call_id)
        self.on_stop, self.is_present = on_stop, is_present
        self.active = False
        self.pipeline_ready = False
        self.adapter_auth = AdapterAuth()
        self.expires = 0
        self.started_at = time.monotonic()
        self.tasks = set()
        self.flux = None
        self.worker = None
        self.runner = None
        self.runner_task = None
        self.finish_task = None
        self.finish_scheduled = False
        self.control = None
        self.converter = None
        self.pipeline_input = None
        self.output_sequence = 0
        self.stats = {}
        self.ever_ready = False
        self.cleanup_complete = False
        self.input_disconnected_at = None
        self.attach_deadline = None
        # Adapter sockets by role, each with the listeners added to it.
        self.media = {}
        self.media_listeners = {}
        self.media_input = asyncio.Queue(maxsize=MAX_QUEUED_PACKETS)
        self.client_events = []
        self.event_sequence = 0
        self.events_changed = asyncio.Event()

    def event(self, kind, **values):
        event = {"event": kind, "at_ms": round((time.monotonic() - self.started_at) * 1000)}
        for key, value in values.items():
            if key in {"text", "content", "transcript"}:
                continue
            if isinstance(value, (str, int, float, bool)) or value is None:
                event[key] = value[:1200] if isinstance(value, str) else value
        events = self.stats.setdefault("events", [])
        events.append(event)
        del events[:-160]

    def fail_call(self, stage, exc, **details):
        self.log.error("voice_error", stage=stage, **{**exception_fields(exc), **details})
        errors = self.stats.setdefault("errors", [])
        errors.append(
            {"stage": stage, "type": type(exc).__name__, "message": "Voice service error"}
        )
        del errors[:-12]
        self.notify(
            {"type": "error", "stage": stage, "message": "The voice session encountered an error."}
        )
        self._stop_soon(stage)

    def background(self, coro, name):
        task = asyncio.create_task(coro, name=name)
        self.tasks.add(task)
        proxy = create_proxy(task)
        self.ctx.waitUntil(proxy)

        def completed(result):
            self.tasks.discard(result)
            proxy.destroy()
            if not result.cancelled() and result.exception() is not None:
                self.fail_call(name, result.exception())

        task.add_done_callback(completed)
        return task

    def sockets(self, role=None):
        return [
            ws
            for name, ws in self.media.items()
            if ws.readyState == 1 and (role is None or name == role)
        ]

    def _ready(self):
        media = bool(self.sockets("input")) and bool(self.sockets("output"))
        return bool(
            self.active
            and self.pipeline_ready
            and self.runner_task
            and not self.runner_task.done()
            and self.flux
            and self.flux.is_open
            and media
        )

    def notify(self, event):
        self.event_sequence += 1
        data = {
            "at_ms": round((time.monotonic() - self.started_at) * 1000),
            "server_time_ms": round(time.time() * 1000),
            **event,
            "sequence": self.event_sequence,
        }
        kind = str(data.get("type", "event"))
        if kind in {"clear", "audio_started", "output_unavailable"}:
            self.event(
                kind, **{key: value for key, value in data.items() if key not in {"type", "at_ms"}}
            )
        # JSON can use twelve ASCII bytes for one Unicode character in a full transcript.
        if len(json.dumps(data)) <= 128 * 1024:
            self.client_events.append(data)
            del self.client_events[:-128]
        self.events_changed.set()
        if kind == "output_unavailable":
            self._stop_soon("output_unavailable")

    def _stop_soon(self, reason):
        if self.active and not self.finish_scheduled:
            self.finish_scheduled = True
            provider = self.flux.snapshot() if self.flux else {}
            self.log.warning(
                "call_stop_requested",
                reason=reason,
                provider_reason=provider.get("stop_reason"),
                provider_error_code=provider.get("provider_error_code"),
                provider_close_code=provider.get("close_code"),
            )
            self.on_stop(reason)

    def publish_pcm(self, pcm_mono48k, generation):
        if not self.active:
            return False
        sockets = self.sockets("output")
        if not sockets:
            return False
        stereo = self.converter.outgoing(pcm_mono48k)
        payload = encode_packet(stereo, self.output_sequence, self.output_sequence * 1920)
        try:
            for ws in sockets:
                with acquire_js_buffer(payload) as buffer:
                    ws.send(buffer)
        except Exception as exc:
            self.fail_call("audio_send", exc)
            return False
        self.output_sequence += 1
        self.stats["output_packets"] += 1
        self.stats["output_mono_pcm_bytes"] += len(pcm_mono48k)
        return True

    async def prepare(self, origin, call_id):
        self.started_at = time.monotonic()
        self.expires = time.time() + MAX_CALL_SECONDS
        self.stats = {
            "input_packets": 0,
            "input_pcm_bytes": 0,
            "output_packets": 0,
            "output_mono_pcm_bytes": 0,
            "events": [],
            "errors": [],
        }
        self.control = SimpleNamespace(
            generation=0,
            llm_pending=False,
            tts_pending=False,
            context_generations={},
        )
        media_token = self.adapter_auth.issue()
        self.converter = AudioConverter()
        self.flux = FluxBridge(
            self.env,
            lambda event: provider_event(self, event),
            max_session_seconds=MAX_CALL_SECONDS,
            keyterms=STT_KEYTERMS,
        )
        self.active = True
        await start_pipeline(self)
        await self.flux.start()
        self.attach_deadline = time.monotonic() + 30
        self.background(self.watch_session(), "voice-session-watchdog")
        self.background(self.receive_audio(), "voice-media-input")
        base = origin.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        return {
            role: f"{base}/media/{call_id}/{role}?token={media_token}"
            for role in ("input", "output")
        }

    async def accept_socket(self, request, parsed, role):
        token = parse_qs(parsed.query).get("token", [""])[0]
        if not self.active or time.time() >= self.expires or not self.adapter_auth.accepts(token):
            return Response("Forbidden", status=403)
        if request.headers.get("Upgrade", "").lower() != "websocket":
            return Response("Expected WebSocket", status=426)
        if self.sockets(role):
            return Response("Already connected", status=409)
        client, server = WebSocketPair.new()
        # The standard API, not hibernation: the call's tasks keep this object
        # in memory anyway, and hibernation turns every 20 ms packet into its
        # own invocation and log event.
        self._release_socket(role)
        server.accept()
        server.binaryType = "arraybuffer"
        listeners = []
        for name, callback in (
            ("message", self._on_media_message),
            ("close", self._on_media_close),
            ("error", self._on_media_error),
        ):
            proxy = create_proxy(
                lambda event, callback=callback, ws=server: callback(role, ws, event)
            )
            server.addEventListener(name, proxy)
            listeners.append((name, proxy))
        self.media[role] = server
        self.media_listeners[role] = (server, listeners)
        if role == "input":
            self.input_disconnected_at = None
        self.event("socket_opened", role=role)
        if self._ready():
            self.ever_ready = True
        self.notify(
            {
                "type": "ready",
                "ready": self._ready(),
                "generation": self.control.generation,
            }
        )
        return Response(None, status=101, web_socket=client)

    def _release_socket(self, role):
        entry = self.media_listeners.pop(role, None)
        if entry:
            ws, listeners = entry
            for name, proxy in listeners:
                ws.removeEventListener(name, proxy)
                proxy.destroy()

    def _on_media_message(self, role, ws, event):
        if not self.active:
            return
        message = event.data
        if isinstance(message, str):
            self.fail_call("adapter_protocol", ValueError("Expected a binary SFU packet"))
        elif role != "input":
            self.fail_call("adapter_protocol", ValueError("Audio arrived on the wrong connection"))
        else:
            # Listeners cannot await, so packets queue here and one task hands
            # them to the recognizer in arrival order.
            raw = message.to_bytes() if hasattr(message, "to_bytes") else bytes(message)
            try:
                self.media_input.put_nowait(raw)
            except asyncio.QueueFull:
                self.fail_call("audio_input_backlog", AudioInputBacklog("Media input is full"))

    async def receive_audio(self):
        while self.active:
            raw = await self.media_input.get()
            try:
                packet = decode_packet(raw)
                pcm = self.converter.incoming(packet["payload"])
                self.stats["input_packets"] += 1
                self.stats["input_pcm_bytes"] += len(packet["payload"])
                if pcm:
                    await self.pipeline_input.queue_audio(pcm)
            except AudioInputBacklog as exc:
                self.fail_call("audio_input_backlog", exc)
                return
            except Exception as exc:
                self.fail_call("audio_input", exc)
                return

    def _on_media_close(self, role, ws, event):
        self.event("socket_closed", role=role, code=int(event.code))
        try:
            ws.close(1000, "Voice connection closed")
        except Exception:
            pass
        if not self.active:
            return
        if role == "input":
            # The public egress adapter retries this same credential for 15 sec.
            self.input_disconnected_at = None if self.sockets("input") else time.monotonic()
        else:
            self._stop_soon("output_disconnected")

    def _on_media_error(self, role, ws, event):
        self.event("socket_error", role=role)
        if self.active and role == "input":
            self.input_disconnected_at = (
                None if self.sockets("input") else self.input_disconnected_at or time.monotonic()
            )
        elif self.active:
            self._stop_soon("socket_error")

    async def watch_session(self):
        while self.active:
            await asyncio.sleep(0.5)
            if self._ready():
                self.ever_ready = True
                self.input_disconnected_at = None
            if time.time() >= self.expires:
                self._stop_soon("session_timeout")
            elif not self.is_present():
                self._stop_soon("browser_disconnected")
            elif not self.pipeline_ready or not self.runner_task or self.runner_task.done():
                self._stop_soon("pipeline_stopped")
            elif not self.flux or not self.flux.is_open:
                self._stop_soon("provider_disconnected")
            elif self.input_disconnected_at and time.monotonic() - self.input_disconnected_at >= 16:
                self._stop_soon("input_reconnect_expired")
            elif (
                not self.ever_ready
                and self.attach_deadline
                and time.monotonic() >= self.attach_deadline
            ):
                self._stop_soon("connection_timeout")

    async def finish(self, reason="finished"):
        if self.finish_task is None or (self.finish_task.done() and not self.cleanup_complete):
            self.finish_task = asyncio.create_task(
                self._finish(reason), name="voice-session-cleanup"
            )
        await asyncio.shield(self.finish_task)

    async def _finish(self, reason):
        self.active = False
        self.adapter_auth.revoke()
        self.stats["finish_reason"] = reason
        self.notify({"type": "closing", "reason": reason})
        cleanup_errors = []
        if self.flux:
            try:
                async with asyncio.timeout(4):
                    await self.flux.stop()
            except Exception as exc:
                cleanup_errors.append({"stage": "provider", "type": type(exc).__name__})
                self.fail_call("provider_cleanup", exc)
        if self.runner and self.runner_task and not self.runner_task.done():
            try:
                async with asyncio.timeout(10):
                    await self.runner.cancel(reason=reason)
                    await asyncio.shield(self.runner_task)
            except Exception as exc:
                cleanup_errors.append({"stage": "pipeline", "type": type(exc).__name__})
                self.fail_call("pipeline_cleanup", exc)
        current = asyncio.current_task()
        # Do not cancel the task currently awaiting this cleanup operation.
        remaining = [
            task
            for task in self.tasks
            if task is not current and task.get_name() != "voice-session-finish" and not task.done()
        ]
        for task in remaining:
            task.cancel()
        try:
            async with asyncio.timeout(5):
                await asyncio.gather(*remaining, return_exceptions=True)
        except Exception as exc:
            cleanup_errors.append({"stage": "tasks", "type": type(exc).__name__})
            self.fail_call("task_cleanup", exc)
        for ws in self.sockets():
            try:
                ws.close(1000, "Voice session ended")
            except Exception:
                pass
        for role in list(self.media_listeners):
            self._release_socket(role)
        self.pipeline_ready = False
        self.stats["cleanup_errors"] = cleanup_errors
        self.cleanup_complete = not cleanup_errors
        self.event("finished", reason=reason)
        await asyncio.sleep(0)

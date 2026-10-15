"""Workers-native Flux audio client; no Pipecat or native Python dependencies.

Call start() inside an active Worker/DO request, send 16 kHz mono PCM16 chunks,
then stop() when the call ends. on_event must be async and should enqueue work
rather than await a complete LLM/TTS response. It receives genuine provider
fields in arrival order; this bridge never invents speech or turn events.
"""

import asyncio
import inspect
import json
import math
import re
import time

from pyodide.ffi import create_proxy
from workers.asgi import acquire_js_buffer

MODEL = "@cf/deepgram/flux"
SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2
MAX_AUDIO_CHUNK_BYTES = 64000
MAX_MODEL_MESSAGE_CHARS = 65536
MAX_TRANSCRIPT_CHARS = 8192
CONNECT_TIMEOUT_SECONDS = 20.0
CALLBACK_TIMEOUT_SECONDS = 5.0
CLOSE_TIMEOUT_SECONDS = 1.0
DRAIN_TIMEOUT_SECONDS = 2.0
EVENT_QUEUE_CAPACITY = 64


class FluxBridge:
    """One call's Flux connection, with bounded callback delivery and cleanup.

    start(): establish the native Workers AI WebSocket.
    send_audio(bytes): synchronously send one bounded PCM chunk; raises on close
        or invalid sample alignment/size.
    stop(drain_events=False): close and cancel owned tasks. Passing True gives
        already received events up to two seconds to finish delivery.
    snapshot(): counters and lifecycle state without transcripts.

    The configurable session guard defaults to three minutes.
    Application queue limits belong at the caller. Native WebSocket.send has no
    drain primitive; a successful write does not acknowledge remote consumption.
    """

    def __init__(self, env, on_event, *, max_session_seconds=180.0, keyterms=()):
        if not callable(on_event):
            raise TypeError("on_event must be an async callable")
        if not 1 <= max_session_seconds <= 3600:
            raise ValueError("max_session_seconds must be between 1 and 3600")
        self._env = env
        self._on_event = on_event
        self._max_session_seconds = float(max_session_seconds)
        self._keyterms = tuple(keyterms)
        if len(self._keyterms) > 100 or any(
            not isinstance(term, str) or not 1 <= len(term) <= 100 for term in self._keyterms
        ):
            raise ValueError("Flux keyterms must be up to 100 short, nonempty terms")
        self._queue = asyncio.Queue(maxsize=EVENT_QUEUE_CAPACITY)
        self._closed = asyncio.Event()
        self._ws = None
        self._listeners = []
        self._connect_task = None
        self._consumer_task = None
        self._watchdog_task = None
        self._stop_task = None
        self._stop_initiator = None
        self._stop_requested = False
        self._state = "new"
        self._started_at = None
        self._stopped_at = None
        self._counts = {
            "audio_chunks_sent": 0,
            "audio_bytes_sent": 0,
            "provider_messages": 0,
            "events_delivered": 0,
            "events_discarded_on_stop": 0,
            "events_ignored_during_stop": 0,
            "queue_high_water": 0,
            "nonempty_transcripts": 0,
            "event_counts": {},
        }

    @property
    def is_open(self):
        return self._state == "open" and not self._stop_requested

    def _elapsed_ms(self):
        if self._started_at is None:
            return 0.0
        end = self._stopped_at if self._stopped_at is not None else time.monotonic()
        return round((end - self._started_at) * 1000, 1)

    async def start(self):
        if self._stop_requested:
            raise RuntimeError("A stopped FluxBridge cannot be restarted")
        if self.is_open:
            return
        if self._connect_task is None:
            self._started_at = time.monotonic()
            self._state = "connecting"
            self._connect_task = asyncio.create_task(self._connect())
        try:
            await asyncio.shield(self._connect_task)
        except asyncio.CancelledError:
            self._request_stop("start_cancelled")
            raise
        except Exception as exc:
            self._counts["error_type"] = type(exc).__name__
            self._request_stop("connect_error")
            await self.stop()
            raise

    async def _connect(self):
        self._counts["connect_task_dispatch_ms"] = self._elapsed_ms()
        upgrade_started = time.monotonic()
        response = await asyncio.wait_for(
            self._env.AI.run(
                MODEL,
                {
                    "encoding": "linear16",
                    "sample_rate": str(SAMPLE_RATE),
                    "eot_timeout_ms": "1500",
                    **({"keyterm": list(self._keyterms)} if self._keyterms else {}),
                },
                {"websocket": True},
            ),
            timeout=CONNECT_TIMEOUT_SECONDS,
        )
        self._counts["ai_upgrade_ms"] = round((time.monotonic() - upgrade_started) * 1000, 1)
        accept_started = time.monotonic()
        native_response = getattr(response, "js_response", response)
        status = int(native_response.status)
        self._counts["upgrade_status"] = status
        if status != 101:
            raise ConnectionError("Flux did not accept the WebSocket upgrade")
        self._ws = native_response.webSocket
        if self._stop_requested:
            self._ws.close(1000, "Call ended during connection")
            raise ConnectionError("Call ended during Flux connection")
        for name, callback in (
            ("message", self._on_message),
            ("close", self._on_close),
            ("error", self._on_error),
        ):
            proxy = create_proxy(callback)
            self._listeners.append((name, proxy))
            self._ws.addEventListener(name, proxy)
        self._consumer_task = asyncio.create_task(self._consume_events())
        self._ws.accept()
        self._ws.binaryType = "arraybuffer"
        self._counts["socket_accept_ms"] = round((time.monotonic() - accept_started) * 1000, 1)
        self._state = "open"
        self._counts["connection_ms"] = self._elapsed_ms()
        self._watchdog_task = asyncio.create_task(self._session_guard())

    def send_audio(self, pcm):
        if not isinstance(pcm, bytes):
            raise TypeError("Audio must be bytes containing mono PCM16")
        if len(pcm) % 2 or len(pcm) > MAX_AUDIO_CHUNK_BYTES:
            raise ValueError("PCM chunk must be aligned and no larger than 64000 bytes")
        if not self.is_open or self._ws is None or self._ws.readyState != 1:
            raise ConnectionError("Flux WebSocket is not open")
        if not pcm:
            return
        try:
            with acquire_js_buffer(pcm) as buffer:
                self._ws.send(buffer)
        except Exception as exc:
            self._counts["error_type"] = type(exc).__name__
            self._request_stop("audio_send_error")
            raise ConnectionError("Flux audio send failed") from None
        self._counts["audio_chunks_sent"] += 1
        self._counts["audio_bytes_sent"] += len(pcm)

    def _on_message(self, message):
        if self._stop_requested:
            self._counts["events_ignored_during_stop"] += 1
            return
        self._counts["provider_messages"] += 1
        if "first_message_ms" not in self._counts:
            self._counts["first_message_ms"] = self._elapsed_ms()
        data = message.data
        if not isinstance(data, str) or len(data) > MAX_MODEL_MESSAGE_CHARS:
            self._request_stop("invalid_provider_message")
            return
        try:
            payload = json.loads(data)
        except ValueError, RecursionError:
            self._request_stop("invalid_provider_json")
            return
        if not isinstance(payload, dict):
            self._request_stop("invalid_provider_payload")
            return
        event = {}
        for key in ("type", "event"):
            value = payload.get(key)
            if isinstance(value, str) and len(value) <= 64:
                event[key] = value
        name = event.get("event") or event.get("type")
        if name is None:
            self._request_stop("missing_provider_event_type")
            return
        if name == "Error":
            # Retain only bounded error identifiers and classifications, never
            # arbitrary provider bodies, transcripts, credentials or URLs.
            code = payload.get("code")
            if type(code) is int or (
                isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_-]{1,95}", code)
            ):
                self._counts["provider_error_code"] = code
                event["code"] = code
            description = payload.get("description")
            if isinstance(description, str):
                lower = description.lower()
                if "no_audio" in lower or "no audio" in lower:
                    self._counts["provider_error_category"] = "no_audio"
                elif "timeout" in lower or "timed out" in lower:
                    self._counts["provider_error_category"] = "timeout"
                elif "encoding" in lower or "sample_rate" in lower or "sample rate" in lower:
                    self._counts["provider_error_category"] = "audio_configuration"
        transcript = payload.get("transcript")
        if isinstance(transcript, str):
            if len(transcript) > MAX_TRANSCRIPT_CHARS:
                self._request_stop("transcript_size_limit")
                return
            # Forward even an empty transcript exactly as received.
            event["transcript"] = transcript
            if transcript.strip():
                self._counts["nonempty_transcripts"] += 1
        for key in ("turn_index", "sequence_id"):
            if type(payload.get(key)) is int:
                event[key] = payload[key]
        for key in ("audio_window_start", "audio_window_end", "end_of_turn_confidence"):
            value = payload.get(key)
            if type(value) in (int, float) and math.isfinite(value):
                event[key] = value
        counts = self._counts["event_counts"]
        counts[name] = counts.get(name, 0) + 1
        if name in ("StartOfTurn", "EndOfTurn"):
            self._counts["last_" + name + "_ms"] = self._elapsed_ms()
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            self._request_stop("event_queue_limit")
            return
        self._counts["queue_high_water"] = max(
            self._counts["queue_high_water"], self._queue.qsize()
        )
        if name == "Error":
            self._request_stop("provider_error_event", drain_events=True)

    async def _consume_events(self):
        while True:
            event = await self._queue.get()
            try:
                result = self._on_event(event)
                if not inspect.isawaitable(result):
                    raise TypeError("on_event must return an awaitable")
                # asyncio.timeout keeps the callback in this task, so shutdown
                # can recognize a callback that calls await bridge.stop().
                async with asyncio.timeout(CALLBACK_TIMEOUT_SECONDS):
                    await result
                self._counts["events_delivered"] += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._counts["error_type"] = type(exc).__name__
                self._request_stop("event_callback_error")
                return
            finally:
                self._queue.task_done()
            if self._stop_requested and self._stop_initiator is asyncio.current_task():
                return

    def _on_close(self, event):
        self._counts["close_code"] = int(event.code)
        reason = getattr(event, "reason", "")
        if isinstance(reason, str):
            known = re.search(r"\b(?:NET|DATA)-[0-9]{4}\b", reason)
            if known:
                self._counts["provider_close_reason_code"] = known.group(0)
            if "no_audio_timeout" in reason.lower():
                self._counts["provider_close_category"] = "no_audio_timeout"
        self._closed.set()
        self._request_stop("provider_closed", drain_events=True)

    def _on_error(self, event):
        self._closed.set()
        self._request_stop("websocket_error")

    async def _session_guard(self):
        await asyncio.sleep(self._max_session_seconds)
        self._request_stop("session_time_limit")

    def _request_stop(self, reason, *, drain_events=False):
        if self._stop_task is None:
            self._stop_requested = True
            self._state = "stopping"
            self._counts["stop_reason"] = reason
            try:
                self._stop_initiator = asyncio.current_task()
            except RuntimeError:
                self._stop_initiator = None
            self._stop_task = asyncio.create_task(self._shutdown(drain_events))
        return self._stop_task

    async def stop(self, *, drain_events=False):
        task = self._request_stop("requested", drain_events=drain_events)
        if asyncio.current_task() is task:
            return
        # A callback can join an already-running shutdown that is waiting for
        # this callback to finish; returning breaks that reentrant wait cycle.
        if (
            asyncio.current_task() is self._consumer_task
            and self._stop_initiator is not self._consumer_task
        ):
            return
        await asyncio.shield(task)

    async def _shutdown(self, drain_events):
        current = asyncio.current_task()
        cancelled = []
        for task in (self._connect_task, self._watchdog_task):
            if task is not None and task is not current and not task.done():
                task.cancel()
                cancelled.append(task)
        if cancelled:
            await asyncio.gather(*cancelled, return_exceptions=True)
        if self._ws is not None:
            try:
                self._ws.close(1000, "Call ended")
            except Exception:
                pass
            try:
                await asyncio.wait_for(self._closed.wait(), timeout=CLOSE_TIMEOUT_SECONDS)
            except TimeoutError:
                self._counts["close_wait_timeout"] = True
        consumer = self._consumer_task
        # If stop was called inside on_event, waiting for/cancelling its parent
        # task would cancel the very stop() call requesting cleanup.
        if consumer is not None and consumer is not self._stop_initiator:
            if drain_events and not consumer.done():
                try:
                    await asyncio.wait_for(self._queue.join(), timeout=DRAIN_TIMEOUT_SECONDS)
                except TimeoutError:
                    self._counts["event_drain_timeout"] = True
            if not consumer.done():
                consumer.cancel()
            await asyncio.gather(consumer, return_exceptions=True)
        while not self._queue.empty():
            self._queue.get_nowait()
            self._queue.task_done()
            self._counts["events_discarded_on_stop"] += 1
        if self._ws is not None:
            for name, proxy in self._listeners:
                try:
                    self._ws.removeEventListener(name, proxy)
                except Exception:
                    pass
                proxy.destroy()
        self._listeners.clear()
        self._ws = None
        self._closed.set()
        self._state = "stopped"
        self._stopped_at = time.monotonic()

    def snapshot(self):
        return {
            **self._counts,
            "event_counts": dict(self._counts["event_counts"]),
            "state": self._state,
            "model": MODEL,
            "sample_rate": SAMPLE_RATE,
            "channels": 1,
            "encoding": "linear16",
            "elapsed_ms": self._elapsed_ms(),
            "audio_ms_sent": round(self._counts["audio_bytes_sent"] / BYTES_PER_SECOND * 1000, 1),
            "queue_depth": self._queue.qsize(),
            "session_limit_seconds": self._max_session_seconds,
        }

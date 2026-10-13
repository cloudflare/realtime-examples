"""Bound Loguru records emitted as structured Workers console objects."""

import json
import re
import sys
import uuid
from pathlib import PurePath

from loguru import logger

_FIELDS = {
    "call_id",
    "request_id",
    "operation",
    "scope",
    "phase",
    "reason",
    "stage",
    "provider",
    "model",
    "status",
    "elapsed_ms",
    "generation",
    "tool",
    "tool_call_id",
    "error_type",
    "error_category",
    "error_code",
    "error_reference",
    "error_location",
    "retryable",
    "overloaded",
    "attempt",
    "adapters_pending",
    "tracks_pending",
    "engine_complete",
    "prompt_tokens",
    "completion_tokens",
    "cached_prompt_tokens",
    "provider_reason",
    "provider_error_code",
    "provider_close_code",
    "processor",
    "processor_usable",
    "fatal",
    "text_characters",
}
_CATEGORIES = (
    ("memory_limit", r"memory.{0,40}(?:limit|exceed)|out of memory|allocation failed"),
    ("cpu_limit", r"cpu.{0,40}(?:limit|exceed)|exceed.{0,20}cpu"),
    ("overloaded", r"overload|too many requests|too many concurrent"),
    ("request_context", r"I/O.{0,100}(?:context|different request)"),
    ("object_reset", r"(?:object|isolate).{0,60}(?:reset|replac|restart)"),
    ("network", r"network connection lost|connection (?:reset|closed|refused)"),
    ("timeout", r"timed out|timeout|time limit"),
    (
        "context_limit",
        r"context_length_exceeded|maximum context length|"
        r"context (?:length|window).{0,40}exceed",
    ),
    ("reply_limit", r"Incomplete model reply: length"),
    ("audio_backlog", r"recognizer input queue is full"),
    ("internal", r"internal error"),
)


def exception_fields(exc):
    """Keep error classifications and a source location, never exception payloads."""
    try:
        message = str(exc)[:4096]
    except Exception:
        message = ""
    result = {
        "error_type": type(exc).__name__,
        "error_category": next(
            (name for name, pattern in _CATEGORIES if re.search(pattern, message, re.I)),
            "unexpected",
        ),
    }
    if isinstance(exc, TimeoutError):
        result["error_category"] = "timeout"
    elif isinstance(exc, ConnectionError):
        result["error_category"] = "network"
    reference = re.search(
        r"(?:reference\s*[=:]|wdErrId\s*[=:])\s*([a-f0-9-]{16,64})\b", message, re.I
    )
    if reference:
        result["error_reference"] = reference.group(1)
    trace = exc.__traceback__
    if trace:
        while trace.tb_next:
            trace = trace.tb_next
        result["error_location"] = (
            f"{PurePath(trace.tb_frame.f_code.co_filename).name}:{trace.tb_lineno}"
        )
    try:
        native = getattr(exc, "js_error", exc)
        for flag in ("retryable", "overloaded"):
            value = getattr(native, flag, None)
            if isinstance(value, bool):
                result[flag] = value
    except Exception:
        # Inspecting a JS exception must not replace the original failure.
        pass
    return result


def _write(payload):
    if sys.platform == "emscripten":
        from js import Object, console
        from pyodide.ffi import to_js

        method = {"error": console.error, "warning": console.warn}.get(
            payload["level"], console.log
        )
        method(to_js(payload, dict_converter=Object.fromEntries))
    else:
        print(json.dumps(payload))


def _sink(message):
    record = message.record
    event = record["message"]
    if not re.fullmatch(r"[a-z_]{1,80}", event):
        return
    payload = {"event": event, "level": record["level"].name.lower()}
    for key, value in record["extra"].items():
        if key not in _FIELDS or value is None:
            continue
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_./:@-]{1,160}", value):
            payload[key] = value
        elif type(value) in (int, float, bool):
            payload[key] = value
    try:
        _write(payload)
    except Exception:
        # A logging failure must not break the call or dump the original record.
        print(json.dumps(payload))


logger.remove()
logger.add(
    _sink,
    filter=lambda record: record["extra"].get("component") == "voice_agent",
    format="{message}",
    level="INFO",
    catch=False,
)
logger.disable("pipecat")
log = logger.bind(component="voice_agent")


def failure(event, exc, **context):
    request_id = uuid.uuid4().hex
    log.bind(**context).error(event, request_id=request_id, **exception_fields(exc))
    return request_id

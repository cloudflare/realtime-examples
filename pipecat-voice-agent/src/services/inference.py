"""Workers AI requests: classified failures and one retry within one deadline."""

import asyncio
import re

from pipecat.utils.errors import (
    ErrorCategory,
    classify_http_exception,
    classify_http_status_code,
    extract_http_status_code,
)

from server.observability import exception_fields

REQUEST_TIMEOUT_SECONDS = 25
RETRY_DELAY_SECONDS = 0.3


class InferenceError(RuntimeError):
    def __init__(self, category, *, status=None, code=None):
        super().__init__("Workers AI inference failed")
        self.category, self.status, self.code = category, status, code

    @property
    def retryable(self):
        return (
            self.category in {ErrorCategory.CONNECTIVITY, ErrorCategory.SERVER} or self.code == 3040
        )


def inference_error(exc):
    if isinstance(exc, InferenceError):
        return exc
    native = getattr(exc, "js_error", exc)
    status = extract_http_status_code(native) or extract_http_status_code(exc)
    category = (
        classify_http_status_code(status) if status is not None else classify_http_exception(native)
    )
    # The AI binding puts its internal code at the start of the JS error message.
    # Do not consult binding.lastRequest* fields: concurrent requests share them.
    message = str(getattr(native, "message", exc))[:4096]
    match = re.match(r"(?:\w+Error:\s*)?(\d{3,5}):", message)
    code = int(match[1]) if match else None
    if code == 3040:
        category = ErrorCategory.RATE_LIMIT
    elif code == 3036:
        category = ErrorCategory.QUOTA
    elif status is None and code is not None and 400 <= code < 600:
        status = code
        category = classify_http_status_code(status)
    elif category == ErrorCategory.UNKNOWN:
        category = {
            "network": ErrorCategory.CONNECTIVITY,
            "timeout": ErrorCategory.CONNECTIVITY,
            "internal": ErrorCategory.SERVER,
        }.get(exception_fields(exc)["error_category"], ErrorCategory.UNKNOWN)
    return InferenceError(category, status=status, code=code)


async def run_inference(
    ai, model, inputs, options, *, log, is_current, timeout=REQUEST_TIMEOUT_SECONDS
):
    """Retry the request, never audio playback, model parsing, or tool execution."""
    try:
        async with asyncio.timeout(timeout):
            for attempt in range(2):
                if not is_current():
                    raise asyncio.CancelledError()
                try:
                    response = await ai.run(model, inputs, options)
                    if options.get("returnRawResponse"):
                        native = getattr(response, "js_response", response)
                        status = int(native.status)
                        if status != 200:
                            # Discard an error body without reading/logging its payload.
                            if native.body is not None:
                                try:
                                    async with asyncio.timeout(2):
                                        await native.body.cancel()
                                except Exception:
                                    pass
                            raise InferenceError(classify_http_status_code(status), status=status)
                    return response
                except Exception as exc:
                    error = inference_error(exc)
                    if attempt or not error.retryable:
                        if error is exc:
                            raise
                        raise error from exc
                    log.warning(
                        "provider_retry",
                        attempt=2,
                        status=error.status,
                        error_code=error.category.value,
                        provider_error_code=error.code,
                    )
                    await asyncio.sleep(RETRY_DELAY_SECONDS)
    except TimeoutError as exc:
        raise InferenceError(ErrorCategory.CONNECTIVITY) from exc

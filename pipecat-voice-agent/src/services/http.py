"""Bound streamed lookup responses before parsing them."""


class LookupUnavailable(Exception):
    """A safe, caller-facing lookup failure, without the provider's raw response."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


async def read_limited(response, limit: int) -> bytes:
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(body) + len(chunk) > limit:
            raise ValueError("Lookup response exceeds its byte limit")
        body.extend(chunk)
    return bytes(body)

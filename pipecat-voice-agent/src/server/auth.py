"""Browser authentication boundary; SFU adapter credentials live in transport.auth."""

from typing import Protocol

from workers import Response


class BrowserAuth(Protocol):
    """Providers return a stable owner or raise ApiError for rejected requests.

    Identity verification is async so providers can fetch and cache JWT keys.
    Call ownership and same-origin checks remain outside the provider.
    """

    async def identity(self, request) -> str: ...

    async def session(self, request) -> dict[str, bool]: ...

    async def login(self, request) -> Response: ...

    async def logout(self, request) -> Response: ...


def browser_auth(env) -> BrowserAuth:
    """Replace this factory to use another browser identity provider."""
    from server.auth_code import AccessCodeAuth

    return AccessCodeAuth(env)

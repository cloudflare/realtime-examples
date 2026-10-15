"""Per-call SFU adapter credentials, independent of browser authentication."""

import hashlib
import hmac


class AdapterAuth:
    def __init__(self):
        self._digest = ""

    def issue(self):
        from js import crypto

        token = str(crypto.randomUUID()) + str(crypto.randomUUID())
        self._digest = hashlib.sha256(token.encode()).hexdigest()
        return token

    def accepts(self, token):
        # Keep the credential valid for reconnects during this call. Only its
        # digest is retained; the plain token goes to the SFU in its endpoint.
        return bool(self._digest and token) and hmac.compare_digest(
            hashlib.sha256(token.encode()).hexdigest(), self._digest
        )

    def revoke(self):
        self._digest = ""

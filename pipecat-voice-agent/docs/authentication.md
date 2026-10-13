# Authentication

The default shared access code is suitable for evaluating the example with a known group. Everyone uses the same code, but each browser session owns its own calls. Use an identity provider when people need individual access control or revocation.

`APP_PASSWORD` controls new sign-ins. Changing it does not revoke existing signed sessions; rotate `SESSION_SECRET` when those sessions must be invalidated as well.

## Authorization

A call belongs to the browser session that created it. Later requests for the call must come from the same owner, so knowing a call ID grants nothing. Requests that change state must come from the app's own origin, and call creation and sign-in attempts are [rate limited](../wrangler.jsonc) per owner and per IP address.

The SFU's adapter connections don't carry the browser session. They use a [per-call token](../src/transport/auth.py) that is issued when the assistant is prepared and stops working when the call ends or expires.

## Use another browser identity provider

Implement [the server authentication contract](../src/server/auth.py) and select it in the provider factory. Return a stable owner identity so reauthentication does not orphan the person's existing calls. Keep call ownership and same-origin checks in place.

Pair it with [a browser authentication provider](../web/src/auth/provider.ts), selected in [the frontend factory](../web/src/auth/index.ts). This is where sign-in UI, redirects, and logout navigation belong. Call setup should receive authenticated state without handling credentials.

## Cloudflare Access

Configure Access at the edge and verify JWT signatures, issuer, audience, and expiry in the server provider. An email header by itself is not verified identity.

An expired Access session can return a login redirect or HTML where the frontend expects JSON. Have the browser provider navigate to reauthenticate; retrying the API request alone cannot complete an interactive login. Use Access's logout navigation when signing out.

The SFU's adapter connections need a separate edge policy. They cannot supply custom authentication headers or follow login redirects. Allow them to reach `/media/<call-id>/input` and `/media/<call-id>/output`, while preserving [per-call adapter token verification](../src/transport/auth.py). Keep the application pages and `/api/` routes protected.

Some accounts require Access on every endpoint and prohibit this exception. Choose a deployment arrangement that permits adapter ingress; a Worker route exception cannot bypass an edge Access challenge. See the [adapter endpoint requirements](https://developers.cloudflare.com/realtime/sfu/features/media-transport-adapters/websocket-adapter/).

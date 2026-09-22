# Deployment and operations

Use the [README setup](README.md#set-up) for the first deployment. This guide
covers operating and updating your instance. The example remains experimental.
Run `make` commands from `esp32-radio/` and the Wrangler commands below from
`esp32-radio/worker/`.

## Deploy your instance

Set your account explicitly for deploy, secret, rollback, and removal commands:

```sh
export CLOUDFLARE_ACCOUNT_ID=your-account-id
```

`ROBOT_NAME` in `worker/wrangler.jsonc` defaults to `pocket-radio` and selects one
room. Keep it stable across compatible deployments: changing it selects a new
Durable Object rather than moving the existing state. Keep the Worker name
`esp32-radio`, which the helpers use for Vite's `dist/esp32_radio/` path.

The device's exported `SIGNALING_URL` must match your deployed HTTPS origin.
Changing it or the device/Wi-Fi credentials requires a private firmware build
and a board flash. Notify current listeners before a flash/reset, preserve the
verified original backup, and reconnect listeners after the device returns.

Only `worker/dist/client/` is public browser output. Preserve the
[credential and private-artifact boundary](ARCHITECTURE.md#authentication)
when exporting builds or adding CI artifacts.

## Authentication and authorization

The [architecture](ARCHITECTURE.md#authentication) describes device and viewer
authentication and the controller policy. Retain backend authorization when
changing the browser or replacing application signaling.

For a deployment serving distinct users, integrate identity at the Worker auth
seam (or equivalent trusted backend), define device enrollment/revocation, and
add login throttling and abuse controls. Viewer admission and request-size
checks do not provide those policies. Keep local loopback behavior separate
from deployed authentication.

To rotate the viewer password, edit `VIEWER_PASSWORD` in ignored
`.credential.env` and run `make deploy` from `esp32-radio/`. New API requests
must authenticate under the new password. Existing WebRTC transport is not
closed synchronously by a password change; browser polling/heartbeats and
cleanup handle departure. Rotating the SFU token also needs the matching local
provisioning update. Device-token rotation needs a coordinated firmware update.
Restart local `make dev` after credential changes. Keep credentials out of logs.

## Observe and troubleshoot

The browser distinguishes status, connection, heartbeat, and control failures.
Audio receiver statistics, spectrum updates, command acknowledgments, and
hardware measurements help separate application signaling from the WebRTC path.
Unavailable hardware readings are displayed as unavailable, not zero.

The Worker logs operation, status, duration, and request ID for selected
requests; SFU warnings identify the operation and status. Read the browser's
`X-Request-Id` when correlating a failed request. From `esp32-radio/worker/`,
after selecting your account:

```sh
./node_modules/.bin/wrangler tail --name esp32-radio
```

Use `make monitor` for the board's filtered USB diagnostics. Do not add raw
SDP, bearer headers, cookies, packet payloads, or firmware contents to logs.
SFU warnings include bounded symbolic request and item error codes; descriptions
and SDP are omitted. Non-symbolic codes become `unrecognized_error_code`.
The [troubleshooting guide](TROUBLESHOOTING.md) maps symptoms to these checks.

## Stop and clean up

1. Select **Release control** and **Disconnect** in open listeners, then power
   off the board to stop publication and its automatic recovery loop.
2. Keep the Worker and its SFU credentials available for cleanup retries while
   the publisher generation is current. Replacement or expiry discards its
   receipts and ends retries. Check SFU failures before retirement; offline
   status and zero viewers do not prove old media or reply access stopped.
   Applications needing confirmed revocation must adapt the
   [cleanup policy](ARCHITECTURE.md#cleanup-and-failure-behavior).
3. When removing your dedicated example deployment, run from
   `esp32-radio/worker/` with the intended account selected:

   ```sh
   ./node_modules/.bin/wrangler delete --name esp32-radio --config wrangler.jsonc
   ```

   Review the resources named by the command before confirming deletion. See
   [Wrangler delete](https://developers.cloudflare.com/workers/wrangler/commands/workers/#delete).
   Check the account afterward for remaining example Worker/Durable Object
   resources and custom-domain DNS records. Remove only resources dedicated to
   this instance, and remove its SFU app through the dashboard when it is no
   longer needed by any endpoint.
4. Stop local development/monitoring processes with Ctrl-C. Retain the verified
   board backup privately. Keep or remove local secrets, generated firmware/music,
   `.tools/`, and `worker/.wrangler/` according to your recovery needs.

## Compatible updates

Preserve the `RobotRoom` export, binding, migration history, and persisted state
shape. State changes need a migration and rollback plan. Deploy a compatible
browser/Worker before firmware protocol changes and refresh open listeners.
See [ERRATA](ERRATA.md) before rollback for cleanup-policy differences, pending
allocation receipts, and music pack/partition compatibility.

For a compatible rollback, run
`./node_modules/.bin/wrangler rollback <version-id>` from `worker/`, with your
account selected. Use the [declared checks](README.md#development) and the
component guides' build/live checks when validating changes.

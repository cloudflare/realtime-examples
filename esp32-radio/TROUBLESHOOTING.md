# Troubleshooting

Separate application signaling from firmware-to-SFU WebRTC. The Worker can be
reachable while UDP media is blocked, and the browser exhibit can render without
a board. The [firmware/SFU walkthrough](firmware/docs/sfu.md) identifies the
owner and protocol for each stage.

| Symptom | Check and next action |
| --- | --- |
| Firmware setup rejects the host | `make setup-firmware` supports Linux x86_64. Use the documented build host and prerequisites; host tests on another OS do not establish firmware-toolchain support. |
| Board does not boot or flash layout is rejected | Confirm ESP32-S3-DevKitC-1 N32R16V, native USB, octal flash/PSRAM settings and the saved backup. Read [memory and music compatibility](ERRATA.md) before changing the partition table. |
| `clang-format` missing or wrong version | Run `make setup-c-format` from `esp32-radio/`; the pinned formatter lives under `.tools/` independently of the full SDK. |
| Worker build cannot find credentials | If private files exist, fill the four Worker values in `.credential.env` and run `make secrets`. A clean checkout with no private files can run the host/build tests using synthetic bindings. Do not copy a private `.dev.vars` to browser assets. |
| Deployment still names an example hostname | Replace `radio.example.com` in `worker/wrangler.jsonc`, select your account, and export the same HTTPS origin as `SIGNALING_URL` when building firmware. Keep the Worker name expected by the helper. |
| Local preview says the deployed board is offline | `make dev` has local, independent room state. Use `make dev-live` with an explicit deployed `SIGNALING_URL` when you intend to use that board; deployed viewer authentication still applies. |
| Viewer API returns 401 | Enter the viewer password. After rotation or cookie expiry, authenticate again. Device requests instead require the configured device bearer token. |
| Viewer operation returns 403 | Check that the request belongs to that viewer and satisfies origin policy. Viewer IDs do not replace their per-viewer tokens. A repeated leave after successful cleanup may also return 403. |
| Device generation changed / viewer gets 409 | A publisher was replaced or became unavailable. Wait for the board to be online, then select **Start listening**. Do not reuse an old generation or viewer token. |
| Signaling succeeds but WebRTC will not connect | Check outbound IPv4 UDP on the board's network and browser network. This firmware implements no TURN/TCP fallback. Check the board's filtered connection logs without printing SDP. |
| Channels never open | Confirm stream 0 bootstrap and the actual SFU-returned IDs on each endpoint. Check `robot`/`spectrum` profiles and the browser's `waitForAck` acknowledgment. Never substitute the publisher's IDs for the subscriber's. |
| Audio connected but inaudible | Select **Enable sound** if shown, check local mute/volume and device output, then inspect receiver statistics. Shared pause sends silence; local mute does not pause the board. |
| Spectrum or metadata looks stale | Check publisher generation and playback revision, channel receipt, and analysis freshness. Preserve the [music/protocol compatibility rules](ERRATA.md#music-pack-compatibility). |
| Hardware meters show unavailable | Check the metrics sampler and the board build. A missing/stale sample is deliberately unavailable; it is not a zero measurement. See [hardware metrics](firmware/README.md#hardware-metrics). |
| Take control is unavailable | Start listening, wait for channels, and check whether another viewer owns the lease. Release/expiry must revoke SFU reply permission successfully before handoff; do not bypass it in the UI. |
| All eight slots are occupied | Disconnect unused listeners. Inactivity cleanup and pending SFU cleanup can delay reuse. See the Worker's [listener policy](ARCHITECTURE.md#authorization) when adapting admission. |
| Board restarts repeatedly | Inspect filtered USB error/status messages, Wi-Fi, signaling auth, and transport failure. Read [ERRATA](ERRATA.md) before changing crypto, task stacks, memory placement, or buffering. |
| SFU cleanup is failing | Keep the Worker deployed and its SFU credentials valid. Failed resource receipts are retained for retry. Removing the backend does not prove those resources were closed. Follow [shutdown](PRODUCTION.md#stop-and-clean-up). |

Use the [board monitor](firmware/README.md#backup-and-flash-details) and
[Worker logs](PRODUCTION.md#observe-and-troubleshoot) to locate the failing
stage. Correlate API failures with `X-Request-Id`, operation and status; keep
SDP, bearer tokens, cookies and private firmware out of reports.

The [Worker guide](worker/README.md#worker-tests) separates portable tests,
simulated SFU tests, fixture browser tests, and the live two-listener test.
Use the test for the boundary you changed. Hardware flashing, reset, and live
playback/control tests interrupt current listeners; announce the interruption
and preserve the board backup before running them.

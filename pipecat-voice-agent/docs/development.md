# Development

Run commands from this example's directory, `pipecat-voice-agent/`. If Node is managed by nvm, run `nvm use` first.

## Interface preview

`npm run dev` opens the interface at `http://127.0.0.1:5173` with sample states. It needs no Python, credentials, microphone, or network backend. Any access code works in this preview.

Use the scenario selector to work on connection, conversation, authentication, and failure states. URLs such as `/?scenario=docs-sources` and `/?scenario=tool-running` open a state directly. Add preview cases for new user-visible behavior so it can be reviewed without making a call. Keep preview code excluded from production builds.

## Real calls

First [deploy the backend](deployment.md). Create `.env.local` from `.env.example` and set `VOICE_BACKEND_URL` to the deployed Worker's HTTPS origin, without a path or query string.

```sh
npm run dev:live
```

Open `http://127.0.0.1:5173` and use the deployed app's access code. The SFU connects to the deployed Worker directly; it cannot reach a media endpoint on your laptop's loopback address.

The local API proxy is intended for loopback use. Keep its host and origin checks, and keep credentials out of `VITE_*` variables. The cookie's `Secure` attribute is removed only for local HTTP responses; deployed cookies must retain it.

`npm run build && npm run preview` serves the production frontend locally on port 4173 against the same backend. `npm run worker:dev` is useful for Worker/API work, but a local Worker alone does not provide a publicly reachable SFU adapter endpoint.

## Checks

```sh
uv sync --locked
npm run check
npm run lint:python
npm run test:python
```

Use `npm run format` for Prettier and `npm run format:python` for Ruff. Frontend checks include formatting, tests, and a production build; Python checks use native test doubles at the Workers boundary.

Native Python tests cannot establish Workers runtime compatibility. When changing dependencies, providers, or the media path, also validate a deployed call. See the [Python compatibility guide](../vendor/README.md) before adding packages.

For a voice check, ask a question, give the agent a fact to recall, exercise a tool, interrupt a reply, and end the call. Confirm that capture stops and cleanup finishes. Use a headset so speaker echo does not look like an intentional interruption.

## Timing and connection problems

Browser startup timings are in the console and **Connection details**. Server timings are nested inside browser operations, so adding every row together overcounts setup time. The total measures application startup, including microphone access and network setup; it is not a Worker cold-start measurement. Synchronous Python initialization should be assessed with Workers CPU telemetry because Worker clocks advance with I/O.

For a failed connection, use the negotiation phase and ICE state from the browser console to locate the failing step. Avoid logging raw SDP, adapter callback URLs, cookies, or full provider responses: these can carry credentials or conversation data.

## Worker logs

Use the call ID from the exported transcript to filter `call_id` in the Worker's **Logs** view. For a failed HTTP request, the browser's `[Voice API]` console entry also provides a `CF-Ray` and, when available, an application `requestId`. Search for that value as `request_id` to find the corresponding server failure.

Look for the first failure before cleanup retries: a failing Stop request can be a consequence of an earlier error. A runtime failure can prevent application logging, so also check invocation errors. Logs only exist for traffic after observability was enabled.

Use [the structured logger](../src/server/observability.py) when adding events, and keep payloads out of its allowed fields. Keep URL query redaction enabled because adapter requests carry credentials there.

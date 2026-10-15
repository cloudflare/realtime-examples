# Deployment

You need Node.js 22.12+, Python 3.14, [uv](https://docs.astral.sh/uv/getting-started/installation/), and a Cloudflare account with Workers AI and a [Realtime SFU app](https://developers.cloudflare.com/realtime/sfu/).

The default [DeepSeek model requires paid access](https://developers.cloudflare.com/workers-ai/models/deepseek-v4-flash-0731/). Enable Workers Paid on the target account before using this deployment. Web Search has separate Gateway payment setup below.

The SFU must be able to reach the Worker's adapter endpoints without a browser login challenge. Choose an account and hostname that allow this; see [authentication](authentication.md) before putting the app behind Cloudflare Access.

## Configure

From the `pipecat-voice-agent/` directory:

```sh
npm ci
npm run setup
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
```

Fill in the ignored `.dev.vars` file:

| Secret                | Value                                                         |
| --------------------- | ------------------------------------------------------------- |
| `REALTIME_APP_ID`     | Your SFU app ID                                               |
| `REALTIME_AUTH_TOKEN` | That app's secret, rather than a general Cloudflare API token |
| `APP_PASSWORD`        | The access code people use to sign in                         |
| `SESSION_SECRET`      | A random signing key of at least 32 characters                |

Generate a signing key with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'`. Keep the file and its values out of Git and `VITE_*` variables.

For Web Search, add credits to AI Gateway in the same account, or configure a provider key on the Gateway selected in [the server configuration](../src/agent/config.py). No account API token belongs in the app's secrets. See [Web Search setup](https://developers.cloudflare.com/web-search/how-to-use/) for payment options.

A `402` from Web Search means its payment setup needs attention. Check credits and provider-key configuration on the selected Gateway before retrying; it does not mean the search found no results.

## Deploy

Authenticate Wrangler for the target account, then run:

```sh
export CLOUDFLARE_ACCOUNT_ID=your-account-id
npm run deploy
python3 scripts/worker.py secret bulk .dev.vars
```

Both commands must use the same account. A local `.dev.vars` file does not provision deployed secrets; the app will report that setup is required until the secret upload completes.

Open the printed Worker URL, enter the access code, choose **Continue**, then **Start conversation**. Allow microphone access. With **Tools** enabled, try asking for current weather in a named city or asking "Check the Cloudflare docs: what audio format does the SFU WebSocket adapter use?"

Open-Meteo's free endpoint is restricted to [noncommercial use](https://open-meteo.com/en/terms). Commercial deployments need an appropriate provider plan. Preserve the [weather-data attribution](../NOTICE.md#weather-data) when sharing answers or transcripts.

For subsequent deployments, run `npm run deploy`. Upload secrets again only when their values change. To use your local frontend with this backend, follow [local development with real calls](development.md#real-calls).

## Previews

[Workers Previews](https://developers.cloudflare.com/workers/previews/) (open beta) run a branch at its own URL without replacing production. From the branch, using the same account, run `npm run deploy:preview`.

The script deploys a Preview named after the Git branch, served at `<branch>-realtime-pipecat-voice-agent.<subdomain>.workers.dev`, then uploads `.dev.vars` as its secrets. A new Preview deployment does not keep the previous deployment's secrets, and `wrangler preview --secrets-file` currently fails with API error 10013, so the upload is a separate step. The Preview reports that setup is required until it finishes; if it fails, rerun `npx wrangler preview secret bulk .dev.vars`. The URL is public, like the production one, so the access code still applies.

A Preview inherits none of the top-level bindings. The `previews` block in [the Wrangler configuration](../wrangler.jsonc) declares them again: keep it in step when adding a binding. Without `CALLS`, every request fails with error 1101. Each Preview has its own Durable Object namespace, so its calls never share state with production, while both use the same SFU app.

Delete a Preview when the branch is done with `npx wrangler preview delete`.

## Operating the example

Calls do not resume after a Worker restart or browser disconnect. Short network drops are tolerated: the browser waits 8 seconds for a disconnected audio connection to recover, and the agent waits 16 seconds for the SFU to reconnect its input adapter. An output adapter disconnect ends the call, and so does a browser that stops checking in for a minute. For longer-lived agents, consider [context compaction and persistent memory](agent.md#models-speech-and-conversation-memory) before extending the duration in the server configuration.

Ending a call closes its SFU adapters and tracks. If a close request fails, a Durable Object alarm retries it with backoff, so cleanup can remain pending after the page closes. A failed close request does not prove that an SFU resource is gone; check the call's logs before assuming it was released. The call record is deleted an hour after cleanup succeeds.

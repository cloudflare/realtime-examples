# Realtime SFU - OpenAI WebRTC relay

> Example status: **Legacy**
>
> This example uses stale configuration, allows unauthenticated resource
> creation, and does not implement complete teardown. Its checked-in
> configuration also illustrates plain variables for credentials. Do not use it
> as a production starting point.

This is a historical example of connecting OpenAI's WebRTC Realtime API with
Cloudflare Realtime SFU. The `CALLS_*` environment variable names are retained
for compatibility with the implementation.

## Configuration

Please update the environment variables in wrangler.toml
```
OPENAI_API_KEY = "<openai api key>"
OPENAI_MODEL_ENDPOINT = "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01"
CALLS_BASE_URL = "https://rtc.live.cloudflare.com/v1/apps"
CALLS_APP_ID = "<calls app id>"
CALLS_APP_TOKEN = "<calls app token>"
```

## How to run it
Install dependencies if you run this for first time:
```
npm install --include=dev
```
Once everything is in place, run the dev server:
```
npm start -- --port 7878
```

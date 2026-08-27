# WHIP-WHEP Server

> Example status: **Legacy**
>
> This example uses stale protocol drafts and terminology, configures the
> Realtime SFU secret as a plain variable, and does not authorize or fully clean
> up ingest and playback resources. Do not use it as a production starting
> point.

WHIP and WHEP server implemented on top of the Realtime SFU API. The `CALLS_*`
environment variable names are retained for compatibility with the
implementation.

## Usage
### Configuration
The following environment variables must be set in wrangler.toml before running it:

* CALLS_APP_ID
* CALLS_APP_SECRET

### Install dependencies

```
npm install --include=dev
```

### Run it locally or deploy it to Earth

To run it locally:

```
npx wrangler dev --local
```

If you want it to run on the Cloudflare network:

```
npx wrangler deploy
```

### Ingest
The ingest endpoint will look like \<deployed-domain\>/ingest/\<stream-name\>

Example: http://your-domain.com/ingest/my-live

### Play

The play endpoint will look like \<deployed-domain\>/play/\<stream-name\>

Example: http://your-domain.com/play/my-live

## Bonus: WHEP player
A basic WHEP player can be found under the directory wish-whep-00-player/

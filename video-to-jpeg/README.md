# Cloudflare Realtime Video: WebRTC → JPEG Demo

Stream your camera through the **Cloudflare Realtime SFU** and view it as JPEG snapshots (~1 FPS) using the **WebSocket media transport adapter**.

After deployment, you can share a session with others entirely from your browser. It provides two interfaces: a **Publisher** page for camera control and a **Viewer** page for watching the JPEG stream.

## Quickstart (Deploy First)

> **Important:** We recommend deploying to Cloudflare Workers first before trying local development. The Realtime SFU needs to connect back to your Worker via WebSocket, which doesn't work with `localhost`.

1. Clone and install:
   ```bash
   npm install
   ```

2. Configure `wrangler.jsonc` vars and add secrets (see Configuration below).

3. Build and deploy:
   ```bash
   npm run build:web
   npx wrangler deploy
   ```

4. Open in your browser:
   - Publisher: `https://<your-worker>.workers.dev/<session-name>/publisher`
   - Viewer: `https://<your-worker>.workers.dev/<session-name>/viewer`

## How It Works

This demo uses the Realtime SFU's **WebSocket adapter** to convert WebRTC video into JPEG frames that can be processed in a Worker.

- **Cloudflare Worker**: Serves the UI and handles API requests. All secrets stay on the server.
- **Cloudflare Realtime SFU**: Receives your camera stream via WebRTC and converts video to JPEG frames (~1 FPS).
- **`VideoAdapter` (Durable Object)**: Manages each session. Receives JPEG frames from the SFU and broadcasts them to viewer WebSockets. [See technical details](./ARCHITECTURE.md).
- **Frontend UI**: A TypeScript app bundled with `esbuild` that handles camera access, WebRTC connections, and displays JPEG snapshots.

## Getting Started

### Prerequisites

- A Cloudflare account with **Workers**, **Durable Objects**, and **Realtime SFU** enabled.
- A configured **Realtime SFU application**.
- A **Realtime SFU API bearer token**.
- [Node.js](https://nodejs.org/) and npm.
- The [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

### Configuration

1. **Clone and Install:**
   ```bash
   git clone <repository-url>
   cd calls-examples/video-to-jpeg
   npm install
   ```

2. **Set up `wrangler.jsonc`:**
   Open the file and add your SFU app ID to the `vars` block:

   ```jsonc
   {
     // ... other wrangler config ...
     "vars": {
       "SFU_API_BASE": "https://rtc.live.cloudflare.com/v1",
       "REALTIME_SFU_APP_ID": "<your-realtime-sfu-app-id>"
     }
   }
   ```

3. **Add Your Secret:**
   Use Wrangler to store your Realtime SFU bearer token securely:

   ```bash
   npx wrangler secret put REALTIME_SFU_BEARER_TOKEN
   ```

   This token is used only from the Worker to the Realtime SFU API; it's never exposed to the browser.

## Deploy and Use

1. **Build the frontend:**
   ```bash
   npm run build:web
   ```

2. **Deploy to Cloudflare Workers:**
   ```bash
   npx wrangler deploy
   ```

3. **Open the Publisher page:**
   Navigate to your deployed Worker's URL with any unique session name:
   ```
   https://<your-worker>.workers.dev/<session-name>/publisher
   ```

4. **Start streaming:**
   - Click **Connect Camera** to allow camera access and establish WebRTC.
   - Click **Start JPEG Stream** to begin streaming JPEG snapshots.
   - You'll see your camera feed and the JPEG snapshots side-by-side.

5. **Share the Viewer link:**
   Send the viewer URL to anyone you want to share with:
   ```
   https://<your-worker>.workers.dev/<session-name>/viewer
   ```
   They'll see the JPEG stream without needing camera access.

6. **Stop streaming:**
   - Click **Stop JPEG Stream** to stop the adapter.
   - Click **Reset Session** to clear all state and start fresh.

> **URL patterns:**
> - Publisher: `/<session-name>/publisher`
> - Viewer: `/<session-name>/viewer`

## Local Development (Advanced)

> **⚠️ Localhost Limitation:** The Realtime SFU cannot connect back to `localhost` WebSockets, so the JPEG adapter won't work locally. **We strongly recommend deploying to Workers first** to test the full functionality.

If you still want to develop locally (e.g., for UI changes):

1. **Start the frontend watcher:**
   ```bash
   npm run watch:web
   ```

2. **Start the Worker:**
   ```bash
   npm run dev
   ```

3. **Open in browser:**
   ```
   http://localhost:8787/<session-name>/publisher
   ```

Note: WebRTC and the UI will work, but the JPEG streaming via the adapter will fail because the SFU can't reach your local machine.

For technical details about the architecture, API flows, and implementation, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Troubleshooting

### "Forwarding already active" error

- Click the **Reset Session** button on the publisher page to clear the Durable Object state.
- Alternatively, send a DELETE request: `curl -X DELETE https://<your-worker>.workers.dev/<session-name>`

### Camera not working

- Check your browser's permissions for camera access.
- Try a different browser or device.
- Ensure you're using HTTPS (required for camera access, except on localhost).

### No JPEG frames appearing

- Make sure you clicked **Start JPEG Stream** after connecting the camera.
- Check the browser console for WebSocket errors.
- If testing locally, remember that the SFU can't connect to localhost—deploy to Workers instead.

### Stale UI or 404s on assets

- Run `npm run build:web` to rebuild the frontend.
- Check that `wrangler.jsonc` has `"assets": { "directory": "public" }`.
- Try a hard refresh in your browser.

### Deployed changes not showing up

- Ensure you ran `npm run build:web` before `npx wrangler deploy`.
- Hard refresh your browser to clear cached assets.

## Notes and Limitations

- Video is streamed as **JPEG at approximately 1 FPS** (beta behavior).
- This is a **reference demo** and should not be used in production without:
  - Authentication and authorization
  - Error handling and monitoring
  - Rate limiting and resource controls

For more details, see [ARCHITECTURE.md](./ARCHITECTURE.md).

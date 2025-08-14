# Realtime TTS Audio Streaming with Cloudflare Workers

This folder demonstrates a realtime text-to-speech (TTS) audio streaming solution using Cloudflare Workers, Durable Objects, and Cloudflare's Realtime serverless SFU. Audio is generated via the ElevenLabs API and streamed to clients, with the worker acting as a secure proxy so **no secrets are ever exposed to the browser**.

The demo is designed to be fully interactive from the browser after deployment, allowing for multiple, sequential TTS generations within a single session, and it provides two distinct interfaces: a **Publisher Console** for controlling the session and a **Listener Page** for passive listening.

## Project Architecture

*   **Cloudflare Worker**: Acts as the secure backend and public entry point. It serves the interactive player, handles API requests, and **proxies calls** to the Cloudflare SFU, keeping all secrets and tokens on the server-side.
*   **Durable Object (`AudioSession`)**: A stateful, single-instance object that manages a unique audio stream (e.g., for a session named "live-podcast"). It generates audio using the ElevenLabs API, stores the SFU session state, and pushes the audio stream to the Cloudflare SFU.
*   **Cloudflare Realtime SFU**: Ingests the audio stream from the worker and makes it available globally for clients to connect to via WebRTC.
*   **`player.html`**: A single-file, user-friendly web page that communicates only with the Cloudflare Worker to manage the session lifecycle. It dynamically renders a view for either the publisher or a listener.

## Getting Started

### Prerequisites

*   A Cloudflare account with Workers and Durable Objects enabled.
*   A Cloudflare Realtime SFU application configured.
*   An ElevenLabs account and API key.
*   [Node.js](https://nodejs.org/) and npm installed.
*   [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and configured.

### Configuration

1.  **Clone the Repository and Install Dependencies:**
    ```bash
    git clone <repository-url>
    cd <repository-directory>
    npm install
    ```

2.  **Configure `wrangler.jsonc` (or `wrangler.toml`):**
    Open your wrangler configuration file and modify the `vars` block with your own Cloudflare and ElevenLabs IDs.

    ```jsonc
    {
    	// ... other wrangler config ...
    	"vars": {
            "SFU_API_BASE": "https://rtc.live.cloudflare.com/v1",
    		"ELEVENLABS_VOICE_ID": "<your-elevenlabs-voice-id>",
    		"REALTIME_SFU_APP_ID": "<your-realtime-sfu-app-id>"
    	}
    }
    ```

3.  **Configure Secrets:**
    Use the Wrangler CLI to securely store your API keys and tokens. These are encrypted and never exposed to your code or clients.

    *   **ElevenLabs API Key:**
        ```bash
        npx wrangler secret put ELEVENLABS_API_KEY
        ```
        (You will be prompted to enter the key)

    *   **Cloudflare SFU Bearer Token:**
        ```bash
        npx wrangler secret put REALTIME_SFU_BEARER_TOKEN
        ```
        (You will be prompted to enter the token)

## Deployment & Usage

1.  **Deploy the Worker:**
    Deploy your worker and Durable Object to Cloudflare:
    ```bash
    npx wrangler deploy
    ```

2.  **Open the Publisher Console:**
    To control the session, navigate to the URL of your deployed worker, adding a unique session ID and `/publisher` to the path. You can make up any session ID you like.

    **Publisher URL:** `https://<your-worker-name>.<your-subdomain>.workers.dev/my-stream/publisher`

3.  **Start the Session:**
    As the publisher, click the **"Publish Session"** button. This makes the audio stream available for anyone to connect to.

4.  **Share the Listener Link:**
    Share the `/player` URL with anyone who you want to listen to the stream.

    **Listener URL:** `https://<your-worker-name>.<your-subdomain>.workers.dev/my-stream/player`

5.  **Listeners Connect:**
    Users opening the listener URL will see a simple page with a "Connect and Listen" button. Clicking this will connect them to the audio stream via **Cloudflare Realtime SFU**

6.  **Generate Speech:**
    As the publisher, you can type text into the box and click **"Generate Speech"**. You can do this multiple times. Each time, the newly generated audio will be streamed in realtime to all connected listeners (including yourself, if you've also clicked "Connect and Listen").

7.  **Stop the Session:**
    As the publisher, you can click **"Unpublish Session"** to completely remove the audio track from Cloudflare's servers. This will disconnect the publisher track, prevent new ones from joining, and reset the UI.

8.  **End the Session (Forcibly):**
    You can also terminate the session and clear all its state on the server by sending a `DELETE` request. This is useful for cleaning up abandoned sessions.

    ```bash
    curl -X DELETE https://<your-worker-name>.<your-subdomain>.workers.dev/my-stream
    ```
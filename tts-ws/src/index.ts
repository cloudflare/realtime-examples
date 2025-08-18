import { DurableObject } from 'cloudflare:workers';
import { Packet } from './packet';

import playerHtml from './player.html';

// --- Constants ---

// The size of audio chunks sent over WebSockets.
// FOOTGUN: This value must be less than the WebSocket message size limit of the SFU adapter (32KB)
// 16KB is a very safe value.
const BUFFER_CHUNK_SIZE = 16 * 1024; // 16KB

// After 1 hour of no new audio generation, the session will self-destruct to conserve resources.
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// --- Enums ---

// Available audio output formats from the TTS service.
// pcm_48000 is available on ElevenLabs Pro tier or above.
enum OutputFormat {
	PCM_48000 = 'pcm_48000',
	PCM_24000 = 'pcm_24000',
}

/**
 * AudioSession Durable Object
 *
 * Manages the state for a single, named audio session. This includes:
 *  - Storing the SFU session ID after publishing.
 *  - Handling the audio generation via a third-party TTS API.
 *  - Managing WebSocket connections from the Cloudflare SFU.
 *  - Storing the generated audio buffer.
 *  - Broadcasting audio data to connected clients (the SFU).
 */
export class AudioSession extends DurableObject<Env> {
	env: Env;
	ctx: DurableObjectState;
	stereoAudioBuffer: ArrayBuffer | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx = ctx;
		// Note: `ctx.id` is the internal, hexadecimal ID of the DO instance, not its name.
		console.log(`[AudioSession:${ctx.id.toString()}] Durable Object created or woken up.`);
	}

	/**
	 * Handles the self-destruction alarm on inactivity.
	 */
	async alarm() {
		console.log(`[AudioSession:${this.ctx.id.toString()}] Inactivity timeout reached. Disconnecting all clients and clearing state.`);
		await this.disconnectAll();
	}

	/**
	 * The main entry point for requests routed to this Durable Object instance.
	 * Acts as an internal router for session-specific actions.
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathParts = url.pathname
			.substring(1)
			.split('/')
			.filter((p) => p);

		if (pathParts.length < 1) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Invalid request path to DO: ${url.pathname}`);
			return new Response('Invalid request to Durable Object', { status: 400 });
		}

		// FOOTGUN: The `sessionId` is the human-readable name from the URL (e.g., "live-podcast-123").
		// This MUST be used for all public-facing identifiers like track names and callback URLs
		// to ensure requests are always routed back to this specific named DO instance.
		const sessionId = pathParts[0];
		const action = pathParts.length > 1 ? pathParts[1] : null;

		switch (action) {
			case 'subscribe':
				if (request.headers.get('Upgrade') === 'websocket') {
					console.log(`[AudioSession:${this.ctx.id.toString()}] WebSocket upgrade for session "${sessionId}" accepted.`);
					return this.handleSubscribe();
				}
				return new Response('Expected websocket', { status: 400 });
			case 'publish':
				return this.handlePublish(request, sessionId);
			case 'unpublish':
				return this.handleUnpublish();
			case 'connect':
				return this.handleConnect(request, sessionId);
			case 'generate':
				return this.handleGenerate(request);
			default:
				return new Response('Not Found in Durable Object', { status: 404 });
		}
	}

	/**
	 * Handles WebSocket upgrade requests from the SFU.
	 */
	private handleSubscribe(): Response {
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		// If audio already exists (e.g., a late joiner), send it immediately.
		if (this.stereoAudioBuffer) {
			console.log(`[AudioSession:${this.ctx.id.toString()}] Sending existing buffer to new WebSocket client.`);
			this.sendBufferInChunks(server);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Handles POST /<session-id>/publish
	 * Registers this DO's audio track with the SFU and persists the resulting SFU session ID.
	 */
	private async handlePublish(request: Request, sessionId: string): Promise<Response> {
		// FOOTGUN: The callback URL must be correctly constructed based on the incoming request's protocol and host.
		const subscribeUrl = new URL(request.url);
		subscribeUrl.pathname = `/${sessionId}/subscribe`;
		subscribeUrl.protocol = new URL(request.url).protocol === 'https:' ? 'wss:' : 'ws:';

		console.log(`[AudioSession:${this.ctx.id.toString()}] Publishing track "${sessionId}" with callback: ${subscribeUrl.toString()}`);

		const sfuApiUrl = `${this.env.SFU_API_BASE}/apps/${this.env.REALTIME_SFU_APP_ID}/adapters/websocket/new`;
		const apiRequestBody = {
			tracks: [
				{
					location: 'local',
					trackName: sessionId, // Use the human-readable name
					endpoint: subscribeUrl.toString(),
					inputCodec: 'pcm',
					mode: 'buffer',
				},
			],
		};
		const sfuResponse = await fetch(sfuApiUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.env.REALTIME_SFU_BEARER_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(apiRequestBody),
		});

		const responseText = await sfuResponse.text();
		if (!sfuResponse.ok) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Failed to publish to SFU: ${responseText}`);
			return new Response(`Failed to publish to SFU: ${responseText}`, { status: sfuResponse.status });
		}

		try {
			const responseJson = JSON.parse(responseText);
			const sfuSessionId = responseJson?.tracks?.[0]?.sessionId;
			const adapterId = responseJson?.tracks?.[0]?.adapterId;

			if (!sfuSessionId || !adapterId) {
				throw new Error('SFU Session ID or Adapter ID not found in response');
			}
			// Persist both IDs needed for connect and unpublish
			await this.ctx.storage.put('sfuSessionId', sfuSessionId);
			await this.ctx.storage.put('adapterId', adapterId);
			console.log(`[AudioSession:${this.ctx.id.toString()}] Stored SFU Session ID: ${sfuSessionId} and Adapter ID: ${adapterId}`);

			await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
			console.log(`[AudioSession:${this.ctx.id.toString()}] Initial inactivity alarm set on publish.`);

			return new Response(responseText, { headers: { 'Content-Type': 'application/json' }, status: 200 });
		} catch (e: any) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Failed to parse SFU publish response:`, e.message);
			return new Response(`Internal Error: Could not parse SFU response. ${e.message}`, { status: 500 });
		}
	}

	/**
	 * Handles POST /<session-id>/unpublish
	 * Removes this DO's audio track from the SFU.
	 */
	private async handleUnpublish(): Promise<Response> {
		const adapterId: string | undefined = await this.ctx.storage.get('adapterId');
		if (!adapterId) {
			return new Response('Session is not published or has already been unpublished.', { status: 400 });
		}

		console.log(`[AudioSession:${this.ctx.id.toString()}] Unpublishing track with Adapter ID: ${adapterId}`);
		const sfuApiUrl = `${this.env.SFU_API_BASE}/apps/${this.env.REALTIME_SFU_APP_ID}/adapters/websocket/close`;
		const apiRequestBody = {
			tracks: [{ adapterId: adapterId }],
		};

		const sfuResponse = await fetch(sfuApiUrl, {
			method: 'POST',
			headers: { Authorization: `Bearer ${this.env.REALTIME_SFU_BEARER_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(apiRequestBody),
		});

		if (!sfuResponse.ok) {
			const errorText = await sfuResponse.text();
			console.error(`[AudioSession:${this.ctx.id.toString()}] Failed to unpublish from SFU: ${errorText}`);
			return new Response(`Failed to unpublish from SFU: ${errorText}`, { status: sfuResponse.status });
		}

		// Clean up all state related to the session
		this.stereoAudioBuffer = null;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();

		console.log(`[AudioSession:${this.ctx.id.toString()}] Session unpublished and all state cleared.`);
		return new Response('Session unpublished successfully.', { status: 200 });
	}

	/**
	 * Handles POST /<session-id>/connect
	 * Retrieves the stored SFU session ID and proxies the request for a player.
	 */
	private async handleConnect(request: Request, sessionId: string): Promise<Response> {
		try {
			const { sessionDescription } = (await request.json()) as any;
			if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

			const publisherSfuSessionId: string | undefined = await this.ctx.storage.get('sfuSessionId');
			if (!publisherSfuSessionId) {
				return new Response('Cannot connect. The track has not been published yet.', { status: 400 });
			}

			const sfuApiBase = `${this.env.SFU_API_BASE}/apps/${this.env.REALTIME_SFU_APP_ID}`;
			const authHeader = { Authorization: `Bearer ${this.env.REALTIME_SFU_BEARER_TOKEN}`, 'Content-Type': 'application/json' };

			// Step 1: Create a new, separate SFU session for the connecting player.
			const playerSessionRes = await fetch(`${sfuApiBase}/sessions/new`, { method: 'POST', headers: authHeader });
			if (!playerSessionRes.ok)
				throw new Error(`Failed to create player SFU session: ${playerSessionRes.status} ${await playerSessionRes.text()}`);
			const { sessionId: sfuPlayerSessionId } = (await playerSessionRes.json()) as any;

			// Step 2: Instruct the player's SFU session to pull the track from the publisher's SFU session.
			// FOOTGUN: This is the most critical part of the logic.
			// `sessionId` (the human-readable name) is the `trackName`.
			// `publisherSfuSessionId` (the ID from storage) is the `sessionId` to pull from.
			const pullReqBody = {
				sessionDescription,
				tracks: [{ location: 'remote', sessionId: publisherSfuSessionId, trackName: sessionId, kind: 'audio' }],
			};
			console.log(
				`[AudioSession:${this.ctx.id.toString()}] Player connecting to track "${sessionId}" via SFU session "${publisherSfuSessionId}"`
			);
			const pullRes = await fetch(`${sfuApiBase}/sessions/${sfuPlayerSessionId}/tracks/new`, {
				method: 'POST',
				headers: authHeader,
				body: JSON.stringify(pullReqBody),
			});
			if (!pullRes.ok) throw new Error(`Failed to pull track: ${pullRes.status} ${await pullRes.text()}`);

			const sfuAnswer = await pullRes.json();
			return new Response(JSON.stringify(sfuAnswer), { headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] SFU Connect Error: ${error.message}`);
			return new Response(`SFU Connect Error: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Handles the POST /<session-id>/generate request.
	 */
	private handleGenerate(request: Request): Response {
		// In a Durable Object, to run a task in the background, we call an async method
		// but DO NOT `await` it. The DO runtime will keep the object alive until the
		// promise returned by the method settles. This is the correct pattern for
		// "fire-and-forget" tasks inside a DO.
		// We add a .catch() to prevent unhandled promise rejection warnings in the logs.
		this.processGenerateRequest(request).catch((err) => {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Unhandled error in background generate task:`, err);
		});

		// We can immediately return a 202 Accepted response to the client.
		return new Response('Audio generation accepted', { status: 202 });
	}

	/**
	 * The actual async logic for handling a generate request.
	 */
	private async processGenerateRequest(request: Request): Promise<void> {
		try {
			const { text, format } = (await request.json()) as any;
			if (!text) {
				console.error(`[AudioSession:${this.ctx.id.toString()}] Generate request failed: Missing text.`);
				return;
			}
			const outputFormat = format === OutputFormat.PCM_48000 ? OutputFormat.PCM_48000 : OutputFormat.PCM_24000;
			await this.generateAndBroadcastAudio(text, outputFormat);
		} catch (e: any) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Error during audio generation: ${e.message}`);
		}
	}

	/**
	 * Generates audio from text using an external TTS service.
	 */
	private async generateAudio(text: string, format: OutputFormat): Promise<ArrayBuffer> {
		// FOOTGUN: Ensure API keys and voice IDs are correctly set as secrets/variables.
		// A failure here will cause the `generateAndBroadcastAudio` to fail.
		const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.env.ELEVENLABS_VOICE_ID}?output_format=${format}`, {
			headers: {
				'xi-api-key': this.env.ELEVENLABS_API_KEY,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				text: text,
				model_id: 'eleven_multilingual_v2',
			}),
			method: 'POST',
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`ElevenLabs API Error: ${response.status} ${errorText}`);
		}
		return response.arrayBuffer();
	}

	/**
	 * Generates audio and broadcasts it to all connected clients.
	 * This method now overwrites the previous buffer, allowing for multiple TTS generations.
	 */
	private async generateAndBroadcastAudio(text: string, format: OutputFormat) {
		console.log(`[AudioSession:${this.ctx.id.toString()}] Starting audio generation for text: "${text.substring(0, 50)}..."`);

		const audioData = await this.generateAudio(text, format);
		console.log(`[AudioSession:${this.ctx.id.toString()}] Audio generated. Raw size: ${audioData.byteLength} bytes.`);

		const resampledData =
			format === OutputFormat.PCM_24000 ? this.resample16bitPCM24to48(new Int16Array(audioData)) : new Int16Array(audioData);

		// Overwrite the previous buffer to allow for repeated TTS.
		this.stereoAudioBuffer = this.monoToStereo(resampledData.buffer);

		const connectedClients = this.ctx.getWebSockets();
		if (connectedClients.length > 0) {
			console.log(`[AudioSession:${this.ctx.id.toString()}] Broadcasting new buffer to ${connectedClients.length} client(s).`);
			connectedClients.forEach((ws) => this.sendBufferInChunks(ws));
		} else {
			console.log(`[AudioSession:${this.ctx.id.toString()}] Buffer generated, but no clients are connected to receive it.`);
		}

		// Reset the inactivity alarm on every successful generation.
		await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
		console.log(`[AudioSession:${this.ctx.id.toString()}] Inactivity alarm has been reset.`);
	}

	/**
	 * Disconnects all WebSocket clients.
	 */
	async disconnectAll() {
		const clients = this.ctx.getWebSockets();
		if (clients.length > 0) {
			console.log(`[AudioSession:${this.ctx.id.toString()}] Closing ${clients.length} WebSocket connection(s).`);
			clients.forEach((ws) => ws.close(1000, 'Session terminated by API request'));
		}
		// Clear stored state on explicit disconnect.
		await this.ctx.storage.deleteAll();
	}

	/**
	 * Handles WebSocket closures, cleaning up state if it's the last client.
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		console.log(
			`[AudioSession:${this.ctx.id.toString()}] WebSocket closed: code=${code}, reason=${reason}. Remaining clients: ${
				this.ctx.getWebSockets().length
			}.`
		);
		// When the SFU disconnects, we can clean up the audio buffer to free memory.
		if (this.ctx.getWebSockets().length === 0) {
			console.log(`[AudioSession:${this.ctx.id.toString()}] Last client disconnected. Clearing audio buffer and SFU session ID.`);
			this.stereoAudioBuffer = null;
			await this.ctx.storage.delete('sfuSessionId');
			await this.ctx.storage.deleteAlarm();
		}
	}

	/**
	 * Handles WebSocket errors.
	 */
	webSocketError(ws: WebSocket, error: any) {
		console.error(`[AudioSession:${this.ctx.id.toString()}] WebSocket error:`, error);
	}

	/**
	 * Sends the audio buffer to a WebSocket in fixed-size chunks.
	 */
	private sendBufferInChunks(ws: WebSocket) {
		if (!this.stereoAudioBuffer) {
			console.error(`[AudioSession:${this.ctx.id.toString()}] Attempted to send a null audio buffer.`);
			return;
		}
		for (let offset = 0; offset < this.stereoAudioBuffer.byteLength; offset += BUFFER_CHUNK_SIZE) {
			const chunk = this.stereoAudioBuffer.slice(offset, offset + BUFFER_CHUNK_SIZE);
			ws.send(this.encodeBufferPacket(chunk));
		}
		// Send an empty packet to signal the end of this audio stream segment.
		ws.send(this.encodeBufferPacket(new ArrayBuffer(0)));
	}

	// --- Audio Processing Utilities ---

	private encodeBufferPacket(payload: ArrayBuffer): ArrayBuffer {
		const packet = {
			sequenceNumber: 0,
			timestamp: 0,
			payload: new Uint8Array(payload),
		};
		return Packet.toBinary(packet);
	}
	private resample16bitPCM24to48(pcmData24k: Int16Array): Int16Array {
		const sourceLength = pcmData24k.length;
		if (sourceLength === 0) return new Int16Array(0);

		const pcmData48k = new Int16Array(sourceLength * 2);

		for (let i = 0; i < sourceLength - 1; i++) {
			pcmData48k[i * 2] = pcmData24k[i];
			const interpolatedSample = (pcmData24k[i] + pcmData24k[i + 1]) / 2;
			pcmData48k[i * 2 + 1] = Math.round(interpolatedSample);
		}

		const lastSample = pcmData24k[sourceLength - 1];
		pcmData48k[sourceLength * 2 - 2] = lastSample;
		pcmData48k[sourceLength * 2 - 1] = lastSample;

		return pcmData48k;
	}
	private monoToStereo(monoPcm: ArrayBuffer): ArrayBuffer {
		const monoView = new Int16Array(monoPcm);
		const stereoPcm = new ArrayBuffer(monoPcm.byteLength * 2);
		const stereoView = new Int16Array(stereoPcm);
		for (let i = 0; i < monoView.length; i++) {
			stereoView[i * 2] = monoView[i];
			stereoView[i * 2 + 1] = monoView[i];
		}
		return stereoPcm;
	}
}

/**
 * Main Worker Fetch Handler
 *
 * This is the public entry point for all incoming requests.
 * Its primary job is to act as a router, forwarding all stateful,
 * session-specific requests to the correct Durable Object instance.
 */
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const pathParts = url.pathname
			.substring(1)
			.split('/')
			.filter((p) => p);

		// Root request handler.
		if (pathParts.length === 0) {
			return new Response('Welcome! Use /<session-id>/publisher to control or /<session-id>/player to listen.', { status: 200 });
		}

		const sessionId = pathParts[0];
		const action = pathParts.length > 1 ? pathParts[1] : null;

		// Route: GET /<session-id>/player OR GET /<session-id>/publisher
		// These are stateless requests to serve the UI. Both routes serve the same HTML file.
		if (action && ['player', 'publisher'].includes(action) && request.method === 'GET') {
			return new Response(playerHtml, {
				headers: { 'Content-Type': 'text/html;charset=UTF-8' },
			});
		}

		// Route: DELETE /<session-id>
		// Forcibly terminates a session.
		if (!action && request.method === 'DELETE') {
			const id = env.AUDIO_SESSION.idFromName(sessionId);
			const stub = env.AUDIO_SESSION.get(id);
			// `ctx.waitUntil` is used correctly here in the Worker context
			// to ensure the RPC call to the DO completes before the Worker may be terminated.
			ctx.waitUntil(stub.disconnectAll());
			return new Response(`Session ${sessionId} termination signal sent.`, { status: 202 });
		}

		// All other actions are stateful and must be forwarded to the Durable Object.
		if (action && ['publish', 'unpublish', 'connect', 'generate', 'subscribe'].includes(action)) {
			const id = env.AUDIO_SESSION.idFromName(sessionId);
			const stub = env.AUDIO_SESSION.get(id);
			return stub.fetch(request);
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

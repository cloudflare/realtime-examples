import { DurableObject } from 'cloudflare:workers';
import { SpeexResampler } from './speex-resampler';
import { SfuClient, buildWsCallbackUrl, encodePcmForSfu } from './shared/sfu-utils';
import { resample24kToStereo48k, initSpeexResampler } from './shared/audio-utils';
import { createAdapterLogger } from './shared/log';
import { createStateStore, StateStore } from './shared/state-store';
import { dedupedConnect } from './shared/ws-connection';
import { buildDeadlineAggregator, scheduleDeferredCleanup, getOpenSockets, scheduleReconnect } from './shared/do-utils';
import { TTS_MODEL, DEFAULT_INACTIVITY_TIMEOUT_MS, DEFAULT_MAX_RECONNECT_ATTEMPTS, TTS_BUFFER_CHUNK_SIZE } from './shared/config';

// --- Enums ---

// Aura TTS Speaker options
enum AuraSpeaker {
	ANGUS = 'angus',
	ASTERIA = 'asteria',
	ARCAS = 'arcas',
	ORION = 'orion',
	ORPHEUS = 'orpheus',
	ATHENA = 'athena',
	LUNA = 'luna',
	ZEUS = 'zeus',
	PERSEUS = 'perseus',
	HELIOS = 'helios',
	HERA = 'hera',
	STELLA = 'stella',
}

// Aura Audio Encoding options
enum AuraEncoding {
	LINEAR16 = 'linear16',
	FLAC = 'flac',
	MULAW = 'mulaw',
	ALAW = 'alaw',
	MP3 = 'mp3',
	OPUS = 'opus',
	AAC = 'aac',
}

// Aura Container options
enum AuraContainer {
	NONE = 'none',
	WAV = 'wav',
	OGG = 'ogg',
}

/**
 * WebSocket Session State - Persisted across hibernation
 */
interface SessionState {
	id: string;
	type: 'sfu-subscriber';
	createdAt?: number;
}

/**
 * TTS Adapter Persistent State - All state that needs to survive hibernation
 */
interface TTSAdapterState {
	// Reconnection state
	allowReconnect: boolean;
	reconnectAttempts: number;
	reconnectType?: string;
	reconnectDeadline?: number;

	// Deadline tracking
	inactivityDeadline?: number;
	cleanupDeadline?: number;

	// SFU session info
	sfuSessionId?: string;
	adapterId?: string;

	// TTS configuration
	selectedSpeaker?: string;
	// Human-readable session name (for logging)
	sessionName?: string;
}

/**
 * TTSAdapter Durable Object
 *
 * Manages the state for a single, named TTS session. This includes:
 *  - Storing the SFU session ID after publishing.
 *  - Handling audio generation via Cloudflare AI (Aura)
 *  - Managing WebSocket connections from the Cloudflare SFU.
 *  - Storing the generated audio buffer.
 *  - Broadcasting audio data to connected clients (the SFU).
 *  - Uses WebSocket Hibernation with ping/pong auto-response to avoid waking the DO on keepalives.
 */
export class TTSAdapter extends DurableObject<Env> {
	env: Env;
	ctx: DurableObjectState;
	private logger: ReturnType<typeof createAdapterLogger>;
	stereoAudioBuffer: ArrayBuffer | null = null;
	// WebSocket TTS Connection Management
	private auraWebSocket: WebSocket | null = null;
	private auraConnectionPromise: Promise<WebSocket> | null = null;
	private maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS;
	private audioStreamBuffer: ArrayBuffer[] = [];
	private isStreaming = false;
	private speexTTSResampler: SpeexResampler | null = null;

	// Persistent state management using shared state store
	private stateStore: StateStore<TTSAdapterState>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx = ctx;
		this.logger = createAdapterLogger('TTS', ctx.id);

		// Initialize state store with default values and deadline getter
		this.stateStore = createStateStore<TTSAdapterState>(
			ctx,
			'ttsState',
			{
				allowReconnect: false,
				reconnectAttempts: 0,
			},
			buildDeadlineAggregator<TTSAdapterState>(['inactivityDeadline', 'reconnectDeadline', 'cleanupDeadline'])
		);

		// Restore persistent state under blockConcurrencyWhile to avoid init races
		this.ctx.blockConcurrencyWhile(async () => {
			try {
				await this.stateStore.restore();
				const restoredName = this.stateStore.state.sessionName;
				if (restoredName) {
					this.logger.setAliasSilently(restoredName);
				}
			} catch (e) {
				this.logger.warn(`restore failed:`, e);
			}
		});

		// Log restored WebSocket sessions after hibernation
		this.ctx.getWebSockets().forEach((ws) => {
			const attachment = ws.deserializeAttachment();
			if (attachment) {
				const sessionState = attachment as SessionState;
				this.logger.log(`Restored session ${sessionState.id} from hibernation`);
			}
		});

		// Initialize SpeexDSP WASM and pre-create TTS resampler (24k -> 48k, mono)
		this.speexTTSResampler = initSpeexResampler(1, 24000, 48000);
		if (this.speexTTSResampler) {
			this.logger.log(`Speex TTS resampler initialized`);
		}

		// Auto-respond to pings without waking the DO
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

		// Setup initial inactivity deadline (10 minutes since last generation/publish)
		this.setupInactivityAlarm();

		this.logger.log(`Durable Object created or woken up.`);
	}

	private async scheduleInactivity(reason: string, ms: number = DEFAULT_INACTIVITY_TIMEOUT_MS) {
		const now = Date.now();
		const newDeadline = now + ms;
		let desired = newDeadline;
		if (typeof this.stateStore.state.inactivityDeadline === 'number') {
			desired = Math.max(this.stateStore.state.inactivityDeadline, newDeadline); // do not shorten existing inactivity
			if (Math.abs(desired - this.stateStore.state.inactivityDeadline) < 1000) return; // churn guard
		}
		await this.stateStore.update({ inactivityDeadline: desired });
		this.logger.log(`Inactivity scheduled (${reason}) at ${new Date(desired).toISOString()}`);
	}

	private async scheduleInactivityIfIdle(reason: string, ms: number = DEFAULT_INACTIVITY_TIMEOUT_MS) {
		if (this.ctx.getWebSockets().length > 0) return;
		await this.scheduleInactivity(reason, ms);
	}

	private async cancelInactivity() {
		await this.stateStore.deleteKeys(['inactivityDeadline']);
	}

	/**
	 * Sets up an inactivity alarm to self-destruct the session after a period of inactivity
	 */
	private setupInactivityAlarm() {
		// 10 minutes since last generation/publish – schedule regardless of clients
		this.scheduleInactivity('init').catch(() => {});
	}

	/**
	 * Handles alarms for inactivity, reconnection attempts, and last-client cleanup.
	 * Acts as the single reducer for time-triggered state transitions: deadline fields/flags
	 * in persisted state schedule work; the handler is idempotent and safe across hibernation.
	 * Uses readyState === OPEN checks (via getOpenSockets) for timing-safe last-client cleanup.
	 */
	async alarm() {
		const now = Date.now();
		const updates: Partial<TTSAdapterState> = {};
		let needsSave = false;

		// Check for cleanup deadline (last-client check)
		if (typeof this.stateStore.state.cleanupDeadline === 'number' && now >= this.stateStore.state.cleanupDeadline) {
			this.logger.log(`Cleanup deadline reached. Checking for open WebSocket clients.`);

			// Count actually open sockets (readyState check for timing safety)
			const openCount = getOpenSockets(this.ctx).length;

			if (openCount === 0) {
				this.logger.log(`No open WebSocket clients. Performing last-client cleanup.`);

				// Clear audio buffer
				this.stereoAudioBuffer = null;

				// Update state - disable reconnect, clear session ID (keep adapterId for unpublish)
				updates.allowReconnect = false;
				updates.sfuSessionId = undefined;
				updates.reconnectAttempts = 0;
				updates.reconnectType = undefined;
				updates.reconnectDeadline = undefined;
				updates.cleanupDeadline = undefined;
				needsSave = true;

				// Close Aura connection
				this.closeAuraConnection();

				// Schedule inactivity after cleanup
				await this.stateStore.update(updates);
				await this.scheduleInactivity('last-client-closed');
				return;
			} else {
				this.logger.log(`${openCount} WebSocket client(s) still open. Skipping cleanup.`);
				updates.cleanupDeadline = undefined;
				needsSave = true;
			}
		}

		// Check for inactivity deadline
		if (typeof this.stateStore.state.inactivityDeadline === 'number' && now >= this.stateStore.state.inactivityDeadline) {
			this.logger.log(`Inactivity timeout reached. Cleaning up.`);
			updates.inactivityDeadline = undefined;
			needsSave = true;

			// Apply updates before disconnecting
			await this.stateStore.update(updates);
			this.closeAuraConnection();
			await this.disconnectAll();
			return; // Exit early since we're cleaning up
		}

		// Check for reconnection deadline
		if (typeof this.stateStore.state.reconnectDeadline === 'number' && now >= this.stateStore.state.reconnectDeadline) {
			this.logger.log(`Alarm triggered for Aura WS reconnection attempt ${this.stateStore.state.reconnectAttempts}`);
			if (this.stateStore.state.allowReconnect && this.stateStore.state.reconnectAttempts <= this.maxReconnectAttempts) {
				try {
					await this.getOrCreateAuraConnection();
					// Success - clear reconnection state (handled in getOrCreateAuraConnection)
				} catch (error) {
					this.logger.error(`Reconnection attempt failed:`, error);
					// Schedule next attempt via exponential backoff
					await this.scheduleTTSAuraReconnect();
				}
			} else {
				// Max attempts reached or reconnect disabled - clear reconnection state
				updates.reconnectAttempts = 0;
				updates.reconnectType = undefined;
				updates.reconnectDeadline = undefined;
				needsSave = true;
			}
		}

		// Single save for all state changes
		if (needsSave) {
			await this.stateStore.update(updates);
		}
	}

	/**
	 * The main entry point for requests routed to this Durable Object instance.
	 * Acts as an internal router for session-specific actions.
	 * Endpoints:
	 *  - WS   /<session-name>/subscribe
	 *  - POST /<session-name>/(publish|unpublish|connect|generate)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const pathParts = url.pathname
			.substring(1)
			.split('/')
			.filter((p) => p);

		if (pathParts.length < 1) {
			this.logger.error(`Invalid request path to DO: ${url.pathname}`);
			return new Response('Invalid request to Durable Object', { status: 400 });
		}

		// FOOTGUN: The session name is the human-readable name from the URL (e.g., "live-podcast-123").
		// This MUST be used for all public-facing identifiers like track names and callback URLs
		// to ensure requests are always routed back to this specific named DO instance.
		const sessionName = pathParts[0];

		// Apply human-readable alias and persist it once
		if (!this.stateStore.state.sessionName) {
			this.logger.aliasOnce(sessionName);
			await this.stateStore.update({ sessionName }, true);
		}
		const action = pathParts.length > 1 ? pathParts[1] : null;

		switch (action) {
			case 'subscribe':
				if (request.headers.get('Upgrade') === 'websocket') {
					this.logger.log(`WebSocket upgrade for session "${sessionName}" accepted.`);
					return this.handleSubscribe();
				}
				return new Response('Expected websocket', { status: 400 });
			case 'publish':
				return this.handlePublish(request, sessionName);
			case 'unpublish':
				return this.handleUnpublish();
			case 'connect':
				return this.handleConnect(request, sessionName);
			case 'generate':
				return this.handleGenerate(request);
			default:
				return new Response('Not Found in Durable Object', { status: 404 });
		}
	}

	/**
	 * Handles WebSocket upgrade requests from the SFU.
	 * Enforces single subscriber by closing any existing sockets.
	 */
	private handleSubscribe(): Response {
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id: crypto.randomUUID(), type: 'sfu-subscriber', createdAt: Date.now() });

		// Enforce single subscriber: close any existing sockets except the new one
		const existingSockets = this.ctx.getWebSockets();
		for (const ws of existingSockets) {
			if (ws !== server && ws.readyState === WebSocket.OPEN) {
				this.logger.log(`Closing existing WebSocket to enforce single subscriber.`);
				ws.close(1000, 'Superseded by newer subscriber');
			}
		}

		// If audio already exists (e.g., a late joiner), send it immediately.
		if (this.stereoAudioBuffer) {
			this.logger.log(`Sending existing buffer to new WebSocket client.`);
			this.sendBufferInChunks(server);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Handles POST /<session-name>/publish
	 * Registers this DO's audio track with the Cloudflare SFU.
	 * Enforces single subscriber (409 if already published), persists SFU session/adapter IDs,
	 * and attempts to pre-create a persistent Aura WebSocket for lower latency.
	 */
	private async handlePublish(request: Request, sessionName: string): Promise<Response> {
		// Check if already published - reject with 409 if adapter exists
		if (this.stateStore.state.adapterId) {
			this.logger.log(`Session already published with adapter ID: ${this.stateStore.state.adapterId}`);
			return new Response('Session is already published. Please unpublish first or wait for automatic cleanup.', { status: 409 });
		}

		// Parse request body to get speaker selection
		let selectedSpeaker = AuraSpeaker.ZEUS; // Default
		try {
			const body = (await request.json()) as any;
			if (body?.speaker) {
				selectedSpeaker = body.speaker;
				this.logger.log(`Speaker selected: ${selectedSpeaker}`);
			}
		} catch (e) {
			// If body parsing fails, use default speaker
			this.logger.log(`No speaker specified, using default: ${selectedSpeaker}`);
		}

		// Store the selected speaker and enable reconnections in single update
		await this.stateStore.update(
			{
				selectedSpeaker: selectedSpeaker,
				allowReconnect: true,
			},
			true
		); // Skip alarm reschedule since we'll schedule inactivity below
		// FOOTGUN: The callback URL must be correctly constructed based on the incoming request's protocol and host.
		const subscribeUrl = buildWsCallbackUrl(request, `/${sessionName}/subscribe`);

		this.logger.log(`Publishing track "${sessionName}" with callback: ${subscribeUrl.toString()}`);

		// Use SFU client to create local WebSocket adapter (push DO -> SFU)
		try {
			const sfu = new SfuClient(this.env);
			const { sessionId: sfuSessionId, adapterId, json } = await sfu.pushTrackFromWebSocket(sessionName, subscribeUrl.toString());

			// Persist both IDs needed for connect and unpublish in single update
			await this.stateStore.update({ sfuSessionId, adapterId });
			this.logger.log(`Stored SFU Session ID: ${sfuSessionId} and Adapter ID: ${adapterId}`);

			await this.scheduleInactivity('publish');
			this.logger.log(`Initial inactivity scheduled on publish.`);

			// Create persistent TTS WebSocket connection when track is published with the selected speaker
			try {
				this.logger.log(`Creating persistent TTS WebSocket connection with speaker: ${selectedSpeaker}...`);
				await this.getOrCreateAuraConnection();
				this.logger.log(`TTS WebSocket connection established successfully.`);
			} catch (error: any) {
				this.logger.warn(`Failed to create TTS WebSocket connection on publish: ${error.message}`);
				// Don't fail the publish operation if TTS WebSocket fails - it will be created on-demand
			}

			return new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' }, status: 200 });
		} catch (e: any) {
			this.logger.error(`Failed to publish to SFU:`, e?.message || e);
			return new Response(`Failed to publish to SFU: ${e?.message || e}`, { status: 500 });
		}
	}

	/**
	 * Handles POST /<session-name>/unpublish
	 * Removes this DO's audio track from the SFU.
	 */
	private async handleUnpublish(): Promise<Response> {
		const adapterId = this.stateStore.state.adapterId;
		if (!adapterId) {
			return new Response('Session is not published or has already been unpublished.', { status: 400 });
		}

		this.logger.log(`Unpublishing track with Adapter ID: ${adapterId}`);
		const sfu = new SfuClient(this.env);
		const close = await sfu.closeWebSocketAdapter(adapterId);
		if (!close.ok) {
			this.logger.error(`Failed to unpublish from SFU: ${close.status} ${close.text}`);
			return new Response(`Failed to unpublish from SFU: ${close.text}`, { status: close.status });
		}
		if (close.alreadyClosed) {
			this.logger.log(`Adapter already closed on SFU. Proceeding with local cleanup.`);
		}

		// Clean up all state related to the session
		this.stereoAudioBuffer = null;
		this.closeAuraConnection(); // Close Aura TTS WebSocket

		// Proactively disconnect all DO WebSocket clients
		await this.disconnectAll();

		// Clear publish-specific state and cleanup deadline (disconnectAll already resets base state)
		await this.stateStore.deleteKeys(['sfuSessionId', 'adapterId', 'selectedSpeaker', 'cleanupDeadline']);

		this.logger.log(`Session unpublished, Aura connection closed, clients disconnected, and all state cleared.`);
		return new Response('Session unpublished successfully.', { status: 200 });
	}

	/**
	 * Handles POST /<session-name>/connect
	 * Retrieves the stored SFU session ID and proxies the request for a player.
	 */
	private async handleConnect(request: Request, sessionName: string): Promise<Response> {
		try {
			const { sessionDescription } = (await request.json()) as any;
			if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

			const publisherSfuSessionId = this.stateStore.state.sfuSessionId;
			if (!publisherSfuSessionId) {
				return new Response('Cannot connect. The track has not been published yet.', { status: 400 });
			}

			// Create a player session and pull the published track into it
			const sfu = new SfuClient(this.env);
			const { sessionId: sfuPlayerSessionId } = await sfu.createSession();
			this.logger.log(`Player connecting to track "${sessionName}" via SFU session "${publisherSfuSessionId}"`);
			const sfuAnswer = await sfu.pullRemoteTrackToPlayer(sfuPlayerSessionId, publisherSfuSessionId, sessionName, sessionDescription);
			return new Response(JSON.stringify(sfuAnswer), { headers: { 'Content-Type': 'application/json' } });
		} catch (error: any) {
			this.logger.error(`SFU Connect Error: ${error.message}`);
			return new Response(`SFU Connect Error: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Handles the POST /<session-name>/generate request.
	 */
	private handleGenerate(request: Request): Response {
		// In a Durable Object, to run a task in the background, we call an async method
		// but DO NOT `await` it. The DO runtime will keep the object alive until the
		// promise returned by the method settles. This is the correct pattern for
		// "fire-and-forget" tasks inside a DO.
		// We add a .catch() to prevent unhandled promise rejection warnings in the logs.
		this.processGenerateRequest(request).catch((err) => {
			this.logger.error(`Unhandled error in background generate task:`, err);
		});

		// We can immediately return a 202 Accepted response to the client.
		return new Response('Audio generation accepted', { status: 202 });
	}

	/**
	 * The actual async logic for handling a generate request.
	 */
	private async processGenerateRequest(request: Request): Promise<void> {
		try {
			const { text } = (await request.json()) as any;
			if (!text) {
				this.logger.error(`Generate request failed: Missing text.`);
				return;
			}
			await this.generateAndBroadcastAudio(text);
		} catch (e: any) {
			this.logger.error(`Error during audio generation: ${e.message}`);
		}
	}

	/**
	 * Gets or creates a persistent WebSocket connection to Aura.
	 */
	private async getOrCreateAuraConnection(): Promise<WebSocket> {
		return await dedupedConnect({
			getCurrent: () => this.auraWebSocket,
			setCurrent: (ws) => {
				this.auraWebSocket = ws;
			},
			getCurrentPromise: () => this.auraConnectionPromise,
			setCurrentPromise: (promise) => {
				this.auraConnectionPromise = promise;
			},
			connectFn: () => this.connectToAura(),
		});
	}

	/**
	 * Establishes WebSocket connection to Aura TTS.
	 */
	private async connectToAura(): Promise<WebSocket> {
		// Get the speaker that was selected during publishing
		const selectedSpeaker = this.stateStore.state.selectedSpeaker || AuraSpeaker.ZEUS;

		const params = new URLSearchParams({
			encoding: AuraEncoding.LINEAR16,
			// Note: Not setting sample_rate defaults to 24kHz for linear16
			speaker: selectedSpeaker,
			container: AuraContainer.NONE, // Raw PCM output
		});

		const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT}/ai/run/${TTS_MODEL}?${params.toString()}`;

		// Use fetch with Upgrade header to include Authorization header
		const resp = await fetch(url, {
			headers: {
				Upgrade: 'websocket',
				Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
			},
		});

		const ws = resp.webSocket;

		if (!ws) {
			this.logger.log(`Aura WebSocket request error: ${await resp.text()}`);
			throw new Error('Server did not accept WebSocket connection');
		}

		// Accept the WebSocket to handle it in this Worker
		ws.accept();

		// WebSocket from fetch is already open after accept(), no 'open' event will fire
		if (ws.readyState === WebSocket.OPEN) {
			this.logger.log(`Aura WebSocket connected (already open)`);
			// Clear reconnection state on successful connection in single update
			await this.stateStore.update({
				reconnectAttempts: 0,
				reconnectType: undefined,
				reconnectDeadline: undefined,
			});
			this.auraWebSocket = ws;
			this.setupAuraMessageHandlers(ws);

			// Set up close handler
			ws.addEventListener('close', async (event) => {
				this.logger.log(`Aura WebSocket closed: ${event.code}`);
				this.auraWebSocket = null;
				if (this.stateStore.state.allowReconnect && this.stateStore.state.reconnectAttempts < this.maxReconnectAttempts) {
					this.scheduleTTSAuraReconnect();
				}
			});

			return ws;
		}

		// Fallback: if not immediately open, wait for open event (shouldn't happen with fetch)
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('WebSocket connection timeout'));
			}, 10000); // 10 second timeout

			ws.addEventListener('open', async () => {
				clearTimeout(timeout);
				this.logger.log(`Aura WebSocket connected (via open event)`);
				// Clear reconnection state on successful connection in single update
				await this.stateStore.update({
					reconnectAttempts: 0,
					reconnectType: undefined,
					reconnectDeadline: undefined,
				});
				this.auraWebSocket = ws;
				this.setupAuraMessageHandlers(ws);
				resolve(ws);
			});

			ws.addEventListener('error', (event) => {
				clearTimeout(timeout);
				this.logger.error(`Aura WebSocket error:`, event);
				reject(new Error('WebSocket connection failed'));
			});

			ws.addEventListener('close', async (event) => {
				this.logger.log(`Aura WebSocket closed: ${event.code}`);
				this.auraWebSocket = null;
				if (this.stateStore.state.allowReconnect && this.stateStore.state.reconnectAttempts < this.maxReconnectAttempts) {
					this.scheduleTTSAuraReconnect();
				}
			});
		});
	}

	/**
	 * Sets up message handlers for the Aura WebSocket.
	 */
	private setupAuraMessageHandlers(ws: WebSocket) {
		ws.addEventListener('message', (event) => {
			this.handleAuraMessage(event.data);
		});
	}

	/**
	 * Handles messages from Aura WebSocket.
	 */
	private async handleAuraMessage(data: ArrayBuffer | string) {
		if (typeof data === 'string') {
			// Handle JSON control messages
			try {
				const msg = JSON.parse(data);
				this.logger.log(`Aura control message:`, msg);
				if (msg.type === 'Flushed') {
					this.finalizeAudioStream();
				}
			} catch (e) {
				this.logger.warn(`Invalid JSON from Aura:`, data);
			}
			return;
		}

		// Handle audio data chunks - stream immediately to clients
		const audioChunk = data as ArrayBuffer;

		// Add to buffer for late joiners
		this.audioStreamBuffer.push(audioChunk);

		// Process and stream this chunk immediately to connected clients
		this.streamChunkToClients(audioChunk);

		// Mark as streaming
		if (!this.isStreaming) {
			this.isStreaming = true;
		}
	}

	/**
	 * Schedules a reconnection attempt with exponential backoff using Durable Object alarms.
	 */
	private async scheduleTTSAuraReconnect() {
		const currentAttempts = this.stateStore.state.reconnectAttempts || 0;
		this.logger.log(`Scheduling reconnection attempt ${currentAttempts + 1} for Aura WebSocket`);

		await scheduleReconnect(this.stateStore, {
			type: 'aura-websocket',
			maxAttempts: this.maxReconnectAttempts,
		});
	}

	/**
	 * Closes the Aura WebSocket connection.
	 */
	private closeAuraConnection() {
		if (this.auraWebSocket) {
			this.auraWebSocket.close();
			this.auraWebSocket = null;
		}
		this.auraConnectionPromise = null;
		// If reconnection is disabled, ensure any reconnection state/alarms are cleared
		if (!this.stateStore.state.allowReconnect) {
			// Clear reconnection state in single update
			this.stateStore
				.update({
					reconnectAttempts: 0,
					reconnectType: undefined,
					reconnectDeadline: undefined,
				})
				.catch(() => {});
		} else {
			// Just reset attempts if reconnect is allowed
			this.stateStore.update({ reconnectAttempts: 0 }).catch(() => {});
		}
	}

	/**
	 * Streams a single audio chunk to connected clients in real-time.
	 */
	private streamChunkToClients(audioChunk: ArrayBuffer) {
		if (audioChunk.byteLength === 0) {
			return;
		}

		// Process audio chunk: prefer Speex (24kHz -> 48kHz), then convert mono -> stereo; fallback to JS pipeline
		const processedAudio = this.processTTSUsingSpeexOrFallback(audioChunk);

		// Send to connected clients immediately with proper packet encoding
		const connectedClients = this.ctx.getWebSockets();
		if (connectedClients.length > 0) {
			connectedClients.forEach((ws) => {
				if (ws.readyState === WebSocket.OPEN) {
					// Send the chunk in proper packet format
					for (let offset = 0; offset < processedAudio.byteLength; offset += TTS_BUFFER_CHUNK_SIZE) {
						const chunk = processedAudio.slice(offset, offset + TTS_BUFFER_CHUNK_SIZE);
						ws.send(encodePcmForSfu(chunk));
					}
				}
			});
		}
	}

	/**
	 * Finalizes the audio stream and prepares complete buffer for late joiners.
	 */
	private finalizeAudioStream() {
		this.isStreaming = false;

		// Send end-of-stream signal to all connected clients
		const connectedClients = this.ctx.getWebSockets();
		if (connectedClients.length > 0) {
			this.logger.log(`Sending end-of-stream signal to ${connectedClients.length} client(s)`);
			connectedClients.forEach((ws) => {
				if (ws.readyState === WebSocket.OPEN) {
					// Send empty packet to signal end of audio stream
					ws.send(encodePcmForSfu(new ArrayBuffer(0)));
				}
			});
		}

		if (this.audioStreamBuffer.length === 0) {
			return;
		}

		// Combine all chunks for the persistent buffer (for late joiners)
		const totalLength = this.audioStreamBuffer.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const combinedBuffer = new ArrayBuffer(totalLength);
		const combinedView = new Uint8Array(combinedBuffer);

		let offset = 0;
		for (const chunk of this.audioStreamBuffer) {
			combinedView.set(new Uint8Array(chunk), offset);
			offset += chunk.byteLength;
		}

		// Process complete audio for late joiners
		this.stereoAudioBuffer = this.processTTSUsingSpeexOrFallback(combinedBuffer);

		this.logger.log(`Audio stream finalized. Total buffer: ${this.stereoAudioBuffer.byteLength} bytes`);

		// Clear streaming buffer
		this.audioStreamBuffer = [];

		// Reset inactivity deadline using unified scheduler
		this.scheduleInactivity('finalize').catch((err) => {
			this.logger.error(`Failed to schedule inactivity:`, err);
		});
	}

	/**
	 * Generates audio using WebSocket-based TTS.
	 */
	private async generateAudioAuraWebSocket(text: string): Promise<void> {
		const ws = await this.getOrCreateAuraConnection();

		// Clear previous buffer
		this.audioStreamBuffer = [];
		this.isStreaming = false;

		// Send text for synthesis
		ws.send(JSON.stringify({ type: 'Speak', text }));
		ws.send(JSON.stringify({ type: 'Flush' }));

		this.logger.log(`Sent TTS request via WebSocket: "${text.substring(0, 50)}..."`);
	}

	/**
	 * Legacy HTTP-based Aura generation for fallback.
	 */
	private async generateAudioAura(text: string): Promise<ArrayBuffer> {
		// Get the speaker that was selected during publishing
		const selectedSpeaker = this.stateStore.state.selectedSpeaker || AuraSpeaker.ZEUS;

		const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT}/ai/run/${TTS_MODEL}`, {
			headers: {
				authorization: `Bearer ${this.env.CF_API_TOKEN}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				text: text,
				speaker: selectedSpeaker,
				encoding: AuraEncoding.LINEAR16,
				// Note: Not setting sample_rate defaults to 24kHz for linear16
			}),
			method: 'POST',
		});
		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Cloudflare AI API Error: ${response.status} ${errorText}`);
		}
		return response.arrayBuffer();
	}

	/**
	 * Generates audio and broadcasts it to all connected clients.
	 * Uses WebSocket-based TTS for lower latency streaming.
	 */
	private async generateAndBroadcastAudio(text: string) {
		this.logger.log(`Starting WebSocket TTS generation for text: "${text.substring(0, 50)}..."`);
		try {
			// Use WebSocket-based TTS for streaming
			await this.generateAudioAuraWebSocket(text);
			// Audio will stream in real-time via WebSocket message handlers
		} catch (error: any) {
			this.logger.warn(`WebSocket TTS failed, falling back to HTTP: ${error.message}`);

			// Fallback to HTTP-based generation (always 24kHz for linear16)
			const audioData = await this.generateAudioAura(text);
			this.logger.log(`HTTP fallback completed. Raw size: ${audioData.byteLength} bytes.`);

			// Aura returns 24kHz mono PCM; convert to 48kHz stereo for SFU (prefer Speex, fallback to JS)
			this.stereoAudioBuffer = this.processTTSUsingSpeexOrFallback(audioData);

			const connectedClients = this.ctx.getWebSockets();
			if (connectedClients.length > 0) {
				this.logger.log(`Broadcasting HTTP fallback buffer to ${connectedClients.length} client(s).`);
				connectedClients.forEach((ws) => this.sendBufferInChunks(ws));
			} else {
				this.logger.log(`HTTP fallback buffer generated, but no clients are connected.`);
			}
		}

		// Reset the inactivity deadline on every generation (unconditional)
		await this.scheduleInactivity('generate');
		this.logger.log(`Inactivity deadline has been reset.`);
	}

	/**
	 * Disconnects all WebSocket clients.
	 */
	async disconnectAll() {
		const clients = this.ctx.getWebSockets();
		if (clients.length > 0) {
			this.logger.log(`Closing ${clients.length} WebSocket connection(s).`);
			clients.forEach((ws) => ws.close(1000, 'Session terminated by API request'));
		}
		// Clear stored state on explicit disconnect.
		await this.stateStore.update({
			allowReconnect: false,
			reconnectAttempts: 0,
			sfuSessionId: undefined,
			adapterId: undefined,
			selectedSpeaker: undefined,
			reconnectType: undefined,
			reconnectDeadline: undefined,
			inactivityDeadline: undefined,
		});
	}

	/**
	 * Hard-destroy this session: close Aura + all client sockets, cancel alarms, and wipe storage.
	 */
	public async destroy(): Promise<void> {
		this.logger.log(`Destroy requested: closing Aura, clients, and deleting state`);
		try {
			// Close upstream Aura connection and reset reconnect state
			this.closeAuraConnection();

			// Close all connected WebSocket clients
			const clients = this.ctx.getWebSockets();
			if (clients.length > 0) {
				this.logger.log(`Destroy: closing ${clients.length} WebSocket connection(s)`);
				clients.forEach((ws) => {
					try {
						ws.close(1000, 'Session destroyed');
					} catch {
						/* noop */
					}
				});
			}

			// Clear in-memory buffers/flags
			this.stereoAudioBuffer = null;
			this.audioStreamBuffer = [];
			this.isStreaming = false;

			// Disable reconnects and clear deadlines/state without rescheduling alarms
			await this.stateStore.update(
				{
					allowReconnect: false,
					reconnectAttempts: 0,
					reconnectType: undefined,
					reconnectDeadline: undefined,
					inactivityDeadline: undefined,
					cleanupDeadline: undefined,
					sfuSessionId: undefined,
					adapterId: undefined,
					selectedSpeaker: undefined,
				},
				true
			);

			// Cancel any scheduled alarms and wipe all persisted state
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();

			this.logger.log(`Destroy completed.`);
		} catch (e) {
			this.logger.error(`Destroy error:`, e);
		}
	}

	/**
	 * Handles WebSocket closures. Schedules a deferred cleanup check via alarm.
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		this.logger.log(`WebSocket closed: code=${code}, reason=${reason}. Remaining clients: ${this.ctx.getWebSockets().length}.`);

		// Schedule a deferred cleanup check to handle DO timing issues
		// The alarm will verify if this was truly the last client
		await scheduleDeferredCleanup(this.stateStore);
	}

	/**
	 * Handles WebSocket errors.
	 */
	webSocketError(ws: WebSocket, error: any) {
		this.logger.error(`WebSocket error:`, error);
	}

	/**
	 * Sends the audio buffer to a WebSocket in fixed-size chunks.
	 */
	private sendBufferInChunks(ws: WebSocket, buffer?: ArrayBuffer) {
		const audioBuffer = buffer || this.stereoAudioBuffer;
		if (!audioBuffer) {
			this.logger.error(`Attempted to send a null audio buffer.`);
			return;
		}
		for (let offset = 0; offset < audioBuffer.byteLength; offset += TTS_BUFFER_CHUNK_SIZE) {
			const chunk = audioBuffer.slice(offset, offset + TTS_BUFFER_CHUNK_SIZE);
			ws.send(encodePcmForSfu(chunk));
		}
		// Send an empty packet to signal the end of this audio stream segment.
		ws.send(encodePcmForSfu(new ArrayBuffer(0)));
	}

	// --- Audio Processing Utilities ---

	/**
	 * Prefer SpeexDSP to resample mono 24kHz -> 48kHz, then convert to stereo.
	 * Falls back to JS implementation if WASM is not yet ready.
	 */
	private processTTSUsingSpeexOrFallback(mono24k: ArrayBuffer): ArrayBuffer {
		return resample24kToStereo48k(mono24k, this.speexTTSResampler);
	}
}

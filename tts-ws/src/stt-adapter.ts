import { DurableObject } from 'cloudflare:workers';
import { SpeexResampler } from './speex-resampler';
import { SfuClient, buildWsCallbackUrl, extractPcmFromSfuPacket } from './shared/sfu-utils';
import { toMono16kFromStereo48k, initSpeexResampler } from './shared/audio-utils';
import { createAdapterLogger } from './shared/log';
import { createStateStore, StateStore } from './shared/state-store';
import { dedupedConnect } from './shared/ws-connection';
import { buildDeadlineAggregator, scheduleDeferredCleanup, getOpenSockets, scheduleReconnect } from './shared/do-utils';
import {
	STT_MODEL,
	DEFAULT_INACTIVITY_TIMEOUT_MS,
	DEFAULT_MAX_RECONNECT_ATTEMPTS,
	STT_DEBUG_GRACE_MS,
	STT_NOVA_KEEPALIVE_MS,
	STT_MAX_QUEUE_BYTES,
	STT_MIN_BATCH_BYTES,
	STT_MAX_BATCH_BYTES,
	STT_MAX_DRAIN_BATCHES_PER_TURN,
	STT_MAX_DRAIN_SLICE_MS,
} from './shared/config';

/**
 * WebSocket Session State - Persisted across hibernation
 */
interface SessionState {
	id: string;
	type: 'sfu-audio' | 'transcription-stream';
	createdAt?: number;
}

/**
 * STT Adapter Persistent State - All state that needs to survive hibernation
 */
interface STTAdapterState {
	// Control message flags
	pendingClose: boolean;
	pendingFinalize: boolean;
	closingDueToInactivity: boolean;

	// Reconnection state
	allowReconnect: boolean;
	reconnectAttempts: number;
	reconnectType?: string;
	reconnectDeadline?: number;

	// Deadline tracking
	inactivityDeadline?: number;
	keepAliveDeadline?: number;
	cleanupDeadline?: number;

	// SFU session info
	sfuSessionId?: string;
	sfuAdapterId?: string;
	sfuCallbackUrl?: string;
	micTrackName?: string;
	// Human-readable session name (for logging)
	sessionName?: string;
}

/**
 * STTAdapter Durable Object - Handles Speech-to-Text processing
 * Receives SFU audio packets, processes them, and streams to Nova
 * Uses WebSocket Hibernation API to reduce costs during idle periods
 */
export class STTAdapter extends DurableObject<Env> {
	protected env: Env;
	protected ctx: DurableObjectState;
	private logger: ReturnType<typeof createAdapterLogger>;

	// Persistent state management using shared state store
	private stateStore: StateStore<STTAdapterState>;
	private novaSTTWebSocket: WebSocket | null = null;
	private novaSTTConnectionPromise: Promise<WebSocket> | null = null;
	private readonly maxReconnectAttempts = DEFAULT_MAX_RECONNECT_ATTEMPTS;
	private transcriptionBuffer: any[] = [];

	// STT send queue (FIFO) to avoid dropping frames under load or reconnects
	private sttSendQueue: ArrayBuffer[] = [];
	private sttQueuedBytes = 0;
	private readonly maxSTTQueueBytes = STT_MAX_QUEUE_BYTES;
	private readonly minSTTBatchBytes = STT_MIN_BATCH_BYTES;
	private readonly maxSTTBatchBytes = STT_MAX_BATCH_BYTES;
	private sttDraining = false;
	private sttDrainScheduled = false;
	private readonly maxDrainBatchesPerTurn = STT_MAX_DRAIN_BATCHES_PER_TURN;
	private readonly maxDrainSliceMs = STT_MAX_DRAIN_SLICE_MS;
	private speexSTTResampler: SpeexResampler | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.ctx = ctx;
		this.logger = createAdapterLogger('STT', ctx.id);

		// Initialize state store with default values and deadline getter
		this.stateStore = createStateStore<STTAdapterState>(
			ctx,
			'sttState',
			{
				pendingClose: false,
				pendingFinalize: false,
				closingDueToInactivity: false,
				allowReconnect: true,
				reconnectAttempts: 0,
			},
			buildDeadlineAggregator<STTAdapterState>(['inactivityDeadline', 'reconnectDeadline', 'keepAliveDeadline', 'cleanupDeadline'])
		);

		// Restore persistent state under blockConcurrencyWhile to avoid init races
		this.ctx.blockConcurrencyWhile(async () => {
			await this.stateStore.restore();
			// Restore alias silently if we have a persisted session name
			const restoredName = this.stateStore.state.sessionName;
			if (restoredName) {
				this.logger.setAliasSilently(restoredName);
			}
			// If we have pending control messages, trigger drain to send them
			if (this.stateStore.state.pendingClose || this.stateStore.state.pendingFinalize) {
				this.logger.log(`Pending control messages found after restore, triggering drain`);
				this.scheduleSTTDrainSoon();
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

		// Initialize SpeexDSP WASM and pre-create STT resampler (48k -> 16k, mono)
		this.speexSTTResampler = initSpeexResampler(1, 48000, 16000);
		if (this.speexSTTResampler) {
			this.logger.log(`Speex STT resampler initialized`);
		}

		// Set auto-response for ping/pong to avoid waking from hibernation
		this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

		this.logger.log(`Durable Object created or woken up.`);
	}

	/**
	 * Connection accounting helpers
	 */
	private getConnectionCounts() {
		const sockets = this.ctx.getWebSockets();
		let sfuAudio = 0;
		let transcription = 0;
		for (const w of sockets) {
			const s = w.deserializeAttachment() as SessionState | null;
			if (!s) continue;
			if (s.type === 'sfu-audio') sfuAudio++;
			else if (s.type === 'transcription-stream') transcription++;
		}
		return { sfuAudio, transcription };
	}

	private isAnyoneHere() {
		const { sfuAudio, transcription } = this.getConnectionCounts();
		return sfuAudio > 0 || transcription > 0;
	}

	/**
	 * Get connection counts for only actually-open sockets (readyState === OPEN)
	 * Used by alarm() to make reliable cleanup decisions
	 */
	private getOpenConnectionCounts() {
		const openSockets = getOpenSockets(this.ctx);
		let sfuAudio = 0;
		let transcription = 0;
		for (const w of openSockets) {
			const s = w.deserializeAttachment() as SessionState | null;
			if (!s) continue;
			if (s.type === 'sfu-audio') sfuAudio++;
			else if (s.type === 'transcription-stream') transcription++;
		}
		return { sfuAudio, transcription };
	}

	/**
	 * Inactivity scheduling helpers
	 */
	private async scheduleInactivityIfIdle(reason: string, graceMs = DEFAULT_INACTIVITY_TIMEOUT_MS) {
		if (!this.isAnyoneHere()) {
			this.logger.log(`No active sessions when called from '${reason}', checking inactivity timer`);
		} else {
			return; // Someone is here, skip inactivity scheduling
		}
		const desired = Date.now() + graceMs;
		if (this.stateStore.state.inactivityDeadline && this.stateStore.state.inactivityDeadline <= desired + 250) {
			// Existing is earlier or close enough; do nothing
			return;
		}
		await this.stateStore.update({ inactivityDeadline: desired });
		this.logger.log(`Inactivity scheduled (${reason}) at ${new Date(desired).toISOString()}`);
	}

	private async cancelInactivity() {
		await this.stateStore.deleteKeys(['inactivityDeadline']);
	}

	/**
	 * Handles HTTP requests to the STT adapter
	 * Endpoints:
	 *  - WS   /<session-name>/stt/sfu-subscribe          (Cloudflare SFU → DO audio)
	 *  - WS   /<session-name>/stt/transcription-stream   (clients receive transcriptions)
	 *  - POST /<session-name>/stt/connect                (create SFU session, publish mic)
	 *  - POST /<session-name>/stt/start-forwarding       (create SFU→DO WS adapter once PC connected)
	 *  - POST /<session-name>/stt/stop-forwarding
	 *  - POST /<session-name>/stt/reconnect-nova         (debug)
	 */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		const pathParts = url.pathname
			.substring(1)
			.split('/')
			.filter((p) => p);

		if (pathParts.length < 2) {
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
		// pathParts[1] is 'stt'
		const action = pathParts.length > 2 ? pathParts[2] : null;

		switch (action) {
			case 'sfu-subscribe':
				return this.handleSFUSubscribe(request);
			case 'transcription-stream':
				return this.handleTranscriptionStream(request);
			case 'connect':
				return this.handleSTTConnect(request, sessionName);
			case 'start-forwarding':
				return this.handleStartForwarding();
			case 'stop-forwarding':
				return this.handleStopForwarding();
			case 'reconnect-nova':
				return this.handleReconnectNova();
			default:
				return new Response(
					'STT Adapter: WebSocket endpoints available at /sfu-subscribe and /transcription-stream. POST to /connect to establish WebRTC connection.',
					{ status: 200 }
				);
		}
	}

	/**
	 * Handles WebSocket upgrade requests from SFU for audio input
	 * Enforces single SFU audio subscriber - new connections supersede old ones
	 */
	private handleSFUSubscribe(request: Request): Response {
		// Check for WebSocket upgrade header
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Use Hibernation API to accept WebSocket
		this.ctx.acceptWebSocket(server);

		// Create session state for this WebSocket
		const sessionState: SessionState = {
			id: crypto.randomUUID(),
			type: 'sfu-audio',
		};

		// Store session state directly on WebSocket for hibernation compatibility
		server.serializeAttachment(sessionState);

		// Enforce single SFU audio subscriber: close any existing sfu-audio sockets
		const existingSockets = this.ctx.getWebSockets();
		for (const ws of existingSockets) {
			if (ws !== server && ws.readyState === WebSocket.OPEN) {
				const attachment = ws.deserializeAttachment() as SessionState | null;
				if (attachment && attachment.type === 'sfu-audio') {
					this.logger.log(`Closing existing SFU audio socket ${attachment.id} to enforce single subscriber`);
					ws.close(1000, 'Superseded by newer subscriber');
				}
			}
		}

		this.logger.log(`New SFU WebSocket connection established: ${sessionState.id}`);
		// Someone is here; cancel inactivity
		void this.cancelInactivity();
		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/**
	 * Handles STT WebRTC connection setup
	 * Creates an SFU session and publishes mic via autoDiscover; defers WebSocket forwarding
	 * to /start-forwarding after the PeerConnection reaches "connected".
	 */
	private async handleSTTConnect(request: Request, sessionName: string): Promise<Response> {
		try {
			const { sessionDescription } = (await request.json()) as any;
			if (!sessionDescription) return new Response('Missing sessionDescription', { status: 400 });

			// Use SFU client: create session and publish mic track via autoDiscover
			const sfu = new SfuClient(this.env);
			const { sessionId: sfuSTTSessionId } = await sfu.createSession();
			const { json: publishResponse, audioTrackName: micTrackName } = await sfu.addTracksAutoDiscover(sfuSTTSessionId, sessionDescription);

			if (!micTrackName) {
				throw new Error('Failed to get microphone track name from SFU response');
			}

			// Store the SFU session ID and track name for later WebSocket forwarding
			// Use the STT adapter's Durable Object ID for the callback URL
			const sttCallbackUrl = buildWsCallbackUrl(request, `/${sessionName}/stt/sfu-subscribe`);

			// Batch all state updates into a single operation
			await this.stateStore.update({
				sfuSessionId: sfuSTTSessionId,
				micTrackName: micTrackName,
				sfuCallbackUrl: sttCallbackUrl.toString(),
				allowReconnect: false, // During pre-warm, do not try to auto-reconnect Nova
			});

			// Pre-warm Nova WebSocket so start-forwarding has minimal latency
			try {
				await this.getOrCreateNovaSTTConnection();
				// Start KeepAlive cycle to prevent Nova from closing during pre-forwarding
				await this.scheduleKeepAliveIfPreForwarding();
				// If still idle after prewarm, start inactivity timer
				await this.scheduleInactivityIfIdle('prewarm-nova');
				this.logger.log(`Pre-warmed Nova WebSocket with KeepAlive`);
			} catch (e) {
				this.logger.warn(`Pre-warm Nova failed (will connect on demand):`, e);
			}

			this.logger.log(`STT WebRTC connection prepared for session ${sfuSTTSessionId}, track ${micTrackName}`);
			this.logger.log(`Client should now complete WebRTC connection, then call /start-forwarding`);

			return new Response(JSON.stringify(publishResponse), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error: any) {
			this.logger.error(`STT Connect Error:`, error.message);
			return new Response(`STT Connect Error: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Handles WebSocket upgrade requests for transcription streaming
	 */
	private handleTranscriptionStream(request: Request): Response {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected WebSocket upgrade', { status: 426 });
		}

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Use Hibernation API to accept WebSocket
		this.ctx.acceptWebSocket(server);

		// Generate session ID and attach state to WebSocket
		const sessionId = crypto.randomUUID();
		const sessionState: SessionState = {
			id: sessionId,
			type: 'transcription-stream',
			createdAt: Date.now(),
		};

		// Serialize attachment for hibernation recovery
		server.serializeAttachment(sessionState);

		// Send any buffered transcriptions
		if (this.transcriptionBuffer.length > 0) {
			this.transcriptionBuffer.forEach((transcript) => {
				server.send(JSON.stringify(transcript));
			});
		}

		this.logger.log(`New transcription stream connection: ${sessionId}`);
		// Someone is here; cancel inactivity
		void this.cancelInactivity();
		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	/**
	 * WebSocket message handler - called by Hibernation API
	 * Handles messages from both SFU audio and control connections
	 */
	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		const session = ws.deserializeAttachment() as SessionState | null;
		if (!session) {
			return;
		}

		if (session.type === 'sfu-audio' && message instanceof ArrayBuffer) {
			// Handle SFU audio packet
			await this.handleSFUAudioPacket(message);
		} else if (session.type === 'transcription-stream' && typeof message === 'string') {
			// Handle control messages from transcription clients
			try {
				const controlMsg = JSON.parse(message);
				this.logger.log(`Control message from ${session.id}:`, controlMsg);
			} catch (error) {
				this.logger.error(`Invalid control message:`, error);
			}
		}
	}

	/**
	 * WebSocket close handler - called by Hibernation API
	 * Defers cleanup decisions to alarm() to avoid timing races
	 */
	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		const session = ws.deserializeAttachment() as SessionState | null;
		if (session) {
			this.logger.log(`Session ${session.id} disconnected: ${code} ${reason}`);
		} else {
			this.logger.log(`Unknown WebSocket disconnected: ${code} ${reason}`);
		}

		// Schedule deferred cleanup check to handle DO timing issues
		await scheduleDeferredCleanup(this.stateStore);
	}

	/**
	 * WebSocket error handler - called by Hibernation API
	 */
	async webSocketError(ws: WebSocket, error: unknown) {
		const session = ws.deserializeAttachment() as SessionState | null;
		if (session) {
			this.logger.error(`WebSocket error for ${session.id}:`, error);
		}
	}

	/**
	 * Handles incoming audio packets from SFU
	 */
	private async handleSFUAudioPacket(packetData: ArrayBuffer) {
		const audioData = extractPcmFromSfuPacket(packetData);
		if (audioData) {
			await this.processAudioForSTT(audioData);
		}
	}

	/**
	 * Processes audio data for STT (format conversion + streaming)
	 */
	private async processAudioForSTT(audioData: ArrayBuffer) {
		if (audioData.byteLength === 0) return;

		// Convert stereo 48kHz to mono 16kHz using shared utility
		const mono16k = toMono16kFromStereo48k(audioData, this.speexSTTResampler);

		// Enqueue for FIFO sending
		this.enqueueAudioForSTT(mono16k);
	}

	/**
	 * Enqueue audio for FIFO sending to Nova STT
	 */
	private enqueueAudioForSTT(audioData: ArrayBuffer) {
		if (audioData.byteLength === 0) return;
		this.sttSendQueue.push(audioData);
		this.sttQueuedBytes += audioData.byteLength;
		// Drop oldest frames if queue exceeds cap
		while (this.sttQueuedBytes > this.maxSTTQueueBytes && this.sttSendQueue.length > 0) {
			const dropped = this.sttSendQueue.shift()!;
			this.sttQueuedBytes -= dropped.byteLength;
			this.logger.warn(`STT queue overflow. Dropping ${dropped.byteLength} bytes. Current queued: ${this.sttQueuedBytes}`);
		}
		this.scheduleSTTDrainSoon();
	}

	/**
	 * Request finalization of the STT stream (send Finalize after draining)
	 */
	private async requestFinalize() {
		await this.stateStore.update({ pendingFinalize: true });
		this.scheduleSTTDrainSoon();
	}

	/**
	 * Request CloseStream due to inactivity (send CloseStream after draining)
	 */
	private async requestCloseStreamDueToInactivity() {
		await this.stateStore.update({
			pendingClose: true,
			closingDueToInactivity: true,
		});
		this.scheduleSTTDrainSoon();
	}

	/**
	 * Schedule a non-blocking drain on the next turn of the event loop
	 */
	private scheduleSTTDrainSoon() {
		if (this.sttDrainScheduled || this.sttDraining) return;
		this.sttDrainScheduled = true;
		setTimeout(() => {
			this.sttDrainScheduled = false;
			void this.ensureSTTDrain();
		}, 0);
	}

	/**
	 * Drain the STT queue sequentially, maintaining send order, without blocking the worker
	 * Control semantics: Finalize is used on stop-forwarding to flush results; CloseStream is
	 * reserved for inactivity cleanup after draining.
	 */
	private async ensureSTTDrain() {
		if (this.sttDraining) return;
		this.sttDraining = true;
		try {
			const start = Date.now();
			let batches = 0;
			while (
				this.sttQueuedBytes >= this.minSTTBatchBytes ||
				((this.stateStore.state.pendingClose || this.stateStore.state.pendingFinalize) && this.sttQueuedBytes > 0)
			) {
				const ws = await this.getOrCreateNovaSTTConnection();
				if (ws.readyState !== WebSocket.OPEN) break; // not OPEN

				// Coalesce multiple frames into a single batch
				let batchBytes = 0;
				const pieces: ArrayBuffer[] = [];
				while (this.sttSendQueue.length > 0 && batchBytes < this.maxSTTBatchBytes) {
					const next = this.sttSendQueue[0]; // Peek
					if (batchBytes + next.byteLength > this.maxSTTBatchBytes && batchBytes > 0) {
						break; // Don't add if it exceeds max batch size, and we already have data
					}
					this.sttSendQueue.shift(); // Pop
					this.sttQueuedBytes -= next.byteLength;
					pieces.push(next);
					batchBytes += next.byteLength;
				}

				if (batchBytes > 0) {
					let toSend: ArrayBuffer;
					if (pieces.length === 1) {
						toSend = pieces[0];
					} else {
						const out = new Uint8Array(batchBytes);
						let offset = 0;
						for (const p of pieces) {
							out.set(new Uint8Array(p), offset);
							offset += p.byteLength;
						}
						toSend = out.buffer;
					}
					ws.send(toSend);
				}

				batches++;
				if (batches >= this.maxDrainBatchesPerTurn || Date.now() - start >= this.maxDrainSliceMs) {
					break; // Yield to allow other events to be processed
				}
			}

			// After draining audio frames in this tick, send control messages if pending and queue empty
			if (this.sttQueuedBytes === 0) {
				const ws = await this.getOrCreateNovaSTTConnection();
				if (ws.readyState === WebSocket.OPEN) {
					if (this.stateStore.state.pendingFinalize) {
						try {
							ws.send(JSON.stringify({ type: 'Finalize' }));
							this.logger.log(`Sent Finalize to Nova`);
						} catch (e) {
							this.logger.warn(`Failed to send Finalize:`, e);
						}
						await this.stateStore.update({ pendingFinalize: false });
					} else if (this.stateStore.state.pendingClose) {
						try {
							ws.send(JSON.stringify({ type: 'CloseStream' }));
							this.logger.log(`Sent CloseStream to Nova (inactivity)`);
						} catch (e) {
							this.logger.warn(`Failed to send CloseStream:`, e);
						}
						await this.stateStore.update({ pendingClose: false });
					}
				}
			}
		} catch (error) {
			this.logger.error(`Error draining STT queue:`, error);
		} finally {
			this.sttDraining = false;
			// If more work remains, schedule another drain turn
			if (
				this.sttQueuedBytes >= this.minSTTBatchBytes ||
				((this.stateStore.state.pendingClose || this.stateStore.state.pendingFinalize) && this.sttQueuedBytes > 0)
			) {
				this.scheduleSTTDrainSoon();
			}
		}
	}

	/**
	 * Gets or creates a persistent Nova STT WebSocket connection
	 */
	private async getOrCreateNovaSTTConnection(): Promise<WebSocket> {
		return await dedupedConnect({
			getCurrent: () => this.novaSTTWebSocket,
			setCurrent: (ws) => {
				this.novaSTTWebSocket = ws;
			},
			getCurrentPromise: () => this.novaSTTConnectionPromise,
			setCurrentPromise: (promise) => {
				this.novaSTTConnectionPromise = promise;
			},
			connectFn: () => this.connectToNovaSTT(),
		});
	}

	/**
	 * Establishes WebSocket connection to Nova STT
	 */
	private async connectToNovaSTT(): Promise<WebSocket> {
		const params = new URLSearchParams({
			encoding: 'linear16',
			sample_rate: '16000',
		});

		const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.CF_ACCOUNT}/ai/run/${STT_MODEL}?${params.toString()}`;

		// Use fetch with Upgrade header to include Authorization header
		const resp = await fetch(url, {
			headers: {
				Upgrade: 'websocket',
				Authorization: `Bearer ${this.env.CF_API_TOKEN}`,
			},
		});

		const ws = resp.webSocket;

		if (!ws) {
			this.logger.log(`Nova WebSocket request error: ${await resp.text()}`);
			throw new Error(`Failed to establish Nova WebSocket: ${resp.status}`);
		}

		// Accept the WebSocket to handle it in this Worker
		ws.accept();

		this.novaSTTWebSocket = ws;
		this.novaSTTConnectionPromise = null;

		// Clear reconnection state on successful connection
		await this.stateStore.update({
			reconnectAttempts: 0,
			reconnectType: undefined,
			reconnectDeadline: undefined,
		});

		this.setupNovaSTTMessageHandlers(ws);
		this.logger.log(`Connected to Nova WebSocket`);
		// Resume draining queued audio upon successful connection
		if (this.sttSendQueue.length > 0 || this.stateStore.state.pendingClose) {
			this.scheduleSTTDrainSoon();
		}

		return ws;
	}

	/**
	 * Sets up message handlers for Nova STT WebSocket
	 */
	private setupNovaSTTMessageHandlers(ws: WebSocket) {
		ws.addEventListener('message', (event) => {
			this.handleNovaSTTMessage(event.data);
		});

		ws.addEventListener('error', (event) => {
			this.logger.error(`Nova WebSocket error:`, event);
		});

		ws.addEventListener('close', async (event) => {
			this.logger.log(`Nova WebSocket closed: ${event.code}`);
			this.novaSTTWebSocket = null;

			// If closing due to inactivity, re-check if clients have joined since then
			if (this.stateStore.state.closingDueToInactivity) {
				// Re-check occupancy to avoid closing newly-joined clients
				const { sfuAudio, transcription } = this.getOpenConnectionCounts();

				if (sfuAudio === 0 && transcription === 0) {
					// Still no clients, proceed with inactivity cleanup
					this.logger.log(`Nova closed due to inactivity, closing transcription clients`);
					this.broadcastTranscriptionDone();
					// Close all transcription stream clients
					// Rationale: getOpenConnectionCounts() returns counts for sockets with readyState === OPEN.
					// Cloudflare DO timing can leave CONNECTING/CLOSING sockets in ctx.getWebSockets().
					// Even when open counts are zero, explicitly closing any tracked 'transcription-stream'
					// sockets ensures we deterministically enforce the "stt_done then close" contract and
					// avoid stragglers lingering. These close() calls are idempotent and cheap if a socket
					// is already closing/closed.
					const webSockets = this.ctx.getWebSockets();
					webSockets.forEach((ws) => {
						const session = ws.deserializeAttachment() as SessionState | null;
						if (session && session.type === 'transcription-stream') {
							ws.close(1000, 'Transcription complete');
						}
					});
				} else {
					// New clients have connected, skip client closures
					this.logger.log(
						`Nova closed with closingDueToInactivity=true, but found ${sfuAudio} audio and ${transcription} transcription clients. Skipping client closures.`
					);
				}

				await this.stateStore.update({
					closingDueToInactivity: false,
					allowReconnect: false,
				});
			} else if (this.stateStore.state.allowReconnect && this.stateStore.state.reconnectAttempts < this.maxReconnectAttempts) {
				this.scheduleSTTReconnect();
			}
		});
	}

	/**
	 * Handles messages from Nova STT WebSocket
	 */
	private handleNovaSTTMessage(data: string | ArrayBuffer) {
		if (typeof data === 'string') {
			try {
				const response = JSON.parse(data);
				this.logger.log(`STT Response:`, response);

				// Stream transcription results back to connected SFU clients
				this.broadcastTranscriptionResult(response);

				// Handle finalize response (segment finalized, but keep connection)
				if (response && response.from_finalize) {
					this.logger.log(`Segment finalized (from_finalize: true)`);
					// Optionally broadcast a segment finalized event
					this.broadcastSegmentFinalized();
				}
				// Note: Do NOT use response.created as a completion signal
			} catch (error) {
				this.logger.error(`Error parsing STT response:`, error);
			}
		}
	}

	/**
	 * Broadcasts transcription results to connected transcription clients
	 */
	private broadcastTranscriptionResult(transcriptionData: any) {
		// Add to buffer for late joiners
		if (this.transcriptionBuffer.length > 100) {
			// Keep only last 100 transcriptions
			this.transcriptionBuffer.shift();
		}
		this.transcriptionBuffer.push({
			type: 'transcription',
			data: transcriptionData,
			timestamp: Date.now(),
		});

		// Broadcast transcription to connected transcription stream clients
		const webSockets = this.ctx.getWebSockets();
		if (webSockets.length > 0) {
			const transcriptionClients = webSockets.filter((ws) => {
				const session = ws.deserializeAttachment() as SessionState | null;
				return session && session.type === 'transcription-stream';
			});

			const message = JSON.stringify({
				type: 'transcription',
				data: transcriptionData,
				timestamp: Date.now(),
			});

			transcriptionClients.forEach((ws) => {
				ws.send(message);
			});

			this.logger.log(`Broadcasted transcription to ${transcriptionClients.length} client(s)`);
		}
	}

	/**
	 * Broadcasts a 'done' signal to clients so they can close their transcription WS
	 */
	private broadcastTranscriptionDone() {
		const webSockets = this.ctx.getWebSockets();
		const transcriptionClients = webSockets.filter((ws) => {
			const session = ws.deserializeAttachment() as SessionState | null;
			return session && session.type === 'transcription-stream';
		});
		const message = JSON.stringify({ type: 'stt_done', timestamp: Date.now() });
		transcriptionClients.forEach((ws) => ws.send(message));
		this.logger.log(`Broadcasted stt_done to ${transcriptionClients.length} client(s)`);
	}

	/**
	 * Broadcasts a segment finalized signal (from Finalize response)
	 */
	private broadcastSegmentFinalized() {
		const webSockets = this.ctx.getWebSockets();
		const transcriptionClients = webSockets.filter((ws) => {
			const session = ws.deserializeAttachment() as SessionState | null;
			return session && session.type === 'transcription-stream';
		});
		const message = JSON.stringify({ type: 'segment_finalized', timestamp: Date.now() });
		transcriptionClients.forEach((ws) => ws.send(message));
		this.logger.log(`Broadcasted segment_finalized to ${transcriptionClients.length} client(s)`);
	}

	/**
	 * Schedules a reconnection attempt with exponential backoff using Durable Object alarms
	 */
	private async scheduleSTTReconnect() {
		const currentAttempts = this.stateStore.state.reconnectAttempts || 0;
		this.logger.log(`Scheduling STT reconnection attempt ${currentAttempts + 1} for Nova`);

		await scheduleReconnect(this.stateStore, {
			type: 'nova-stt-websocket',
			maxAttempts: this.maxReconnectAttempts,
		});
	}

	private async handleStartForwarding(): Promise<Response> {
		try {
			const sfuSTTSessionId = this.stateStore.state.sfuSessionId;
			const micTrackName = this.stateStore.state.micTrackName;
			const callbackUrl = this.stateStore.state.sfuCallbackUrl;

			if (!sfuSTTSessionId || !micTrackName || !callbackUrl) {
				return new Response('Missing forwarding setup data. Please call /connect first.', { status: 400 });
			}

			// Idempotency: if we already have an active adapter, no-op
			if (this.stateStore.state.sfuAdapterId) {
				this.logger.log(`Forwarding already active via adapter ${this.stateStore.state.sfuAdapterId}.`);
				return new Response('Forwarding already active', { status: 200 });
			}

			// Cancel KeepAlive since forwarding is now active
			await this.cancelKeepAlive();

			// Enable reconnection for Nova STT while forwarding is active
			await this.stateStore.update({ allowReconnect: true });

			this.logger.log(`Setting up WebSocket forwarding for track ${micTrackName}`);

			const sfu = new SfuClient(this.env);
			const { adapterId } = await sfu.pullTrackToWebSocket(sfuSTTSessionId, micTrackName, callbackUrl);

			if (adapterId) {
				await this.stateStore.update({ sfuAdapterId: adapterId });
				this.logger.log(`Stored STT adapterId: ${adapterId}`);
			}

			this.logger.log(`Successfully set up WebSocket forwarding for session ${sfuSTTSessionId}`);
			// Active use; cancel inactivity timer
			await this.cancelInactivity();
			return new Response('WebSocket forwarding started successfully', { status: 200 });
		} catch (error: any) {
			this.logger.error(`Error setting up forwarding:`, error.message);
			return new Response(`Error setting up forwarding: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Handles POST /stop-forwarding
	 * Closes the SFU WebSocket adapter forwarding audio to this DO.
	 */
	private async handleStopForwarding(): Promise<Response> {
		try {
			if (!this.stateStore.state.sfuAdapterId) {
				this.logger.log(`Stop-forwarding requested but no adapterId found. No-op.`);
				return new Response('Forwarding already stopped', { status: 200 });
			}

			this.logger.log(`Closing STT forwarding adapter ${this.stateStore.state.sfuAdapterId}`);
			const sfu = new SfuClient(this.env);
			const close = await sfu.closeWebSocketAdapter(this.stateStore.state.sfuAdapterId);
			if (!close.ok) {
				this.logger.error(`Failed to stop STT forwarding: ${close.status} ${close.text}`);
				return new Response(`Failed to stop forwarding: ${close.text}`, { status: 500 });
			}
			if (close.alreadyClosed) {
				this.logger.log(`Adapter already closed on SFU. Proceeding with local cleanup.`);
			}

			await this.stateStore.deleteKeys(['sfuAdapterId']);
			// Request Finalize to flush any buffered transcriptions
			await this.requestFinalize();

			// Re-enter pre-forwarding state: ensure Nova is open and resume KeepAlive
			try {
				await this.getOrCreateNovaSTTConnection();
				await this.scheduleKeepAliveIfPreForwarding();
				this.logger.log(`STT forwarding stopped. Sent Finalize. Nova kept open with KeepAlive resumed.`);
			} catch (e) {
				this.logger.warn(`Failed to ensure Nova connection after stop-forwarding:`, e);
			}

			// If nobody is connected anymore, start inactivity timer
			if (!this.isAnyoneHere()) {
				await this.scheduleInactivityIfIdle('stop-forwarding');
			}
			return new Response('WebSocket forwarding stopped successfully', { status: 200 });
		} catch (error: any) {
			this.logger.error(`Error stopping forwarding:`, error.message);
			return new Response(`Error stopping forwarding: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * POST /reconnect-nova (debug only)
	 * Closes and immediately reconnects to Nova STT without finalizing.
	 */
	private async handleReconnectNova(): Promise<Response> {
		try {
			const { sfuAudio, transcription } = this.getConnectionCounts();
			if (sfuAudio === 0 && transcription === 0) {
				// Edge case: no clients, ensure Nova closed and schedule short cleanup
				await this.closeNovaSTTConnection();
				await this.scheduleInactivityIfIdle('debug-restart-no-clients', STT_DEBUG_GRACE_MS);
				return new Response('No clients connected; Nova closed.', { status: 200 });
			}
			// Setup reconnection logic with WebSocket close handler
			await this.stateStore.update({ allowReconnect: true });
			await this.restartNovaSTTConnection();
			await this.cancelInactivity();
			return new Response('Nova reconnected', { status: 200 });
		} catch (error: any) {
			this.logger.error(`Reconnect Nova failed:`, error.message);
			return new Response(`Reconnect Nova failed: ${error.message}`, { status: 500 });
		}
	}

	/**
	 * Closes current Nova STT WS (if any) and establishes a new one.
	 * Does NOT call finalize; queued audio will resume on reconnect.
	 */
	private async restartNovaSTTConnection(): Promise<void> {
		try {
			if (this.novaSTTWebSocket) {
				try {
					this.novaSTTWebSocket.close(1012, 'Service Restart');
				} catch {}
				this.novaSTTWebSocket = null;
			}
			this.novaSTTConnectionPromise = null;
			await this.stateStore.update({
				reconnectAttempts: 0,
				reconnectType: undefined,
			});
			await this.getOrCreateNovaSTTConnection();
		} catch (e) {
			this.logger.warn(`restartNovaSTTConnection warning:`, e);
			throw e;
		}
	}

	/**
	 * Closes the Nova STT WebSocket connection
	 */
	private async closeNovaSTTConnection() {
		// Intentionally disable reconnection and close Nova STT immediately
		try {
			this.novaSTTWebSocket?.close(1000, 'No clients');
		} catch {}
		this.novaSTTWebSocket = null;
		this.novaSTTConnectionPromise = null;

		// Clear send queue
		this.sttSendQueue = [];
		this.sttQueuedBytes = 0;

		// Single state update for all state changes
		await this.stateStore.update({
			allowReconnect: false,
			reconnectAttempts: 0,
			reconnectType: undefined,
			pendingClose: false,
			pendingFinalize: false,
			closingDueToInactivity: false,
		});
	}

	/**
	 * Schedule KeepAlive messages during pre-forwarding window
	 */
	private async scheduleKeepAliveIfPreForwarding() {
		// Check gating conditions
		if (!this.novaSTTWebSocket || this.novaSTTWebSocket.readyState !== WebSocket.OPEN) {
			return; // Nova not open
		}
		if (!this.stateStore.state.sfuSessionId) {
			return; // No SFU session established
		}
		if (this.stateStore.state.sfuAdapterId) {
			return; // Forwarding already active
		}

		// Schedule next KeepAlive in STT_NOVA_KEEPALIVE_MS (5s by default)
		await this.stateStore.update({ keepAliveDeadline: Date.now() + STT_NOVA_KEEPALIVE_MS });
		this.logger.log(`KeepAlive scheduled for pre-forwarding window`);
	}

	/**
	 * Cancel KeepAlive scheduling
	 */
	private async cancelKeepAlive() {
		await this.stateStore.deleteKeys(['keepAliveDeadline']);
		this.logger.log(`KeepAlive cancelled`);
	}

	/**
	 * Hard-destroy this session: close Nova + all client sockets, cancel alarms, and wipe storage.
	 */
	public async destroy(): Promise<void> {
		this.logger.log(`Destroy requested: closing Nova, clients, and deleting state`);
		try {
			// Close upstream Nova connection and reset state
			await this.closeNovaSTTConnection();

			// Close all connected WebSocket clients (SFU audio + transcription)
			const sockets = this.ctx.getWebSockets();
			if (sockets.length > 0) {
				this.logger.log(`Destroy: closing ${sockets.length} WebSocket connection(s)`);
				sockets.forEach((ws) => {
					try {
						ws.close(1000, 'Session destroyed');
					} catch {
						/* noop */
					}
				});
			}

			// Clear in-memory queues/buffers and flags
			this.sttSendQueue = [];
			this.sttQueuedBytes = 0;
			this.sttDraining = false;
			this.sttDrainScheduled = false;
			this.transcriptionBuffer = [];

			// Disable reconnects and clear deadlines/state without rescheduling alarms
			await this.stateStore.update(
				{
					pendingClose: false,
					pendingFinalize: false,
					closingDueToInactivity: false,
					allowReconnect: false,
					reconnectAttempts: 0,
					reconnectType: undefined,
					reconnectDeadline: undefined,
					inactivityDeadline: undefined,
					keepAliveDeadline: undefined,
					cleanupDeadline: undefined,
					sfuSessionId: undefined,
					sfuAdapterId: undefined,
					sfuCallbackUrl: undefined,
					micTrackName: undefined,
					sessionName: undefined,
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
	 * Durable Object alarm handler for cleanup, inactivity, reconnect, and keepalive.
	 * Acts as the single reducer for time-triggered state transitions: deadline fields/flags
	 * in persisted state schedule work; the handler is idempotent and safe across hibernation.
	 * Uses readyState === OPEN counts (via getOpenConnectionCounts) for timing-safe cleanup decisions.
	 */
	async alarm(): Promise<void> {
		const now = Date.now();
		let updates: Partial<STTAdapterState> = {};
		let needsSave = false;

		// Check for cleanup deadline (last-client check with timing safety)
		if (this.stateStore.state.cleanupDeadline && now >= this.stateStore.state.cleanupDeadline) {
			this.logger.log(`Cleanup deadline reached. Checking for open WebSocket clients.`);

			// Count only actually-open sockets (readyState check for timing safety)
			const { sfuAudio, transcription } = this.getOpenConnectionCounts();

			// Clear sfuAdapterId if no SFU audio sockets remain
			if (sfuAudio === 0 && this.stateStore.state.sfuAdapterId) {
				this.logger.log(`No open SFU audio connections. Clearing sfuAdapterId.`);
				updates.sfuAdapterId = undefined;
			}

			// Close Nova STT and schedule inactivity if no clients at all
			if (sfuAudio === 0 && transcription === 0) {
				this.logger.log(`No open WebSocket clients. Performing last-client cleanup.`);
				await this.closeNovaSTTConnection();
				await this.scheduleInactivityIfIdle('all-sockets-closed');
			} else {
				this.logger.log(`${sfuAudio} SFU audio and ${transcription} transcription client(s) still open.`);
			}

			// Clear cleanup deadline
			updates.cleanupDeadline = undefined;
			needsSave = true;
		}

		// Check for KeepAlive
		if (this.stateStore.state.keepAliveDeadline && now >= this.stateStore.state.keepAliveDeadline) {
			// Verify gating conditions again
			if (
				this.novaSTTWebSocket &&
				this.novaSTTWebSocket.readyState === WebSocket.OPEN &&
				this.stateStore.state.sfuSessionId &&
				!this.stateStore.state.sfuAdapterId
			) {
				// Send KeepAlive
				try {
					this.novaSTTWebSocket.send(JSON.stringify({ type: 'KeepAlive' }));
					this.logger.log(`Sent KeepAlive to Nova STT`);
					// Schedule next KeepAlive
					updates.keepAliveDeadline = now + STT_NOVA_KEEPALIVE_MS;
					needsSave = true;
				} catch (e) {
					this.logger.warn(`Failed to send KeepAlive:`, e);
					updates.keepAliveDeadline = undefined;
					needsSave = true;
				}
			} else {
				// Gating conditions no longer met, cancel KeepAlive
				updates.keepAliveDeadline = undefined;
				needsSave = true;
			}
		}

		// Check for inactivity cleanup
		if (this.stateStore.state.inactivityDeadline && now >= this.stateStore.state.inactivityDeadline) {
			if (!this.isAnyoneHere()) {
				this.logger.log(`Inactivity timeout reached, sending CloseStream`);
				await this.requestCloseStreamDueToInactivity();
				updates.inactivityDeadline = undefined;
				needsSave = true;
			} else {
				// Someone connected in the meantime, cancel inactivity
				updates.inactivityDeadline = undefined;
				needsSave = true;
			}
		}

		// Check for reconnection
		if (
			this.stateStore.state.reconnectDeadline &&
			now >= this.stateStore.state.reconnectDeadline &&
			this.stateStore.state.reconnectType === 'nova-stt-websocket' &&
			this.stateStore.state.allowReconnect
		) {
			this.logger.log(`Attempting STT reconnection from alarm`);
			let reconnected = false;
			try {
				await this.getOrCreateNovaSTTConnection();
				reconnected = true;
			} catch (error) {
				this.logger.error(`Reconnection failed:`, error);
				// If connection fails before a WS 'close' event, schedule the next attempt here.
				if (this.stateStore.state.allowReconnect && this.stateStore.state.reconnectAttempts < this.maxReconnectAttempts) {
					await this.scheduleSTTReconnect();
				}
			}
			if (reconnected) {
				updates.reconnectDeadline = undefined;
				updates.reconnectType = undefined;
				needsSave = true;
			}
		}

		// Single save at the end if any updates were made
		if (needsSave) {
			await this.stateStore.update(updates);
		}
	}
}

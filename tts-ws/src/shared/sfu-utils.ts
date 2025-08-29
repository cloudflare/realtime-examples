/**
 * SFU (Selective Forwarding Unit) utilities for Cloudflare Calls
 */

import { Packet } from '../packet';

/**
 * Gets the SFU API base URL
 */
export function getSfuApiBase(env: Env): string {
	return `${env.SFU_API_BASE}/apps/${env.REALTIME_SFU_APP_ID}`;
}

/**
 * High-level SFU API client to encapsulate common Calls operations.
 * Keeps Env handling, base URL, and auth headers in one place.
 */
export class SfuClient {
	private env: Env;

	constructor(env: Env) {
		this.env = env;
	}

	private get base(): string {
		return getSfuApiBase(this.env);
	}

	private get headers(): Record<string, string> {
		return getSfuAuthHeaders(this.env);
	}

	// --- Sessions & Tracks ---

	async createSession(): Promise<{ sessionId: string }> {
		const res = await fetch(`${this.base}/sessions/new`, {
			method: 'POST',
			headers: this.headers,
		});
		if (!res.ok) {
			throw new Error(`SFU createSession failed: ${res.status} ${await res.text()}`);
		}
		const json = (await res.json()) as any;
		const sessionId = json?.sessionId;
		if (!sessionId) throw new Error('SFU createSession: sessionId missing in response');
		return { sessionId };
	}

	/**
	 * Adds tracks to an existing session using autoDiscover from the provided SDP offer.
	 * Returns entire JSON response and the first audio trackName (if present).
	 */
	async addTracksAutoDiscover(sessionId: string, sessionDescription: any): Promise<{ json: any; audioTrackName?: string }> {
		const body = { autoDiscover: true, sessionDescription };
		const res = await fetch(`${this.base}/sessions/${sessionId}/tracks/new`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`SFU addTracksAutoDiscover failed: ${res.status} ${await res.text()}`);
		}
		const json = (await res.json()) as any;
		const audio = json?.tracks?.find((t: any) => t.kind === 'audio' || !t.kind);
		const audioTrackName = audio?.trackName || json?.tracks?.[0]?.trackName;
		return { json, audioTrackName };
	}

	/**
	 * Player flow: pull a remote track from the publisher session into a new player session.
	 * Returns the SFU answer JSON to send back to the client.
	 */
	async pullRemoteTrackToPlayer(
		playerSessionId: string,
		publisherSessionId: string,
		trackName: string,
		sessionDescription: any
	): Promise<any> {
		const body = {
			sessionDescription,
			tracks: [{ location: 'remote', sessionId: publisherSessionId, trackName, kind: 'audio' }],
		};
		const res = await fetch(`${this.base}/sessions/${playerSessionId}/tracks/new`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`SFU pullRemoteTrackToPlayer failed: ${res.status} ${await res.text()}`);
		}
		return res.json();
	}

	// --- WebSocket Adapters ---

	/**
	 * DO pushes PCM into SFU as a local track via WebSocket adapter.
	 * Used by TTS publish path.
	 */
	async pushTrackFromWebSocket(
		trackName: string,
		endpoint: string,
		opts?: { inputCodec?: 'pcm'; mode?: 'buffer' }
	): Promise<{ sessionId: string; adapterId: string; json: any }> {
		const body = {
			tracks: [
				{
					location: 'local',
					trackName,
					endpoint,
					inputCodec: opts?.inputCodec ?? 'pcm',
					mode: opts?.mode ?? 'buffer',
				},
			],
		};
		const res = await fetch(`${this.base}/adapters/websocket/new`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`SFU pushTrackFromWebSocket failed: ${res.status} ${text}`);
		}
		let json: any = {};
		try {
			json = JSON.parse(text);
		} catch {}
		const sessionId = json?.tracks?.[0]?.sessionId;
		const adapterId = json?.tracks?.[0]?.adapterId;
		if (!sessionId || !adapterId) throw new Error('SFU pushTrackFromWebSocket: sessionId/adapterId missing');
		return { sessionId, adapterId, json };
	}

	/**
	 * SFU pulls a remote track and streams PCM to our DO via WebSocket adapter.
	 * Used by STT start-forwarding path.
	 */
	async pullTrackToWebSocket(
		sessionId: string,
		trackName: string,
		endpoint: string,
		opts?: { outputCodec?: 'pcm' }
	): Promise<{ adapterId?: string; json: any }> {
		const body = {
			tracks: [
				{
					location: 'remote',
					sessionId,
					trackName,
					endpoint,
					outputCodec: opts?.outputCodec ?? 'pcm',
				},
			],
		};
		const res = await fetch(`${this.base}/adapters/websocket/new`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`SFU pullTrackToWebSocket failed: ${res.status} ${text}`);
		}
		let json: any = {};
		try {
			json = JSON.parse(text);
		} catch {}
		const adapterId = json?.tracks?.[0]?.adapterId as string | undefined;
		return { adapterId, json };
	}

	/**
	 * Idempotent close for WebSocket adapters.
	 * If SFU returns 503 adapter_not_found, treat as already-closed success.
	 */
	async closeWebSocketAdapter(adapterId: string): Promise<{ ok: boolean; alreadyClosed: boolean; status: number; text: string }> {
		const body = { tracks: [{ adapterId }] };
		const res = await fetch(`${this.base}/adapters/websocket/close`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(body),
		});
		const text = await res.text();
		if (res.ok) return { ok: true, alreadyClosed: false, status: res.status, text };
		let alreadyClosed = false;
		if (res.status === 503) {
			try {
				const j = JSON.parse(text);
				if (j?.tracks?.[0]?.errorCode === 'adapter_not_found') alreadyClosed = true;
			} catch {}
		}
		return { ok: alreadyClosed, alreadyClosed, status: res.status, text };
	}
}

/**
 * Gets standard SFU authorization headers
 */
export function getSfuAuthHeaders(env: Env): Record<string, string> {
	return {
		Authorization: `Bearer ${env.REALTIME_SFU_BEARER_TOKEN}`,
		'Content-Type': 'application/json',
	};
}

/**
 * Builds a WebSocket callback URL from an HTTP request
 */
export function buildWsCallbackUrl(request: Request, path: string): string {
	const url = new URL(request.url);
	url.pathname = path;
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	return url.toString();
}

/**
 * Encodes PCM audio payload for SFU transmission
 */
export function encodePcmForSfu(payload: ArrayBuffer): ArrayBuffer {
	const packet = {
		sequenceNumber: 0,
		timestamp: 0,
		payload: new Uint8Array(payload),
	};
	const bytes = Packet.toBinary(packet);
	// Return a freshly allocated ArrayBuffer
	const out = new Uint8Array(bytes.byteLength);
	out.set(bytes);
	return out.buffer;
}

/**
 * Extracts PCM audio from SFU packet with safety checks
 */
export function extractPcmFromSfuPacket(packetData: ArrayBuffer): ArrayBuffer | null {
	try {
		const packet = Packet.fromBinary(new Uint8Array(packetData));
		if (!packet.payload) {
			return null;
		}

		// IMPORTANT: Do not use `packet.payload.buffer` directly because it may include
		// unrelated bytes (due to byteOffset) leading to odd lengths/misalignment.
		let payloadView = packet.payload as Uint8Array;

		// Ensure even byte length for 16-bit PCM
		if (payloadView.byteLength % 2 !== 0) {
			console.warn(`Odd payload length (${payloadView.byteLength}) detected. Truncating last byte.`);
			payloadView = payloadView.subarray(0, payloadView.byteLength - 1);
		}

		// Copy into a new Uint8Array to guarantee an ArrayBuffer backing
		const safeCopy = new Uint8Array(payloadView);
		return safeCopy.buffer;
	} catch (error) {
		console.error('Error decoding SFU packet:', error);
		return null;
	}
}

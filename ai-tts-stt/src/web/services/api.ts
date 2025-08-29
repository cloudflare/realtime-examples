/**
 * API client for TTS and STT endpoints
 */

export class ApiClient {
	constructor(private sessionId: string) {}

	// TTS endpoints
	async publish(speaker: string): Promise<void> {
		const res = await fetch(`/${this.sessionId}/publish`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ speaker }),
		});
		if (!res.ok) {
			throw new Error(`Failed to publish: ${res.status} ${await res.text()}`);
		}
	}

	async unpublish(): Promise<void> {
		const res = await fetch(`/${this.sessionId}/unpublish`, {
			method: 'POST',
		});
		if (!res.ok) {
			throw new Error(`Failed to unpublish: ${res.status} ${await res.text()}`);
		}
	}

	async connect(sessionDescription: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
		const res = await fetch(`/${this.sessionId}/connect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionDescription }),
		});

		if (res.status === 400) {
			throw new Error('Session has not been published yet.');
		}
		if (!res.ok) {
			throw new Error(`Failed to connect: ${res.status} ${await res.text()}`);
		}

		const answer = await res.json();
		return answer.sessionDescription;
	}

	async generate(text: string): Promise<void> {
		const res = await fetch(`/${this.sessionId}/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text }),
		});
		if (res.status !== 202) {
			throw new Error(`Failed to generate audio: ${res.status} ${await res.text()}`);
		}
	}

	// STT endpoints
	async sttConnect(sessionDescription: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
		const res = await fetch(`/${this.sessionId}/stt/connect`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionDescription }),
		});

		if (!res.ok) {
			throw new Error(`STT connection failed: ${res.status} ${await res.text()}`);
		}

		const answer = await res.json();
		return answer.sessionDescription;
	}

	async sttStartForwarding(): Promise<void> {
		const res = await fetch(`/${this.sessionId}/stt/start-forwarding`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
		});
		if (!res.ok) {
			throw new Error(`Failed to start forwarding: ${await res.text()}`);
		}
	}

	async sttStopForwarding(): Promise<void> {
		const res = await fetch(`/${this.sessionId}/stt/stop-forwarding`, {
			method: 'POST',
		});
		if (!res.ok) {
			throw new Error(`Failed to stop forwarding: ${await res.text()}`);
		}
	}

	async sttReconnectNova(): Promise<void> {
		const res = await fetch(`/${this.sessionId}/stt/reconnect-nova`, {
			method: 'POST',
		});
		if (!res.ok) {
			throw new Error(await res.text());
		}
	}

	getTranscriptionStreamUrl(): string {
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${protocol}//${window.location.host}/${this.sessionId}/stt/transcription-stream`;
	}
}

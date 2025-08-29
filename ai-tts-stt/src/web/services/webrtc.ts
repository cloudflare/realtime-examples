/**
 * WebRTC connection management
 */

import { log } from '../state';

export class WebRTCService {
	private peerConnection: RTCPeerConnection | null = null;
	private role: 'listener' | 'mic' | null = null;

	/**
	 * Create a peer connection for listening (pulling audio)
	 */
	async createListenerConnection(): Promise<RTCPeerConnection> {
		this.closePeerConnection();

		this.peerConnection = new RTCPeerConnection({
			iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
		});

		// Configure to receive audio only
		this.peerConnection.addTransceiver('audio', { direction: 'recvonly' });
		this.role = 'listener';
		// this.attachDebugEventListeners('listener');
		log('🎧 Listener PeerConnection created (recvonly)');

		return this.peerConnection;
	}

	/**
	 * Create a peer connection for publishing microphone
	 */
	async createMicConnection(stream: MediaStream): Promise<RTCPeerConnection> {
		this.closePeerConnection();

		this.peerConnection = new RTCPeerConnection({
			iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
		});

		// Add all tracks from the microphone stream
		stream.getTracks().forEach((track) => {
			this.peerConnection!.addTrack(track, stream);
		});
		this.role = 'mic';
		// this.attachDebugEventListeners('mic');
		log(`🎤 Mic PeerConnection created; added ${stream.getTracks().length} track(s)`);

		return this.peerConnection;
	}

	/**
	 * Create an SDP offer
	 */
	async createOffer(): Promise<RTCSessionDescriptionInit> {
		if (!this.peerConnection) {
			throw new Error('No peer connection established');
		}

		log('📝 Creating SDP offer...');
		const offer = await this.peerConnection.createOffer();
		await this.peerConnection.setLocalDescription(offer);
		const sdpLen = offer.sdp?.length ?? 0;
		log(`📨 Local offer set (SDP length=${sdpLen})`);
		return offer;
	}

	/**
	 * Set remote SDP answer
	 */
	async setRemoteAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		if (!this.peerConnection) {
			throw new Error('No peer connection established');
		}

		await this.peerConnection.setRemoteDescription(answer);
		const sdpLen = answer.sdp?.length ?? 0;
		log(`📬 Remote answer set (SDP length=${sdpLen})`);
	}

	/**
	 * Set up event handlers
	 */
	onIceConnectionStateChange(callback: (state: RTCIceConnectionState) => void) {
		if (!this.peerConnection) return;

		this.peerConnection.oniceconnectionstatechange = () => {
			if (this.peerConnection) {
				callback(this.peerConnection.iceConnectionState);
			}
		};
	}

	onConnectionStateChange(callback: (state: RTCPeerConnectionState) => void) {
		if (!this.peerConnection) return;

		this.peerConnection.onconnectionstatechange = () => {
			if (this.peerConnection) {
				callback(this.peerConnection.connectionState);
			}
		};
	}

	onTrack(callback: (event: RTCTrackEvent) => void) {
		if (!this.peerConnection) return;

		this.peerConnection.ontrack = callback;
	}

	/**
	 * Get current connection state
	 */
	getConnectionState(): RTCPeerConnectionState | null {
		return this.peerConnection?.connectionState || null;
	}

	/**
	 * Close the peer connection
	 */
	closePeerConnection() {
		if (this.peerConnection) {
			try {
				const conn = this.peerConnection;
				log(`⏹️ Closing PeerConnection (conn=${conn.connectionState}, ice=${conn.iceConnectionState}, signaling=${conn.signalingState})`);
				conn.close();
			} catch {}
			this.peerConnection = null;
			this.role = null;
		}
	}

	/**
	 * Attach debug listeners without overriding consumer-provided on* handlers.
	 * Uses addEventListener so logs and app callbacks can both run.
	 */
	private attachDebugEventListeners(role: 'listener' | 'mic') {
		const pc = this.peerConnection;
		if (!pc) return;

		pc.addEventListener('connectionstatechange', () => {
			log(`[webrtc/${role}] connectionstatechange → ${pc.connectionState}`);
		});
		pc.addEventListener('iceconnectionstatechange', () => {
			log(`[webrtc/${role}] iceconnectionstatechange → ${pc.iceConnectionState}`);
		});
		pc.addEventListener('signalingstatechange', () => {
			log(`[webrtc/${role}] signalingstatechange → ${pc.signalingState}`);
		});
		pc.addEventListener('icegatheringstatechange', () => {
			log(`[webrtc/${role}] icegatheringstatechange → ${pc.iceGatheringState}`);
		});
		pc.addEventListener('negotiationneeded', () => {
			log(`[webrtc/${role}] negotiationneeded`);
		});
		pc.addEventListener('icecandidate', (ev: Event) => {
			const e = ev as RTCPeerConnectionIceEvent;
			if (!e.candidate) {
				log(`[webrtc/${role}] icecandidate → null (gathering complete)`);
				return;
			}
			const cand = e.candidate.candidate || '';
			const m = cand.match(/ typ (host|srflx|relay)/);
			const typ = m?.[1] ?? 'unknown';
			log(`[webrtc/${role}] icecandidate (${typ})`);
		});
		pc.addEventListener('track', (ev: Event) => {
			const e = ev as RTCTrackEvent;
			const kind = e.track?.kind || 'unknown';
			const streams = e.streams?.length ?? 0;
			log(`[webrtc/${role}] ontrack kind=${kind} streams=${streams}`);
		});
	}

	/**
	 * Get microphone stream with optimal settings
	 */
	static async getMicrophoneStream(): Promise<MediaStream> {
		return navigator.mediaDevices.getUserMedia({
			audio: {
				sampleRate: 48000,
				channelCount: 2,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
			},
		});
	}
}

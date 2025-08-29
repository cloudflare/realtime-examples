/**
 * STT (Speech-to-Text) service
 */

import { ApiClient } from './api';
import { WebRTCService } from './webrtc';
import { setState, getState, log } from '../state';
import { TranscriptionMessage } from '../types';

export class STTService {
	private api: ApiClient;
	private webrtc: WebRTCService;
	private transcriptionWS: WebSocket | null = null;
	private transcriptionCloseTimer: number | null = null;

	constructor(sessionId: string) {
		this.api = new ApiClient(sessionId);
		this.webrtc = new WebRTCService();
	}

	async startRecording() {
		const state = getState();
		if (state.sttState.isMicActive) return;

		try {
			log('🎤 Starting microphone (WebRTC publish)...');

			// Get microphone access
			const stream = await WebRTCService.getMicrophoneStream();

			// Create WebRTC connection for audio upload
			const peerConnection = await this.webrtc.createMicConnection(stream);

			// Monitor connection state
			this.webrtc.onConnectionStateChange((pcState) => {
				const connected = pcState === 'connected';
				setState({
					sttState: {
						...getState().sttState,
						pcConnected: connected,
					},
				});
				log(`📡 PeerConnection state: ${pcState}`);
			});

			// Create offer and send to STT adapter
			const offer = await this.webrtc.createOffer();
			const answer = await this.api.sttConnect(offer);
			await this.webrtc.setRemoteAnswer(answer);

			setState({
				sttState: {
					...getState().sttState,
					isMicActive: true,
					startTime: null,
				},
			});

			log('✅ Microphone publishing started. You can start forwarding once connected.');
		} catch (error) {
			log(`❌ STT Error: ${(error as Error).message}`);
			this.stopRecording();
			throw error;
		}
	}

	async startForwarding() {
		const state = getState();

		if (!state.sttState.isMicActive) {
			log('⚠️ Start mic first.');
			return;
		}

		if (!state.sttState.pcConnected) {
			log('⏳ Waiting for PeerConnection to be connected...');
			return;
		}

		if (state.sttState.isForwarding) {
			log('ℹ️ Forwarding already active.');
			return;
		}

		try {
			log('🔄 Starting WebSocket forwarding...');
			await this.api.sttStartForwarding();

			setState({
				sttState: {
					...getState().sttState,
					isForwarding: true,
					startTime: Date.now(),
				},
			});

			// Connect to transcription stream if not already connected
			if (!this.transcriptionWS || this.transcriptionWS.readyState === WebSocket.CLOSED) {
				this.connectTranscriptionStream();
			}

			log('✅ WebSocket forwarding started');
		} catch (error) {
			log(`❌ Forwarding Error: ${(error as Error).message}`);
			throw error;
		}
	}

	async stopForwarding() {
		const state = getState();

		if (!state.sttState.isForwarding) {
			log('ℹ️ Forwarding already stopped.');
			return;
		}

		try {
			log('⛔ Stopping WebSocket forwarding...');
			await this.api.sttStopForwarding();

			setState({
				sttState: {
					...getState().sttState,
					isForwarding: false,
				},
			});

			// Keep transcription WS connected
			log('✅ Forwarding stopped. Transcription stream remains connected.');
		} catch (error) {
			log(`❌ Stop Forwarding Error: ${(error as Error).message}`);
			throw error;
		}
	}

	async stopRecording() {
		const state = getState();

		if (!state.sttState.isMicActive) return;

		if (state.sttState.isForwarding) {
			log('⚠️ Stop forwarding before stopping the mic.');
			return;
		}

		log('⏹️ Stopping microphone/WebRTC...');

		this.webrtc.closePeerConnection();

		setState({
			sttState: {
				isMicActive: false,
				isForwarding: false,
				pcConnected: false,
				startTime: null,
			},
		});

		log('✅ Microphone stopped');
	}

	async restartNova() {
		try {
			log('🛠️ Restarting Nova STT (debug)...');
			await this.api.sttReconnectNova();
			log('✅ Nova STT restarted');
		} catch (error) {
			log(`❌ Restart Nova error: ${(error as Error).message}`);
			throw error;
		}
	}

	private connectTranscriptionStream() {
		const wsUrl = this.api.getTranscriptionStreamUrl();

		this.transcriptionWS = new WebSocket(wsUrl);

		this.transcriptionWS.onopen = () => {
			log('🟢 Transcription stream connected');
		};

		this.transcriptionWS.onmessage = (event) => {
			try {
				const data: TranscriptionMessage = JSON.parse(event.data);

				if (data.type === 'stt_done') {
					log('✅ Transcription segment finalized');
					return;
				}

				// Handle transcription data
				if (!data.type || data.type === 'transcription') {
					this.displayTranscription(data);
				}
			} catch (error) {
				log(`❌ Transcription parse error: ${(error as Error).message}`);
			}
		};

		this.transcriptionWS.onclose = () => {
			log('🔌 Transcription stream disconnected');
		};

		this.transcriptionWS.onerror = (error) => {
			log(`❌ Transcription WebSocket error: ${error}`);
		};
	}

	private displayTranscription(data: TranscriptionMessage) {
		if (!data.data?.channel?.alternatives?.[0]?.transcript) {
			return;
		}

		const transcript = data.data.channel.alternatives[0].transcript;
		const isFinal = data.data.is_final || false;
		const timestamp = data.timestamp || Date.now();
		const state = getState();

		// Add transcript to state
		const relativeTime = state.sttState.startTime ? (timestamp - state.sttState.startTime) / 1000 : 0;

		setState({
			transcripts: [
				...state.transcripts,
				{
					start: Math.max(0, relativeTime),
					text: transcript,
					timestamp,
					isFinal,
				},
			],
		});
	}

	closeTranscriptionStream() {
		if (this.transcriptionCloseTimer) {
			clearTimeout(this.transcriptionCloseTimer);
			this.transcriptionCloseTimer = null;
		}

		if (this.transcriptionWS) {
			this.transcriptionWS.close();
			this.transcriptionWS = null;
		}
	}

	clearTranscriptions() {
		setState({ transcripts: [] });
		log('🗑️ Transcriptions cleared');
	}
}

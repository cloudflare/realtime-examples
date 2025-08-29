export type UserRole = 'player' | 'publisher';

export type ConnectionState = 'initial' | 'publishing' | 'published' | 'unpublishing' | 'connecting' | 'connected' | 'disconnected';

export interface AppState {
	// Core session info
	sessionId: string;
	userRole: UserRole;

	// Connection state
	connectionState: ConnectionState;
	isPublished: boolean;

	// TTS settings
	selectedSpeaker: string;

	// Publisher UI
	publisherTab?: 'tts' | 'stt';

	// STT state
	sttState: {
		isMicActive: boolean;
		isForwarding: boolean;
		pcConnected: boolean;
		startTime: number | null;
	};

	// Transcripts
	transcripts: Transcript[];

	// Debug logs
	debugLogs: LogEntry[];
}

export interface Transcript {
	start: number;
	text: string;
	timestamp: number;
	isFinal: boolean;
}

export interface LogEntry {
	timestamp: Date;
	message: string;
}

export interface TranscriptionMessage {
	type?: 'transcription' | 'stt_done';
	data?: {
		channel?: {
			alternatives?: Array<{
				transcript: string;
			}>;
		};
		is_final?: boolean;
	};
	timestamp?: number;
}

export type StateListener = (state: AppState) => void;
export type StateUpdater = (updates: Partial<AppState>) => void;

import { AppState, StateListener, StateUpdater } from './types';

class StateStore extends EventTarget {
	private state: AppState;
	private listeners = new Set<StateListener>();

	constructor(initialState: AppState) {
		super();
		this.state = initialState;
	}

	getState(): AppState {
		return this.state;
	}

	setState(updates: Partial<AppState>) {
		const oldState = this.state;
		this.state = { ...this.state, ...updates };

		// Notify listeners
		this.listeners.forEach((listener) => listener(this.state));

		// Emit custom event for specific state changes
		this.dispatchEvent(
			new CustomEvent('statechange', {
				detail: { newState: this.state, oldState, updates },
			})
		);
	}

	subscribe(listener: StateListener): () => void {
		this.listeners.add(listener);
		// Return unsubscribe function
		return () => this.listeners.delete(listener);
	}

	log(message: string) {
		this.setState({
			debugLogs: [
				...this.state.debugLogs,
				{
					timestamp: new Date(),
					message,
				},
			],
		});
	}

	clearLogs() {
		this.setState({ debugLogs: [] });
	}

	addTranscript(transcript: string, isFinal: boolean, timestamp?: number) {
		const now = timestamp || Date.now();
		const relativeTime = this.state.sttState.startTime ? (now - this.state.sttState.startTime) / 1000 : 0;

		if (isFinal && transcript.trim()) {
			this.setState({
				transcripts: [
					...this.state.transcripts,
					{
						start: Math.max(0, relativeTime),
						text: transcript.trim(),
						timestamp: now,
						isFinal: true,
					},
				],
			});
		} else {
			// Handle interim transcripts differently if needed
			this.setState({
				transcripts: [
					...this.state.transcripts,
					{
						start: Math.max(0, relativeTime),
						text: transcript,
						timestamp: now,
						isFinal: false,
					},
				],
			});
		}
	}

	clearTranscripts() {
		this.setState({ transcripts: [] });
	}
}

// Parse URL to get session name and role
function parseUrl(): { sessionId: string; userRole: 'player' | 'publisher' } {
	const pathParts = window.location.pathname.split('/').filter((p) => p);

	if (pathParts.length < 2 || !['player', 'publisher'].includes(pathParts[1])) {
		throw new Error('Invalid URL. Expected: /<session-name>/player or /<session-name>/publisher');
	}

	return {
		sessionId: pathParts[0],
		userRole: pathParts[1] as 'player' | 'publisher',
	};
}

// Initialize state from URL
const urlParams = parseUrl();

export const store = new StateStore({
	sessionId: urlParams.sessionId,
	userRole: urlParams.userRole,
	connectionState: 'initial',
	isPublished: false,
	selectedSpeaker: 'zeus',
	publisherTab: 'tts',
	sttState: {
		isMicActive: false,
		isForwarding: false,
		pcConnected: false,
		startTime: null,
	},
	transcripts: [],
	debugLogs: [],
});

// Export convenience methods
export const getState = () => store.getState();
export const setState: StateUpdater = (updates) => store.setState(updates);
export const subscribe = (listener: StateListener) => store.subscribe(listener);
export const log = (message: string) => store.log(message);

/**
 * Main application entry point
 */

import { store, setState, subscribe, log, getState } from './state';
import { ApiClient } from './services/api';
import { WebRTCService } from './services/webrtc';
import { STTService } from './services/stt';
import { SubtitleExporter } from './services/subtitles';
import { cacheElements, setButtonLoading, setVisible } from './ui/dom';
import { StatusIndicator } from './ui/statusIndicator';
import { PublisherControls } from './ui/publisherControls';
import { GenerateControls } from './ui/generateControls';
import { ListenerControls } from './ui/listenerControls';
import { STTControls } from './ui/sttControls';
import { TranscriptionList } from './ui/transcriptionList';
import { DebugLog } from './ui/debugLog';

// Services
let api: ApiClient;
let listenerWebRTC: WebRTCService;
let sttService: STTService;

// UI Components
let elements: ReturnType<typeof cacheElements>;
let statusIndicator: StatusIndicator;
let publisherControls: PublisherControls;
let generateControls: GenerateControls;
let listenerControls: ListenerControls;
let sttControls: STTControls;
let transcriptionList: TranscriptionList;
let debugLog: DebugLog;

/**
 * Initialize the application
 */
function initializeApp() {
	const state = getState();

	// Cache DOM elements
	elements = cacheElements();

	// Initialize services
	api = new ApiClient(state.sessionId);
	listenerWebRTC = new WebRTCService();
	sttService = new STTService(state.sessionId);

	// Initialize UI components
	statusIndicator = new StatusIndicator(elements);
	debugLog = new DebugLog(elements);
	transcriptionList = new TranscriptionList(elements);

	publisherControls = new PublisherControls(elements, handlePublish, handleUnpublish);

	generateControls = new GenerateControls(elements, handleGenerate);

	listenerControls = new ListenerControls(elements, handleConnect, handleDisconnect);

	sttControls = new STTControls(
		elements,
		handleStartRecording,
		handleStopRecording,
		handleStartForwarding,
		handleStopForwarding,
		handleClearTranscriptions,
		handleExportSubtitles,
		handleRestartNova
	);

	// Bind publisher tab events
	elements.tabTTS.addEventListener('click', () => setState({ publisherTab: 'tts' }));
	elements.tabSTT.addEventListener('click', () => setState({ publisherTab: 'stt' }));

	// Setup UI based on role
	setupUIForRole();

	// Subscribe to state changes
	subscribe((newState) => {
		statusIndicator.update(newState);
		debugLog.update(newState);
		transcriptionList.update(newState);
		applyPublisherTabVisibility(newState);

		if (newState.userRole === 'publisher') {
			publisherControls.update(newState);
			generateControls.update(newState);
			sttControls.update(newState);
		}

		listenerControls.update(newState);
	});

	// Display initial info
	elements.sessionNameDisplay.textContent = `Session Name: ${state.sessionId}`;

	// Trigger initial UI update
	setState({ connectionState: 'initial' });

	log(`Initialized as ${state.userRole} for session ${state.sessionId}`);
}

/**
 * Setup UI visibility based on user role
 */
function setupUIForRole() {
	const state = getState();

	if (state.userRole === 'publisher') {
		elements.pageTitle.textContent = 'TTS Publisher';
		setVisible(elements.publisherTabs, true);
		applyPublisherTabVisibility(state);
	} else {
		elements.pageTitle.textContent = 'TTS Listener';
		setVisible(elements.publisherTabs, false);
		setVisible(elements.publisherSection, false);
		setVisible(elements.generateSection, false);
		setVisible(elements.sttSection, false);
		setVisible(elements.listenerSection, true);
	}
}

/**
 * Show/hide publisher sections based on active tab
 */
function applyPublisherTabVisibility(state = getState()) {
	// Tabs only apply to publisher role
	if (state.userRole !== 'publisher') return;

	const active = state.publisherTab ?? 'tts';

	// Update tab active class
	elements.tabTTS.classList.toggle('active', active === 'tts');
	elements.tabSTT.classList.toggle('active', active === 'stt');

	const showTTS = active === 'tts';

	// TTS panels
	setVisible(elements.publisherSection, showTTS);
	setVisible(elements.generateSection, showTTS);
	setVisible(elements.listenerSection, showTTS);

	// STT panel
	setVisible(elements.sttSection, !showTTS);

	// Titles
	elements.pageTitle.textContent = showTTS ? 'TTS Publisher' : 'STT Publisher';
	try {
		document.title = showTTS ? 'TTS Demo - Cloudflare AI' : 'STT Demo - Cloudflare AI';
	} catch {
		/* no-op when document not available */
	}
}

// --- TTS Handlers ---

async function handlePublish() {
	setState({ connectionState: 'publishing' });
	const speaker = publisherControls.getSelectedSpeaker();

	try {
		log(`📣 Publishing session with voice: ${speaker}...`);
		await api.publish(speaker);
		setState({
			connectionState: 'published',
			isPublished: true,
			selectedSpeaker: speaker,
		});
		log('✅ Session published.');
	} catch (error) {
		log(`❌ Error during publish: ${(error as Error).message}`);
		setState({ connectionState: 'initial' });
	}
}

async function handleUnpublish() {
	setState({ connectionState: 'unpublishing' });

	try {
		log('🗑️ Unpublishing worker track from SFU...');
		await api.unpublish();
		log('✅ Session unpublished successfully.');

		// Disconnect if connected
		if (getState().connectionState === 'connected') {
			handleDisconnect();
		}

		setState({
			connectionState: 'initial',
			isPublished: false,
		});
	} catch (error) {
		log(`❌ Error during unpublish: ${(error as Error).message}`);
		setState({ connectionState: 'published' });
	}
}

async function handleGenerate() {
	const text = generateControls.getText();
	if (!text) {
		log('⚠️ Please enter some text.');
		return;
	}

	log(`💬 Generating speech: "${text.substring(0, 50)}..."`);
	generateControls.setLoading(true);

	try {
		await api.generate(text);
		log('✅ Audio generation started.');
	} catch (error) {
		log(`❌ Error: ${(error as Error).message}`);
	} finally {
		generateControls.setLoading(false);
	}
}

// --- Listener Handlers ---

async function handleConnect() {
	setState({ connectionState: 'connecting' });

	try {
		await startWebRTCPull();
	} catch (error) {
		log(`❌ Error during connect: ${(error as Error).message}`);
		handleDisconnect();
	}
}

async function startWebRTCPull() {
	const pc = await listenerWebRTC.createListenerConnection();

	// Set up ICE connection monitoring
	listenerWebRTC.onIceConnectionStateChange((state) => {
		log(`🚦 ICE state: ${state}`);

		if (['connected', 'completed'].includes(state)) {
			setState({ connectionState: 'connected' });
			log('✅ Connected to audio stream.');
		}

		if (['failed', 'disconnected', 'closed'].includes(state)) {
			log(`❌ Connection lost or failed.`);
			handleDisconnect();
		}
	});

	// Handle incoming audio track
	listenerWebRTC.onTrack((event) => {
		log(`🎵 Received remote audio track.`);
		const mediaElement = document.createElement('audio');
		mediaElement.srcObject = event.streams[0];
		mediaElement.autoplay = true;
		mediaElement.controls = true;
		elements.mediaContainer.innerHTML = '';
		elements.mediaContainer.appendChild(mediaElement);
	});

	// Create offer and connect
	const offer = await listenerWebRTC.createOffer();
	const answer = await api.connect(offer);
	await listenerWebRTC.setRemoteAnswer(answer);
	log('🤝 Set remote description successfully.');
}

function handleDisconnect() {
	log('⏹️ Stopping connection...');
	listenerWebRTC.closePeerConnection();
	elements.mediaContainer.innerHTML = '';

	const state = getState();
	setState({
		connectionState: state.isPublished ? 'published' : 'initial',
	});

	log('🔄 UI reset.');
}

// --- STT Handlers ---

async function handleStartRecording() {
	sttControls.setStartRecordingLoading(true);
	try {
		await sttService.startRecording();
	} finally {
		sttControls.setStartRecordingLoading(false);
	}
}

async function handleStopRecording() {
	sttService.stopRecording();
}

async function handleStartForwarding() {
	sttControls.setStartForwardingLoading(true);
	try {
		await sttService.startForwarding();
	} finally {
		sttControls.setStartForwardingLoading(false);
	}
}

async function handleStopForwarding() {
	await sttService.stopForwarding();
}

function handleClearTranscriptions() {
	sttService.clearTranscriptions();
	transcriptionList.clear();
}

function handleExportSubtitles(format: 'vtt' | 'srt') {
	const state = getState();

	try {
		if (format === 'vtt') {
			SubtitleExporter.exportVTT(state.transcripts, state.sessionId);
		} else {
			SubtitleExporter.exportSRT(state.transcripts, state.sessionId);
		}

		const count = state.transcripts.filter((t) => t.isFinal).length;
		log(`📁 Exported ${count} transcriptions as ${format.toUpperCase()}`);
	} catch (error) {
		log(`⚠️ ${(error as Error).message}`);
	}
}

async function handleRestartNova() {
	await sttService.restartNova();
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', initializeApp);
} else {
	initializeApp();
}

/**
 * DOM element caching and utilities
 */

export interface UIElements {
	// Header
	pageTitle: HTMLHeadingElement;
	sessionNameDisplay: HTMLSpanElement;
	statusIndicator: HTMLDivElement;

	// Publisher tabs
	publisherTabs: HTMLDivElement;
	tabTTS: HTMLButtonElement;
	tabSTT: HTMLButtonElement;

	// Publisher controls
	publisherSection: HTMLDivElement;
	publishBtn: HTMLButtonElement;
	unpublishBtn: HTMLButtonElement;
	speakerSelect: HTMLSelectElement;

	// Generate controls
	generateSection: HTMLDivElement;
	ttsText: HTMLTextAreaElement;
	generateBtn: HTMLButtonElement;

	// Listener controls
	listenerSection: HTMLDivElement;
	listenerTitle: HTMLHeadingElement;
	connectBtn: HTMLButtonElement;
	disconnectBtn: HTMLButtonElement;

	// STT controls
	sttSection: HTMLDivElement;
	startSTTBtn: HTMLButtonElement;
	stopSTTBtn: HTMLButtonElement;
	startForwardingBtn: HTMLButtonElement;
	stopForwardingBtn: HTMLButtonElement;
	clearTranscriptionBtn: HTMLButtonElement;
	exportSubtitlesBtn: HTMLButtonElement;
	restartNovaBtn: HTMLButtonElement;

	// Transcription display
	transcriptionContent: HTMLDivElement;

	// Media and debug
	mediaContainer: HTMLDivElement;
	debugArea: HTMLTextAreaElement;
}

/**
 * Cache all UI elements
 */
export function cacheElements(): UIElements {
	const getElement = <T extends HTMLElement>(id: string): T => {
		const el = document.getElementById(id);
		if (!el) throw new Error(`Element with id "${id}" not found`);
		return el as T;
	};

	return {
		// Header
		pageTitle: getElement<HTMLHeadingElement>('pageTitle'),
		sessionNameDisplay: getElement<HTMLSpanElement>('sessionNameDisplay'),
		statusIndicator: getElement<HTMLDivElement>('statusIndicator'),

		// Publisher tabs
		publisherTabs: getElement<HTMLDivElement>('publisherTabs'),
		tabTTS: getElement<HTMLButtonElement>('tabTTS'),
		tabSTT: getElement<HTMLButtonElement>('tabSTT'),

		// Publisher controls
		publisherSection: getElement<HTMLDivElement>('publisherSection'),
		publishBtn: getElement<HTMLButtonElement>('publishBtn'),
		unpublishBtn: getElement<HTMLButtonElement>('unpublishBtn'),
		speakerSelect: getElement<HTMLSelectElement>('speakerSelect'),

		// Generate controls
		generateSection: getElement<HTMLDivElement>('generateSection'),
		ttsText: getElement<HTMLTextAreaElement>('ttsText'),
		generateBtn: getElement<HTMLButtonElement>('generateBtn'),

		// Listener controls
		listenerSection: getElement<HTMLDivElement>('listenerSection'),
		listenerTitle: getElement<HTMLHeadingElement>('listenerTitle'),
		connectBtn: getElement<HTMLButtonElement>('connectBtn'),
		disconnectBtn: getElement<HTMLButtonElement>('disconnectBtn'),

		// STT controls
		sttSection: getElement<HTMLDivElement>('sttSection'),
		startSTTBtn: getElement<HTMLButtonElement>('startSTTBtn'),
		stopSTTBtn: getElement<HTMLButtonElement>('stopSTTBtn'),
		startForwardingBtn: getElement<HTMLButtonElement>('startForwardingBtn'),
		stopForwardingBtn: getElement<HTMLButtonElement>('stopForwardingBtn'),
		clearTranscriptionBtn: getElement<HTMLButtonElement>('clearTranscriptionBtn'),
		exportSubtitlesBtn: getElement<HTMLButtonElement>('exportSubtitlesBtn'),
		restartNovaBtn: getElement<HTMLButtonElement>('restartNovaBtn'),

		// Transcription display
		transcriptionContent: getElement<HTMLDivElement>('transcriptionContent'),

		// Media and debug
		mediaContainer: getElement<HTMLDivElement>('media-container'),
		debugArea: getElement<HTMLTextAreaElement>('debugArea'),
	};
}

/**
 * Set loading state on button
 */
export function setButtonLoading(button: HTMLButtonElement, loading: boolean) {
	if (loading) {
		button.classList.add('loading');
		button.disabled = true;
	} else {
		button.classList.remove('loading');
		button.disabled = false;
	}
}

/**
 * Show/hide element
 */
export function setVisible(element: HTMLElement, visible: boolean) {
	if (visible) {
		element.classList.remove('hidden');
	} else {
		element.classList.add('hidden');
	}
}

/**
 * Enable/disable element
 */
export function setEnabled(element: HTMLElement, enabled: boolean) {
	if (enabled) {
		element.classList.remove('disabled');
	} else {
		element.classList.add('disabled');
	}
}

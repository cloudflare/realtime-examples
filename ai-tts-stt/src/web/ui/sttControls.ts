/**
 * STT controls UI component
 */

import { AppState } from '../types';
import { UIElements, setButtonLoading, setVisible } from './dom';

export class STTControls {
	constructor(
		private elements: UIElements,
		private onStartRecording: () => void,
		private onStopRecording: () => void,
		private onStartForwarding: () => void,
		private onStopForwarding: () => void,
		private onClear: () => void,
		private onExport: (format: 'vtt' | 'srt') => void,
		private onRestartNova: () => void
	) {
		this.bindEvents();
	}

	private bindEvents() {
		const { startSTTBtn, stopSTTBtn, startForwardingBtn, stopForwardingBtn, clearTranscriptionBtn, exportSubtitlesBtn, restartNovaBtn } =
			this.elements;

		startSTTBtn.addEventListener('click', this.onStartRecording);
		stopSTTBtn.addEventListener('click', this.onStopRecording);
		startForwardingBtn.addEventListener('click', this.onStartForwarding);
		stopForwardingBtn.addEventListener('click', this.onStopForwarding);
		clearTranscriptionBtn.addEventListener('click', this.onClear);

		exportSubtitlesBtn.addEventListener('click', () => {
			const format = confirm('Export as SRT? (Cancel for WebVTT)') ? 'srt' : 'vtt';
			this.onExport(format);
		});

		restartNovaBtn.addEventListener('click', this.onRestartNova);
	}

	update(state: AppState) {
		const { startSTTBtn, stopSTTBtn, startForwardingBtn, stopForwardingBtn } = this.elements;

		const { isMicActive, isForwarding, pcConnected } = state.sttState;

		// Mic buttons
		setVisible(startSTTBtn, !isMicActive);
		setVisible(stopSTTBtn, isMicActive);
		stopSTTBtn.disabled = isForwarding; // Cannot stop mic while forwarding

		// Forwarding buttons
		startForwardingBtn.disabled = !(isMicActive && pcConnected) || isForwarding;
		setVisible(startForwardingBtn, !isForwarding);
		setVisible(stopForwardingBtn, isForwarding);
	}

	setStartRecordingLoading(loading: boolean) {
		setButtonLoading(this.elements.startSTTBtn, loading);
	}

	setStartForwardingLoading(loading: boolean) {
		setButtonLoading(this.elements.startForwardingBtn, loading);
	}
}

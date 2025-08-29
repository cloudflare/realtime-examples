/**
 * Transcription list UI component
 */

import { AppState, Transcript } from '../types';
import { UIElements } from './dom';

export class TranscriptionList {
	constructor(private elements: UIElements) {}

	update(state: AppState) {
		// Only render new transcripts (optimization for large lists)
		const container = this.elements.transcriptionContent;
		const currentCount = container.children.length;
		const newTranscripts = state.transcripts.slice(currentCount);

		newTranscripts.forEach((transcript) => {
			this.renderTranscript(transcript);
		});

		// Auto-scroll to bottom
		container.scrollTop = container.scrollHeight;
	}

	private renderTranscript(transcript: Transcript) {
		const line = document.createElement('div');
		line.className = 'transcript-line';

		const time = new Date(transcript.timestamp);
		const timeStr = time.toLocaleTimeString('en-US', {
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});

		line.innerHTML = `
      <span class="transcript-time">${timeStr}</span>
      <span class="transcript-text ${transcript.isFinal ? 'transcript-final' : 'transcript-interim'}">${transcript.text}</span>
    `;

		this.elements.transcriptionContent.appendChild(line);
	}

	clear() {
		this.elements.transcriptionContent.innerHTML = '';
	}
}

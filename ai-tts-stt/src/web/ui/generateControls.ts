/**
 * Generate (TTS) controls UI component
 */

import { AppState } from '../types';
import { UIElements, setButtonLoading, setEnabled } from './dom';

export class GenerateControls {
	constructor(private elements: UIElements, private onGenerate: () => void) {
		this.bindEvents();
	}

	private bindEvents() {
		this.elements.generateBtn.addEventListener('click', this.onGenerate);
	}

	update(state: AppState) {
		const { generateSection, generateBtn } = this.elements;

		// Enable generate section only when published or connected
		const isEnabled = state.connectionState === 'published' || state.connectionState === 'connected';

		setEnabled(generateSection, isEnabled);

		// Reset button loading state
		setButtonLoading(generateBtn, false);
	}

	getText(): string {
		return this.elements.ttsText.value.trim();
	}

	setLoading(loading: boolean) {
		setButtonLoading(this.elements.generateBtn, loading);
	}
}

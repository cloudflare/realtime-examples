/**
 * Debug log UI component
 */

import { AppState } from '../types';
import { UIElements } from './dom';

export class DebugLog {
	constructor(private elements: UIElements) {}

	update(state: AppState) {
		const { debugArea } = this.elements;

		// Clear and rebuild log (simple approach)
		debugArea.value = state.debugLogs.map((entry) => `[${entry.timestamp.toLocaleTimeString()}] ${entry.message}`).join('\n');

		// Auto-scroll to bottom
		debugArea.scrollTop = debugArea.scrollHeight;
	}

	clear() {
		this.elements.debugArea.value = '';
	}
}

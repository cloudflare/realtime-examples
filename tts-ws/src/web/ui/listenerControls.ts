/**
 * Listener controls UI component
 */

import { AppState } from '../types';
import { UIElements, setButtonLoading, setVisible } from './dom';

export class ListenerControls {
	constructor(private elements: UIElements, private onConnect: () => void, private onDisconnect: () => void) {
		this.bindEvents();
	}

	private bindEvents() {
		this.elements.connectBtn.addEventListener('click', this.onConnect);
		this.elements.disconnectBtn.addEventListener('click', this.onDisconnect);
	}

	update(state: AppState) {
		const { connectBtn, disconnectBtn, listenerTitle } = this.elements;

		// Update title based on role and active tab (publisher only)
		if (state.userRole === 'publisher') {
			const activeTab = state.publisherTab ?? 'tts';
			listenerTitle.textContent = activeTab === 'tts' ? 'Step 2: Audio Stream' : 'Audio Stream';
		} else {
			listenerTitle.textContent = 'Audio Stream';
		}

		// Reset loading states
		setButtonLoading(connectBtn, false);

		switch (state.connectionState) {
			case 'initial':
			case 'published':
				setVisible(connectBtn, true);
				setVisible(disconnectBtn, false);
				connectBtn.disabled = false;
				break;

			case 'connecting':
				setVisible(connectBtn, true);
				setVisible(disconnectBtn, false);
				setButtonLoading(connectBtn, true);
				break;

			case 'connected':
				setVisible(connectBtn, false);
				setVisible(disconnectBtn, true);
				break;

			case 'publishing':
			case 'unpublishing':
				setVisible(connectBtn, true);
				setVisible(disconnectBtn, false);
				connectBtn.disabled = true;
				break;
		}
	}
}

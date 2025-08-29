/**
 * Publisher controls UI component
 */

import { AppState } from '../types';
import { UIElements, setButtonLoading, setVisible } from './dom';

export class PublisherControls {
	constructor(private elements: UIElements, private onPublish: () => void, private onUnpublish: () => void) {
		this.bindEvents();
	}

	private bindEvents() {
		this.elements.publishBtn.addEventListener('click', this.onPublish);
		this.elements.unpublishBtn.addEventListener('click', this.onUnpublish);
	}

	update(state: AppState) {
		const { publishBtn, unpublishBtn, speakerSelect } = this.elements;

		// Reset loading states
		setButtonLoading(publishBtn, false);
		setButtonLoading(unpublishBtn, false);

		switch (state.connectionState) {
			case 'initial':
				setVisible(publishBtn, true);
				setVisible(unpublishBtn, false);
				publishBtn.disabled = false;
				speakerSelect.disabled = false;
				break;

			case 'publishing':
				setButtonLoading(publishBtn, true);
				setVisible(unpublishBtn, false);
				speakerSelect.disabled = true;
				break;

			case 'published':
			case 'connected':
				setVisible(publishBtn, false);
				setVisible(unpublishBtn, true);
				unpublishBtn.disabled = false;
				speakerSelect.disabled = true;
				break;

			case 'unpublishing':
				setVisible(publishBtn, false);
				setVisible(unpublishBtn, true);
				setButtonLoading(unpublishBtn, true);
				break;

			case 'connecting':
				setVisible(publishBtn, false);
				setVisible(unpublishBtn, true);
				unpublishBtn.disabled = true;
				break;
		}
	}

	getSelectedSpeaker(): string {
		return this.elements.speakerSelect.value;
	}
}

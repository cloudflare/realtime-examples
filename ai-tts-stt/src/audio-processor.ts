/**
 * AudioProcessor - Shared audio processing utilities for TTS and STT
 * Handles format conversion, resampling, and channel conversion
 */
export class AudioProcessor {
	/**
	 * Converts stereo PCM audio to mono by averaging channels
	 */
	static stereoToMono(stereoBuffer: ArrayBuffer): ArrayBuffer {
		const stereoData = new Int16Array(stereoBuffer);
		if (stereoData.length === 0) return stereoBuffer;

		// Stereo has 2 channels, so mono length is half
		const monoLength = Math.floor(stereoData.length / 2);
		const monoData = new Int16Array(monoLength);

		// Average left and right channels
		for (let i = 0; i < monoLength; i++) {
			const left = stereoData[i * 2];
			const right = stereoData[i * 2 + 1];
			monoData[i] = Math.round((left + right) / 2);
		}

		return monoData.buffer;
	}

	/**
	 * Converts mono PCM audio to stereo by duplicating the channel
	 */
	static monoToStereo(monoBuffer: ArrayBuffer): ArrayBuffer {
		const monoView = new Int16Array(monoBuffer);
		const stereoBuffer = new ArrayBuffer(monoBuffer.byteLength * 2);
		const stereoView = new Int16Array(stereoBuffer);

		for (let i = 0; i < monoView.length; i++) {
			stereoView[i * 2] = monoView[i];
			stereoView[i * 2 + 1] = monoView[i];
		}

		return stereoBuffer;
	}

	/**
	 * Downsamples audio from 48kHz to 16kHz (3x decimation)
	 * Used for STT preprocessing
	 */
	static downsample48kHzTo16kHz(audioBuffer: ArrayBuffer): ArrayBuffer {
		const sourceData = new Int16Array(audioBuffer);
		if (sourceData.length === 0) return audioBuffer;

		// 48kHz to 16kHz is 3:1 decimation - take every 3rd sample
		const targetLength = Math.floor(sourceData.length / 3);
		const targetData = new Int16Array(targetLength);

		// Simple decimation - take every 3rd sample
		// For better quality, could implement a low-pass filter
		for (let i = 0; i < targetLength; i++) {
			targetData[i] = sourceData[i * 3];
		}

		return targetData.buffer;
	}

	/**
	 * Upsamples audio from 24kHz to 48kHz (2x upsampling)
	 * Used for TTS postprocessing
	 */
	static resample24kHzTo48kHz(audioBuffer: ArrayBuffer): ArrayBuffer {
		const sourceData = new Int16Array(audioBuffer);
		if (sourceData.length === 0) return audioBuffer;

		// 24kHz to 48kHz is exactly 2x upsampling
		const targetLength = sourceData.length * 2;
		const targetData = new Int16Array(targetLength);

		// Linear interpolation for upsampling
		for (let i = 0; i < sourceData.length - 1; i++) {
			const sample1 = sourceData[i];
			const sample2 = sourceData[i + 1];

			// Place original sample
			targetData[i * 2] = sample1;

			// Interpolate one sample between each original pair
			targetData[i * 2 + 1] = Math.round((sample1 + sample2) / 2);
		}

		// Handle last sample
		const lastSample = sourceData[sourceData.length - 1];
		targetData[targetLength - 2] = lastSample;
		targetData[targetLength - 1] = lastSample;

		return targetData.buffer;
	}

	/**
	 * Combined processing pipeline for STT
	 * Converts stereo 48kHz to mono 16kHz
	 */
	static processForSTT(stereo48kHz: ArrayBuffer): ArrayBuffer {
		const monoAudio = this.stereoToMono(stereo48kHz);
		const downsampledAudio = this.downsample48kHzTo16kHz(monoAudio);
		return downsampledAudio;
	}

	/**
	 * Combined processing pipeline for TTS
	 * Converts mono 24kHz to stereo 48kHz
	 */
	static processForTTS(mono24kHz: ArrayBuffer): ArrayBuffer {
		const resampledAudio = this.resample24kHzTo48kHz(mono24kHz);
		const stereoAudio = this.monoToStereo(resampledAudio);
		return stereoAudio;
	}
}

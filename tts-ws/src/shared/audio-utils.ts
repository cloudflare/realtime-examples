/**
 * Audio processing utilities shared between STT and TTS adapters
 */

import { SpeexResampler } from '../speex-resampler';
import { AudioProcessor } from '../audio-processor';

/**
 * Ensures buffer has even byte length for 16-bit PCM
 */
export function ensureEvenBytes(buf: ArrayBuffer): ArrayBuffer {
	if (buf.byteLength % 2 !== 0) {
		return buf.slice(0, buf.byteLength - 1);
	}
	return buf;
}

/**
 * Safely initializes a Speex resampler
 */
export function initSpeexResampler(channels: number, inputRate: number, outputRate: number): SpeexResampler | null {
	try {
		SpeexResampler.ensureWasm();
		return SpeexResampler.tryCreate(channels, inputRate, outputRate);
	} catch (e) {
		console.warn('Speex resampler init failed:', e);
		return null;
	}
}

/**
 * STT Helper: Convert stereo 48kHz to mono 16kHz with Speex preference
 */
export function toMono16kFromStereo48k(input48kStereo: ArrayBuffer, speexResampler?: SpeexResampler | null): ArrayBuffer {
	if (input48kStereo.byteLength === 0) return input48kStereo;

	// Convert stereo to mono first
	let mono48k = AudioProcessor.stereoToMono(input48kStereo);

	// Ensure even byte length
	mono48k = ensureEvenBytes(mono48k);

	// Try Speex resampling if available
	if (speexResampler) {
		try {
			const inView = new Int16Array(mono48k);
			const outView = speexResampler.processInterleavedInt(inView);
			if (outView.length > 0) {
				return outView.buffer as ArrayBuffer;
			}
		} catch (e) {
			console.warn('Speex resample failed, using JS fallback:', e);
		}
	}

	// Fallback to JS downsampler
	return AudioProcessor.downsample48kHzTo16kHz(mono48k);
}

/**
 * TTS Helper: Resample mono 24kHz to stereo 48kHz with Speex preference
 */
export function resample24kToStereo48k(input24kMono: ArrayBuffer, speexResampler?: SpeexResampler | null): ArrayBuffer {
	if (input24kMono.byteLength === 0) return input24kMono;

	// Ensure even byte length
	const evenInput = ensureEvenBytes(input24kMono);

	// Try Speex resampling if available
	if (speexResampler) {
		try {
			const inView = new Int16Array(evenInput);
			const outView = speexResampler.processInterleavedInt(inView);
			if (outView.length > 0) {
				// Convert mono 48kHz to stereo 48kHz
				return AudioProcessor.monoToStereo(outView.buffer as ArrayBuffer);
			}
		} catch (e) {
			console.warn('Speex resample failed, using JS fallback:', e);
		}
	}

	// Fallback to JS pipeline (24k -> 48k resample + mono -> stereo)
	return AudioProcessor.processForTTS(evenInput);
}

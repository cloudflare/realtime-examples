/**
 * Subtitle export utilities for VTT and SRT formats
 */

import { Transcript } from '../types';

export class SubtitleExporter {
	/**
	 * Format time for subtitles
	 */
	private static formatTime(seconds: number, format: 'vtt' | 'srt'): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		const ms = Math.floor((seconds % 1) * 1000);

		const separator = format === 'srt' ? ',' : '.';
		return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}${separator}${ms
			.toString()
			.padStart(3, '0')}`;
	}

	/**
	 * Export transcripts as WebVTT
	 */
	static exportVTT(transcripts: Transcript[], sessionId: string): void {
		const finalTranscripts = transcripts.filter((t) => t.isFinal);

		if (finalTranscripts.length === 0) {
			throw new Error('No transcriptions to export');
		}

		let content = 'WEBVTT\n\n';

		finalTranscripts.forEach((transcript) => {
			const start = this.formatTime(transcript.start, 'vtt');
			const end = this.formatTime(transcript.start + 3, 'vtt'); // 3 second duration

			content += `${start} --> ${end}\n`;
			content += `${transcript.text}\n\n`;
		});

		this.downloadFile(content, `transcription-${sessionId}.vtt`);
	}

	/**
	 * Export transcripts as SRT
	 */
	static exportSRT(transcripts: Transcript[], sessionId: string): void {
		const finalTranscripts = transcripts.filter((t) => t.isFinal);

		if (finalTranscripts.length === 0) {
			throw new Error('No transcriptions to export');
		}

		let content = '';

		finalTranscripts.forEach((transcript, index) => {
			const start = this.formatTime(transcript.start, 'srt');
			const end = this.formatTime(transcript.start + 3, 'srt'); // 3 second duration

			content += `${index + 1}\n`;
			content += `${start} --> ${end}\n`;
			content += `${transcript.text}\n\n`;
		});

		this.downloadFile(content, `transcription-${sessionId}.srt`);
	}

	/**
	 * Download file to user's computer
	 */
	private static downloadFile(content: string, filename: string): void {
		const blob = new Blob([content], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}
}

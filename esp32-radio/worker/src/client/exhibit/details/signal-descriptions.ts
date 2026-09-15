import type { Selection } from '@/client/exhibit/diagram/diagram-model.ts';

export const descriptions: Record<Selection, { title: string; body: string; chain?: string }> = {
  board: {
    title: 'ESP32-S3',
    body: 'Music is stored in flash as Opus packets. The LED drawing follows the board’s reported color. Audio plays on listeners’ devices; the board has no speaker attached.',
  },
  audio: {
    title: 'Opus audio',
    body: 'The board sends stereo Opus packets every 20 ms. The SFU forwards them to each listener’s device for decoding. Songs advance through the board’s playlist. Volume and mute affect only you; playback controls affect everyone.',
  },
  spectrum: {
    title: 'Live spectrum',
    chain: 'Opus copy → PCM → Hann window → FFT → 32 bands',
    body: 'A Rust task on core 1 calls ESP-DSP’s 2,048-point FFT. The board sends 32 logarithmic frequency bands at 25 Hz over an unordered data channel. Audio and spectrum can arrive at different times.',
  },
  robot: {
    title: 'Telemetry & controls',
    body: 'A reliable data channel carries telemetry twice a second, commands, and board confirmations. The board samples CPU load, chip temperature, and memory once a second. One listener at a time can control the board; the SFU enforces that permission.',
  },
  sfu: {
    title: 'Cloudflare Realtime SFU',
    body: 'The board publishes one audio track and two data channels over a single WebRTC connection. Each listener connects to the SFU separately. A Worker and Durable Object manage access, sessions, and control permission; audio and data bypass them.',
  },
};

import { z } from 'zod';
import { nowPlayingSchema } from './track.ts';
import { hardwareSchema } from './hardware.ts';

const count = z.number().int().nonnegative();
export const rgbSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);
export const spectrumStatsSchema = z.object({
  source: z.string().max(32),
  fftSize: count,
  core: count,
  sampleRate: count,
  frames: count,
  errors: count,
  inputDropped: count,
  outputDropped: count,
  meanUs: count,
  maxUs: count,
  stackFree: count.optional(),
});
export const telemetrySchema = z.object({
  event: z.literal('telemetry'),
  firmware: z.string().max(32),
  sequence: count,
  uptimeMs: count,
  positionMs: count,
  durationMs: count.positive(),
  playbackRevision: count.max(0xffff_ffff).optional(),
  paused: z.boolean(),
  rssi: z.number().int().min(-127).max(0).nullable(),
  heap: count,
  hardware: hardwareSchema.nullish(),
  stackFree: count.optional(),
  led: rgbSchema,
  audioErrors: count,
  dataErrors: count,
  skippedFrames: count,
  spectrum: spectrumStatsSchema.optional(),
  music: z
    .object({ cacheBytes: count, indexBytes: count, reads: count, maxReadUs: count })
    .optional(),
});
export const ackSchema = z.object({
  event: z.literal('ack'),
  command_id: z.string().max(64),
  result: z.number().int(),
  led: rgbSchema,
  paused: z.boolean(),
});
export const nowPlayingMessageSchema = z.object({
  event: z.literal('nowPlaying'),
  nowPlaying: nowPlayingSchema,
});
export const robotMessageSchema = z.discriminatedUnion('event', [
  telemetrySchema,
  ackSchema,
  nowPlayingMessageSchema,
]);
export const commandSchema = z.union([
  z.object({ led: rgbSchema }).strict(),
  z.object({ action: z.enum(['play', 'pause', 'restart', 'next']) }).strict(),
]);

export type RGB = z.infer<typeof rgbSchema>;
export type SpectrumStats = z.infer<typeof spectrumStatsSchema>;
export type Telemetry = z.infer<typeof telemetrySchema>;
export type Ack = z.infer<typeof ackSchema>;
export type Command = z.infer<typeof commandSchema>;
export type RobotMessage = z.infer<typeof robotMessageSchema>;

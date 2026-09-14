import { z } from 'zod';

const tagSchema = z
  .string()
  .max(256)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 256 && !/\p{Cc}/u.test(value));
export const trackSchema = z
  .object({
    title: tagSchema.refine((value) => value.trim().length > 0),
    artist: tagSchema,
    durationMs: z.number().int().positive().max(600000).multipleOf(20),
  })
  .strict();

export type Track = z.infer<typeof trackSchema>;

export const nowPlayingSchema = z
  .object({
    revision: z.number().int().min(0).max(0xffff_ffff),
    trackIndex: z.number().int().min(0).max(31),
    trackCount: z.number().int().min(1).max(32),
    track: trackSchema.nullable(),
  })
  .strict()
  .refine((value) => value.trackIndex < value.trackCount);

export type NowPlaying = z.infer<typeof nowPlayingSchema>;

/** Wrapping sequence comparison within one publisher generation. */
export function newerRevision(next: number, previous: number): boolean {
  const distance = (next - previous) >>> 0;
  return distance > 0 && distance < 0x8000_0000;
}

export function sameNowPlaying(a: NowPlaying, b: NowPlaying): boolean {
  return (
    a.revision === b.revision &&
    a.trackIndex === b.trackIndex &&
    a.trackCount === b.trackCount &&
    a.track?.title === b.track?.title &&
    a.track?.artist === b.track?.artist &&
    a.track?.durationMs === b.track?.durationMs
  );
}

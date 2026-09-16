import { z } from 'zod';
import { nowPlayingSchema, trackSchema } from './track.ts';

const count = z.number().int().nonnegative();
export const descriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(16000).startsWith('v=0'),
});
export const offerSchema = descriptionSchema.extend({ type: z.literal('offer') });
export const answerSchema = descriptionSchema.extend({ type: z.literal('answer') });
export const deviceStartSchema = z
  .object({
    sessionDescription: offerSchema,
    track: trackSchema.nullish(),
    nowPlaying: nowPlayingSchema.optional(),
    bootId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  })
  .strict();
export const generationSchema = z.object({ generation: z.uuid() }).strict();
export const deviceHeartbeatSchema = generationSchema.extend({
  nowPlaying: nowPlayingSchema.optional(),
});
export const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();
export const emptySchema = z.object({}).strict();
export const answerInputSchema = z.object({ sessionDescription: answerSchema }).strict();
export const leaveSchema = z.object({ viewerToken: z.uuid().optional() }).strict();
export const viewerKeySchema = z.object({ id: z.uuid(), token: z.uuid() });
export const statusSchema = z.object({
  online: z.boolean(),
  viewers: count,
  controller: z.string().nullable(),
  generation: z.string().nullable(),
  track: trackSchema.nullish(),
  nowPlaying: nowPlayingSchema.nullish(),
});
export const joinedSchema = z.object({
  id: z.uuid(),
  viewerToken: z.uuid(),
  generation: z.uuid(),
  sessionDescription: offerSchema,
});
export const controllerSchema = z.object({ controller: z.string().nullable() });
export const okSchema = z.object({ ok: z.literal(true) });
export const audioResponseSchema = z.object({ sessionDescription: offerSchema });

export type Description = z.infer<typeof descriptionSchema>;
export type DeviceStart = z.infer<typeof deviceStartSchema>;
export type ViewerKey = z.infer<typeof viewerKeySchema>;
export type Joined = z.infer<typeof joinedSchema>;
export type RoomStatus = z.infer<typeof statusSchema>;
export type Answer = z.infer<typeof answerSchema>;
export type ViewerCredentials = Pick<Joined, 'id' | 'viewerToken'>;

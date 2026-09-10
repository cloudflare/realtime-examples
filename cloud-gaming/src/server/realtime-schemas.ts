import { z } from "zod";

import { sessionDescriptionSchema } from "../shared/schemas";

const safeLocatorSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const errorFields = {
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
};

export const sfuErrorEnvelopeSchema = z.object(errorFields).passthrough();

export const newSessionResponseSchema = z
  .object({
    ...errorFields,
    sessionId: safeLocatorSchema,
  })
  .passthrough();

export const sfuTrackSchema = z
  .object({
    ...errorFields,
    mid: safeLocatorSchema.optional(),
    sessionId: safeLocatorSchema.optional(),
    trackName: safeLocatorSchema.optional(),
  })
  .passthrough();

export const sfuDataChannelSchema = z
  .object({
    ...errorFields,
    canReply: z.boolean().optional(),
    dataChannelName: safeLocatorSchema.optional(),
    id: z.number().int().min(0).max(65_534).optional(),
    location: z.enum(["local", "remote"]).optional(),
    maxRetransmits: z.number().int().min(0).optional(),
    ordered: z.boolean().optional(),
    sessionId: safeLocatorSchema.optional(),
    waitForAck: z.boolean().optional(),
  })
  .passthrough();

export const tracksResponseSchema = z
  .object({
    ...errorFields,
    requiresImmediateRenegotiation: z.boolean().optional(),
    sessionDescription: sessionDescriptionSchema.optional(),
    tracks: z.array(sfuTrackSchema).optional().default([]),
  })
  .passthrough();

export const dataChannelsResponseSchema = z
  .object({
    ...errorFields,
    dataChannels: z.array(sfuDataChannelSchema).optional().default([]),
    requiresImmediateRenegotiation: z.boolean().optional(),
    sessionDescription: sessionDescriptionSchema.optional(),
  })
  .passthrough();

export const transportResponseSchema = z
  .object({
    ...errorFields,
    dataChannel: sfuDataChannelSchema.optional(),
    datachannel: sfuDataChannelSchema.optional(),
    dataChannels: z.array(sfuDataChannelSchema).optional(),
    requiresImmediateRenegotiation: z.boolean().optional(),
    sessionDescription: sessionDescriptionSchema.optional(),
  })
  .passthrough();

export const emptySfuResponseSchema = z
  .object({
    ...errorFields,
    sessionDescription: sessionDescriptionSchema.optional(),
  })
  .passthrough();

export type SfuTrack = z.output<typeof sfuTrackSchema>;
export type SfuDataChannel = z.output<typeof sfuDataChannelSchema>;
export type SfuTracksResponse = z.output<typeof tracksResponseSchema>;
export type SfuDataChannelsResponse = z.output<
  typeof dataChannelsResponseSchema
>;

import { z } from "zod";

export const API_HEADER_MEMBER_TOKEN = "x-room-member-token";
export const API_HEADER_LOCAL_IDENTITY = "x-video-room-local-identity";
export const ROOM_SOCKET_PROTOCOL = "video-room-notify-v1";
export const ROOM_SOCKET_TICKET_PREFIX = "ticket.";

export const roomIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const operationIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/);
const displayNameSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,47}$/u);
const capabilitySchema = z.string().regex(/^[a-zA-Z0-9_-]{32,128}$/);
const generationSchema = z.int().positive();
const revisionSchema = z.int().nonnegative();
const trackKeySchema = z.string().regex(/^p_[a-zA-Z0-9]+:(?:audio|video)$/);
const browserMidSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/);

export const mediaKindSchema = z.enum(["audio", "video"]);
export const sessionDescriptionSchema = z.looseObject({
  // Preserve the existing limit in JavaScript string units, including surrogate pairs.
  sdp: z.string().refine((sdp) => sdp.length > 0 && sdp.length <= 1_000_000),
  type: z.enum(["offer", "answer"]),
});
const offerSchema = sessionDescriptionSchema.refine(
  (sdp) => sdp.type === "offer",
);
const answerSchema = sessionDescriptionSchema.refine(
  (sdp) => sdp.type === "answer",
);

// The Worker resolves a missing/null display name from the authenticated principal
// before validating. Internal RPC commands always carry the resolved value.
export const joinRequestSchema = z.object({
  clientId: operationIdSchema,
  displayName: displayNameSchema,
  memberToken: capabilitySchema,
});
export const reconnectRequestSchema = z.object({
  clientId: operationIdSchema,
  displayName: displayNameSchema,
  requestId: operationIdSchema,
});
export const publishRequestSchema = z.object({
  generation: generationSchema,
  mutationId: operationIdSchema,
  sessionDescription: offerSchema,
  tracks: z
    .array(z.object({ kind: mediaKindSchema, mid: browserMidSchema }))
    .min(1)
    .max(2)
    .refine(
      (tracks) =>
        new Set(tracks.map((track) => track.kind)).size === tracks.length,
    ),
});
export const subscribeRequestSchema = z.object({
  generation: generationSchema,
  mutationId: operationIdSchema,
  trackKeys: z.array(trackKeySchema).transform((keys) => [...new Set(keys)]),
});
export const renegotiateRequestSchema = z.object({
  generation: generationSchema,
  mutationId: operationIdSchema,
  sessionDescription: answerSchema,
});

const trackReferenceSchema = z.object({
  key: z.string().min(1),
  kind: mediaKindSchema,
  participantId: z.string().min(1),
});
const participantViewSchema = z.object({
  displayName: z.string().min(1),
  id: z.string().min(1),
  published: z.array(trackReferenceSchema),
});
export const roomSnapshotSchema = z.object({
  creatorParticipantId: z.string().min(1).nullable(),
  participants: z.array(participantViewSchema),
  revision: revisionSchema,
  roomId: roomIdSchema,
  terminated: z.boolean(),
});
export const joinResponseSchema = z.object({
  generation: generationSchema,
  memberToken: capabilitySchema,
  participantId: z.string().min(1),
  snapshot: roomSnapshotSchema,
});
export const publishResponseSchema = z.object({
  mutationId: operationIdSchema,
  sessionDescription: answerSchema,
  tracks: z.array(
    z.object({
      key: z.string().min(1),
      kind: mediaKindSchema,
      mid: z.string().min(1),
    }),
  ),
});
const subscriptionFields = {
  mutationId: operationIdSchema,
  subscriptions: z.array(
    trackReferenceSchema.extend({ mid: z.string().min(1) }),
  ),
};
export const subscriptionResponseSchema = z.discriminatedUnion(
  "requiresImmediateRenegotiation",
  [
    z.object({
      ...subscriptionFields,
      requiresImmediateRenegotiation: z.literal(true),
      sessionDescription: offerSchema,
    }),
    z.object({
      ...subscriptionFields,
      requiresImmediateRenegotiation: z.literal(false),
      sessionDescription: sessionDescriptionSchema.optional(),
    }),
  ],
);
export const socketTicketResponseSchema = z.object({
  expiresAt: z.int().nonnegative(),
  ticket: capabilitySchema,
});
export const okResponseSchema = z.object({ ok: z.literal(true) });
export const roomChangedNotificationSchema = z.object({
  revision: revisionSchema,
  type: z.literal("room-changed"),
});
export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(1024),
    requestId: z.string().min(1).max(255).optional(),
    retryable: z.boolean().optional(),
  }),
});

export type MediaKind = z.infer<typeof mediaKindSchema>;
export type SessionDescription = z.infer<typeof sessionDescriptionSchema>;
export type JoinRequest = z.infer<typeof joinRequestSchema>;
export type ReconnectRequest = z.infer<typeof reconnectRequestSchema>;
export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type SubscribeRequest = z.infer<typeof subscribeRequestSchema>;
export type RenegotiateRequest = z.infer<typeof renegotiateRequestSchema>;
export type TrackReference = z.infer<typeof trackReferenceSchema>;
export type ParticipantView = z.infer<typeof participantViewSchema>;
export type RoomSnapshot = z.infer<typeof roomSnapshotSchema>;
export type JoinResponse = z.infer<typeof joinResponseSchema>;
export type PublishResponse = z.infer<typeof publishResponseSchema>;
export type SubscriptionResponse = z.infer<typeof subscriptionResponseSchema>;
export type SocketTicketResponse = z.infer<typeof socketTicketResponseSchema>;
export type RoomChangedNotification = z.infer<
  typeof roomChangedNotificationSchema
>;
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

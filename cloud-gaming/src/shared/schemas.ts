import { z } from "zod";

import {
  GAME_SETTINGS,
  type ApiErrorBody,
  type ControlClaimResponse,
  type ControlLeaseResponse,
  type GameSnapshot,
  type PublisherPublishRequest,
  type PublisherRegisterRequest,
  type PublisherTransportCompleteRequest,
  type SessionDescription,
  type ViewerHeartbeatResponse,
  type ViewerInputResponse,
  type ViewerJoinRequest,
  type ViewerJoinResponse,
  type ViewerLeaveResponse,
  type ViewerTransportCompleteRequest,
  type ViewerTransportResponse,
} from "./protocol";

export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
export const capabilitySchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
export const emptySearchSchema = z.literal("");
export const jsonContentTypeSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .refine((value) => value.includes("application/json"));
export const contentLengthSchema = z
  .union([z.null(), z.string().regex(/^[0-9]+$/)])
  .transform((value) => (value === null ? 0 : Number(value)))
  .refine(Number.isSafeInteger);

export const sessionDescriptionSchema = z
  .object({
    sdp: z.string().min(1).max(1_000_000),
    type: z.enum(["answer", "offer"]),
  })
  .strict() satisfies z.ZodType<SessionDescription>;
const sessionDescriptionOfferSchema = sessionDescriptionSchema.extend({
  type: z.literal("offer"),
});
const sessionDescriptionAnswerSchema = sessionDescriptionSchema.extend({
  type: z.literal("answer"),
});
const midSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/);
const trackNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const safeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const localTrackSchema = z
  .object({
    mid: midSchema,
    trackName: trackNameSchema,
  })
  .strict();

export const viewerJoinSchema: z.ZodType<ViewerJoinRequest> = z
  .object({
    sessionDescription: sessionDescriptionOfferSchema,
  })
  .strict();

export const viewerTransportCompleteSchema: z.ZodType<ViewerTransportCompleteRequest> = z
  .object({
    sessionDescription: sessionDescriptionAnswerSchema,
  })
  .strict();

export const publisherEmptySchema = z.object({}).strict();

export const publisherGenerationPathSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number)
  .refine(Number.isSafeInteger);
export const publisherRouteParamsSchema = z
  .object({
    generation: publisherGenerationPathSchema,
    runId: uuidSchema,
  })
  .strict();

export const publisherRegisterSchema: z.ZodType<PublisherRegisterRequest> = z
  .object({
    viewport: z
      .object({
        fps: z.literal(GAME_SETTINGS.fps),
        height: z.literal(GAME_SETTINGS.height),
        width: z.literal(GAME_SETTINGS.width),
      })
      .strict(),
  })
  .strict();

export const publisherPublishSchema: z.ZodType<PublisherPublishRequest> = z
  .object({
    audio: localTrackSchema,
    sessionDescription: sessionDescriptionOfferSchema,
    video: localTrackSchema,
  })
  .strict();

export const publisherTransportCompleteSchema: z.ZodType<PublisherTransportCompleteRequest> =
  z
  .object({
    sessionDescription: sessionDescriptionAnswerSchema,
  })
  .strict();

export const gameSnapshotResponseSchema: z.ZodType<GameSnapshot> = z
  .object({
    cleanupPending: z.boolean(),
    controllerGeneration: safeIntegerSchema,
    expiresAt: safeIntegerSchema.optional(),
    hasController: z.boolean(),
    runGeneration: safeIntegerSchema,
    runId: uuidSchema.optional(),
    settings: z
      .object({
        fps: z.literal(GAME_SETTINGS.fps),
        height: z.literal(GAME_SETTINGS.height),
        title: z.literal(GAME_SETTINGS.title),
        width: z.literal(GAME_SETTINGS.width),
      })
      .strict(),
    startedAt: safeIntegerSchema.optional(),
    status: z.enum([
      "failed",
      "running",
      "starting",
      "stopped",
      "stopping",
    ]),
    viewerCount: safeIntegerSchema,
  })
  .strict();

export const viewerJoinResponseSchema: z.ZodType<ViewerJoinResponse> = z
  .object({
    expiresAt: safeIntegerSchema,
    runGeneration: safeIntegerSchema.min(1),
    runId: uuidSchema,
    sessionDescription: sessionDescriptionAnswerSchema,
    tracks: z.array(
      z
        .object({
          kind: z.enum(["audio", "video"]),
          mid: z.string().min(1).max(64),
        })
        .strict(),
    ),
    viewerCapability: capabilitySchema,
    viewerId: uuidSchema,
  })
  .strict();

export const viewerHeartbeatResponseSchema: z.ZodType<ViewerHeartbeatResponse> =
  z
    .object({
      ok: z.literal(true),
    })
    .strict();

export const viewerLeaveResponseSchema: z.ZodType<ViewerLeaveResponse> = z
  .object({
    cleanupPending: z.boolean(),
    left: z.literal(true),
  })
  .strict();

export const controlClaimResponseSchema: z.ZodType<ControlClaimResponse> = z
  .object({
    leaseGeneration: safeIntegerSchema.min(1),
  })
  .strict();

export const controlLeaseResponseSchema: z.ZodType<ControlLeaseResponse> = z
  .object({
    cleanupPending: z.boolean(),
    leaseGeneration: safeIntegerSchema,
    released: z.boolean(),
  })
  .strict();

const controlInputChannelSchema = z
  .object({
    dataChannelName: z.string().min(1).max(256),
    id: safeIntegerSchema.max(65_534),
    kind: z.enum(["keyboard", "pointer"]),
    maxRetransmits: safeIntegerSchema.optional(),
    ordered: z.boolean(),
  })
  .strict();

export const viewerInputResponseSchema: z.ZodType<ViewerInputResponse> = z
  .object({
    inputs: z.array(controlInputChannelSchema),
  })
  .strict();

export const viewerTransportResponseSchema: z.ZodType<ViewerTransportResponse> =
  z
    .object({
      sessionDescription: sessionDescriptionOfferSchema,
    })
    .strict();

export const apiErrorResponseSchema: z.ZodType<
  Pick<ApiErrorBody, "error">
> = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string().optional(),
        retryable: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

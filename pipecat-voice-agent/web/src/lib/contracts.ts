import { z } from 'zod';

export const agentSchema = z.object({
  name: z.string().min(1).max(40),
  instructions: z.string().max(1600),
  voice: z.enum(['apollo', 'arcas', 'asteria', 'athena', 'luna', 'orion', 'zeus']),
  tools_enabled: z.boolean(),
  utc_offset_minutes: z.number().int().min(-840).max(840),
});
export type AgentSettings = z.infer<typeof agentSchema>;
export const defaultAgent: AgentSettings = {
  name: 'Matt',
  instructions: 'Be friendly and useful.',
  voice: 'arcas',
  tools_enabled: true,
  utc_offset_minutes: -new Date().getTimezoneOffset(),
};

export const sessionSchema = z.object({
  authenticated: z.boolean(),
  configured: z.boolean(),
  agent: agentSchema.optional(),
  max_call_seconds: z.number().int().positive().optional(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;

export const timingSchema = z.object({
  operation: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'failed']),
  elapsed_ms: z.number().nonnegative(),
});
export type Timing = z.infer<typeof timingSchema> & {
  source: 'browser' | 'server';
  cumulative_ms?: number;
};

export const callSchema = z.object({
  call_id: z.string().nullable(),
  phase: z.enum(['created', 'published', 'preparing', 'active', 'ending', 'ended']),
  active: z.boolean(),
  ready: z.boolean(),
  generation: z.number().int(),
  expires_at_ms: z.number(),
  finish_reason: z.string().nullable(),
  cleanup_complete: z.boolean(),
  timings: z.array(timingSchema),
});

export const toolSourceSchema = z.object({
  title: z.string().min(1).max(160),
  url: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return url.protocol === 'https:' && !url.port && !url.username && !url.password;
    }),
});
export type ToolSource = z.infer<typeof toolSourceSchema>;

export const toolEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('tool_started'),
    call_id: z.string().min(1),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal('tool_finished'),
    call_id: z.string().min(1),
    sources: z.array(toolSourceSchema).max(6).optional(),
  }),
  z.object({ type: z.literal('tool_empty'), call_id: z.string().min(1) }),
  z.object({ type: z.literal('tool_failed'), call_id: z.string().min(1) }),
  z.object({ type: z.literal('tool_cancelled'), call_id: z.string().min(1) }),
]);
export type ToolEvent = z.infer<typeof toolEventSchema>;

const generation = z.number().int().nonnegative();
// Flux allows 8192 Unicode code points, each occupying up to two UTF-16 units.
const text = z.string().max(16_384);
export const eventSchema = z.intersection(
  z.object({
    sequence: z.number().int().positive(),
    at_ms: z.number(),
    server_time_ms: z.number(),
  }),
  z.discriminatedUnion('type', [
    ...toolEventSchema.options,
    z.object({ type: z.literal('user_transcript'), text }),
    z.object({ type: z.literal('user_turn_started'), generation }),
    z.object({ type: z.literal('user_turn_stopped'), text }),
    z.object({ type: z.literal('assistant_turn_started'), generation }),
    z.object({ type: z.literal('assistant_response'), text: text.min(1), generation }),
    z.object({ type: z.literal('assistant_response_finished'), generation }),
    z.object({ type: z.literal('filler_finished'), generation }),
    z.object({ type: z.literal('speech_failed'), generation }),
    z.object({
      type: z.literal('assistant_turn_stopped'),
      text,
      interrupted: z.boolean(),
      generation,
    }),
    z.object({ type: z.literal('clear'), generation }),
    z.object({ type: z.literal('audio_started'), generation }),
    z.object({ type: z.literal('output_unavailable'), generation }),
    z.object({ type: z.literal('ready'), ready: z.boolean(), generation }),
    z.object({ type: z.literal('closing'), reason: z.string() }),
    z.object({ type: z.literal('error') }),
    z.object({ type: z.literal('pipeline_error') }),
    z.object({ type: z.literal('pipeline_started') }),
    z.object({ type: z.literal('pipeline_finished') }),
    z.object({ type: z.literal('context_updated') }),
  ]),
);
export type VoiceEvent = z.infer<typeof eventSchema>;
export const eventsSchema = callSchema.extend({
  last_sequence: z.number().int().nonnegative(),
  earliest_sequence: z.number().int().nonnegative(),
  server_time_ms: z.number(),
  events: z.array(eventSchema).max(128),
});
export type EventBatch = z.infer<typeof eventsSchema>;

export const negotiationSchema = z.object({
  sessionDescription: z
    .object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1) })
    .optional(),
  requiresImmediateRenegotiation: z.boolean().optional(),
  timings: z.array(timingSchema),
});
export const attachedSchema = z.object({
  attached: z.literal(true),
  timings: z.array(timingSchema),
});

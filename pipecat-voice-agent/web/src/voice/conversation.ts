import type { ToolEvent, ToolSource, VoiceEvent } from '../lib/contracts';

export type ToolDefinition = {
  name: string;
  label: string;
  icon: 'clock' | 'weather' | 'docs' | 'page' | 'status' | 'web' | 'tool';
};

const tools = new Map<string, ToolDefinition>([
  [
    'get_weather_forecast',
    { name: 'get_weather_forecast', label: 'Check weather forecast', icon: 'weather' },
  ],
  [
    'get_current_time',
    { name: 'get_current_time', label: 'Check the current time', icon: 'clock' },
  ],
  [
    'get_current_weather',
    { name: 'get_current_weather', label: 'Check current weather', icon: 'weather' },
  ],
  [
    'search_cloudflare_documentation',
    { name: 'search_cloudflare_documentation', label: 'Search Cloudflare docs', icon: 'docs' },
  ],
  [
    'read_cloudflare_documentation',
    { name: 'read_cloudflare_documentation', label: 'Read Cloudflare docs', icon: 'page' },
  ],
  [
    'get_cloudflare_status',
    { name: 'get_cloudflare_status', label: 'Check Cloudflare status', icon: 'status' },
  ],
  ['search_web', { name: 'search_web', label: 'Search the web', icon: 'web' }],
]);

export function describeTool(name: string): ToolDefinition {
  return tools.get(name) ?? { name, label: 'Run a tool', icon: 'tool' };
}

export type ToolStatus = 'running' | 'complete' | 'empty' | 'failed' | 'cancelled';
export type AssistantStatus =
  'preparing' | 'speaking' | 'complete' | 'interrupted' | 'audio_failed';
export type ConversationEntry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; generation: number; text: string; status: AssistantStatus }
  | ({ kind: 'tool'; id: string; tool: ToolDefinition } & (
      { status: 'complete'; sources?: ToolSource[] } | { status: Exclude<ToolStatus, 'complete'> }
    ));

const completion = {
  tool_finished: 'complete',
  tool_empty: 'empty',
  tool_failed: 'failed',
  tool_cancelled: 'cancelled',
} as const satisfies Record<Exclude<ToolEvent['type'], 'tool_started'>, ToolStatus>;

export function applyToolEvent(
  history: ConversationEntry[],
  event: ToolEvent,
): ConversationEntry[] {
  const id = `tool-${event.call_id}`;
  if (event.type === 'tool_started') {
    if (history.some((entry) => entry.kind === 'tool' && entry.id === id)) return history;
    const entry: ConversationEntry = {
      kind: 'tool',
      id,
      tool: describeTool(event.name),
      status: 'running',
    };
    return [...history, entry];
  }
  const current = history.find((entry) => entry.kind === 'tool' && entry.id === id);
  if (!current || current.kind !== 'tool' || current.status !== 'running') return history;
  const updated: ConversationEntry =
    event.type === 'tool_finished'
      ? { ...current, status: 'complete', sources: event.sources }
      : { ...current, status: completion[event.type] };
  return history.map((entry) => (entry === current ? updated : entry));
}

export function interruptResponses(
  history: ConversationEntry[],
  beforeGeneration = Infinity,
): ConversationEntry[] {
  return history.map((entry) =>
    entry.kind === 'assistant' &&
    entry.generation < beforeGeneration &&
    (entry.status === 'preparing' || entry.status === 'speaking')
      ? { ...entry, status: 'interrupted' }
      : entry,
  );
}

export function applyConversationEvent(
  history: ConversationEntry[],
  event: VoiceEvent,
  minimumGeneration = 0,
): ConversationEntry[] {
  if ('generation' in event && event.generation < minimumGeneration) return history;
  switch (event.type) {
    case 'tool_started':
    case 'tool_finished':
    case 'tool_empty':
    case 'tool_failed':
    case 'tool_cancelled':
      return applyToolEvent(history, event);
    case 'user_transcript': {
      if (!event.text.trim()) return history;
      const entry: ConversationEntry = {
        kind: 'user',
        id: String(event.sequence),
        text: event.text,
      };
      return [...history, entry];
    }
    case 'assistant_response': {
      const id = `assistant-${event.generation}`;
      if (!event.text.trim() || history.some((entry) => entry.id === id)) return history;
      const entry: ConversationEntry = {
        kind: 'assistant',
        id,
        generation: event.generation,
        text: event.text,
        status: 'preparing',
      };
      return [...history, entry];
    }
    case 'audio_started':
    case 'assistant_response_finished':
    case 'speech_failed':
      return history.map((entry) =>
        entry.kind === 'assistant' &&
        entry.generation === event.generation &&
        (entry.status === 'preparing' || entry.status === 'speaking')
          ? { ...entry, status: speechStatuses[event.type] }
          : entry,
      );
    case 'clear':
      return interruptResponses(history, event.generation);
    case 'closing':
    case 'error':
    case 'pipeline_error':
    case 'output_unavailable':
      return interruptResponses(history);
    default:
      return history;
  }
}

const speechStatuses = {
  audio_started: 'speaking',
  assistant_response_finished: 'complete',
  speech_failed: 'audio_failed',
} as const satisfies Record<string, AssistantStatus>;

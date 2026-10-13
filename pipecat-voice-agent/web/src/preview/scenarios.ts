import type { SessionState } from '../lib/session';
import { describeTool, type ConversationEntry } from '../voice/conversation';
import { describeCallEnd, idleCall, type CallView } from '../voice/model';

export const scenarios = [
  { id: 'idle', label: 'Ready' },
  { id: 'access-code', label: 'Access code' },
  { id: 'access-error', label: 'Incorrect access code' },
  { id: 'signing-in', label: 'Checking access code' },
  { id: 'connecting', label: 'Connecting' },
  { id: 'listening', label: 'Listening' },
  { id: 'preparing-audio', label: 'Answer ready, preparing audio' },
  { id: 'speaking', label: 'Speaking' },
  { id: 'tool-running', label: 'Running a tool' },
  { id: 'tool-failed', label: 'Tool failed' },
  { id: 'docs-searching', label: 'Searching Cloudflare docs' },
  { id: 'docs-sources', label: 'Cloudflare docs sources' },
  { id: 'docs-empty', label: 'No documentation matches' },
  { id: 'docs-read', label: 'Read a documentation page' },
  { id: 'weather-forecast', label: 'Weather forecast' },
  { id: 'cloudflare-status', label: 'Cloudflare service status' },
  { id: 'web-search', label: 'Web search sources' },
  { id: 'interrupted', label: 'Interrupted reply' },
  { id: 'audio-failed', label: 'Speech failed, call continues' },
  { id: 'playback-blocked', label: 'Audio permission needed' },
  { id: 'error', label: 'Connection error' },
  { id: 'call-error', label: 'Call failed with a transcript' },
  { id: 'cleanup', label: 'Cleanup pending' },
  { id: 'ended', label: 'Call ended' },
] as const;
export type Scenario = (typeof scenarios)[number]['id'];
export type Preview = { scenario: Scenario; view: CallView; session: SessionState };

export function scenarioFrom(value: string | null): Scenario {
  return scenarios.find((item) => item.id === value)?.id ?? 'idle';
}

const question = {
  kind: 'user',
  id: '1',
  text: "What's the weather in San Leandro, California?",
} satisfies ConversationEntry;
const answer = {
  kind: 'assistant',
  id: '3',
  generation: 1,
  text: "It's clear in San Leandro, California, with a temperature of 28.7°C.",
  status: 'complete',
} satisfies ConversationEntry;
const weatherSources = [
  { title: 'Open-Meteo (summarized data)', url: 'https://open-meteo.com/' },
  { title: 'Weather data: CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
];
const tool = (status: 'running' | 'complete' | 'failed'): ConversationEntry => ({
  kind: 'tool',
  id: 'tool-weather',
  tool: describeTool('get_current_weather'),
  ...(status === 'complete' ? { status, sources: weatherSources } : { status }),
});

export function previewFor(scenario: Scenario): Preview {
  const view = idleCall();
  const preview: Preview = { scenario, view, session: { kind: 'ready' } };
  switch (scenario) {
    case 'docs-read':
    case 'weather-forecast':
    case 'cloudflare-status':
    case 'web-search': {
      const examples = {
        'docs-read': {
          question: 'Read the SFU adapter documentation and explain its audio format.',
          tool: 'read_cloudflare_documentation',
          answer:
            'The adapter carries signed 16-bit little-endian PCM audio at 48 kHz, with interleaved stereo channels.',
          sources: [
            {
              title: 'WebSocket adapter',
              url: 'https://developers.cloudflare.com/realtime/sfu/features/media-transport-adapters/websocket-adapter/',
            },
          ],
        },
        'weather-forecast': {
          question: 'Will I need an umbrella tomorrow in San Leandro?',
          tool: 'get_weather_forecast',
          answer:
            'The forecast shows a 70% chance of rain, so taking an umbrella would be a good idea.',
          sources: weatherSources,
        },
        'cloudflare-status': {
          question: 'Are there any reported Workers incidents?',
          tool: 'get_cloudflare_status',
          answer:
            'The public status page currently lists Workers as operational, with no linked active incidents.',
          sources: [{ title: 'Cloudflare Status', url: 'https://www.cloudflarestatus.com' }],
        },
        'web-search': {
          question: "Search the web for NASA's Artemis program.",
          tool: 'search_web',
          answer:
            "NASA's Artemis program aims to explore the Moon and prepare for missions to Mars.",
          sources: [{ title: 'Artemis', url: 'https://www.nasa.gov/humans-in-space/artemis/' }],
        },
      };
      const example = examples[scenario];
      return {
        ...preview,
        view: {
          ...view,
          phase: 'connected',
          microphoneActive: true,
          connectedAt: Date.now() - 24_000,
          status: 'Connected. Say hello.',
          history: [
            { kind: 'user', id: '1', text: example.question },
            {
              kind: 'tool',
              id: '2',
              tool: describeTool(example.tool),
              status: 'complete',
              sources: example.sources,
            },
            { kind: 'assistant', id: '3', generation: 1, text: example.answer, status: 'complete' },
          ],
        },
      };
    }
    case 'idle':
      return preview;
    case 'access-code':
      return { ...preview, session: { kind: 'locked' } };
    case 'access-error':
      return {
        ...preview,
        session: { kind: 'locked', error: "That access code didn't work. Please try again." },
      };
    case 'signing-in':
      return { ...preview, session: { kind: 'signing-in' } };
    case 'connecting':
      return {
        ...preview,
        view: {
          ...view,
          phase: 'connecting',
          status: 'Prepare voice agent',
          microphoneActive: true,
        },
      };
    case 'error':
      return {
        ...preview,
        view: {
          ...view,
          phase: 'ended',
          status: 'Call ended. Your microphone is off.',
          error: 'The audio connection could not be established. Please try again.',
        },
      };
    case 'cleanup':
    case 'ended':
    case 'call-error':
      return {
        ...preview,
        view: {
          ...view,
          phase: 'ended',
          agentName: 'Aster',
          startedAt: Date.now() - 42_000,
          ...describeCallEnd(scenario === 'call-error' ? 'output_disconnected' : 'user_left'),
          history:
            scenario === 'call-error'
              ? [question, tool('complete'), { ...answer, status: 'interrupted' }]
              : [question, tool('complete'), answer],
          cleanupPending: scenario === 'cleanup',
        },
      };
  }

  Object.assign(view, {
    phase: 'connected',
    microphoneActive: true,
    connectedAt: Date.now() - 24_000,
    status: 'Connected. Say hello.',
    history: [question, tool('complete'), answer],
  });
  switch (scenario) {
    case 'listening':
      view.userLevel = 0.5;
      break;
    case 'preparing-audio':
      view.activity = 'thinking';
      view.history = [question, tool('complete'), { ...answer, status: 'preparing' }];
      break;
    case 'audio-failed':
      view.history = [question, tool('complete'), { ...answer, status: 'audio_failed' }];
      break;
    case 'speaking':
      view.activity = 'speaking';
      view.agentLevel = 0.65;
      view.history = [question, tool('complete'), { ...answer, status: 'speaking' }];
      break;
    case 'tool-running':
      view.activity = 'tool';
      view.history = [question, tool('running')];
      break;
    case 'tool-failed':
      view.history = [
        question,
        tool('failed'),
        { ...answer, text: "I couldn't reach the weather service. Please try again in a moment." },
      ];
      break;
    case 'docs-empty':
      view.history = [
        { kind: 'user', id: '1', text: 'Does Cloudflare offer video conferencing?' },
        {
          kind: 'tool',
          id: 'tool-docs',
          tool: describeTool('search_cloudflare_documentation'),
          status: 'empty',
        },
        { ...answer, text: "That search didn't return any matches. Let me try another query." },
      ];
      break;
    case 'docs-searching':
    case 'docs-sources':
      view.activity = scenario === 'docs-searching' ? 'tool' : 'listening';
      view.history = [
        { kind: 'user', id: '1', text: 'What audio format does the SFU WebSocket adapter use?' },
        {
          kind: 'tool',
          id: 'tool-docs',
          tool: describeTool('search_cloudflare_documentation'),
          ...(scenario === 'docs-searching'
            ? { status: 'running' as const }
            : {
                status: 'complete' as const,
                sources: [
                  {
                    title: 'WebSocket adapters · Cloudflare Realtime docs',
                    url: 'https://developers.cloudflare.com/realtime/sfu/features/media-transport-adapters/websocket-adapter/',
                  },
                ],
              }),
        },
      ];
      if (scenario === 'docs-sources')
        view.history.push({
          ...answer,
          text: "The adapter uses 48 kHz stereo PCM audio. I've included a link to the documentation in our conversation.",
        });
      break;
    case 'interrupted':
      view.history = [
        question,
        { ...answer, text: 'The weather in San Leandro...', status: 'interrupted' },
        { kind: 'user', id: '4', text: 'Actually, how about Oakland?' },
      ];
      break;
    case 'playback-blocked':
      view.playbackBlocked = true;
      break;
  }
  return preview;
}

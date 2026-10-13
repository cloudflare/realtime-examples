import type { Timing, VoiceEvent } from '../lib/contracts';
import type { SessionState } from '../lib/session';
import type { ConversationEntry } from './conversation';

export type CallView = {
  phase: 'idle' | 'connecting' | 'connected' | 'ending' | 'ended';
  activity: 'listening' | 'thinking' | 'speaking' | 'tool';
  status: string;
  error?: string;
  muted: boolean;
  microphoneActive: boolean;
  playbackBlocked: boolean;
  userLevel: number;
  agentLevel: number;
  agentName?: string;
  callId?: string;
  startedAt?: number;
  connectedAt?: number;
  history: ConversationEntry[];
  timings: Timing[];
  cleanupPending: boolean;
};

export function idleCall(): CallView {
  return {
    phase: 'idle',
    activity: 'listening',
    status: 'Ready when you are.',
    muted: false,
    microphoneActive: false,
    playbackBlocked: false,
    userLevel: 0,
    agentLevel: 0,
    history: [],
    timings: [],
    cleanupPending: false,
  };
}

export function isCallBusy(view: CallView) {
  return view.phase === 'connecting' || view.phase === 'connected' || view.phase === 'ending';
}

// A filler can still be playing when its lookup starts or finishes, so tool
// events change the activity only while the assistant is silent.
export function nextActivity(
  view: Pick<CallView, 'activity' | 'history'>,
  event: VoiceEvent,
  history: ConversationEntry[],
): CallView['activity'] {
  switch (event.type) {
    case 'user_turn_started':
    case 'clear':
    case 'assistant_response_finished':
    case 'speech_failed':
      return 'listening';
    case 'user_turn_stopped':
    case 'assistant_turn_started':
      return 'thinking';
    case 'audio_started':
      return 'speaking';
    case 'filler_finished':
      return history.some((entry) => entry.kind === 'tool' && entry.status === 'running')
        ? 'tool'
        : 'thinking';
  }
  if (history === view.history || view.activity === 'speaking') return view.activity;
  if (event.type === 'tool_started') return 'tool';
  if (event.type === 'tool_finished' || event.type === 'tool_empty' || event.type === 'tool_failed')
    return 'thinking';
  return view.activity;
}

export function describeCallEnd(reason: string | null): { status: string; error?: string } {
  if (reason === 'user_left' || reason === 'finished')
    return { status: 'Call ended. Your microphone is off.', error: undefined };
  if (reason === 'session_timeout')
    return {
      status: 'The call time limit was reached. Start another whenever you like.',
      error: undefined,
    };
  const messages: Record<string, string> = {
    provider_disconnected: 'Speech recognition disconnected. Please start a new call.',
    session_restarted: 'The assistant restarted and ended this call. Please start a new call.',
    browser_disconnected: 'The connection to this tab was lost. Please start a new call.',
    output_disconnected: 'The audio connection was lost. Please start a new call.',
    input_reconnect_expired: 'The microphone connection was lost. Please start a new call.',
    socket_error: 'The audio connection failed. Please start a new call.',
    output_unavailable: 'Assistant audio disconnected. Please start a new call.',
    setup_failed: 'The call could not be connected. Please try again.',
  };
  const message =
    messages[reason ?? ''] ??
    'The assistant encountered an error and ended the call. Please start a new call.';
  return { status: message, error: message };
}

/**
 * Everything the call stage renders for one call state. Each phase spells out
 * its own presentation so the component only renders fields.
 */
export type StageView = {
  heading: string;
  subheading: string;
  /** Participant label suffix, as in "Aster · speaking". Absent outside a call. */
  activity?: string;
  orb: 'quiet' | 'loading' | 'live' | 'thinking' | 'speaking';
  controls: 'start' | 'cancel' | 'call' | 'ending';
  microphone: 'hidden' | 'off' | 'muted' | 'live';
  showTimer: boolean;
  showHeadphonesTip: boolean;
  showEnableAudio: boolean;
};

export function describeStage(
  view: CallView,
  name: string,
  toolsEnabled: boolean,
  maxCallSeconds?: number,
): StageView {
  const agent = name.trim() || 'your assistant';
  const duration =
    view.phase !== 'idle' || maxCallSeconds === undefined
      ? ''
      : ` Calls last up to ${new Intl.NumberFormat('en', {
          style: 'unit',
          unit: 'minute',
          unitDisplay: 'long',
          maximumFractionDigits: 1,
        }).format(maxCallSeconds / 60)}.`;
  switch (view.phase) {
    case 'idle':
      return {
        heading: `Talk to ${agent}`,
        subheading:
          (toolsEnabled
            ? 'Ask about Cloudflare, check the time or weather, or just say hello.'
            : 'Ask a question, think something through, or just say hello.') + duration,
        orb: 'quiet',
        controls: 'start',
        microphone: 'hidden',
        showTimer: false,
        showHeadphonesTip: true,
        showEnableAudio: false,
      };
    case 'connecting':
      return {
        heading: 'Getting connected',
        subheading: 'Setting up your microphone and assistant.',
        activity: 'connecting',
        orb: 'loading',
        controls: 'cancel',
        microphone: describeMicrophone(view),
        showTimer: false,
        showHeadphonesTip: false,
        showEnableAudio: false,
      };
    case 'connected':
      return describeConversation(view, agent);
    case 'ending':
      return {
        heading: 'Ending your call',
        subheading: 'Your microphone is off.',
        activity: 'ending',
        orb: 'loading',
        controls: 'ending',
        microphone: describeMicrophone(view),
        showTimer: true,
        showHeadphonesTip: false,
        showEnableAudio: false,
      };
    case 'ended':
      return {
        heading: 'Call ended',
        subheading: "Start a new call whenever you're ready.",
        orb: 'quiet',
        controls: 'start',
        microphone: 'hidden',
        // A call that never connected has no duration worth showing.
        showTimer: view.connectedAt !== undefined,
        showHeadphonesTip: false,
        showEnableAudio: false,
      };
  }
}

function describeConversation(view: CallView, agent: string): StageView {
  const shared = {
    subheading: view.muted
      ? "Unmute whenever you're ready."
      : 'Speak naturally. You can interrupt any time.',
    controls: 'call',
    microphone: describeMicrophone(view),
    showTimer: true,
    showHeadphonesTip: false,
    showEnableAudio: view.playbackBlocked,
  } as const;
  if (view.muted && view.activity === 'listening') {
    return { ...shared, heading: 'Your microphone is muted', activity: 'muted', orb: 'live' };
  }
  switch (view.activity) {
    case 'listening':
      return { ...shared, heading: 'Listening to you', activity: 'listening', orb: 'live' };
    case 'thinking':
      return { ...shared, heading: `${agent} is thinking`, activity: 'thinking', orb: 'thinking' };
    case 'speaking':
      return { ...shared, heading: `${agent} is speaking`, activity: 'speaking', orb: 'speaking' };
    case 'tool':
      return { ...shared, heading: 'Looking that up', activity: 'looking it up', orb: 'live' };
  }
}

function describeMicrophone(view: CallView): StageView['microphone'] {
  if (!view.microphoneActive) return 'off';
  return view.muted ? 'muted' : 'live';
}

/** The single status line under the call. Errors replace the routine status. */
export type StatusView = {
  tone: 'neutral' | 'ok' | 'warning' | 'error';
  /** True while something is in flight, so the status marker may pulse. */
  busy: boolean;
  message: string;
};

export function describeStatus(view: CallView, session: SessionState): StatusView {
  const busy = view.phase === 'connecting' || view.phase === 'ending';
  // Session problems are the response to the most recent action, so they lead.
  // Showing them here, rather than beside the control, keeps the layout still.
  switch (session.kind) {
    case 'unavailable':
      return { tone: 'error', busy, message: session.message };
    case 'locked':
      return session.error
        ? { tone: 'error', busy, message: session.error }
        : { tone: 'neutral', busy, message: 'Sign in to start a call.' };
    case 'signing-in':
      return { tone: 'neutral', busy: true, message: 'Signing in...' };
    case 'loading':
    case 'checking':
      return { tone: 'neutral', busy: true, message: view.status };
    case 'ready':
      break;
  }
  const cleanup = view.cleanupPending ? ' Server cleanup will retry automatically.' : '';
  if (view.error) return { tone: 'error', busy, message: `${view.error}${cleanup}` };
  if (view.cleanupPending) return { tone: 'warning', busy, message: `${view.status}${cleanup}` };
  return { tone: view.phase === 'connected' ? 'ok' : 'neutral', busy, message: view.status };
}

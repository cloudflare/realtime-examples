import { useRef, useState } from 'react';
import { initialState } from '@/client/radio/session-state.ts';
import type { SessionState, SignalBuffer } from '@/client/radio/session-state.ts';
import type { RadioActions } from '@/client/radio/use-radio.ts';

const track = { title: 'Morning Radio', artist: 'Example Artist', durationMs: 240000 };
const room = {
  online: true,
  viewers: 1,
  controller: null,
  generation: 'fixture',
  track,
  nowPlaying: { revision: 1, trackIndex: 0, trackCount: 4, track },
};

declare global {
  interface Window {
    exhibitFixture: { patch: (patch: Partial<SessionState>) => void; calls: () => string[] };
  }
}

// Replaces only the React/session boundary in browser tests; the real App renders.
export function useFixtureRadio() {
  const [state, setState] = useState<SessionState>(() => ({
    ...initialState(),
    auth: 'ready',
    room,
    nowPlaying: room.nowPlaying,
    message: 'Board online. Start listening.',
  }));
  const calls = useRef<string[]>([]);
  const signal = useRef<SignalBuffer>({ at: 0, count: 0 });
  const audioRef = useRef<HTMLAudioElement>(null);
  const patch = (next: Partial<SessionState>) => setState((previous) => ({ ...previous, ...next }));
  window.exhibitFixture = { patch, calls: () => calls.current };
  const actions: RadioActions = {
    login: async () => {},
    connect: async () => {
      calls.current.push('connect');
      patch({ phase: 'connecting', message: 'Opening data channels…' });
    },
    disconnect: async () => {
      calls.current.push('disconnect');
      patch({
        phase: 'idle',
        viewerId: undefined,
        telemetry: undefined,
        paused: undefined,
        led: undefined,
        busy: false,
        audioBlocked: false,
        room,
        ack: { state: 'idle', text: '', at: 0 },
        message: 'Disconnected. Shared playback is unchanged.',
      });
    },
    toggleAudio: async () => {
      calls.current.push('audio');
      patch({ audioBlocked: false, muted: !state.muted });
    },
    setVolume: (volume) => patch({ volume }),
    toggleControl: async () => {
      calls.current.push('control');
      patch({ busy: true });
    },
    send: (command) => {
      calls.current.push(JSON.stringify(command));
      patch({ ack: { state: 'pending', text: 'Waiting for board confirmation…', at: 10000 } });
    },
  };
  return { state, signal: signal.current, actions, audioRef };
}

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Command } from '@/shared/contracts/robot.ts';
import { RadioSession } from './session.ts';

/** The React boundary owns one session and exposes bound actions to the exhibit. */
export function useRadio() {
  const [{ session, actions }] = useState(() => {
    const session = new RadioSession();
    return {
      session,
      actions: {
        login: (password: string) => session.login(password),
        connect: () => session.connect(),
        disconnect: () => session.disconnect(),
        toggleAudio: () => session.toggleAudio(),
        setVolume: (volume: number) => session.setVolume(volume),
        toggleControl: () => session.toggleControl(),
        send: (command: Command) => session.send(command),
      },
    };
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    if (audioRef.current) return session.start(audioRef.current);
  }, [session]);
  return { state, signal: session.signal, actions, audioRef };
}

export type RadioActions = ReturnType<typeof useRadio>['actions'];

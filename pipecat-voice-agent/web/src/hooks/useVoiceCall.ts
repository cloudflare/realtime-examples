import { useEffect, useState, useSyncExternalStore } from 'react';
import { VoiceCall } from '../voice/call';

export function useVoiceCall(authenticated: boolean) {
  const [call] = useState(() => new VoiceCall());
  const view = useSyncExternalStore(call.subscribe, call.snapshot);
  useEffect(() => {
    window.addEventListener('pagehide', call.unload);
    return () => {
      window.removeEventListener('pagehide', call.unload);
      void call.stop();
    };
  }, [call]);
  useEffect(() => {
    if (authenticated) void call.recover();
  }, [call, authenticated]);
  return { call, view };
}

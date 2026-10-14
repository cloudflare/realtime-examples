import { useEffect, useState, useSyncExternalStore } from 'react';
import { VoiceCall } from '../voice/call';

// A warmed Durable Object hibernates after about ten seconds idle. Rewarming
// keeps the Worker loaded on its host while the page is open.
const warmIntervalMs = 30_000;

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
  useEffect(() => {
    if (!authenticated) return;
    const warm = () => {
      if (document.visibilityState === 'visible') call.warm();
    };
    warm();
    const timer = setInterval(warm, warmIntervalMs);
    document.addEventListener('visibilitychange', warm);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', warm);
    };
  }, [call, authenticated]);
  return { call, view };
}

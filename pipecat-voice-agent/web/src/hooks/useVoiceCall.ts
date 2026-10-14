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
  // Warming starts when the session is ready and again as each call ends,
  // so the next call is warm even if the person clicks without hovering.
  const resting = view.phase === 'idle' || view.phase === 'ended';
  useEffect(() => {
    if (!authenticated || !resting) return;
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
  }, [call, authenticated, resting]);
  return { call, view };
}

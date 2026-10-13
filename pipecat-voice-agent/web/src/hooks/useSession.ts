import { useCallback, useEffect, useRef, useState } from 'react';
import { browserAuth } from '../auth';
import { ApiError, describeError } from '../lib/api';
import type { AgentSettings, SessionInfo } from '../lib/contracts';
import type { SessionState } from '../lib/session';

function settled(result: SessionInfo): SessionState {
  if (!result.configured) {
    return {
      kind: 'unavailable',
      message: 'This voice agent needs its server credentials before it can take calls.',
    };
  }
  return { kind: result.authenticated ? 'ready' : 'locked' };
}

function failed(error: unknown): SessionState {
  if (error instanceof ApiError && [401, 429].includes(error.status)) {
    return { kind: 'locked', error: describeError(error) };
  }
  return { kind: 'unavailable', message: describeError(error) };
}

/**
 * Browser session state machine. It knows nothing about how a session is
 * established; that belongs to the provider in `web/src/auth/`.
 */
export function useSession(onDefaults: (agent: AgentSettings) => void) {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [maxCallSeconds, setMaxCallSeconds] = useState<number>();
  const pending = useRef<AbortController | undefined>(undefined);

  // One provider operation at a time; a newer one cancels the older.
  const run = useCallback(
    async (initial: SessionState, task: (signal: AbortSignal) => Promise<boolean>) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setState(initial);
      try {
        return await task(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) setState(failed(error));
        return false;
      }
    },
    [],
  );

  // Read the session after authentication; local UI state is not proof of access.
  const settle = useCallback(
    async (signal: AbortSignal, defaults = false) => {
      const result = await browserAuth.session(signal);
      signal.throwIfAborted();
      setMaxCallSeconds(result.max_call_seconds);
      if (defaults && result.agent) onDefaults(result.agent);
      setState(settled(result));
      return result.configured && result.authenticated;
    },
    [onDefaults],
  );

  const check = useCallback(
    (defaults = false) =>
      run({ kind: defaults ? 'loading' : 'checking' }, (signal) => settle(signal, defaults)),
    [run, settle],
  );

  useEffect(() => {
    void check(true);
    return () => pending.current?.abort();
  }, [check]);

  return {
    state,
    maxCallSeconds,
    refresh: () => check(),
    // Recheck before starting: an expired session must prompt for sign-in
    // before requesting microphone access or allocating a call.
    authorize: () => check(),
    signIn: (credential: string) =>
      run({ kind: 'signing-in' }, async (signal) => {
        await browserAuth.signIn(credential, signal);
        return settle(signal);
      }),
    signOut: () =>
      run({ kind: 'checking' }, async (signal) => {
        await browserAuth.signOut(signal);
        signal.throwIfAborted();
        setState({ kind: 'locked' });
        return false;
      }),
  };
}

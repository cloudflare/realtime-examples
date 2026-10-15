import { LogOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Button } from './components/Button';
import { VoiceRoom } from './components/VoiceRoom';
import { useSession } from './hooks/useSession';
import { useVoiceCall } from './hooks/useVoiceCall';
import { defaultAgent, type AgentSettings } from './lib/contracts';
import { isCallBusy } from './voice/model';

export default function App() {
  const [settings, setSettings] = useState(defaultAgent);
  const session = useSession(setSettings);
  const { call, view } = useVoiceCall(session.state.kind === 'ready');
  const beginning = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = async (agent: AgentSettings) => {
    if (beginning.current || isCallBusy(call.snapshot())) return;
    beginning.current = true;
    try {
      // The session is re-read first; a stale one returns to the sign-in control.
      if (!(await session.authorize()) || !mounted.current) return;
      await call.recover();
      if (!mounted.current) return;
      await call.start(agent);
    } finally {
      beginning.current = false;
    }
  };

  return (
    <AppShell
      label={settings.name.trim() || 'Voice agent'}
      actions={
        session.state.kind === 'ready' && (
          <Button
            tone="quiet"
            size="sm"
            disabled={isCallBusy(view)}
            onClick={() => {
              void session.signOut();
            }}
            aria-label="Sign out"
          >
            <LogOut className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        )
      }
    >
      <VoiceRoom
        settings={settings}
        onSettingsChange={setSettings}
        view={view}
        session={session.state}
        maxCallSeconds={session.maxCallSeconds}
        onStart={(agent) => {
          void start(agent);
        }}
        onWarm={() => call.warm()}
        onSignIn={(credential) => {
          void session.signIn(credential);
        }}
        onRetry={() => {
          void session.refresh();
        }}
        onStop={() => {
          void call.stop();
        }}
        onMute={() => call.toggleMute()}
        onResume={() => {
          void call.resumeAudio();
        }}
      />
    </AppShell>
  );
}

import { ArrowRight, LoaderCircle } from 'lucide-react';
import { browserAuth } from '../auth';
import type { SessionState } from '../lib/session';
import { Button } from './Button';

const { SignIn } = browserAuth;

/** The start control: sign-in while locked, otherwise the call-to-action. */
export function StartCall({
  session,
  ended,
  disabled,
  onStart,
  onSignIn,
  onRetry,
}: {
  session: SessionState;
  ended: boolean;
  /** True when the call cannot start yet, for example without an assistant name. */
  disabled: boolean;
  onStart: () => void;
  onSignIn: (credential: string) => void;
  onRetry: () => void;
}) {
  switch (session.kind) {
    case 'unavailable':
      // The reason is in the status bar; only the recovery action lives here.
      return <Button onClick={onRetry}>Try again</Button>;
    case 'locked':
      return <SignIn busy={false} error={session.error} onSubmit={onSignIn} />;
    case 'signing-in':
      return <SignIn busy onSubmit={onSignIn} />;
    case 'loading':
    case 'checking':
      return <StartButton busy disabled ended={ended} onClick={onStart} />;
    case 'ready':
      return <StartButton disabled={disabled} ended={ended} onClick={onStart} />;
  }
}

function StartButton({
  busy = false,
  disabled,
  ended,
  onClick,
}: {
  busy?: boolean;
  disabled: boolean;
  ended: boolean;
  onClick: () => void;
}) {
  return (
    <Button tone="primary" className="w-full sm:w-auto" disabled={disabled} onClick={onClick}>
      {busy && <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />}
      {busy ? 'Checking...' : ended ? 'Start a new call' : 'Start conversation'}
      {!busy && <ArrowRight className="size-4" aria-hidden="true" />}
    </Button>
  );
}

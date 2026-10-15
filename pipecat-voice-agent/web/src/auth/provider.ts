import type { ComponentType } from 'react';
import type { SessionInfo } from '../lib/contracts';

/**
 * Browser-side counterpart of the server's `BrowserAuth` interface
 * (`src/server/auth.py`). The session hook and the room components use only
 * this contract; everything specific to a sign-in method lives in a provider
 * module next to this file, selected in `index.ts`.
 *
 * The default provider is the shared access code. To move to Cloudflare
 * Access, which authenticates at the edge before the page loads:
 *
 * - `session` still reads `/api/session`. If Access redirects an expired
 *   session to its login page, the response is not JSON; detect that and
 *   reauthenticate by navigation instead of surfacing an error.
 * - `signIn` has nothing to exchange. `SignIn` becomes a "Sign in again"
 *   button, and `signIn` navigates to the login URL.
 * - `signOut` navigates to `/cdn-cgi/access/logout`.
 * - Keep the SFU adapter routes (`/media/<call-id>/...`) reachable by the SFU
 *   through an Access bypass policy; their per-call token checks stay in
 *   `src/transport/auth.py`. See `docs/authentication.md` for Access setup.
 */
export type BrowserAuth = {
  /** Read the current session, including whether the server is configured. */
  session(signal: AbortSignal): Promise<SessionInfo>;
  /**
   * Establish a session from whatever `SignIn` collected. Edge-authenticated
   * providers ignore the credential and navigate instead.
   */
  signIn(credential: string, signal: AbortSignal): Promise<void>;
  /** End the session. Edge-authenticated providers may navigate away. */
  signOut(signal: AbortSignal): Promise<void>;
  /** Rendered in place of the start control while the session is locked. */
  SignIn: ComponentType<SignInProps>;
};

export type SignInProps = {
  /** True while a submitted credential is being checked. */
  busy: boolean;
  /**
   * Why the previous attempt failed, in words meant for the user. The app
   * already shows it in the status bar; use it for field state such as
   * `aria-invalid` rather than adding a line that moves the layout.
   */
  error?: string;
  onSubmit: (credential: string) => void;
};

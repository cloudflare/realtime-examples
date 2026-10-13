/**
 * Browser session state as the UI sees it. Provider-specific details (access
 * codes, Cloudflare Access redirects) stay inside `web/src/auth/`.
 */
export type SessionState =
  | { kind: 'loading' }
  | { kind: 'locked'; error?: string }
  | { kind: 'signing-in' }
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'unavailable'; message: string };

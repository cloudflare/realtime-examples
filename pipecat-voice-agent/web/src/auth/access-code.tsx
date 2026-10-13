import clsx from 'clsx';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Button } from '../components/Button';
import { fieldClass } from '../components/Field';
import { request } from '../lib/api';
import { sessionSchema } from '../lib/contracts';
import type { BrowserAuth, SignInProps } from './provider';

/**
 * Shared access code, paired with `AccessCodeAuth` in `src/server/auth_code.py`.
 * The server sets an HttpOnly session cookie; nothing is kept in browser JS.
 */
export const accessCodeAuth: BrowserAuth = {
  session: (signal) => request('session', sessionSchema, { signal, timeout: 15_000 }),
  async signIn(credential, signal) {
    await request('login', z.object({ authenticated: z.literal(true) }), {
      body: { password: credential },
      signal,
      timeout: 15_000,
    });
  },
  async signOut(signal) {
    await request('logout', z.object({ authenticated: z.literal(false) }), {
      body: {},
      signal,
      timeout: 15_000,
    });
  },
  SignIn: AccessCodeSignIn,
};

function AccessCodeSignIn({ busy, error, onSubmit }: SignInProps) {
  const [code, setCode] = useState('');
  return (
    // One row on wide screens so the control area keeps the same height as the
    // start button it replaces. The app shows `error` in its status bar; here it
    // only marks the field, so a failed attempt does not move the layout.
    <form
      className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && code) onSubmit(code);
      }}
    >
      <label htmlFor="access-code" className="text-sm font-medium sm:mr-1">
        Access code
      </label>
      <input
        id="access-code"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={256}
        value={code}
        disabled={busy}
        onChange={(event) => setCode(event.target.value)}
        aria-describedby={error ? 'access-error' : undefined}
        aria-invalid={Boolean(error)}
        className={clsx(fieldClass, 'sm:w-64')}
      />
      <Button tone="primary" type="submit" className="shrink-0" disabled={busy || !code}>
        {busy ? (
          <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        ) : null}
        {busy ? 'Checking...' : 'Continue'}
        {!busy && <ArrowRight className="size-4" aria-hidden="true" />}
      </Button>
      {error && (
        <span id="access-error" className="sr-only">
          {error}
        </span>
      )}
    </form>
  );
}

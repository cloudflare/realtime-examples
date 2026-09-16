import { afterEach, beforeEach, expect, vi } from 'vitest';
import { reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { bindings } from '@tests/helpers/sfu-fixture.ts';

beforeEach(() => {
  for (const [key, value] of Object.entries(bindings))
    expect(env[key as keyof typeof bindings]).toBe(value);
  vi.stubGlobal('fetch', () => {
    throw new Error('This test has no outbound SFU fixture');
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

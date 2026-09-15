import { vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { evictDurableObject } from 'cloudflare:test';
import { createRadioClient, createSfu } from '@tests/helpers/sfu-fixture.ts';
import type { Responder } from '@tests/helpers/sfu-fixture.ts';

export {
  device,
  offer,
  answer,
  track,
  nowPlaying,
  startedSchema,
} from '@tests/helpers/sfu-fixture.ts';
export function createHarness(respond?: Responder) {
  const sfu = createSfu(respond);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    sfu.fetch(new Request(input, init)),
  );
  const api = createRadioClient((request) => exports.default.fetch(request));
  const room = env.ROBOTS.getByName(env.ROBOT_NAME);
  return {
    ...api,
    calls: sfu.calls,
    allocations: sfu.allocations,
    room,
    evict: () => evictDurableObject(room),
  };
}

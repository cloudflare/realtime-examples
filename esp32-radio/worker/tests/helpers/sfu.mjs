import fs from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { bindings, createRadioClient, createSfu } from './sfu-fixture.ts';

export { offer, answer, track, nowPlaying, device } from './sfu-fixture.ts';

// The production bundle runs with its production compatibility flags, without
// the Node compatibility added by the source-test runner.
export async function createHarness(t, respond) {
  const sfu = createSfu(respond);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'radio-test',
          modules: [
            {
              type: 'ESModule',
              path: 'worker.js',
              contents: await fs.readFile(
                new URL('../../dist/esp32_radio/index.js', import.meta.url),
                'utf8',
              ),
            },
          ],
          compatibilityDate: '2026-09-12',
          bindings,
          durableObjects: { ROBOTS: { className: 'RobotRoom', useSQLite: true } },
          outboundService: (request) => sfu.fetch(request),
        },
      ],
    }),
  );
  t.after(() => mf.dispose());
  return {
    ...createRadioClient(async (request) =>
      mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.arrayBuffer() : undefined,
      }),
    ),
    calls: sfu.calls,
    allocations: sfu.allocations,
    evict: () => mf.unsafeEvictDurableObject('radio-test', 'RobotRoom', { name: 'test-board' }),
  };
}

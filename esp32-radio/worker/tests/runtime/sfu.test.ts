import { expect, test, vi } from 'vitest';
import { SfuClient } from '@/server/sfu.ts';
import { bindings } from '@tests/helpers/sfu-fixture.ts';

test('cleanup accepts item-level absence for tracks and channels', async () => {
  const sfu = new SfuClient(bindings);
  vi.stubGlobal('fetch', async () =>
    Response.json({ tracks: [{ mid: '0', errorCode: 'close_track_error' }] }),
  );
  await sfu.closeTracks('current', ['0']);
  vi.stubGlobal('fetch', async () =>
    Response.json({ dataChannels: [{ id: 2, errorCode: 'close_track_error' }] }),
  );
  await sfu.call('/sessions/current/datachannels/close', { dataChannels: [{ id: 2 }] }, 'PUT');
});

test('cleanup keeps real failures pending beside already closed items', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sfu = new SfuClient(bindings);
  for (const resource of ['tracks', 'dataChannels']) {
    const field = resource === 'tracks' ? 'mid' : 'id';
    const identifiers = resource === 'tracks' ? ['0', '1'] : [2, 4];
    vi.stubGlobal('fetch', async () =>
      Response.json({
        [resource]: [
          { [field]: identifiers[0], errorCode: 'close_track_error' },
          { [field]: identifiers[1], errorCode: 'backend_error' },
        ],
      }),
    );
    await expect(
      sfu.call(
        `/sessions/current/${resource.toLowerCase()}/close`,
        { [resource]: identifiers.map((identifier) => ({ [field]: identifier })) },
        'PUT',
      ),
    ).rejects.toThrow(/could not configure/);
  }
});

test('a request-level close error cannot establish completion for a batch', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sfu = new SfuClient(bindings);
  vi.stubGlobal('fetch', async () => Response.json({ errorCode: 'close_track_error' }));
  await expect(sfu.closeTracks('current', ['0', '1'])).rejects.toThrow(/SFU operation failed/);
  await expect(
    sfu.call(
      '/sessions/current/datachannels/close',
      { dataChannels: [{ id: 2 }, { id: 4 }] },
      'PUT',
    ),
  ).rejects.toThrow(/SFU operation failed/);
});

test('cleanup does not hide failed HTTP requests or errors from other operations', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sfu = new SfuClient(bindings);
  for (const [operation, status, errorCode] of [
    ['tracks/new', 200, 'close_track_error'],
    ['datachannels/update', 200, 'close_track_error'],
    ['tracks/close', 404, 'app_error'],
    ['tracks/close', 410, 'session_error'],
    ['datachannels/close', 404, 'app_error'],
    ['datachannels/close', 410, 'session_error'],
    ['datachannels/update', 404, 'app_error'],
    ['datachannels/update', 410, 'session_error'],
    ['tracks/close', 503, 'close_track_error'],
    ['tracks/close', 200, 'backend_error'],
    ['tracks/close', 200, 'session_error'],
    ['tracks/close', 425, 'session_error'],
  ] as const) {
    vi.stubGlobal('fetch', async () => Response.json({ errorCode }, { status }));
    await expect(sfu.call(`/sessions/current/${operation}`, {}, 'PUT')).rejects.toThrow(
      /SFU operation failed/,
    );
  }
});

test('diagnostics do not print response content supplied as an error code', async () => {
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', async () =>
    Response.json({
      errorCode: 'private response detail',
      tracks: [{ mid: '0', errorCode: 'private track detail' }],
      dataChannels: [{ id: 2, errorCode: 'private channel detail' }],
    }),
  );
  await expect(new SfuClient(bindings).closeTracks('current', ['0'])).rejects.toThrow(
    /SFU operation failed/,
  );
  expect(warnings).toHaveBeenCalledWith(
    JSON.stringify({
      phase: 'sfu',
      operation: 'tracks/close',
      status: 200,
      errorCode: 'unrecognized_error_code',
      trackErrorCodes: ['unrecognized_error_code'],
      dataChannelErrorCodes: ['unrecognized_error_code'],
    }),
  );
  expect(JSON.stringify(warnings.mock.calls)).not.toContain('private');
});

test('an item-level absence must identify a requested resource', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sfu = new SfuClient(bindings);
  for (const track of [{ mid: 'other' }, {}]) {
    vi.stubGlobal('fetch', async () =>
      Response.json({ tracks: [{ ...track, errorCode: 'close_track_error' }] }),
    );
    await expect(sfu.closeTracks('current', ['0'])).rejects.toThrow(/could not configure/);
  }
  for (const channel of [{ id: 8 }, {}]) {
    vi.stubGlobal('fetch', async () =>
      Response.json({ dataChannels: [{ ...channel, errorCode: 'close_track_error' }] }),
    );
    await expect(
      sfu.call('/sessions/current/datachannels/close', { dataChannels: [{ id: 2 }] }, 'PUT'),
    ).rejects.toThrow(/could not configure/);
  }
});

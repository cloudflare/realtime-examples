import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../../web/src/lib/api';
import { defaultAgent } from '../../web/src/lib/contracts';
import { VoiceCall } from '../../web/src/voice/call';

const audio = vi.hoisted(() => ({
  construct: vi.fn(),
  open: vi.fn<() => Promise<void>>(),
  stopCapture: vi.fn(),
  close: vi.fn<() => Promise<void>>(),
}));
vi.mock('../../web/src/voice/audio', () => ({
  CallAudio: class {
    constructor() {
      audio.construct();
    }
    open = audio.open;
    stopCapture = audio.stopCapture;
    close = audio.close;
  },
}));
vi.mock('../../web/src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/lib/api')>()),
  request: vi.fn(),
}));

const pendingKey = 'voice-pending-call';
let storage: Map<string, string>;

beforeEach(() => {
  vi.resetAllMocks();
  storage = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  audio.close.mockResolvedValue();
});
afterEach(() => vi.unstubAllGlobals());

it('leaves connecting state when browser audio initialization fails', async () => {
  audio.construct.mockImplementationOnce(() => {
    throw new DOMException('Audio unavailable', 'NotSupportedError');
  });
  const call = new VoiceCall();
  await call.start(defaultAgent);
  expect(call.snapshot()).toMatchObject({
    phase: 'ended',
    microphoneActive: false,
    error: expect.stringContaining('Audio could not be initialized'),
  });
  expect(request).not.toHaveBeenCalled();
});

describe('warming', () => {
  it('creates the call on the object it warmed, then warms a new one', async () => {
    vi.mocked(request).mockResolvedValue({ warm: true });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const call = new VoiceCall();
      call.warm();
      call.warm();
      expect(request).toHaveBeenCalledTimes(1);
      const warmed = vi.mocked(request).mock.calls[0][0];
      expect(warmed).toMatch(/^calls\/[a-f0-9]{32}\/warm$/);

      audio.open.mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
      await call.start(defaultAgent);
      expect(`calls/${call.snapshot().callId}/warm`).toBe(warmed);
      expect(request).toHaveBeenCalledTimes(1);

      now.mockReturnValue(10_000);
      call.warm();
      expect(request).toHaveBeenCalledTimes(2);
      expect(vi.mocked(request).mock.calls[1][0]).not.toBe(warmed);
    } finally {
      now.mockRestore();
    }
  });
});

describe('pending call recovery', () => {
  it('shares an in-flight cleanup and allows another attempt after failure', async () => {
    storage.set(pendingKey, 'a'.repeat(32));
    let reject!: (error: Error) => void;
    vi.mocked(request).mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const call = new VoiceCall();
    const first = call.recover();
    expect(call.recover()).toBe(first);
    reject(new TypeError('Offline'));
    await first;
    expect(call.snapshot().cleanupPending).toBe(true);
    expect(storage.has(pendingKey)).toBe(true);

    vi.mocked(request).mockResolvedValueOnce({ cleanup_complete: true });
    await call.recover();
    expect(request).toHaveBeenCalledTimes(2);
    expect(storage.has(pendingKey)).toBe(false);
    expect(call.snapshot().cleanupPending).toBe(false);
  });

  it('can recover a later call after a previous cleanup completed', async () => {
    vi.mocked(request).mockResolvedValue({ cleanup_complete: true });
    const call = new VoiceCall();
    for (const id of ['a'.repeat(32), 'b'.repeat(32)]) {
      storage.set(pendingKey, id);
      await call.recover();
      expect(request).toHaveBeenLastCalledWith(
        `calls/${id}/finish`,
        expect.anything(),
        expect.objectContaining({ body: {} }),
      );
      expect(storage.has(pendingKey)).toBe(false);
    }
  });

  it('does not recover a call while the user is already starting one', async () => {
    let release!: () => void;
    audio.open.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const call = new VoiceCall();
    const starting = call.start(defaultAgent);
    storage.set(pendingKey, 'a'.repeat(32));
    try {
      await call.recover();
      expect(request).not.toHaveBeenCalled();
      expect(call.snapshot().phase).toBe('connecting');
    } finally {
      await call.stop();
      release();
      await starting;
    }
  });
});

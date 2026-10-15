import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from '../../web/src/lib/api';
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
    outgoing = { stream: { getAudioTracks: () => [{}] } };
    open = audio.open;
    stopCapture = audio.stopCapture;
    close = audio.close;
    muteMicrophone = vi.fn();
  },
}));
vi.mock('../../web/src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../web/src/lib/api')>()),
  request: vi.fn(),
}));

const pendingKey = 'voice-pending-call';
let storage: Map<string, string>;
// The order in which setup touches the peer connection and the microphone.
let steps: string[];
let peers: Peer[];

/** Gathers one host candidate as soon as the offer is applied. */
class Peer extends EventTarget {
  connectionState = 'new';
  iceGatheringState = 'gathering';
  localDescription?: RTCSessionDescriptionInit & { sdp: string };
  constructor() {
    super();
    steps.push('peer');
    peers.push(this);
  }
  addTransceiver() {
    return { mid: '0', setCodecPreferences: () => {} };
  }
  async createOffer() {
    steps.push('offer');
    return { type: 'offer' as const, sdp: 'v=0\r\n' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = {
      ...description,
      sdp: `${description.sdp}a=candidate:1 1 udp 1 192.0.2.1 10000 typ host\r\n`,
    };
  }
  async setRemoteDescription() {}
  close() {
    this.connectionState = 'closed';
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  storage = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  audio.close.mockResolvedValue();
  steps = [];
  peers = [];
  audio.open.mockImplementation(async () => {
    steps.push('microphone');
  });
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('RTCRtpSender', { getCapabilities: () => null });
  vi.spyOn(console, 'info').mockImplementation(() => {});
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

describe('setup order', () => {
  it('prepares the offer during the microphone prompt and creates the warmed call', async () => {
    vi.mocked(request).mockImplementation(async (path) => {
      if (path.endsWith('/publish')) throw new ApiError('sfu_unavailable', 502);
      return path.endsWith('/warm') ? { warm: true } : { cleanup_complete: true };
    });
    const call = new VoiceCall();
    call.warm();
    const warmed = vi.mocked(request).mock.calls[0][0].replace('/warm', '');
    await call.start(defaultAgent);
    expect(steps).toEqual(['peer', 'offer', 'microphone']);
    const calls = vi.mocked(request).mock.calls.slice(1);
    expect(calls.map(([path]) => path)).toEqual(
      ['create', 'publish', 'finish'].map((action) => `${warmed}/${action}`),
    );
    expect(calls[1][2]?.body).toMatchObject({
      mid: '0',
      sessionDescription: { type: 'offer', sdp: expect.stringContaining('a=candidate:') },
    });
    expect(peers[0].connectionState).toBe('closed');
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

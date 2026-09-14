import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RadioApi } from './api.ts';
import type { Joined, RoomStatus } from '@/shared/contracts/signaling.ts';
import { RadioSession } from './session.ts';
import { playbackView } from './playback.ts';

const joined: Joined = {
  id: 'viewer',
  viewerToken: 'capability',
  generation: 'generation',
  sessionDescription: { type: 'offer', sdp: 'v=0' },
};
const status: RoomStatus = {
  online: true,
  viewers: 1,
  controller: null,
  generation: joined.generation,
};

function stubApi(overrides: Partial<RadioApi> = {}): RadioApi {
  return {
    getStatus: async () => status,
    login: async () => ({ ok: true }),
    joinViewer: async () => joined,
    answerViewer: async () => ({
      channels: [
        { id: 1, dataChannelName: 'robot', ordered: true },
        { id: 3, dataChannelName: 'spectrum', ordered: false, maxRetransmits: 0 },
      ],
    }),
    subscribeAudio: async () => ({ sessionDescription: { type: 'offer', sdp: 'v=0' } }),
    renegotiateViewer: async () => ({ ok: true }),
    heartbeatViewer: async () => ({ controller: null }),
    claimControl: async () => ({ controller: joined.id }),
    releaseControl: async () => ({ controller: null }),
    leaveViewer: async () => ({ ok: true }),
    ...overrides,
  };
}

test('a successful status retry clears the failed status operation', async () => {
  let fail = true;
  const session = new RadioSession(
    stubApi({
      getStatus: async () => {
        if (fail) throw new Error('offline');
        return status;
      },
    }),
  );
  await session.refreshStatus();
  assert.match(session.getSnapshot().issues.status!, /unavailable/);
  fail = false;
  await session.refreshStatus();
  assert.equal(session.getSnapshot().room.online, true);
  assert.equal(session.getSnapshot().issues.status, undefined);
});

test('track information follows the current publisher without fetching static assets', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected static metadata request');
  });
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'window'));
  let current: typeof status & {
    track?: { title: string; artist: string; durationMs: number } | null;
  } = {
    ...status,
    track: { title: 'First track', artist: 'Artist', durationMs: 2000 },
  };
  const api = stubApi({ getStatus: async () => current });
  const session = new RadioSession(api);
  const stop = session.start({
    pause() {},
    volume: 0,
    srcObject: null,
  } as unknown as HTMLAudioElement);
  try {
    await Promise.resolve();
    assert.equal(playbackView(session.getSnapshot()).track?.title, 'First track');
    current = {
      ...status,
      generation: 'replacement',
      track: { title: 'Second track', artist: '', durationMs: 4000 },
    };
    await session.refreshStatus();
    assert.equal(playbackView(session.getSnapshot()).track?.title, 'Second track');
    current = { ...status, track: null };
    await session.refreshStatus();
    assert.equal(playbackView(session.getSnapshot()).track, undefined);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    stop();
  }
});

class Channel extends EventTarget {
  label: string;
  readyState = 'open';
  bufferedAmount = 0;
  onmessage?: (event: { data: unknown }) => void;
  sent: string[] = [];
  constructor(label: string) {
    super();
    this.label = label;
  }
  send(value: string) {
    this.sent.push(value);
  }
}
class Peer extends EventTarget {
  static instances: Peer[] = [];
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription?: RTCSessionDescriptionInit;
  channels: Channel[] = [];
  constructor() {
    super();
    Peer.instances.push(this);
  }
  async createAnswer() {
    return { type: 'answer' as const, sdp: 'v=0' };
  }
  async setLocalDescription(answer: RTCSessionDescriptionInit) {
    this.localDescription = answer;
  }
  async setRemoteDescription() {}
  close() {
    this.connectionState = 'closed';
  }
  createDataChannel(name: string) {
    const channel = new Channel(name);
    this.channels.push(channel);
    return channel;
  }
}

test('cancellation cleans up a viewer allocated after the user disconnected', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ title: 'Test', artist: 'Test', durationMs: 1000 }),
  );
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'window'));
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'));
  const { promise, resolve } = Promise.withResolvers<Joined>();
  const left: string[] = [];
  const api = stubApi({
    joinViewer: () => promise,
    leaveViewer: async (member) => {
      left.push(member.id);
      return { ok: true };
    },
  });
  const session = new RadioSession(api);
  const stop = session.start({
    pause() {},
    volume: 0,
    srcObject: null,
  } as unknown as HTMLAudioElement);
  try {
    const connecting = session.connect();
    await session.disconnect();
    resolve(joined);
    await connecting;
    assert.equal(session.getSnapshot().phase, 'idle');
    assert.equal(session.getSnapshot().viewerId, undefined);
    assert.deepEqual(left, [joined.id]);
    assert.ok(Peer.instances.every((peer) => peer.connectionState === 'closed'));
  } finally {
    stop();
  }
});

test('live song metadata wins over delayed HTTP state and rejects old FFT frames', async (t) => {
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'window'));
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'));
  const first = { title: 'First', artist: '', durationMs: 2000 };
  const second = { title: 'Second', artist: 'Artist', durationMs: 3000 };
  const initial = { revision: 0, trackIndex: 0, trackCount: 2, track: first };
  let remote: RoomStatus = { ...status, track: first, nowPlaying: initial };
  const session = new RadioSession(stubApi({ getStatus: async () => remote }));
  const stop = session.start({
    pause() {},
    volume: 0,
    srcObject: null,
  } as unknown as HTMLAudioElement);
  try {
    await session.connect();
    const peer = Peer.instances.at(-1)!;
    const [robot, spectrum] = peer.channels;
    robot.onmessage!({
      data: JSON.stringify({
        event: 'nowPlaying',
        nowPlaying: { ...initial, revision: 1, trackIndex: 1, track: second },
      }),
    });
    assert.equal(playbackView(session.getSnapshot()).track?.title, 'Second');
    await session.refreshStatus();
    assert.equal(playbackView(session.getSnapshot()).track?.title, 'Second');
    const frame = new ArrayBuffer(48);
    const view = new DataView(frame);
    view.setUint8(0, 2);
    view.setUint8(12, 200);
    view.setUint32(4, 100, true);
    view.setUint32(44, 1, true);
    spectrum.onmessage!({ data: frame });
    assert.equal(session.signal.frame?.revision, 1);
    robot.onmessage!({
      data: JSON.stringify({ event: 'nowPlaying', nowPlaying: { ...initial, revision: 2 } }),
    });
    assert.equal(session.signal.frame, undefined);
    view.setUint32(4, 120, true);
    spectrum.onmessage!({ data: frame });
    assert.equal(session.signal.frame, undefined);
    assert.equal(peer.connectionState, 'new'); // the fake peer has not been closed/recreated
    remote = { ...status, generation: 'replacement', track: first, nowPlaying: initial };
    await session.refreshStatus();
    assert.equal(session.getSnapshot().nowPlaying?.revision, 0);
    assert.equal(session.getSnapshot().phase, 'idle');
  } finally {
    stop();
  }
});

test('commands require ownership and acknowledgment; disconnect ignores late channel events', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ title: 'Test', artist: 'Test', durationMs: 1000 }),
  );
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'window'));
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, 'RTCPeerConnection'));
  const api = stubApi();
  const session = new RadioSession(api);
  const stop = session.start({
    pause() {},
    volume: 0,
    srcObject: null,
  } as unknown as HTMLAudioElement);
  try {
    await session.connect();
    const channel = Peer.instances.at(-1)!.channels[0];
    assert.equal(session.getSnapshot().phase, 'connected');
    session.send({ led: [0, 10, 32] });
    assert.deepEqual(channel.sent, ['ack']);
    await session.toggleControl();
    session.send({ led: [0, 10, 32] });
    session.send({ led: [32, 0, 0] });
    assert.equal(channel.sent.length, 2);
    const command = JSON.parse(channel.sent[1]);
    channel.onmessage!({
      data: JSON.stringify({
        event: 'ack',
        command_id: command.command_id,
        result: 0,
        led: [0, 10, 32],
        paused: false,
      }),
    });
    assert.equal(session.getSnapshot().ack.state, 'confirmed');
    assert.deepEqual(session.getSnapshot().led, [0, 10, 32]);
    session.send({ action: 'pause' });
    const pause = JSON.parse(channel.sent.at(-1)!);
    channel.onmessage!({
      data: JSON.stringify({
        event: 'ack',
        command_id: pause.command_id,
        result: 0,
        led: [0, 10, 32],
        paused: true,
      }),
    });
    assert.equal(playbackView(session.getSnapshot()).paused, true);
    assert.equal(session.getSnapshot().telemetry, undefined);
    assert.equal(session.getSnapshot().telemetryAt, 0);
    await session.disconnect();
    channel.onmessage!({
      data: JSON.stringify({
        event: 'ack',
        command_id: command.command_id,
        result: 0,
        led: [32, 0, 0],
        paused: false,
      }),
    });
    assert.equal(session.getSnapshot().led, undefined);
  } finally {
    stop();
  }
});

test('heartbeat recovery clears its own error without hiding an interaction failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { hidden: false }, configurable: true });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: Peer, configurable: true });
  t.after(() => {
    for (const key of ['window', 'document', 'RTCPeerConnection'])
      Reflect.deleteProperty(globalThis, key);
  });
  let fail = true;
  const session = new RadioSession(
    stubApi({
      claimControl: async () => {
        throw new Error('Lease request failed');
      },
      heartbeatViewer: async () => {
        if (fail) throw new Error('offline');
        return { controller: null };
      },
    }),
  );
  const stop = session.start({
    pause() {},
    volume: 0,
    srcObject: null,
  } as unknown as HTMLAudioElement);
  try {
    await session.connect();
    await session.toggleControl();
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(session.getSnapshot().issues.heartbeat!, /renewal failed/);
    fail = false;
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(session.getSnapshot().issues.heartbeat, undefined);
    assert.equal(session.getSnapshot().issues.control, 'Lease request failed');
  } finally {
    stop();
  }
});

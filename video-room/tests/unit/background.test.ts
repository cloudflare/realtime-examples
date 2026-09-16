import assert from "node:assert/strict";
import test from "node:test";

import { startRoomBackground } from "../../src/client/background";
import type { RoomSnapshot } from "../../src/shared/protocol";

test("snapshot updates coalesce while overlapping heartbeats are skipped", async () => {
  const pendingSnapshot = deferred<RoomSnapshot>();
  const pendingHeartbeat = deferred<RoomSnapshot>();
  let snapshots = 0;
  let heartbeats = 0;
  const background = startBackground({
    snapshot: async () =>
      ++snapshots === 1 ? pendingSnapshot.promise : snapshot(2),
    heartbeat: async () => {
      heartbeats += 1;
      return pendingHeartbeat.promise;
    },
  });
  try {
    void background.notify();
    void background.notify();
    background.tick(15_000);
    background.tick(10_000);
    background.tick(10_000);
    assert.equal(snapshots, 1);
    assert.equal(heartbeats, 1);
    pendingSnapshot.resolve(snapshot(1));
    pendingHeartbeat.resolve(snapshot(1));
    await flush();
    assert.equal(snapshots, 2);
    assert.deepEqual(background.rendered, [1, 2]);
    background.tick(10_000);
    await flush();
    assert.equal(heartbeats, 2);
  } finally {
    background.stop();
  }
});

test("stopped background work aborts requests and ignores results after replacement", async () => {
  const pendingSnapshot = deferred<RoomSnapshot>();
  const pendingHeartbeat = deferred<RoomSnapshot>();
  const signals: AbortSignal[] = [];
  const old = startBackground({
    snapshot: async (signal) => {
      signals.push(signal!);
      return pendingSnapshot.promise;
    },
    heartbeat: async (signal) => {
      signals.push(signal!);
      return pendingHeartbeat.promise;
    },
  });
  void old.notify();
  old.tick(10_000);
  old.stop();
  old.stop();
  const replacement = startBackground({ snapshot: async () => snapshot(2) });
  try {
    await replacement.notify();
    pendingSnapshot.resolve(snapshot(1, true));
    pendingHeartbeat.reject(new Error("Late heartbeat failure."));
    await flush();
    void old.notify();
    old.tick(15_000);
    old.tick(10_000);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal(signals.length, 2);
    assert.deepEqual(old.rendered, []);
    assert.deepEqual(old.errors, []);
    assert.equal(old.terminations(), 0);
    assert.equal(old.notificationStops(), 1);
    assert.deepEqual(replacement.rendered, [2]);
  } finally {
    replacement.stop();
  }
});

function startBackground(
  requests: Partial<
    Pick<
      Parameters<typeof startRoomBackground>[0]["api"],
      "snapshot" | "heartbeat"
    >
  > = {},
) {
  const rendered: number[] = [];
  const errors: unknown[] = [];
  const intervals = new Map<number, () => void>();
  let resync!: () => Promise<void> | void;
  let stoppedNotifications = 0;
  let terminated = 0;
  const stop = startRoomBackground(
    {
      api: {
        snapshot: async () => snapshot(1),
        heartbeat: async () => snapshot(1),
        issueSocketTicket: async () => ({
          expiresAt: 30_000,
          ticket: "a".repeat(43),
        }),
        notificationSocketUrl: () => "wss://room.example/api/rooms/demo/socket",
        ...requests,
      },
      isCurrent: () => true,
      onError: (error) => {
        errors.push(error);
      },
      onSnapshot: async (value) => {
        rendered.push(value.revision);
      },
      onTerminated: () => {
        terminated += 1;
      },
    },
    {
      scheduleInterval(callback, milliseconds) {
        intervals.set(milliseconds, callback);
        return milliseconds;
      },
      cancelInterval: (handle) => {
        intervals.delete(handle as number);
      },
      startNotifications: (_api, callback) => {
        resync = callback;
        return () => {
          stoppedNotifications += 1;
        };
      },
    },
  );
  return {
    errors,
    notificationStops: () => stoppedNotifications,
    notify: () => resync(),
    rendered,
    stop,
    terminations: () => terminated,
    tick: (milliseconds: number) => intervals.get(milliseconds)?.(),
  };
}

function snapshot(revision: number, terminated = false): RoomSnapshot {
  return {
    creatorParticipantId: null,
    participants: [],
    revision,
    roomId: "demo",
    terminated,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

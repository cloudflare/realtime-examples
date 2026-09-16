import assert from "node:assert/strict";
import test from "node:test";

import { RequestError } from "../../src/server/auth";
import { SfuRequestError } from "../../src/server/realtime";
import {
  ALICE_MEMBER_TOKEN,
  BOB_MEMBER_TOKEN,
  CHARLIE_MEMBER_TOKEN,
  OFFER,
  alice,
  bob,
  charlie,
  deferred,
  harness,
  waitFor,
} from "./room-harness";

test("enforces member authorization and creator-only termination", async () => {
  const { coordinator } = harness();
  const aliceJoin = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const bobJoin = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });

  await assert.rejects(
    coordinator.getSnapshot(bob, aliceJoin.memberToken),
    (error: unknown) =>
      error instanceof RequestError && error.code === "member_token_invalid",
  );
  await assert.rejects(
    coordinator.terminate(bob, bobJoin.memberToken),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "creator_required" &&
      error.message === "Only the room creator can terminate this room.",
  );
  const terminated = await coordinator.terminate(
    alice,
    aliceJoin.memberToken,
  );
  assert.equal(terminated.terminated, true);
  assert.equal(terminated.participants.length, 0);
  const peerTerminal = await coordinator.getSnapshot(
    bob,
    bobJoin.memberToken,
  );
  assert.equal(peerTerminal.terminated, true);
  assert.equal(peerTerminal.participants.length, 0);
  assert.equal(
    (await coordinator.terminate(alice, aliceJoin.memberToken)).terminated,
    true,
  );
});

test("refresh reconnect replaces SFU sessions without duplicate presence", async () => {
  const { coordinator, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-publish",
    sessionDescription: OFFER,
    tracks: [
      { kind: "audio", mid: "0" },
      { kind: "video", mid: "1" },
    ],
  });

  const reconnected = await coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice refreshed",
    requestId: "reconnect-refresh",
  });
  assert.equal(reconnected.participantId, joined.participantId);
  assert.equal(reconnected.snapshot.participants.length, 1);
  assert.equal(
    reconnected.snapshot.participants[0]?.displayName,
    "Alice refreshed",
  );
  assert.equal(sfu.sessions, 4);
  assert.ok(sfu.closed.some((entry) => entry.mids.includes("0")));
});

test("leave is idempotent and stale presence is cleaned up", async () => {
  let now = 1_000;
  const { coordinator } = harness({ now: () => now });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  assert.equal(
    (await coordinator.leave(alice, joined.memberToken)).participants.length,
    0,
  );
  assert.equal(
    (await coordinator.leave(alice, joined.memberToken)).participants.length,
    0,
  );

  const bobJoin = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });
  assert.ok(bobJoin.memberToken);
  now += 46_000;
  await coordinator.expireStale();
  assert.equal(coordinator.snapshot().participants.length, 0);
});

test("failed stale cleanup retains active presence until retry converges", async () => {
  let now = 1_000;
  const closed: string[] = [];
  const revisions: number[] = [];
  const { coordinator, sfu, writes } = harness({
    closeParticipantSockets: (participantId) => closed.push(participantId),
    notifyRevision: (revision) => revisions.push(revision),
    now: () => now,
  });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  assert.deepEqual(revisions, [1, 2]);
  sfu.closeResponses.push(
    {
      tracks: [
        {
          errorCode: "provider_track_error",
          errorDescription: "The provider could not close the track.",
          mid: "0",
        },
      ],
    },
    {
      tracks: [
        {
          errorCode: "close_track_error",
          errorDescription: "Provider wording changed.",
          mid: "0",
        },
      ],
    },
  );
  now += 46_000;

  await assert.rejects(
    coordinator.expireStale(),
    (error: unknown) =>
      error instanceof SfuRequestError && error.retryable,
  );
  assert.equal(coordinator.snapshot().participants.length, 1);
  assert.equal(coordinator.snapshot().participants[0]?.published.length, 0);
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.equal(writes.at(-1)?.revision, 3);
  assert.equal(
    writes.at(-1)?.participants[joined.participantId]?.published.length,
    0,
  );
  await coordinator.expireStale();
  assert.equal(coordinator.snapshot().participants.length, 0);
  assert.equal(sfu.closed.length, 2);
  assert.deepEqual(closed, [joined.participantId]);
  assert.deepEqual(revisions, [1, 2, 3, 4]);
});

test("WebSocket tickets are participant-bound, single-use, and expiring", async () => {
  let now = 1_000;
  const { coordinator } = harness({ now: () => now });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await assert.rejects(
    coordinator.issueSocketTicket(bob, joined.memberToken),
    (error: unknown) =>
      error instanceof RequestError && error.code === "member_token_invalid",
  );

  const first = await coordinator.issueSocketTicket(
    alice,
    joined.memberToken,
  );
  assert.notEqual(first.ticket, joined.memberToken);
  assert.equal(first.expiresAt, now + 30_000);
  assert.deepEqual(await coordinator.consumeSocketTicket(first.ticket), {
    participantId: joined.participantId,
  });
  await assert.rejects(
    coordinator.consumeSocketTicket(first.ticket),
    (error: unknown) =>
      error instanceof RequestError && error.code === "socket_ticket_invalid",
  );

  const second = await coordinator.issueSocketTicket(
    alice,
    joined.memberToken,
  );
  now = second.expiresAt;
  await assert.rejects(
    coordinator.consumeSocketTicket(second.ticket),
    (error: unknown) =>
      error instanceof RequestError && error.code === "socket_ticket_expired",
  );
});

test("room revisions notify sockets but ticket bookkeeping does not", async () => {
  const revisions: number[] = [];
  const { coordinator } = harness({
    notifyRevision: (revision) => revisions.push(revision),
  });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  assert.deepEqual(revisions, [1]);

  await coordinator.issueSocketTicket(alice, joined.memberToken);
  await coordinator.heartbeat(alice, joined.memberToken);
  assert.deepEqual(revisions, [1]);

  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  assert.deepEqual(revisions, [1, 2]);
});

test("concurrent identical joins create one participant and two sessions", async () => {
  const { coordinator, sfu } = harness();
  const input = {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  };
  const [first, second] = await Promise.all([
    coordinator.join(alice, input),
    coordinator.join(alice, input),
  ]);
  assert.equal(first.participantId, second.participantId);
  assert.equal(first.memberToken, second.memberToken);
  assert.equal(sfu.sessions, 2);
  assert.equal(coordinator.snapshot().participants.length, 1);
  const repeated = await coordinator.join(alice, input);
  assert.equal(repeated.participantId, first.participantId);
  assert.equal(sfu.sessions, 2);
});

test("reconnect dedupes completed IDs until bounded history eviction", async () => {
  const { coordinator, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const input = {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-identical",
  };
  const [first, second] = await Promise.all([
    coordinator.reconnect(alice, joined.memberToken, input),
    coordinator.reconnect(alice, joined.memberToken, input),
  ]);
  assert.equal(first.generation, 2);
  assert.equal(second.generation, 2);
  assert.equal(sfu.sessions, 4);
  const repeated = await coordinator.reconnect(
    alice,
    joined.memberToken,
    input,
  );
  assert.equal(repeated.generation, 2);
  assert.equal(sfu.sessions, 4);

  await assert.rejects(
    coordinator.publish(alice, joined.memberToken, {
      generation: joined.generation,
      mutationId: "mutation-old-generation",
      sessionDescription: OFFER,
      tracks: [{ kind: "video", mid: "0" }],
    }),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "media_generation_stale",
  );
  assert.equal(coordinator.snapshot().participants[0]?.published.length, 0);

  let current = await coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-request-b",
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: current.generation,
    mutationId: "mutation-current-generation",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const sessionsBeforeReplay = sfu.sessions;
  const closesBeforeReplay = sfu.closed.length;

  const replay = await coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-identical",
  });
  assert.equal(replay.generation, current.generation);
  assert.equal(replay.snapshot.participants[0]?.published.length, 1);
  assert.equal(sfu.sessions, sessionsBeforeReplay);
  assert.equal(sfu.closed.length, closesBeforeReplay);

  for (let index = 0; index < 7; index += 1) {
    current = await coordinator.reconnect(alice, joined.memberToken, {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: `reconnect-history-${index}`,
    });
  }
  const sessionsBeforeEvictionReplay = sfu.sessions;

  const retained = await coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-request-b",
  });
  assert.equal(retained.generation, current.generation);
  assert.equal(sfu.sessions, sessionsBeforeEvictionReplay);

  const evicted = await coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-identical",
  });
  assert.equal(evicted.generation, current.generation + 1);
  assert.equal(sfu.sessions, sessionsBeforeEvictionReplay + 2);
});

test("leave and termination close participant notification sockets", async () => {
  const closed: string[] = [];
  const revisions: number[] = [];
  const { coordinator } = harness({
    closeParticipantSockets: (participantId) => closed.push(participantId),
    notifyRevision: (revision) => revisions.push(revision),
  });
  const aliceJoin = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const bobJoin = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });

  await coordinator.leave(bob, bobJoin.memberToken);
  assert.ok(closed.includes(bobJoin.participantId));
  const revisionBeforeTerminate = revisions.at(-1)!;
  await coordinator.terminate(alice, aliceJoin.memberToken);
  assert.ok(revisions.at(-1)! > revisionBeforeTerminate);
  assert.ok(closed.includes(aliceJoin.participantId));
});

test("termination excludes a join that arrives while cleanup is active", async () => {
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-before-terminate",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });

  sfu.closeTrackBarriers.push(gate.promise);
  const terminating = coordinator.terminate(alice, joined.memberToken);
  await waitFor(
    () => room.phase === "terminating" && sfu.closed.length === 1,
  );
  const joining = coordinator
    .join(charlie, {
      clientId: "client-charlie",
      displayName: "Charlie",
      memberToken: CHARLIE_MEMBER_TOKEN,
    })
    .then(
      (value) => value,
      (error: unknown) => error,
    );
  await Promise.resolve();
  assert.equal(sfu.sessions, 2);

  gate.resolve();
  const terminal = await terminating;
  const joinResult = await joining;
  assert.equal(terminal.terminated, true);
  assert.equal(room.phase, "terminated");
  assert.ok(
    joinResult instanceof RequestError &&
      joinResult.code === "room_terminated",
  );
  assert.equal(sfu.sessions, 2);
});

test("failed termination converges on alarm and later permits deletion", async () => {
  let now = 1_000;
  let cleared = false;
  const { coordinator, room, sfu, writes } = harness({ now: () => now });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-termination-retry",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  sfu.closeResponses.push({
    tracks: [
      {
        errorCode: "provider_track_error",
        errorDescription: "The provider could not close the track.",
        mid: "0",
      },
    ],
  });

  await assert.rejects(
    coordinator.terminate(alice, joined.memberToken),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "provider_track_error" &&
      error.status === 502 &&
      error.retryable,
  );
  assert.equal(room.phase, "terminating");
  assert.equal(room.terminatedAt, undefined);
  assert.equal(coordinator.snapshot().terminated, false);
  assert.equal(coordinator.snapshot().participants.length, 1);
  assert.ok(writes.some((state) => state.phase === "terminating"));
  assert.equal(coordinator.nextAlarmAt(), now + 5_000);

  const sessionsBeforeJoin = sfu.sessions;
  await assert.rejects(
    coordinator.join(bob, {
      clientId: "client-bob",
      displayName: "Bob",
      memberToken: BOB_MEMBER_TOKEN,
    }),
    (error: unknown) =>
      error instanceof RequestError && error.code === "room_terminating",
  );
  assert.equal(sfu.sessions, sessionsBeforeJoin);

  assert.equal(await coordinator.expireStale(), null);
  assert.equal(room.phase, "terminated");
  assert.ok(room.terminatedAt);
  assert.equal(sfu.closed.length, 2);
  assert.equal(writes.at(-1)?.phase, "terminated");
  assert.equal(room.participants[joined.participantId]?.status, "left");
  assert.equal(
    (await coordinator.getSnapshot(alice, joined.memberToken)).terminated,
    true,
  );

  now += 5 * 60_000;
  const lease = await coordinator.expireStale();
  assert.ok(lease);
  assert.equal(room.participants[joined.participantId], undefined);
  assert.equal(
    await coordinator.deleteWithLease(lease, async () => {
      cleared = true;
    }),
    true,
  );
  assert.equal(cleared, true);
  assert.equal(room.phase, "open");
});

test("room creator remains immutable when leaving during termination", async () => {
  const gate = deferred<void>();
  const { coordinator, persistBarriers, room } = harness();
  const aliceJoin = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const bobJoin = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });

  persistBarriers.push(gate.promise);
  const terminating = coordinator.terminate(alice, aliceJoin.memberToken);
  await waitFor(() => room.phase === "terminating");
  await coordinator.leave(alice, aliceJoin.memberToken);
  assert.equal(room.creatorParticipantId, aliceJoin.participantId);
  gate.resolve();
  const terminal = await terminating;
  assert.equal(terminal.creatorParticipantId, aliceJoin.participantId);
  assert.equal(terminal.terminated, true);

  await assert.rejects(
    coordinator.terminate(bob, bobJoin.memberToken),
    (error: unknown) =>
      error instanceof RequestError && error.code === "creator_required",
  );
});

test("remaining participants never inherit creator termination rights", async () => {
  let now = 1_000;
  const { coordinator, room } = harness({ now: () => now });
  const creatorJoin = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const bobJoin = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });

  await coordinator.leave(alice, creatorJoin.memberToken);
  now += 5 * 60_000;
  await coordinator.heartbeat(bob, bobJoin.memberToken);
  await coordinator.expireStale();

  assert.equal(room.participants[creatorJoin.participantId], undefined);
  assert.equal(room.creatorParticipantId, creatorJoin.participantId);
  await assert.rejects(
    coordinator.terminate(bob, bobJoin.memberToken),
    (error: unknown) =>
      error instanceof RequestError && error.code === "creator_required",
  );
});

test("explicit leave cannot be undone by reconnect", async () => {
  const { coordinator, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.leave(alice, joined.memberToken);
  const sessionsAfterLeave = sfu.sessions;

  await assert.rejects(
    coordinator.reconnect(alice, joined.memberToken, {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: "reconnect-after-leave",
    }),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "member_token_invalid",
  );
  assert.equal(sfu.sessions, sessionsAfterLeave);
  assert.equal(coordinator.snapshot().participants.length, 0);
});

test("termination rejects a reconnect whose session creation is still pending", async () => {
  const { coordinator, room, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const gate = deferred<void>();
  sfu.createSessionBarriers.push(gate.promise, gate.promise);
  const reconnecting = coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-delayed-session-creation",
  });
  const rejected = assert.rejects(reconnecting, (error: unknown) =>
    error instanceof RequestError && error.code === "room_terminating");
  await waitFor(() => sfu.sessions === 4);
  const terminating = coordinator.terminate(alice, joined.memberToken);
  await waitFor(() => room.phase === "terminating");
  gate.resolve();
  await rejected;
  const result = await terminating;

  assert.equal(result.terminated, true);
  assert.deepEqual(result.participants, []);
  assert.equal(room.participants[joined.participantId]?.producer.generation,
    joined.generation);
});

test("heartbeat queued first prevents stale expiry", async () => {
  let now = 1_000;
  const { coordinator, persistBarriers, room } = harness({
    now: () => now,
  });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  now += 46_000;
  const gate = deferred<void>();
  persistBarriers.push(gate.promise);
  const heartbeat = coordinator.heartbeat(alice, joined.memberToken);
  await waitFor(
    () => room.participants[joined.participantId]?.lastSeenAt === now,
  );
  const expiry = coordinator.expireStale();
  assert.equal(coordinator.snapshot().participants.length, 1);

  gate.resolve();
  const heartbeatSnapshot = await heartbeat;
  const lease = await expiry;
  assert.equal(heartbeatSnapshot.participants.length, 1);
  assert.equal(coordinator.snapshot().participants.length, 1);
  assert.equal(lease, null);
});

test("stale expiry queued first makes a delayed heartbeat fail", async () => {
  let now = 1_000;
  const gate = deferred<void>();
  const { coordinator, sfu } = harness({ now: () => now });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-before-expiry",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  now += 46_000;
  sfu.closeTrackBarriers.push(gate.promise);
  const expiry = coordinator.expireStale();
  await waitFor(() => sfu.closed.length === 1);
  const heartbeat = coordinator
    .heartbeat(alice, joined.memberToken)
    .then(
      (value) => value,
      (error: unknown) => error,
    );

  gate.resolve();
  await expiry;
  const heartbeatResult = await heartbeat;
  assert.ok(
    heartbeatResult instanceof RequestError &&
      heartbeatResult.code === "member_token_invalid",
  );
  assert.equal(coordinator.snapshot().participants.length, 0);
});

test("room deletion lease serializes deletion before a new join", async () => {
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness();
  const lease = await coordinator.expireStale();
  assert.ok(lease);
  let clearStarted = false;
  const deleting = coordinator.deleteWithLease(lease, async () => {
    clearStarted = true;
    await gate.promise;
  });
  await waitFor(() => clearStarted);
  const joining = coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await Promise.resolve();
  assert.equal(sfu.sessions, 0);

  gate.resolve();
  assert.equal(await deleting, true);
  const joined = await joining;
  assert.equal(room.creatorParticipantId, joined.participantId);
  assert.equal(room.phase, "open");
  assert.equal(room.revision, 1);
});

test("room deletion lease is rejected after a new join changes revision", async () => {
  const { coordinator } = harness();
  const lease = await coordinator.expireStale();
  assert.ok(lease);
  await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  let cleared = false;

  assert.equal(
    await coordinator.deleteWithLease(lease, async () => {
      cleared = true;
    }),
    false,
  );
  assert.equal(cleared, false);
  assert.equal(coordinator.snapshot().participants.length, 1);
});

test("join after the final creator tombstone expires becomes creator", async () => {
  let now = 1_000;
  const { coordinator, room } = harness({ now: () => now });
  const creator = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  await coordinator.leave(alice, creator.memberToken);
  now += 5 * 60_000;

  const staleLease = await coordinator.expireStale();
  assert.ok(staleLease);
  assert.equal(Object.keys(room.participants).length, 0);
  assert.equal(room.creatorParticipantId, null);
  const replacement = await coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });
  assert.equal(room.creatorParticipantId, replacement.participantId);

  let cleared = false;
  assert.equal(
    await coordinator.deleteWithLease(staleLease, async () => {
      cleared = true;
    }),
    false,
  );
  assert.equal(cleared, false);
  assert.equal(coordinator.snapshot().participants.length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";

import { SessionQueueError } from "../../src/server/session-mutation-queue";
import {
  ALICE_MEMBER_TOKEN,
  ANSWER,
  BOB_MEMBER_TOKEN,
  OFFER,
  alice,
  bob,
  deferred,
  harness,
  waitFor,
} from "./room-harness";

async function restorePendingConsumer() {
  const clock = { now: 1_000 };
  const original = harness({ now: () => clock.now });
  const joined = await original.coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const publisher = await original.coordinator.join(bob, {
    clientId: "client-bob",
    displayName: "Bob",
    memberToken: BOB_MEMBER_TOKEN,
  });
  const published = await original.coordinator.publish(bob, publisher.memberToken, {
    generation: publisher.generation,
    mutationId: "mutation-bob-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  await original.coordinator.subscribe(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-restored-offer",
    trackKeys: published.tracks.map((track) => track.key),
  });
  const persisted = structuredClone(original.writes.at(-1)!);
  const answer = {
    generation: joined.generation,
    mutationId: "mutation-restored-offer",
    sessionDescription: ANSWER,
  };
  // Settle the original runtime queue; the reconstructed coordinator uses the
  // persisted snapshot from before that answer, as after an eviction.
  await original.coordinator.renegotiate(alice, joined.memberToken, answer);
  const restored = harness({
    now: () => clock.now,
    room: persisted,
    sfu: original.sfu,
  });
  return { ...restored, answer, clock, joined };
}

test("a restored answer refreshes presence and deduplicates successful completion", async () => {
  const { answer, clock, coordinator, joined, room, sfu, writes } =
    await restorePendingConsumer();
  const completedBefore = sfu.renegotiated.length;
  clock.now = 2_000;

  await coordinator.renegotiate(alice, joined.memberToken, answer);
  await coordinator.renegotiate(alice, joined.memberToken, answer);

  assert.equal(sfu.renegotiated.length, completedBefore + 1);
  assert.equal(room.participants[joined.participantId]?.lastSeenAt, clock.now);
  const stored = writes.at(-1)?.participants[joined.participantId];
  assert.equal(stored?.lastSeenAt, clock.now);
  assert.equal(stored?.consumer.pendingNegotiation, undefined);
  assert.equal(stored?.consumer.invalid, false);
});

test("reconnect drains a restored answer without reviving the old session", async () => {
  const { answer, coordinator, joined, room, sfu, writes } =
    await restorePendingConsumer();
  const gate = deferred<void>();
  const oldSession = room.participants[joined.participantId]!.consumer;
  const startedBefore = sfu.events.filter((event) =>
    event.startsWith("renegotiate-start:"),
  ).length;
  sfu.renegotiateBarriers.push(gate.promise);
  const completing = coordinator.renegotiate(alice, joined.memberToken, answer)
    .then(() => "resolved", (error: unknown) => error);
  await waitFor(() => sfu.events.filter((event) =>
    event.startsWith("renegotiate-start:"),
  ).length > startedBefore);

  const reconnecting = coordinator.reconnect(alice, joined.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-restored-answer",
  });
  await waitFor(() => oldSession.invalid === true);
  const invalidationWrite = writes.length - 1;
  assert.equal(sfu.closed.some((entry) => entry.sessionId === oldSession.id), false);

  gate.resolve();
  const completion = await completing;
  const replacement = await reconnecting;
  assert.ok(completion instanceof SessionQueueError);
  assert.equal(completion.code, "media_generation_stale");
  assert.equal(oldSession.invalid, true);
  assert.equal(replacement.generation, joined.generation + 1);
  assert.notEqual(room.participants[joined.participantId]?.consumer.id, oldSession.id);
  assert.ok(sfu.closed.some((entry) =>
    entry.sessionId === oldSession.id && entry.mids.includes("remote-0"),
  ));
  assert.ok(writes.slice(invalidationWrite).every((state) => {
    const consumer = state.participants[joined.participantId]?.consumer;
    return consumer?.id !== oldSession.id || consumer.invalid === true;
  }));
});

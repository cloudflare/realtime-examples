import assert from "node:assert/strict";
import test from "node:test";

import { RequestError } from "../../src/server/auth";
import { SfuRequestError } from "../../src/server/realtime";
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

test("refresh treats close HTTP 404 or 410 as already absent", async () => {
  for (const status of [404, 410]) {
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
      tracks: [{ kind: "video", mid: "0" }],
    });
    sfu.closeErrors.push(
      new SfuRequestError(
        `sfu_http_${status}`,
        "Realtime SFU rejected the operation.",
        status,
      ),
    );

    const reconnected = await coordinator.reconnect(
      alice,
      joined.memberToken,
      {
        clientId: "client-alice",
        displayName: "Alice",
        requestId: "reconnect-after-session-close",
      },
    );

    assert.equal(reconnected.generation, 2);
    assert.equal(sfu.sessions, 4);
    assert.equal(sfu.closed.length, 1);
  }
});

test("subscription offer blocks concurrent leave until renegotiation", async () => {
  const { coordinator, sfu } = harness();
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
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobJoin.generation,
    mutationId: "mutation-bob-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const bobTrack =
    (await coordinator.getSnapshot(alice, aliceJoin.memberToken)).participants
      .find((participant) => participant.id === bobJoin.participantId)
      ?.published[0]?.key;
  assert.ok(bobTrack);

  const subscription = await coordinator.subscribe(
    alice,
    aliceJoin.memberToken,
    {
      generation: aliceJoin.generation,
      mutationId: "mutation-subscribe",
      trackKeys: [bobTrack],
    },
  );
  assert.equal(subscription.requiresImmediateRenegotiation, true);
  let left = false;
  const leaving = coordinator
    .leave(alice, aliceJoin.memberToken)
    .then(() => {
      left = true;
    });
  await Promise.resolve();
  assert.equal(left, false);
  await coordinator.renegotiate(alice, aliceJoin.memberToken, {
    generation: aliceJoin.generation,
    mutationId: "mutation-subscribe",
    sessionDescription: ANSWER,
  });
  await leaving;
  assert.equal(left, true);
  assert.equal(sfu.renegotiated.length, 1);
});

test("partial close inspects each track and converges on already-absent results", async () => {
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
  sfu.closeResponses.push(
    {
      tracks: [
        { mid: "0" },
        {
          errorCode: "provider_track_error",
          errorDescription: "The provider could not close the track.",
          mid: "1",
        },
      ],
    },
    {
      tracks: [
        {
          errorCode: "close_track_error",
          mid: "0",
        },
        { mid: "1" },
      ],
    },
  );

  await assert.rejects(
    coordinator.leave(alice, joined.memberToken),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.retryable &&
      error.code === "provider_track_error" &&
      error.status === 502,
  );
  assert.equal(coordinator.snapshot().participants.length, 1);
  const snapshot = await coordinator.leave(alice, joined.memberToken);
  assert.equal(snapshot.participants.length, 0);
  assert.equal(sfu.closed.length, 2);
  assert.deepEqual(sfu.closed[0]?.mids, ["0", "1"]);
  assert.deepEqual(sfu.closed[1]?.mids, ["0", "1"]);
});

test("close checks every item after an already-absent result", async () => {
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
  sfu.closeResponses.push({
    tracks: [
      {
        errorCode: "close_track_error",
        errorDescription: "Provider wording changed.",
        mid: "0",
      },
      {
        errorCode: "provider_track_error",
        errorDescription: "Raw provider detail must stay server-side.",
        mid: "1",
        trackName: "safe-video-track",
      },
    ],
  });

  await assert.rejects(
    coordinator.leave(alice, joined.memberToken),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "provider_track_error" &&
      error.status === 502 &&
      error.retryable &&
      error.message ===
        "Realtime SFU close failed for a track. Retry with the request ID." &&
      !error.message.includes("Raw provider detail") &&
      error.track?.mid === "1" &&
      error.track.trackName === "safe-video-track",
  );
  assert.equal(coordinator.snapshot().participants.length, 1);
});

test("publish item failure invalidates the session before retry", async () => {
  const { coordinator, room, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  const failedTrackName = `${joined.participantId}-1-video`;
  sfu.addResponses.push({
    tracks: [
      {
        mid: "server-audio-mid",
        trackName: `${joined.participantId}-1-audio`,
      },
      {
        errorCode: "publish_track_error",
        mid: "server-video-mid",
        trackName: failedTrackName,
      },
    ],
  });
  const input = {
    generation: joined.generation,
    mutationId: "mutation-publish-item-error",
    sessionDescription: OFFER,
    tracks: [
      { kind: "audio", mid: "0" },
      { kind: "video", mid: "1" },
    ],
  };

  await assert.rejects(
    coordinator.publish(alice, joined.memberToken, input),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "publish_track_error" &&
      error.track?.mid === "server-video-mid" &&
      error.track.trackName === failedTrackName,
  );
  const participant = room.participants[joined.participantId];
  assert.equal(participant?.producer.invalid, true);
  assert.deepEqual(participant?.producer.mids, [
    "0",
    "1",
    "server-audio-mid",
    "server-video-mid",
  ]);

  await assert.rejects(
    coordinator.publish(alice, joined.memberToken, input),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "media_generation_stale",
  );
  assert.equal(sfu.added.length, 1);

  const replacement = await coordinator.reconnect(
    alice,
    joined.memberToken,
    {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: "reconnect-after-publish-error",
    },
  );
  assert.equal(replacement.generation, 2);
  assert.deepEqual(sfu.closed[0], {
    mids: ["0", "1", "server-audio-mid", "server-video-mid"],
    sessionId: "session-1",
  });
});

test("subscribe item failure invalidates the session before retry", async () => {
  const { coordinator, room, sfu } = harness();
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
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobJoin.generation,
    mutationId: "mutation-bob-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const bobTrackName = `${bobJoin.participantId}-1-video`;
  const bobTrack = coordinator
    .snapshot()
    .participants.find((participant) => participant.id === bobJoin.participantId)
    ?.published[0]?.key;
  assert.ok(bobTrack);
  sfu.addResponses.push({
    tracks: [
      {
        errorCode: "subscribe_track_error",
        mid: "remote-failed-mid",
        trackName: bobTrackName,
      },
    ],
  });
  const input = {
    generation: aliceJoin.generation,
    mutationId: "mutation-subscribe-item-error",
    trackKeys: [bobTrack],
  };

  await assert.rejects(
    coordinator.subscribe(alice, aliceJoin.memberToken, input),
    (error: unknown) =>
      error instanceof SfuRequestError &&
      error.code === "subscribe_track_error" &&
      error.track?.mid === "remote-failed-mid" &&
      error.track.trackName === bobTrackName,
  );
  const participant = room.participants[aliceJoin.participantId];
  assert.equal(participant?.consumer.invalid, true);
  assert.deepEqual(participant?.consumer.mids, ["remote-failed-mid"]);

  await assert.rejects(
    coordinator.subscribe(alice, aliceJoin.memberToken, input),
    (error: unknown) =>
      error instanceof RequestError &&
      error.code === "media_generation_stale",
  );
  assert.equal(
    sfu.added.filter((entry) => !entry.body.sessionDescription).length,
    1,
  );

  const replacement = await coordinator.reconnect(
    alice,
    aliceJoin.memberToken,
    {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: "reconnect-after-subscribe-error",
    },
  );
  assert.equal(replacement.generation, 2);
  assert.ok(
    sfu.closed.some(
      (entry) =>
        entry.sessionId === "session-2" &&
        entry.mids.includes("remote-failed-mid"),
    ),
  );
});

test("forced stale cleanup drains an active publish and closes its mids", async () => {
  let now = 1_000;
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness({ now: () => now });
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  sfu.addTrackBarriers.push(gate.promise);
  const publishing = coordinator
    .publish(alice, joined.memberToken, {
      generation: joined.generation,
      mutationId: "mutation-blocked-publish",
      sessionDescription: OFFER,
      tracks: [{ kind: "video", mid: "0" }],
    })
    .then(
      () => "resolved",
      (error: unknown) => error,
    );
  await waitFor(() => sfu.added.length === 1);
  now += 46_000;
  let cleanupFinished = false;
  const cleanup = coordinator.expireStale().then(() => {
    cleanupFinished = true;
  });
  await Promise.resolve();
  assert.equal(cleanupFinished, false);

  gate.resolve();
  const publishResult = await publishing;
  await cleanup;
  assert.ok(publishResult instanceof SessionQueueError);
  assert.equal(coordinator.snapshot().participants.length, 0);
  assert.ok(sfu.closed.some((entry) => entry.mids.includes("0")));
  assert.equal(
    Object.values(room.participants)[0]?.published.length,
    0,
  );
});

test("reconnect drains an active publish before replacing its generation", async () => {
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  sfu.addTrackBarriers.push(gate.promise);
  const publishing = coordinator
    .publish(alice, joined.memberToken, {
      generation: joined.generation,
      mutationId: "mutation-before-reconnect",
      sessionDescription: OFFER,
      tracks: [{ kind: "video", mid: "0" }],
    })
    .then(
      () => "resolved",
      (error: unknown) => error,
    );
  await waitFor(() => sfu.added.length === 1);
  let reconnected = false;
  const reconnecting = coordinator
    .reconnect(alice, joined.memberToken, {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: "reconnect-after-publish",
    })
    .then((result) => {
      reconnected = true;
      return result;
    });
  await waitFor(
    () =>
      Object.values(room.participants)[0]?.producer.invalid === true,
  );
  assert.equal(reconnected, false);

  gate.resolve();
  const publishResult = await publishing;
  const replacement = await reconnecting;
  assert.ok(publishResult instanceof SessionQueueError);
  assert.equal(replacement.generation, 2);
  assert.equal(sfu.added[0]?.sessionId, "session-1");
  assert.ok(sfu.closed.some((entry) => entry.mids.includes("0")));
  assert.equal(replacement.snapshot.participants[0]?.published.length, 0);
});

test("reconnect waits for in-flight renegotiation before closing old mids", async () => {
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness();
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
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobJoin.generation,
    mutationId: "mutation-bob-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const bobTrack = coordinator
    .snapshot()
    .participants.find((participant) => participant.id === bobJoin.participantId)
    ?.published[0]?.key;
  assert.ok(bobTrack);
  const subscription = await coordinator.subscribe(
    alice,
    aliceJoin.memberToken,
    {
      generation: aliceJoin.generation,
      mutationId: "mutation-blocked-renegotiate",
      trackKeys: [bobTrack],
    },
  );
  assert.equal(subscription.requiresImmediateRenegotiation, true);

  sfu.renegotiateBarriers.push(gate.promise);
  const completing = coordinator
    .renegotiate(alice, aliceJoin.memberToken, {
      generation: aliceJoin.generation,
      mutationId: "mutation-blocked-renegotiate",
      sessionDescription: ANSWER,
    })
    .then(
      () => "resolved",
      (error: unknown) => error,
    );
  await waitFor(() =>
    sfu.events.includes("renegotiate-start:session-2"),
  );

  let reconnectFinished = false;
  const reconnecting = coordinator
    .reconnect(alice, aliceJoin.memberToken, {
      clientId: "client-alice",
      displayName: "Alice",
      requestId: "reconnect-during-renegotiate",
    })
    .then((result) => {
      reconnectFinished = true;
      return result;
    });
  await waitFor(
    () =>
      Object.values(room.participants).find(
        (participant) => participant.id === aliceJoin.participantId,
      )?.consumer.invalid === true,
  );
  assert.equal(reconnectFinished, false);
  assert.equal(
    sfu.events.includes("close:session-2"),
    false,
  );
  assert.equal(sfu.sessions, 4);

  gate.resolve();
  const completionResult = await completing;
  const replacement = await reconnecting;
  assert.ok(completionResult instanceof SessionQueueError);
  assert.equal(replacement.generation, 2);
  assert.equal(sfu.sessions, 6);
  assert.ok(
    sfu.events.indexOf("renegotiate-settled:session-2") <
      sfu.events.indexOf("close:session-2"),
  );
  const aliceState = room.participants[aliceJoin.participantId];
  assert.equal(aliceState?.consumer.id, "session-6");
  assert.equal(aliceState?.consumer.generation, 2);
  assert.equal(aliceState?.consumer.pendingNegotiation, undefined);
  assert.equal(aliceState?.subscriptions.length, 0);
});

test("same-key subscription follows a publisher replacement", async () => {
  const { coordinator, room, sfu } = harness();
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
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobJoin.generation,
    mutationId: "mutation-bob-first-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const originalTrack = coordinator
    .snapshot()
    .participants.find((participant) => participant.id === bobJoin.participantId)
    ?.published[0]?.key;
  assert.ok(originalTrack);

  await coordinator.subscribe(alice, aliceJoin.memberToken, {
    generation: aliceJoin.generation,
    mutationId: "mutation-first-subscribe",
    trackKeys: [originalTrack],
  });
  await coordinator.renegotiate(alice, aliceJoin.memberToken, {
    generation: aliceJoin.generation,
    mutationId: "mutation-first-subscribe",
    sessionDescription: ANSWER,
  });

  const bobReplacement = await coordinator.reconnect(
    bob,
    bobJoin.memberToken,
    {
      clientId: "client-bob",
      displayName: "Bob",
      requestId: "reconnect-bob-publisher",
    },
  );
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobReplacement.generation,
    mutationId: "mutation-bob-second-publish",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const replacementTrack = coordinator
    .snapshot()
    .participants.find((participant) => participant.id === bobJoin.participantId)
    ?.published[0]?.key;
  assert.equal(replacementTrack, originalTrack);

  const replacementSubscription = await coordinator.subscribe(
    alice,
    aliceJoin.memberToken,
    {
      generation: aliceJoin.generation,
      mutationId: "mutation-second-subscribe",
      trackKeys: [originalTrack],
    },
  );
  const remoteAdds = sfu.added.filter(
    (entry) => !entry.body.sessionDescription,
  );
  const target = (
    remoteAdds.at(-1)?.body.tracks as
      | Array<{ sessionId?: string; trackName?: string }>
      | undefined
  )?.[0];
  assert.equal(target?.sessionId, "session-5");
  assert.match(target?.trackName ?? "", /-2-video$/);
  assert.ok(
    sfu.closed.some(
      (entry) =>
        entry.sessionId === "session-2" &&
        entry.mids.includes("remote-0"),
    ),
  );
  assert.equal(replacementSubscription.subscriptions[0]?.key, originalTrack);
  assert.equal(
    room.participants[aliceJoin.participantId]?.subscriptions[0]
      ?.producerSessionId,
    "session-5",
  );
  await coordinator.renegotiate(alice, aliceJoin.memberToken, {
    generation: aliceJoin.generation,
    mutationId: "mutation-second-subscribe",
    sessionDescription: ANSWER,
  });
});

test("subscription revalidates publication identity after the SFU call", async () => {
  const gate = deferred<void>();
  const { coordinator, room, sfu } = harness();
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
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobJoin.generation,
    mutationId: "mutation-bob-publish-before-race",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  const bobTrack = coordinator
    .snapshot()
    .participants.find((participant) => participant.id === bobJoin.participantId)
    ?.published[0]?.key;
  assert.ok(bobTrack);

  sfu.addTrackBarriers.push(gate.promise);
  const subscribing = coordinator
    .subscribe(alice, aliceJoin.memberToken, {
      generation: aliceJoin.generation,
      mutationId: "mutation-subscribe-race",
      trackKeys: [bobTrack],
    })
    .then(
      (value) => value,
      (error: unknown) => error,
    );
  await waitFor(
    () =>
      sfu.added.some(
        (entry) =>
          entry.sessionId === "session-2" &&
          !entry.body.sessionDescription,
      ),
  );

  const bobReplacement = await coordinator.reconnect(
    bob,
    bobJoin.memberToken,
    {
      clientId: "client-bob",
      displayName: "Bob",
      requestId: "reconnect-during-subscribe",
    },
  );
  await coordinator.publish(bob, bobJoin.memberToken, {
    generation: bobReplacement.generation,
    mutationId: "mutation-bob-after-race",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  gate.resolve();

  const subscribeResult = await subscribing;
  assert.ok(
    subscribeResult instanceof SessionQueueError &&
      subscribeResult.code === "publication_changed",
  );
  const aliceState = room.participants[aliceJoin.participantId];
  assert.equal(aliceState?.consumer.invalid, true);
  assert.ok(aliceState?.consumer.mids.includes("remote-0"));

  await coordinator.reconnect(alice, aliceJoin.memberToken, {
    clientId: "client-alice",
    displayName: "Alice",
    requestId: "reconnect-after-publication-race",
  });
  assert.ok(
    sfu.closed.some(
      (entry) =>
        entry.sessionId === "session-2" &&
        entry.mids.includes("remote-0"),
    ),
  );
});

test("concurrent publish rechecks inside the producer queue and retains mids", async () => {
  const gate = deferred<void>();
  const { coordinator, sfu } = harness();
  const joined = await coordinator.join(alice, {
    clientId: "client-alice",
    displayName: "Alice",
    memberToken: ALICE_MEMBER_TOKEN,
  });
  sfu.addTrackBarriers.push(gate.promise);
  sfu.addResponses.push({
    requiresImmediateRenegotiation: false,
    sessionDescription: ANSWER,
    tracks: [
      {
        mid: "server-video-mid",
        trackName: `${joined.participantId}-1-video`,
      },
    ],
  });
  const first = coordinator.publish(alice, joined.memberToken, {
    generation: joined.generation,
    mutationId: "mutation-concurrent-first",
    sessionDescription: OFFER,
    tracks: [{ kind: "video", mid: "0" }],
  });
  await waitFor(() => sfu.added.length === 1);
  const second = coordinator
    .publish(alice, joined.memberToken, {
      generation: joined.generation,
      mutationId: "mutation-concurrent-second",
      sessionDescription: OFFER,
      tracks: [{ kind: "video", mid: "1" }],
    })
    .then(
      (value) => value,
      (error: unknown) => error,
    );

  gate.resolve();
  const published = await first;
  const secondResult = await second;
  assert.equal(published.tracks[0]?.mid, "server-video-mid");
  assert.ok(
    secondResult instanceof RequestError &&
      secondResult.code === "already_published",
  );
  assert.equal(sfu.added.length, 1);

  await coordinator.leave(alice, joined.memberToken);
  const producerClose = sfu.closed.find(
    (entry) => entry.sessionId === "session-1",
  );
  assert.deepEqual(producerClose?.mids, ["0", "server-video-mid"]);
});

import {
  type PublishRequest,
  type PublishResponse,
  type RenegotiateRequest,
  type SessionDescription,
  type SubscribeRequest,
  type SubscriptionResponse,
} from "../shared/protocol";
import { RequestError } from "./auth";
import {
  parseSfuCloseResponse,
  parseSfuTracksResponse,
  SfuRequestError,
  sfuTrackMids,
  type SfuClient,
  type SfuResponse,
  type SfuTrack,
  type SfuTracksResponse,
} from "./realtime";
import {
  publicTrack,
  type Participant,
  type PersistedRoom,
  type PublishedTrack,
  type SessionState,
  type Subscription,
} from "./room-state";
import {
  SessionMutationQueue,
  SessionQueueError,
} from "./session-mutation-queue";

type QueueKind = "consumer" | "producer";

type SessionFence = {
  kind: QueueKind;
  lifecycleVersion: number;
  session: SessionState;
};

export class RoomMedia {
  private readonly queues = new Map<string, SessionMutationQueue>();

  constructor(
    private readonly room: PersistedRoom,
    private readonly sfu: SfuClient,
    private readonly persist: (room: PersistedRoom) => Promise<void>,
    private readonly now: () => number,
    private readonly assertRoomOpen: () => void,
    private readonly changed: () => Promise<void>,
  ) {}

  async publish(
    participant: Participant,
    { generation, mutationId, sessionDescription, tracks }: PublishRequest,
  ): Promise<PublishResponse> {
    const fence = this.captureSessionFence(
      participant,
      "producer",
      generation,
    );
    const queue = this.queueFor(participant, "producer");
    return queue.enqueue(mutationId, async () => {
      this.assertRoomOpen();
      this.assertSessionFence(participant, fence);
      if (participant.published.length > 0) {
        throw new RequestError(
          409,
          "already_published",
          "This media generation already published tracks. Reconnect before replacing them.",
        );
      }
      const names = tracks.map(({ kind, mid }) => ({
        key: `${participant.id}:${kind}`,
        kind,
        mid,
        trackName: `${participant.id}-${fence.session.generation}-${kind}`,
      }));
      const rawResponse = await this.sfu.addTracks(fence.session.id, {
        sessionDescription,
        tracks: names.map(({ mid, trackName }) => ({
          location: "local",
          mid,
          trackName,
        })),
      });
      const response = await this.acceptAddedTracks(
        fence.session,
        queue,
        rawResponse,
        "publish",
        names.map((track) => track.mid),
      );
      this.assertSessionFence(participant, fence);
      if (
        response.requiresImmediateRenegotiation ||
        response.sessionDescription?.type !== "answer"
      ) {
        fence.session.invalid = true;
        await this.persist(this.room);
        throw new RequestError(
          502,
          "publish_negotiation_invalid",
          "Realtime SFU returned an unexpected publish negotiation. Reconnect and retry.",
          true,
        );
      }
      const responseTracks = indexTracks(response.tracks);
      participant.published = names.map((track) => {
        const result = responseTracks.get(track.trackName);
        const mid = result?.mid ?? track.mid;
        return {
          ...track,
          mid,
          participantId: participant.id,
          producerSessionId: fence.session.id,
        };
      });
      participant.lastSeenAt = this.now();
      await this.changed();
      return {
        response: {
          mutationId,
          sessionDescription: response.sessionDescription,
          tracks: participant.published.map(({ key, kind, mid }) => ({
            key,
            kind,
            mid,
          })),
        },
      };
    });
  }

  async subscribe(
    participant: Participant,
    { generation, mutationId, trackKeys }: SubscribeRequest,
  ): Promise<SubscriptionResponse> {
    const fence = this.captureSessionFence(
      participant,
      "consumer",
      generation,
    );
    const desiredKeys = new Set(trackKeys);
    const queue = this.queueFor(participant, "consumer");
    return queue.enqueue(mutationId, async () => {
      this.assertRoomOpen();
      this.assertSessionFence(participant, fence);
      let desired = this.resolvePublishedTracks(
        participant.id,
        desiredKeys,
      );
      const desiredByKey = new Map(
        desired.map((track) => [track.key, track]),
      );
      const remove = participant.subscriptions.filter(
        (subscription) => {
          const target = desiredByKey.get(subscription.key);
          return !target || !samePublication(subscription, target);
        },
      );
      if (remove.length > 0) {
        await this.closeMids(
          fence.session.id,
          remove.map((track) => track.mid),
        );
        this.assertSessionFence(participant, fence);
        const removedMids = new Set(remove.map((track) => track.mid));
        participant.subscriptions = participant.subscriptions.filter(
          (subscription) => !removedMids.has(subscription.mid),
        );
        desired = this.resolvePublishedTracks(participant.id, desiredKeys);
      }

      const currentByKey = new Map(
        participant.subscriptions.map((subscription) => [
          subscription.key,
          subscription,
        ]),
      );
      const add = desired.filter((track) => {
        const current = currentByKey.get(track.key);
        return !current || !samePublication(current, track);
      });
      if (add.length === 0) {
        participant.lastSeenAt = this.now();
        if (remove.length > 0) await this.changed();
        return {
          response: subscriptionResponse(
            mutationId,
            participant.subscriptions,
          ),
        };
      }

      this.assertPublicationTargetsCurrent(add);
      const rawResponse = await this.sfu.addTracks(fence.session.id, {
        tracks: add.map((track) => ({
          location: "remote",
          sessionId: track.producerSessionId,
          trackName: track.trackName,
        })),
      });
      const response = await this.acceptAddedTracks(
        fence.session,
        queue,
        rawResponse,
        "subscribe",
      );
      this.assertSessionFence(participant, fence);
      await this.ensurePublicationTargetsCurrent(fence, add);
      const responseTracks = indexTracks(response.tracks);
      for (const track of add) {
        const result = responseTracks.get(track.trackName);
        if (!result?.mid) {
          throw new RequestError(
            502,
            "subscribe_track_missing",
            "Realtime SFU did not identify a subscribed track.",
            true,
          );
        }
        participant.subscriptions.push({
          ...publicTrack(track),
          mid: result.mid,
          producerSessionId: track.producerSessionId,
          trackName: track.trackName,
        });
      }
      participant.lastSeenAt = this.now();

      const result = subscriptionResponse(
        mutationId,
        participant.subscriptions,
        response.sessionDescription,
        response.requiresImmediateRenegotiation === true,
      );
      if (result.requiresImmediateRenegotiation) {
        fence.session.pendingNegotiation = {
          expiresAt: this.now() + 15_000,
          mutationId,
        };
      }
      await this.changed();
      return {
        response: result,
        waitForAnswer: result.requiresImmediateRenegotiation
          ? (answer: SessionDescription) => this.completeAnswer(participant, fence, answer)
          : undefined,
      };
    });
  }

  async renegotiate(
    participant: Participant,
    { generation, mutationId, sessionDescription }: RenegotiateRequest,
  ): Promise<void> {
    this.captureSessionFence(participant, "consumer", generation);
    await this.queueFor(participant, "consumer").complete(
      mutationId,
      sessionDescription,
    );
  }

  async cleanupForLeave(participant: Participant): Promise<void> {
    const producerQueue = this.queueFor(participant, "producer");
    const consumerQueue = this.queueFor(participant, "consumer");
    if (producerQueue.isSealed || consumerQueue.isSealed) {
      await this.forceCleanup(participant);
      return;
    }
    const cleanup = Promise.all([
      producerQueue.enqueue(
        `leave-${participant.producer.generation}-producer`,
        async () => {
          await this.closeMids(
            participant.producer.id,
            participant.producer.mids,
          );
          return { response: undefined };
        },
      ),
      consumerQueue.enqueue(
        `leave-${participant.consumer.generation}-consumer`,
        async () => {
          await this.closeMids(
            participant.consumer.id,
            participant.consumer.mids,
          );
          return { response: undefined };
        },
      ),
    ]);
    producerQueue.seal();
    consumerQueue.seal();
    await cleanup;
  }

  async forceCleanup(participant: Participant): Promise<void> {
    const producerQueue = this.queueFor(participant, "producer");
    const consumerQueue = this.queueFor(participant, "consumer");
    participant.lifecycleVersion += 1;
    participant.producer.invalid = true;
    participant.consumer.invalid = true;
    await this.persist(this.room);
    producerQueue.invalidate();
    consumerQueue.invalidate();
    await Promise.all([producerQueue.onIdle(), consumerQueue.onIdle()]);
    const publicationsChanged = participant.published.length > 0;
    participant.published = [];
    participant.subscriptions = [];
    participant.consumer.pendingNegotiation = undefined;
    if (publicationsChanged) await this.changed();
    else await this.persist(this.room);
    const results = await Promise.allSettled([
      this.closeMids(participant.producer.id, participant.producer.mids),
      this.closeMids(participant.consumer.id, participant.consumer.mids),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    if (failure) throw failure.reason;
    this.dropQueues(participant.id);
  }

  dropQueues(participantId: string): void {
    for (const key of this.queues.keys()) {
      if (key.startsWith(`${participantId}:`)) this.queues.delete(key);
    }
  }

  resetQueues(): void {
    this.queues.clear();
  }

  private async closeMids(
    sessionId: string,
    mids: string[],
  ): Promise<void> {
    if (mids.length === 0) return;
    let rawResponse: SfuResponse;
    try {
      rawResponse = await this.sfu.closeTracks(sessionId, [...new Set(mids)]);
    } catch (error) {
      if (
        error instanceof SfuRequestError &&
        (error.status === 404 || error.status === 410)
      ) {
        return;
      }
      throw error;
    }
    const response = parseSfuCloseResponse(rawResponse);
    if (response.requiresImmediateRenegotiation) {
      throw new SessionQueueError(
        "cleanup_reconnect_required",
        "Cleanup required an unavailable SDP answer; replace this media session.",
      );
    }
  }

  private queueFor(
    participant: Participant,
    kind: QueueKind,
  ): SessionMutationQueue {
    const session = participant[kind];
    const key = `${participant.id}:${kind}:${session.generation}`;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new SessionMutationQueue(15_000, async () => {
        session.invalid = true;
        session.pendingNegotiation = undefined;
        await this.persist(this.room);
      });
      const pending = session.pendingNegotiation;
      if (pending) {
        const remaining = pending.expiresAt - this.now();
        if (remaining > 0) {
          const fence = { kind, lifecycleVersion: participant.lifecycleVersion, session };
          queue.restoreBlocked<SessionDescription>(
            pending.mutationId,
            (answer) => this.completeAnswer(participant, fence, answer),
            remaining,
          );
        } else {
          session.invalid = true;
        }
      }
      if (session.invalid) queue.invalidate();
      this.queues.set(key, queue);
    }
    return queue;
  }

  private async completeAnswer(
    participant: Participant,
    fence: SessionFence,
    answer: SessionDescription,
  ): Promise<void> {
    this.assertSessionFence(participant, fence);
    await this.sfu.renegotiate(fence.session.id, answer);
    this.assertSessionFence(participant, fence);
    fence.session.pendingNegotiation = undefined;
    fence.session.invalid = false;
    participant.lastSeenAt = this.now();
    await this.persist(this.room);
  }

  private captureSessionFence(
    participant: Participant,
    kind: QueueKind,
    generation: number,
  ): SessionFence {
    const session = participant[kind];
    if (
      participant.status !== "active" ||
      session.generation !== generation ||
      session.invalid
    ) {
      throw new RequestError(
        409,
        "media_generation_stale",
        "This media operation belongs to a stale session generation. Reconnect and retry.",
      );
    }
    return {
      kind,
      lifecycleVersion: participant.lifecycleVersion,
      session,
    };
  }

  private assertSessionFence(
    participant: Participant,
    fence: SessionFence,
  ): void {
    if (
      participant.status !== "active" ||
      participant.lifecycleVersion !== fence.lifecycleVersion ||
      participant[fence.kind] !== fence.session ||
      fence.session.invalid
    ) {
      throw new SessionQueueError(
        "media_generation_stale",
        "The media session changed while this operation was in flight.",
      );
    }
  }

  private async acceptAddedTracks(
    session: SessionState,
    queue: SessionMutationQueue,
    rawResponse: SfuResponse,
    operation: "publish" | "subscribe",
    requestedMids: string[] = [],
  ): Promise<SfuTracksResponse> {
    const midsChanged = this.recordMids(session, requestedMids, rawResponse);
    let response: SfuTracksResponse;
    try {
      response = parseSfuTracksResponse(rawResponse, operation);
    } catch (error) {
      session.invalid = true;
      queue.invalidate();
      await this.persist(this.room);
      throw error;
    }
    if (midsChanged) await this.persist(this.room);
    return response;
  }

  private async ensurePublicationTargetsCurrent(
    fence: SessionFence,
    targets: PublishedTrack[],
  ): Promise<void> {
    try {
      this.assertPublicationTargetsCurrent(targets);
    } catch (error) {
      fence.session.invalid = true;
      await this.persist(this.room);
      throw error;
    }
  }

  private recordMids(
    session: SessionState,
    requestedMids: string[],
    response: SfuResponse,
  ): boolean {
    const mids = [
      ...new Set([
        ...session.mids,
        ...requestedMids,
        ...sfuTrackMids(response),
      ]),
    ];
    if (
      mids.length === session.mids.length &&
      mids.every((mid, index) => mid === session.mids[index])
    ) {
      return false;
    }
    session.mids = mids;
    return true;
  }

  private resolvePublishedTracks(
    participantId: string,
    desiredKeys: Set<string>,
  ): PublishedTrack[] {
    const available = new Map(
      Object.values(this.room.participants)
        .filter(
          (candidate) =>
            candidate.status === "active" && candidate.id !== participantId,
        )
        .flatMap((candidate) => candidate.published)
        .map((track) => [track.key, track]),
    );
    return [...desiredKeys]
      .map((key) => available.get(key))
      .filter((track): track is PublishedTrack => Boolean(track))
      .map((track) => ({ ...track }));
  }

  private assertPublicationTargetsCurrent(
    targets: PublishedTrack[],
  ): void {
    for (const target of targets) {
      const participant = this.room.participants[target.participantId];
      const current = participant?.published.find(
        (track) => track.key === target.key,
      );
      if (
        participant?.status !== "active" ||
        participant.producer.id !== target.producerSessionId ||
        !current ||
        !samePublication(current, target)
      ) {
        throw new SessionQueueError(
          "publication_changed",
          "A publication changed while the subscription was being updated. Reconnect and retry.",
        );
      }
    }
  }
}

function samePublication(
  left: Pick<PublishedTrack | Subscription, "producerSessionId" | "trackName">,
  right: Pick<PublishedTrack | Subscription, "producerSessionId" | "trackName">,
): boolean {
  return (
    left.producerSessionId === right.producerSessionId &&
    left.trackName === right.trackName
  );
}

function subscriptionResponse(
  mutationId: string,
  subscriptions: Subscription[],
  sessionDescription?: SessionDescription,
  requiresImmediateRenegotiation = false,
): SubscriptionResponse {
  const fields = {
    mutationId,
    subscriptions: subscriptions.map(({ key, kind, mid, participantId }) => ({
      key,
      kind,
      mid,
      participantId,
    })),
  };
  if (requiresImmediateRenegotiation) {
    if (sessionDescription?.type !== "offer") {
      throw new RequestError(
        502,
        "subscribe_offer_missing",
        "Realtime SFU required renegotiation without returning an SDP offer.",
        true,
      );
    }
    return { ...fields, requiresImmediateRenegotiation: true, sessionDescription };
  }
  return { ...fields, requiresImmediateRenegotiation: false, sessionDescription };
}

function indexTracks(
  tracks: SfuTrack[] | undefined,
): Map<string, SfuTrack> {
  return new Map(
    (tracks ?? [])
      .filter((track) => track.trackName)
      .map((track) => [track.trackName!, track]),
  );
}

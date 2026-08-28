import {
  type MediaKind,
  type PublishResponse,
  type SessionDescription,
  type SubscriptionResponse,
  isMediaKind,
  isSessionDescription,
} from "../shared/protocol";
import { RequestError } from "./auth";
import {
  hasSfuError,
  SfuRequestError,
  type SfuClient,
  type SfuTrack,
  type SfuTracksResponse,
  sfuResponseError,
} from "./realtime";
import {
  MUTATION_ID,
  boundedString,
  objectBody,
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

const TRACK_KEY = /^p_[a-zA-Z0-9]+:(?:audio|video)$/;
const MID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

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
    input: unknown,
  ): Promise<PublishResponse> {
    const body = objectBody(input);
    const mutationId = boundedString(
      body.mutationId,
      "mutationId",
      MUTATION_ID,
    );
    const generation = boundedGeneration(body.generation);
    const fence = this.captureSessionFence(
      participant,
      "producer",
      generation,
    );
    if (!isSessionDescription(body.sessionDescription, "offer")) {
      throw new RequestError(
        400,
        "offer_invalid",
        "Publishing requires a valid SDP offer.",
      );
    }
    const tracks = arrayBody(body.tracks, "tracks");
    if (tracks.length < 1 || tracks.length > 2) {
      throw new RequestError(
        400,
        "publish_tracks_invalid",
        "Publish one audio track, one video track, or both.",
      );
    }
    const seenKinds = new Set<MediaKind>();
    const requested = tracks.map((value) => {
      const track = objectBody(value);
      if (!isMediaKind(track.kind) || seenKinds.has(track.kind)) {
        throw new RequestError(
          400,
          "publish_tracks_invalid",
          "Publish at most one track of each media kind.",
        );
      }
      seenKinds.add(track.kind);
      return {
        kind: track.kind,
        mid: boundedString(track.mid, "mid", MID),
      };
    });
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
      const names = requested.map(({ kind, mid }) => ({
        key: `${participant.id}:${kind}`,
        kind,
        mid,
        trackName: `${participant.id}-${fence.session.generation}-${kind}`,
      }));
      const response = await this.sfu.addTracks(fence.session.id, {
        sessionDescription: body.sessionDescription,
        tracks: names.map(({ mid, trackName }) => ({
          location: "local",
          mid,
          trackName,
        })),
      });
      const midsChanged = this.recordMids(
        fence.session,
        names.map((track) => track.mid),
        response,
      );
      const itemError = trackItemError(response, "publish");
      if (itemError) {
        fence.session.invalid = true;
        queue.invalidate();
        await this.persist(this.room);
        throw itemError;
      }
      if (midsChanged) await this.persist(this.room);
      assertTrackResponse(response, "publish");
      await this.ensureSessionFence(participant, fence);
      if (
        response.requiresImmediateRenegotiation ||
        !isSessionDescription(response.sessionDescription, "answer")
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
    input: unknown,
  ): Promise<SubscriptionResponse> {
    const body = objectBody(input);
    const mutationId = boundedString(
      body.mutationId,
      "mutationId",
      MUTATION_ID,
    );
    const generation = boundedGeneration(body.generation);
    const fence = this.captureSessionFence(
      participant,
      "consumer",
      generation,
    );
    const desiredKeys = new Set(
      arrayBody(body.trackKeys, "trackKeys").map((value) =>
        boundedString(value, "track key", TRACK_KEY),
      ),
    );
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
      const response = await this.sfu.addTracks(fence.session.id, {
        tracks: add.map((track) => ({
          location: "remote",
          sessionId: track.producerSessionId,
          trackName: track.trackName,
        })),
      });
      const midsChanged = this.recordMids(fence.session, [], response);
      const itemError = trackItemError(response, "subscribe");
      if (itemError) {
        fence.session.invalid = true;
        queue.invalidate();
        await this.persist(this.room);
        throw itemError;
      }
      if (midsChanged) await this.persist(this.room);
      assertTrackResponse(response, "subscribe");
      await this.ensureSessionFence(participant, fence);
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

      const immediate = response.requiresImmediateRenegotiation === true;
      if (
        immediate &&
        !isSessionDescription(response.sessionDescription, "offer")
      ) {
        throw new RequestError(
          502,
          "subscribe_offer_missing",
          "Realtime SFU required renegotiation without returning an SDP offer.",
          true,
        );
      }
      if (immediate) {
        fence.session.pendingNegotiation = {
          expiresAt: this.now() + 15_000,
          mutationId,
        };
      }
      await this.changed();
      return {
        response: subscriptionResponse(
          mutationId,
          participant.subscriptions,
          response.sessionDescription,
          immediate,
        ),
        waitForAnswer: immediate
          ? async (answer: SessionDescription) => {
              if (!isSessionDescription(answer, "answer")) {
                throw new RequestError(
                  400,
                  "answer_invalid",
                  "Renegotiation requires a valid SDP answer.",
                );
              }
              this.assertSessionFence(participant, fence);
              await this.sfu.renegotiate(fence.session.id, answer);
              this.assertSessionFence(participant, fence);
              fence.session.pendingNegotiation = undefined;
              fence.session.invalid = false;
              participant.lastSeenAt = this.now();
              await this.persist(this.room);
            }
          : undefined,
      };
    });
  }

  async renegotiate(
    participant: Participant,
    input: unknown,
  ): Promise<void> {
    const body = objectBody(input);
    const mutationId = boundedString(
      body.mutationId,
      "mutationId",
      MUTATION_ID,
    );
    const generation = boundedGeneration(body.generation);
    this.captureSessionFence(participant, "consumer", generation);
    if (!isSessionDescription(body.sessionDescription, "answer")) {
      throw new RequestError(
        400,
        "answer_invalid",
        "Renegotiation requires a valid SDP answer.",
      );
    }
    await this.queueFor(participant, "consumer").complete(
      mutationId,
      body.sessionDescription,
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
    let response: SfuTracksResponse;
    try {
      response = await this.sfu.closeTracks(sessionId, [...new Set(mids)]);
    } catch (error) {
      if (
        error instanceof SfuRequestError &&
        (error.status === 404 || error.status === 410)
      ) {
        return;
      }
      throw error;
    }
    assertTrackResponse(response, "close", isAlreadyClosedTrackError);
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
          queue.restoreBlocked<SessionDescription>(
            pending.mutationId,
            async (answer) => {
              await this.sfu.renegotiate(session.id, answer);
              session.pendingNegotiation = undefined;
              session.invalid = false;
              await this.persist(this.room);
            },
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

  private async ensureSessionFence(
    participant: Participant,
    fence: SessionFence,
  ): Promise<void> {
    try {
      this.assertSessionFence(participant, fence);
    } catch (error) {
      await this.persist(this.room);
      throw error;
    }
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
    response: SfuTracksResponse,
  ): boolean {
    const mids = [
      ...new Set([
        ...session.mids,
        ...requestedMids,
        ...(response.tracks ?? [])
          .map((track) => track.mid)
          .filter(Boolean),
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
  return {
    mutationId,
    requiresImmediateRenegotiation,
    sessionDescription,
    subscriptions: subscriptions.map(({ key, kind, mid, participantId }) => ({
      key,
      kind,
      mid,
      participantId,
    })),
  };
}

function assertTrackResponse(
  response: SfuTracksResponse,
  operation: string,
  ignoreItem: (track: SfuTrack) => boolean = () => false,
): void {
  if (hasSfuError(response)) {
    throw sfuResponseError(
      response,
      `Realtime SFU ${operation} failed. Retry with the request ID.`,
    );
  }
  const itemError = trackItemError(response, operation, ignoreItem);
  if (itemError) throw itemError;
}

function isAlreadyClosedTrackError(track: SfuTrack): boolean {
  return track.errorCode === "close_track_error";
}

function trackItemError(
  response: SfuTracksResponse,
  operation: string,
  ignoreItem: (track: SfuTrack) => boolean = () => false,
): SfuRequestError | undefined {
  for (const track of response.tracks ?? []) {
    if (!hasSfuError(track) || ignoreItem(track)) continue;
    return sfuResponseError(
      track,
      `Realtime SFU ${operation} failed for a track. Retry with the request ID.`,
    );
  }
  return undefined;
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

function arrayBody(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RequestError(400, "body_invalid", `${name} must be an array.`);
  }
  return value;
}

function boundedGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RequestError(
      400,
      "generation_invalid",
      "A positive media generation is required.",
    );
  }
  return value as number;
}

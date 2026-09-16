import {
  type JoinRequest,
  type JoinResponse,
  type PublishRequest,
  type PublishResponse,
  type ReconnectRequest,
  type RenegotiateRequest,
  type RoomSnapshot,
  type SocketTicketResponse,
  type SubscribeRequest,
  type SubscriptionResponse,
} from "../shared/protocol";
import { RequestError } from "./auth";
import type { SfuClient } from "./realtime";
import {
  SOCKET_TICKET,
  type SocketAttachment,
} from "./notifications";
import { KeyedLifecycleQueue } from "./lifecycle-queue";
import { RoomMedia } from "./room-media";
import {
  emptyRoom,
  publicTrack,
  sessionState,
  type Participant,
  type PersistedRoom,
  type RoomPhase,
} from "./room-state";
const TOMBSTONE_MS = 5 * 60_000;
const SOCKET_TICKET_TTL_MS = 30_000;
const ROOM_LIFECYCLE_KEY = "room";
const RECONNECT_REQUEST_HISTORY_CAPACITY = 8;
const TERMINATING_RETRY_MS = 5_000;

export { emptyRoom };
export type { PersistedRoom, RoomPhase };

export type RoomDeletionLease = {
  phase: RoomPhase;
  revision: number;
};

type Principal = {
  displayHint: string;
  subject: string;
};

type RoomDependencies = {
  closeParticipantSockets?: (participantId: string) => void;
  now?: () => number;
  notifyRevision?: (revision: number) => Promise<void> | void;
  persist: (room: PersistedRoom) => Promise<void>;
  randomId?: () => string;
  randomToken?: () => string;
  sfu: SfuClient;
  staleMs: number;
};

export class RoomCoordinator {
  private readonly closeParticipantSockets?: (participantId: string) => void;
  private readonly lifecycle = new KeyedLifecycleQueue();
  private readonly media: RoomMedia;
  private readonly now: () => number;
  private readonly notifyRevision?: (revision: number) => Promise<void> | void;
  private readonly persist: (room: PersistedRoom) => Promise<void>;
  private readonly randomId: () => string;
  private readonly randomToken: () => string;
  private readonly sfu: SfuClient;
  private readonly staleMs: number;

  constructor(
    private readonly room: PersistedRoom,
    dependencies: RoomDependencies,
  ) {
    this.closeParticipantSockets = dependencies.closeParticipantSockets;
    this.now = dependencies.now ?? Date.now;
    this.notifyRevision = dependencies.notifyRevision;
    this.persist = dependencies.persist;
    this.randomId = dependencies.randomId ?? (() => crypto.randomUUID());
    this.randomToken = dependencies.randomToken ?? createToken;
    this.sfu = dependencies.sfu;
    this.staleMs = dependencies.staleMs;
    this.media = new RoomMedia(
      this.room,
      this.sfu,
      (room) => this.persist(room),
      () => this.now(),
      () => this.assertRoomOpen(),
      () => this.changed(),
    );
  }

  snapshot(): RoomSnapshot {
    return {
      creatorParticipantId: this.room.creatorParticipantId,
      participants: Object.values(this.room.participants)
        .filter((participant) => participant.status === "active")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((participant) => ({
          displayName: participant.displayName,
          id: participant.id,
          published: participant.published.map(publicTrack),
        })),
      revision: this.room.revision,
      roomId: this.room.roomId,
      terminated: this.room.phase === "terminated",
    };
  }

  async join(
    principal: Principal,
    { clientId, displayName, memberToken }: JoinRequest,
  ): Promise<JoinResponse> {
    const memberTokenHash = await tokenHash(memberToken);
    return this.lifecycle.run(
      ROOM_LIFECYCLE_KEY,
      `join:${principal.subject}:${clientId}:${memberTokenHash}`,
      async () => {
        this.assertRoomOpen();
        const duplicate = Object.values(this.room.participants).find(
          (participant) =>
            participant.subject === principal.subject &&
            participant.clientId === clientId &&
            participant.status === "active",
        );
        if (duplicate) {
          if (duplicate.tokenHash === memberTokenHash) {
            return this.joinResponse(duplicate, memberToken);
          }
          throw new RequestError(
            409,
            "resume_required",
            "This browser is already joined. Reconnect with its member token.",
            true,
          );
        }

        const [producerId, consumerId] = await Promise.all([
          this.sfu.createSession(),
          this.sfu.createSession(),
        ]);
        this.assertRoomOpen();
        const id = `p_${this.randomId().replaceAll("-", "").slice(0, 20)}`;
        const participant: Participant = {
          clientId,
          consumer: sessionState(consumerId, 1),
          completedReconnectRequestIds: [],
          displayName,
          id,
          lastSeenAt: this.now(),
          lifecycleVersion: 1,
          producer: sessionState(producerId, 1),
          published: [],
          status: "active",
          subject: principal.subject,
          subscriptions: [],
          tokenHash: memberTokenHash,
        };
        this.room.participants[id] = participant;
        if (this.room.creatorParticipantId === null) {
          this.room.creatorParticipantId = id;
        }
        await this.changed();
        return this.joinResponse(participant, memberToken);
      },
    );
  }

  async reconnect(
    principal: Principal,
    memberToken: string | null,
    { clientId, displayName, requestId }: ReconnectRequest,
  ): Promise<JoinResponse> {
    const participant = await this.authorize(principal, memberToken);
    if (participant.clientId !== clientId) {
      throw new RequestError(
        403,
        "client_mismatch",
        "This member token belongs to a different browser identity.",
      );
    }
    return this.lifecycle.run(
      `participant:${participant.id}`,
      `reconnect:${requestId}`,
      async () => {
        await this.reauthorize(participant, principal, memberToken);
        this.assertRoomOpen();
        if (participant.completedReconnectRequestIds.includes(requestId)) {
          return this.joinResponse(participant, memberToken!);
        }

        await this.media.forceCleanup(participant);
        const generation =
          Math.max(
            participant.producer.generation,
            participant.consumer.generation,
          ) + 1;
        const [producerId, consumerId] = await Promise.all([
          this.sfu.createSession(),
          this.sfu.createSession(),
        ]);
        this.assertRoomOpen();
        participant.producer = sessionState(producerId, generation);
        participant.consumer = sessionState(consumerId, generation);
        participant.displayName = displayName;
        participant.completedReconnectRequestIds = [
          ...participant.completedReconnectRequestIds,
          requestId,
        ].slice(-RECONNECT_REQUEST_HISTORY_CAPACITY);
        participant.lastSeenAt = this.now();
        participant.lifecycleVersion += 1;
        await this.changed();
        return this.joinResponse(participant, memberToken!);
      },
    );
  }

  async heartbeat(
    principal: Principal,
    memberToken: string | null,
  ): Promise<RoomSnapshot> {
    const participant = await this.authorize(
      principal,
      memberToken,
      this.room.phase === "terminated",
    );
    return this.lifecycle.run(
      `participant:${participant.id}`,
      `heartbeat:${participant.lifecycleVersion}`,
      async () => {
        await this.reauthorize(
          participant,
          principal,
          memberToken,
          this.room.phase === "terminated",
        );
        if (this.room.phase !== "open") return this.snapshot();
        participant.lastSeenAt = this.now();
        await this.persist(this.room);
        return this.snapshot();
      },
    );
  }

  async getSnapshot(
    principal: Principal,
    memberToken: string | null,
  ): Promise<RoomSnapshot> {
    await this.authorize(
      principal,
      memberToken,
      this.room.phase === "terminated",
    );
    return this.snapshot();
  }

  async issueSocketTicket(
    principal: Principal,
    memberToken: string | null,
  ): Promise<SocketTicketResponse> {
    this.assertRoomOpen();
    const participant = await this.authorize(principal, memberToken);
    const now = this.now();
    this.pruneSocketTickets(now);
    this.revokeSocketTickets(participant.id);
    const ticket = this.randomToken();
    if (!SOCKET_TICKET.test(ticket)) {
      throw new Error("Notification ticket generation violated its invariant.");
    }
    const expiresAt = now + SOCKET_TICKET_TTL_MS;
    this.room.socketTickets[await tokenHash(ticket)] = {
      expiresAt,
      participantId: participant.id,
    };
    await this.persist(this.room);
    return { expiresAt, ticket };
  }

  async consumeSocketTicket(ticket: string): Promise<SocketAttachment> {
    if (!SOCKET_TICKET.test(ticket)) {
      throw new RequestError(
        401,
        "socket_ticket_invalid",
        "The notification ticket is invalid or already used.",
      );
    }
    const hash = await tokenHash(ticket);
    const record = this.room.socketTickets[hash];
    if (!record) {
      throw new RequestError(
        401,
        "socket_ticket_invalid",
        "The notification ticket is invalid or already used.",
      );
    }
    delete this.room.socketTickets[hash];
    await this.persist(this.room);
    if (record.expiresAt <= this.now()) {
      throw new RequestError(
        401,
        "socket_ticket_expired",
        "The notification ticket expired. Request another ticket.",
        true,
      );
    }
    const participant = this.room.participants[record.participantId];
    if (!participant || participant.status !== "active") {
      throw new RequestError(
        401,
        "socket_ticket_invalid",
        "The notification membership is no longer active.",
      );
    }
    return { participantId: participant.id };
  }

  async publish(
    principal: Principal,
    memberToken: string | null,
    input: PublishRequest,
  ): Promise<PublishResponse> {
    const participant = await this.authorize(principal, memberToken);
    return this.media.publish(participant, input);
  }

  async subscribe(
    principal: Principal,
    memberToken: string | null,
    input: SubscribeRequest,
  ): Promise<SubscriptionResponse> {
    const participant = await this.authorize(principal, memberToken);
    return this.media.subscribe(participant, input);
  }

  async renegotiate(
    principal: Principal,
    memberToken: string | null,
    input: RenegotiateRequest,
  ): Promise<void> {
    const participant = await this.authorize(principal, memberToken);
    await this.media.renegotiate(participant, input);
  }

  async leave(
    principal: Principal,
    memberToken: string | null,
  ): Promise<RoomSnapshot> {
    const participant = await this.authorize(principal, memberToken, true);
    return this.lifecycle.run(
      `participant:${participant.id}`,
      `leave:${participant.lifecycleVersion}`,
      async () => {
        await this.reauthorize(participant, principal, memberToken, true);
        if (participant.status === "left") return this.snapshot();
        await this.media.cleanupForLeave(participant);
        this.markLeft(participant);
        await this.changed();
        return this.snapshot();
      },
    );
  }

  async terminate(
    principal: Principal,
    memberToken: string | null,
  ): Promise<RoomSnapshot> {
    const authorizationId = await lifecycleAuthorizationId(memberToken);
    return this.lifecycle.run(
      ROOM_LIFECYCLE_KEY,
      `terminate:${principal.subject}:${authorizationId}`,
      async () => {
        const participant = await this.authorize(
          principal,
          memberToken,
          true,
        );
        this.assertCreator(participant);
        if (this.room.phase === "terminated") return this.snapshot();
        if (this.room.phase === "open") {
          this.room.phase = "terminating";
          await this.changed();
        }

        await this.finishTermination();
        return this.snapshot();
      },
    );
  }

  async expireStale(): Promise<RoomDeletionLease | null> {
    if (this.room.phase === "terminating") {
      await this.lifecycle.run(
        ROOM_LIFECYCLE_KEY,
        `alarm-terminate:${this.room.revision}`,
        async () => {
          if (this.room.phase === "terminating") {
            await this.finishTermination();
          }
        },
      );
    }
    const now = this.now();
    let changed = false;
    const ticketsChanged = this.pruneSocketTickets(now);
    for (const participant of Object.values(this.room.participants)) {
      const observedLastSeen = participant.lastSeenAt;
      const observedLeftAt = participant.leftAt;
      if (participant.status === "active") {
        const expired = await this.lifecycle.run(
          `participant:${participant.id}`,
          `stale:${observedLastSeen}`,
          async () => {
            if (
              participant.status !== "active" ||
              participant.lastSeenAt !== observedLastSeen ||
              now - participant.lastSeenAt < this.staleMs
            ) {
              return false;
            }
            await this.media.forceCleanup(participant);
            this.markLeft(participant);
            return true;
          },
        );
        changed = changed || expired;
      }
      if (
        this.room.phase !== "terminating" &&
        participant.status === "left" &&
        observedLeftAt &&
        now - observedLeftAt >= TOMBSTONE_MS
      ) {
        const deleted = await this.lifecycle.run(
          `participant:${participant.id}`,
          `delete:${observedLeftAt}`,
          async () => {
            if (
              participant.status !== "left" ||
              participant.leftAt !== observedLeftAt
            ) {
              return false;
            }
            delete this.room.participants[participant.id];
            return true;
          },
        );
        changed = changed || deleted;
      }
    }
    if (
      Object.keys(this.room.participants).length === 0 &&
      this.room.creatorParticipantId !== null
    ) {
      this.room.creatorParticipantId = null;
      changed = true;
    }
    if (changed) await this.changed();
    else if (ticketsChanged) await this.persist(this.room);
    return this.deletionLease(now);
  }

  async deleteWithLease(
    lease: RoomDeletionLease,
    clear: () => Promise<void>,
  ): Promise<boolean> {
    return this.lifecycle.run(
      ROOM_LIFECYCLE_KEY,
      `delete:${lease.phase}:${lease.revision}`,
      async () => {
        const current = this.deletionLease(this.now());
        if (
          !current ||
          current.phase !== lease.phase ||
          current.revision !== lease.revision
        ) {
          return false;
        }
        await clear();
        this.resetAfterDeletion();
        return true;
      },
    );
  }

  nextAlarmAt(): number {
    const now = this.now();
    if (this.room.phase === "terminating") {
      return now + TERMINATING_RETRY_MS;
    }
    const deadlines = Object.values(this.room.participants).map((participant) =>
      participant.status === "active"
        ? participant.lastSeenAt + this.staleMs
        : (participant.leftAt ?? now) + TOMBSTONE_MS,
    );
    if (this.room.phase === "terminated" && this.room.terminatedAt) {
      deadlines.push(this.room.terminatedAt + TOMBSTONE_MS);
    }
    deadlines.push(
      ...Object.values(this.room.socketTickets).map(
        (ticket) => ticket.expiresAt,
      ),
    );
    return Math.min(...deadlines, now + this.staleMs);
  }

  private async authorize(
    principal: Principal,
    token: string | null,
    includeLeft = false,
  ): Promise<Participant> {
    if (!token || token.length > 256) {
      throw new RequestError(
        401,
        "member_token_required",
        "Join the room before using this operation.",
      );
    }
    const hash = await tokenHash(token);
    const participant = Object.values(this.room.participants).find(
      (candidate) =>
        candidate.subject === principal.subject &&
        candidate.tokenHash === hash &&
        (includeLeft || candidate.status === "active"),
    );
    if (!participant) {
      throw new RequestError(
        403,
        "member_token_invalid",
        "This room operation is not authorized for the current participant.",
      );
    }
    return participant;
  }

  private assertRoomOpen(): void {
    if (this.room.phase === "terminating") {
      throw new RequestError(
        409,
        "room_terminating",
        "This room is being terminated and cannot accept new operations.",
      );
    }
    if (this.room.phase === "terminated") {
      throw new RequestError(
        410,
        "room_terminated",
        "This room was terminated. Use a different room URL or wait for cleanup.",
      );
    }
  }

  private assertCreator(participant: Participant): void {
    if (this.room.creatorParticipantId !== participant.id) {
      throw new RequestError(
        403,
        "creator_required",
        "Only the room creator can terminate this room.",
      );
    }
  }

  private async changed(): Promise<void> {
    this.room.revision += 1;
    await this.persist(this.room);
    await this.notifyRevision?.(this.room.revision);
  }

  private async finishTermination(): Promise<void> {
    const socketClosures: string[] = [];
    const terminationRevision = this.room.revision;
    for (const candidate of Object.values(this.room.participants)) {
      await this.lifecycle.run(
        `participant:${candidate.id}`,
        `terminate:${terminationRevision}`,
        async () => {
          if (candidate.status !== "active") return;
          await this.media.forceCleanup(candidate);
        },
      );
    }
    for (const candidate of Object.values(this.room.participants)) {
      if (candidate.status !== "active") continue;
      this.markLeft(candidate, false);
      socketClosures.push(candidate.id);
    }
    this.room.phase = "terminated";
    this.room.terminatedAt = this.now();
    await this.changed();
    for (const participantId of socketClosures) {
      this.closeParticipantSockets?.(participantId);
    }
  }

  private markLeft(
    participant: Participant,
    closeSocket = true,
  ): void {
    participant.lifecycleVersion += 1;
    participant.status = "left";
    participant.leftAt = this.now();
    participant.published = [];
    participant.subscriptions = [];
    participant.producer.mids = [];
    participant.consumer.mids = [];
    participant.producer.invalid = true;
    participant.consumer.invalid = true;
    participant.consumer.pendingNegotiation = undefined;
    this.revokeSocketTickets(participant.id);
    this.media.dropQueues(participant.id);
    if (closeSocket) this.closeParticipantSockets?.(participant.id);
  }

  private revokeSocketTickets(participantId: string): void {
    for (const [hash, ticket] of Object.entries(this.room.socketTickets)) {
      if (ticket.participantId === participantId) {
        delete this.room.socketTickets[hash];
      }
    }
  }

  private deletionLease(now: number): RoomDeletionLease | null {
    if (
      this.room.phase === "terminating" ||
      Object.keys(this.room.participants).length > 0 ||
      Object.keys(this.room.socketTickets).length > 0
    ) {
      return null;
    }
    if (
      this.room.phase === "terminated" &&
      (!this.room.terminatedAt ||
        now - this.room.terminatedAt < TOMBSTONE_MS)
    ) {
      return null;
    }
    return {
      phase: this.room.phase,
      revision: this.room.revision,
    };
  }

  private async reauthorize(
    participant: Participant,
    principal: Principal,
    memberToken: string | null,
    includeLeft = false,
  ): Promise<void> {
    const current = await this.authorize(
      principal,
      memberToken,
      includeLeft,
    );
    if (current !== participant) {
      throw new RequestError(
        403,
        "member_token_invalid",
        "This room membership has expired.",
      );
    }
  }

  private resetAfterDeletion(): void {
    this.room.creatorParticipantId = null;
    this.room.participants = {};
    this.room.phase = "open";
    this.room.revision = 0;
    this.room.socketTickets = {};
    delete this.room.terminatedAt;
    this.media.resetQueues();
  }

  private pruneSocketTickets(now: number): boolean {
    let changed = false;
    for (const [hash, ticket] of Object.entries(this.room.socketTickets)) {
      const participant = this.room.participants[ticket.participantId];
      if (
        ticket.expiresAt <= now ||
        !participant ||
        participant.status !== "active"
      ) {
        delete this.room.socketTickets[hash];
        changed = true;
      }
    }
    return changed;
  }

  private joinResponse(
    participant: Participant,
    memberToken: string,
  ): JoinResponse {
    return {
      generation: Math.max(
        participant.producer.generation,
        participant.consumer.generation,
      ),
      memberToken,
      participantId: participant.id,
      snapshot: this.snapshot(),
    };
  }
}

function createToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(bytes);
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

async function lifecycleAuthorizationId(token: string | null): Promise<string> {
  if (!token || token.length > 256) return "invalid";
  return tokenHash(token);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

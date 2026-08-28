import type { TrackReference } from "../shared/protocol";
import { RequestError } from "./auth";

export const MUTATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/;
export type RoomPhase = "open" | "terminated" | "terminating";

export type SessionState = {
  generation: number;
  id: string;
  invalid?: boolean;
  mids: string[];
  pendingNegotiation?: {
    expiresAt: number;
    mutationId: string;
  };
};

export type PublishedTrack = TrackReference & {
  mid: string;
  producerSessionId: string;
  trackName: string;
};

export type Subscription = TrackReference & {
  mid: string;
  producerSessionId: string;
  trackName: string;
};

export type Participant = {
  clientId: string;
  consumer: SessionState;
  completedReconnectRequestIds: string[];
  displayName: string;
  id: string;
  lastSeenAt: number;
  leftAt?: number;
  lifecycleVersion: number;
  producer: SessionState;
  published: PublishedTrack[];
  status: "active" | "left";
  subject: string;
  subscriptions: Subscription[];
  tokenHash: string;
};

export type SocketTicketRecord = {
  expiresAt: number;
  participantId: string;
};

export type PersistedRoom = {
  creatorParticipantId: string | null;
  participants: Record<string, Participant>;
  phase: RoomPhase;
  revision: number;
  roomId: string;
  socketTickets: Record<string, SocketTicketRecord>;
  terminatedAt?: number;
};

export function emptyRoom(roomId: string): PersistedRoom {
  return {
    creatorParticipantId: null,
    participants: {},
    phase: "open",
    revision: 0,
    roomId,
    socketTickets: {},
  };
}

export function sessionState(
  id: string,
  generation: number,
): SessionState {
  return { generation, id, mids: [] };
}

export function publicTrack(track: TrackReference): TrackReference {
  return {
    key: track.key,
    kind: track.kind,
    participantId: track.participantId,
  };
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "body_invalid", "Send a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function boundedString(
  value: unknown,
  name: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RequestError(400, "input_invalid", `${name} is invalid.`);
  }
  return value;
}

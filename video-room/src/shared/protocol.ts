export type MediaKind = "audio" | "video";
export type SessionDescription = {
  sdp: string;
  type: "answer" | "offer";
};

export type TrackReference = {
  key: string;
  kind: MediaKind;
  participantId: string;
};

export type ParticipantView = {
  displayName: string;
  id: string;
  published: TrackReference[];
};

export type RoomSnapshot = {
  creatorParticipantId: string | null;
  participants: ParticipantView[];
  revision: number;
  roomId: string;
  terminated: boolean;
};

export type JoinResponse = {
  generation: number;
  memberToken: string;
  participantId: string;
  snapshot: RoomSnapshot;
};

export type PublishResponse = {
  mutationId: string;
  sessionDescription: SessionDescription;
  tracks: Array<{
    key: string;
    kind: MediaKind;
    mid: string;
  }>;
};

export type SubscriptionResponse = {
  mutationId: string;
  requiresImmediateRenegotiation: boolean;
  sessionDescription?: SessionDescription;
  subscriptions: Array<TrackReference & { mid: string }>;
};

export type SocketTicketResponse = {
  expiresAt: number;
  ticket: string;
};

export type RoomChangedNotification = {
  revision: number;
  type: "room-changed";
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
  };
};

export const API_HEADER_MEMBER_TOKEN = "x-room-member-token";
export const API_HEADER_LOCAL_IDENTITY = "x-video-room-local-identity";
export const ROOM_SOCKET_PROTOCOL = "video-room-notify-v1";
export const ROOM_SOCKET_TICKET_PREFIX = "ticket.";

export function isMediaKind(value: unknown): value is MediaKind {
  return value === "audio" || value === "video";
}

export function isSessionDescription(
  value: unknown,
  expectedType?: SessionDescription["type"],
): value is SessionDescription {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sdp === "string" &&
    candidate.sdp.length > 0 &&
    candidate.sdp.length <= 1_000_000 &&
    (candidate.type === "offer" || candidate.type === "answer") &&
    (!expectedType || candidate.type === expectedType)
  );
}

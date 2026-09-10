export const GAME_SETTINGS = {
  fps: 30,
  height: 600,
  title: "Freedoom",
  width: 800,
} as const;

export const PUBLISHER_HOST = "realtime.internal";
export const PUBLISHER_API_PREFIX = "/v1/game-runs";
export const SFU_SERVER_EVENTS_CHANNEL = "server-events";

export const API_HEADER_LOCAL_IDENTITY = "x-cloud-gaming-local-identity";
export const API_HEADER_VIEWER_CAPABILITY = "x-cloud-gaming-viewer-capability";
export const API_HEADER_VIEWER_ID = "x-cloud-gaming-viewer-id";

export type MediaKind = "audio" | "video";
export type InputKind = "keyboard" | "pointer";
export type RunStatus =
  | "failed"
  | "running"
  | "starting"
  | "stopped"
  | "stopping";

export type SessionDescription = {
  sdp: string;
  type: "answer" | "offer";
};

export type GameSnapshot = {
  cleanupPending: boolean;
  controllerGeneration: number;
  expiresAt?: number;
  hasController: boolean;
  runGeneration: number;
  runId?: string;
  settings: typeof GAME_SETTINGS;
  startedAt?: number;
  status: RunStatus;
  viewerCount: number;
};

export type ViewerJoinRequest = {
  sessionDescription: SessionDescription;
};

export type ViewerJoinResponse = {
  expiresAt: number;
  runGeneration: number;
  runId: string;
  sessionDescription: SessionDescription;
  tracks: Array<{
    kind: MediaKind;
    mid: string;
  }>;
  viewerCapability: string;
  viewerId: string;
};

export type ViewerHeartbeatResponse = {
  ok: true;
};

export type ViewerLeaveResponse = {
  cleanupPending: boolean;
  left: true;
};

export type ViewerTransportResponse = {
  sessionDescription: SessionDescription;
};

export type ControlInputChannel = {
  dataChannelName: string;
  id: number;
  kind: InputKind;
  maxRetransmits?: number;
  ordered: boolean;
};

export type ControlClaimResponse = {
  leaseGeneration: number;
};

export type ControlLeaseResponse = {
  cleanupPending: boolean;
  leaseGeneration: number;
  released: boolean;
};

export type ViewerInputResponse = {
  inputs: ControlInputChannel[];
};

export type ViewerTransportCompleteRequest = {
  sessionDescription: SessionDescription;
};

export type PublisherRegisterResponse = {
  sessionId: string;
};

export type PublisherAckResponse = {
  ok: true;
};

export type PublisherRegisterRequest = {
  viewport: {
    fps: number;
    height: number;
    width: number;
  };
};

export type PublisherPublishRequest = {
  audio: {
    mid: string;
    trackName: string;
  };
  sessionDescription: SessionDescription;
  video: {
    mid: string;
    trackName: string;
  };
};

export type PublisherPublishResponse = {
  sessionDescription: SessionDescription;
};

export type PublisherTransportCompleteRequest = {
  sessionDescription: SessionDescription;
};

export type PublisherTransportResponse = {
  sessionDescription: SessionDescription;
};

export type PublisherControllerPollResponse = {
  controller: {
    generation: number;
    id: string;
  } | null;
  generation: number;
};

export type PublisherInputResponse = {
  dataChannels: Array<{
    dataChannelName: string;
    id: number;
    kind: InputKind;
  }>;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
  };
};

export type RpcError = {
  code: string;
  message: string;
  retryable: boolean;
  status: number;
};

export type RpcResult<T> =
  | { type: "error"; error: RpcError }
  | { type: "ok"; value: T };

export function isSessionDescription(
  value: unknown,
  expectedType?: SessionDescription["type"],
): value is SessionDescription {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

import {
  GAME_SETTINGS,
  type ControlInputChannel,
  type GameSnapshot,
  type MediaKind,
  type PublisherInputResponse,
  type PublisherPublishResponse,
  type RunStatus,
} from "../shared/protocol";

export type SfuSessionLedger = {
  dataChannelIds: number[];
  id: string;
  trackMids: string[];
};

export type PublisherMediaTrack = {
  kind: MediaKind;
  mid: string;
  trackName: string;
};

export type PublisherState = {
  heartbeatAt: number;
  inputs?: PublisherInputResponse;
  media?: {
    audio?: PublisherMediaTrack;
    response: PublisherPublishResponse;
    video: PublisherMediaTrack;
  };
  registeredAt: number;
  session: SfuSessionLedger;
  transport?: {
    phase: "negotiating" | "ready";
  };
};

export type ViewerState = {
  capabilityHash: string;
  createdAt: number;
  expiresAt: number;
  id: string;
  inputPhase: "negotiating" | "none" | "ready";
  inputs: ControlInputChannel[];
  phase: "active" | "closing" | "creating";
  principalSubject: string;
  session: SfuSessionLedger;
  tracks: Array<{
    kind: MediaKind;
    mid: string;
  }>;
};

export type ControllerState = {
  createdAt: number;
  leaseGeneration: number;
  phase: "active" | "creating" | "releasing";
  viewerId: string;
};

export type CleanupPending = {
  attempt: number;
  containerStopped?: boolean;
  lastAttemptAt?: number;
  reason:
    | "container_error"
    | "container_exit"
    | "controller_release"
    | "idle"
    | "maximum_runtime"
    | "manual_stop"
    | "publisher_stale"
    | "publisher_stop"
    | "startup_timeout"
    | "viewer_expired"
    | "viewer_leave";
  requestedAt: number;
  terminalStatus?: "failed" | "stopped";
};

export type RunState = {
  cleanupPending?: CleanupPending;
  containerReadyAt?: number;
  controller?: ControllerState;
  controllerGeneration: number;
  expiresAt: number;
  failureCode?: string;
  generation: number;
  id: string;
  lastInteractiveAt: number;
  publisher?: PublisherState;
  startedAt: number;
  startedBy: {
    displayHint: string;
    subject: string;
  };
  status: RunStatus;
  updatedAt: number;
  viewers: Record<string, ViewerState>;
};

export type StoredGameState = {
  generation: number;
  run?: RunState;
  version: 2;
};

export function emptyGameState(): StoredGameState {
  return {
    generation: 0,
    version: 2,
  };
}

export function restoreGameState(value: unknown): StoredGameState {
  if (!value) return emptyGameState();
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 2 ||
    !Number.isSafeInteger((value as { generation?: unknown }).generation)
  ) {
    throw new Error("Stored cloud-gaming state is invalid.");
  }
  const state = value as StoredGameState;
  if (state.run && !isRunState(state.run)) {
    throw new Error("Stored cloud-gaming run state is invalid.");
  }
  return state;
}

export function gameSnapshot(state: StoredGameState): GameSnapshot {
  const run = state.run;
  if (!run) {
    return {
      cleanupPending: false,
      controllerGeneration: 0,
      hasController: false,
      runGeneration: state.generation,
      settings: GAME_SETTINGS,
      status: "stopped",
      viewerCount: 0,
    };
  }
  return {
    cleanupPending: Boolean(run.cleanupPending),
    controllerGeneration: run.controllerGeneration,
    expiresAt: run.expiresAt,
    hasController: Boolean(run.controller),
    runGeneration: run.generation,
    runId: run.id,
    settings: GAME_SETTINGS,
    startedAt: run.startedAt,
    status: run.status,
    viewerCount: Object.values(run.viewers).filter(
      (viewer) => viewer.phase === "active",
    ).length,
  };
}

export function sessionLedger(id: string): SfuSessionLedger {
  return {
    dataChannelIds: [],
    id,
    trackMids: [],
  };
}

function isRunState(value: RunState): boolean {
  return (
    typeof value.id === "string" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 1 &&
    ["failed", "running", "starting", "stopped", "stopping"].includes(
      value.status,
    ) &&
    value.viewers &&
    typeof value.viewers === "object" &&
    !Array.isArray(value.viewers)
  );
}

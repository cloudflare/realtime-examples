import type { GameSnapshot } from "../shared/protocol";
import { ApiRequestError } from "./api";
import type { ControlPhase } from "./control";
import type { ViewerPhase } from "./viewer";

export type PhaseState<Phase extends string> = {
  message: string;
  phase: Phase;
};

export type BusyAction =
  | "release"
  | "retry"
  | "sound"
  | "start"
  | "stop"
  | "take";

export type Notice = {
  message: string;
  source: "action" | "control" | "status" | "viewer";
};

export type SignalState = "error" | "idle" | "live";

export const INITIAL_VIEWER: PhaseState<ViewerPhase> = {
  message: "Reading game status.",
  phase: "idle",
};

export const INITIAL_CONTROL: PhaseState<ControlPhase> = {
  message: "No controller assignment is held.",
  phase: "idle",
};

export function screenMessage(
  snapshot: GameSnapshot | null,
  viewer: PhaseState<ViewerPhase>,
): { copy?: string; title: string } {
  if (viewer.phase === "error") {
    return {
      copy: "Retry to open a fresh connection.",
      title: "Connection lost",
    };
  }
  if (snapshot?.status === "starting") {
    return {
      title: "Starting Freedoom...",
    };
  }
  if (snapshot?.status === "stopping") {
    return {
      title: "Stopping Freedoom...",
    };
  }
  if (snapshot?.status === "failed") {
    return {
      copy: "Start again when cleanup finishes.",
      title: "Run ended",
    };
  }
  if (snapshot?.status === "running") {
    return {
      title: "Connecting...",
    };
  }
  return {
    title: "Freedoom is offline",
  };
}

export function runLabel(snapshot: GameSnapshot | null): string {
  switch (snapshot?.status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Failed";
    case "stopped":
      return "Offline";
    default:
      return "Checking";
  }
}

export function mediaLabel(phase: ViewerPhase): string {
  return {
    connected: "Connected",
    connecting: "Connecting",
    error: "Failed",
    idle: "Idle",
    reconnecting: "Reconnecting",
  }[phase];
}

export function controlLabel(
  snapshot: GameSnapshot | null,
  phase: ControlPhase,
  capturing: boolean,
): string {
  if (capturing) return "Active";
  if (phase === "ready") return "Ready";
  if (phase === "claiming" || phase === "waiting") return "Claiming";
  if (phase === "releasing") return "Releasing";
  if (snapshot?.hasController) return "Occupied";
  return snapshot?.status === "running" ? "Available" : "Unavailable";
}

export function pollDelay(snapshot: GameSnapshot): number {
  if (snapshot.status === "starting" || snapshot.status === "stopping") {
    return 1_000;
  }
  return snapshot.status === "running" ? 2_500 : 4_000;
}

export function busyMessage(action: BusyAction): string {
  return {
    release: "Resetting held input and releasing control.",
    retry: "Refreshing status and opening a fresh viewer session.",
    sound: "Enabling audio after browser interaction.",
    start: "Starting the billable game container.",
    stop: "Stopping the game and releasing active resources.",
    take: "Claiming control and waiting for publisher readiness.",
  }[action];
}

export function actionLabel(action: BusyAction): string {
  return {
    release: "Release control",
    retry: "Retry",
    sound: "Enable sound",
    start: "Start",
    stop: "Stop",
    take: "Take control",
  }[action];
}

export function signalState(
  viewer: PhaseState<ViewerPhase>,
  hasVideo: boolean,
): SignalState {
  if (viewer.phase === "error") return "error";
  return viewer.phase === "connected" && hasVideo ? "live" : "idle";
}

export function formatError(context: string, error: unknown): string {
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred.";
  const requestReference =
    error instanceof ApiRequestError && error.requestId
      ? ` Request ID: ${error.requestId}.`
      : "";
  if (error instanceof ApiRequestError && error.status === 401) {
    return `${context}: ${message}${requestReference} Refresh the page if Access expired.`;
  }
  return `${context}: ${message}${requestReference}`;
}

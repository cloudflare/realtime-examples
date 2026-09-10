import type { StopParams } from "@cloudflare/containers";

import type { GameSnapshot } from "../shared/protocol";
import { RequestError, type AuthenticatedPrincipal } from "./auth";
import { ContextLogger } from "./logger";
import {
  emptyGameState,
  gameSnapshot,
  restoreGameState,
  type CleanupPending,
  type RunState,
  type StoredGameState,
} from "./game-state";
import { RealtimeSfuClient } from "./realtime";
import { RunCleanup } from "./run-cleanup";

export const MAX_VIEWERS = 8;
export const VIEWER_TTL_MS = 45_000;
export const CONTAINER_START_TIMEOUT_MS = 10 * 60_000;
export const PUBLISHER_STARTUP_TIMEOUT_MS = 2 * 60_000;

const MAX_RUN_MS = 30 * 60_000;
const PUBLISHER_STALE_MS = 45_000;
const IDLE_TIMEOUT_MS = 2 * 60_000;
const FORCE_STOP_AFTER_MS = 15_000;
const CONTROLLER_SETUP_TIMEOUT_MS = 15_000;

export type MaintenancePayload = {
  generation: number;
  runId: string;
};

export type PendingContainerStart = MaintenancePayload;

type RunLifecycleDependencies = {
  destroyContainer: () => Promise<void>;
  isContainerRunning: () => boolean;
  persist: (state: StoredGameState) => Promise<void>;
  renewActivity: () => void;
  scheduleMaintenance: (run: RunState, delaySeconds?: number) => Promise<void>;
  sfu: () => RealtimeSfuClient;
  stopContainer: () => Promise<void>;
};

export class RunLifecycle {
  private readonly cleanup: RunCleanup;
  private readonly log = new ContextLogger("lifecycle");
  private storedState: StoredGameState = emptyGameState();

  constructor(private readonly dependencies: RunLifecycleDependencies) {
    this.cleanup = new RunCleanup({
      persist: () => this.persist(),
      sfu: dependencies.sfu,
    });
  }

  get state(): StoredGameState {
    return this.storedState;
  }

  restore(value: unknown): void {
    this.storedState = restoreGameState(value);
  }

  snapshot(): GameSnapshot {
    return gameSnapshot(this.storedState);
  }

  sfu(): RealtimeSfuClient {
    return this.dependencies.sfu();
  }

  renewActivity(): void {
    this.dependencies.renewActivity();
  }

  async persist(): Promise<void> {
    await this.dependencies.persist(this.storedState);
  }

  async schedule(run: RunState, delaySeconds?: number): Promise<void> {
    await this.dependencies.scheduleMaintenance(run, delaySeconds);
  }

  async persistAndSchedule(
    run: RunState,
    delaySeconds?: number,
  ): Promise<void> {
    await this.persist();
    await this.schedule(run, delaySeconds);
  }

  async beginStart(
    principal: AuthenticatedPrincipal,
  ): Promise<PendingContainerStart | undefined> {
    this.sfu();
    const existing = this.storedState.run;
    if (
      existing &&
      !existing.cleanupPending &&
      (existing.status === "running" || existing.status === "starting")
    ) {
      return undefined;
    }
    if (
      existing &&
      (existing.cleanupPending ||
        existing.status === "running" ||
        existing.status === "starting" ||
        existing.status === "stopping")
    ) {
      throw new RequestError(
        409,
        "game_already_active",
        "The fixed game slot is already active or cleaning up.",
      );
    }

    const now = Date.now();
    const generation = this.storedState.generation + 1;
    const run: RunState = {
      controllerGeneration: 0,
      expiresAt: now + MAX_RUN_MS,
      generation,
      id: crypto.randomUUID(),
      lastInteractiveAt: now,
      startedAt: now,
      startedBy: {
        displayHint: principal.displayHint,
        subject: principal.subject,
      },
      status: "starting",
      updatedAt: now,
      viewers: {},
    };
    this.storedState = { generation, run, version: 2 };
    await this.persistAndSchedule(run);

    return {
      generation,
      runId: run.id,
    };
  }

  async recordStartFailure(
    pending: PendingContainerStart,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    const run = this.storedState.run;
    if (
      !run ||
      run.id !== pending.runId ||
      run.generation !== pending.generation ||
      run.status !== "starting" ||
      run.cleanupPending
    ) {
      return;
    }

    const now = Date.now();
    this.log.error(
      "container start failed",
      { request: { requestId }, run },
      { message: error instanceof Error ? error.message : "unknown error" },
    );
    run.failureCode = "container_start_failed";
    this.beginRunCleanup(run, "container_error", "failed", false, now);
    try {
      await this.dependencies.stopContainer();
    } catch {
      this.log.error("startup cleanup could not stop container", {
        request: { requestId },
        run,
      });
    }
    this.markContainerStoppedIfInactive(run);
    await this.attemptCleanup(run, requestId);
    await this.schedule(run);
  }

  async recordContainerReady(
    pending: PendingContainerStart,
  ): Promise<void> {
    const run = this.storedState.run;
    if (
      !run ||
      run.id !== pending.runId ||
      run.generation !== pending.generation ||
      run.status !== "starting" ||
      run.cleanupPending ||
      run.containerReadyAt !== undefined
    ) {
      return;
    }
    run.containerReadyAt = Date.now();
    run.updatedAt = run.containerReadyAt;
    await this.persistAndSchedule(run);
  }

  async stop(): Promise<GameSnapshot> {
    const run = this.storedState.run;
    if (!run || (isTerminal(run.status) && !run.cleanupPending)) {
      return this.snapshot();
    }

    const now = Date.now();
    this.beginRunCleanup(run, "manual_stop", "stopped", false, now);
    await this.persistAndSchedule(run, 1);
    return this.snapshot();
  }

  requireViewableRun(): RunState {
    const run = this.storedState.run;
    if (!run || isTerminal(run.status)) {
      throw new RequestError(
        409,
        "game_not_running",
        "No game is currently available in the fixed slot.",
      );
    }
    return run;
  }

  requirePublisherRun(
    runId: string,
    generation: number,
    allowStopping = false,
  ): RunState {
    const run = this.storedState.run;
    if (
      !run ||
      run.id !== runId ||
      run.generation !== generation ||
      (run.status !== "starting" &&
        run.status !== "running" &&
        !(allowStopping && run.status === "stopping"))
    ) {
      throw new RequestError(
        409,
        "publisher_run_stale",
        "This publisher belongs to a stale game run.",
      );
    }
    return run;
  }

  async expireAndClean(
    run: RunState,
    now: number,
    requestId: string,
  ): Promise<void> {
    if (!this.markExpiredResources(run, now)) return;
    await this.persistAndSchedule(run, 1);
    await this.attemptCleanup(run, requestId);
    await this.schedule(run);
  }

  async expireAndSchedule(run: RunState, now: number): Promise<void> {
    if (!this.markExpiredResources(run, now)) return;
    await this.persistAndSchedule(run, 1);
  }

  markExpiredResources(run: RunState, now: number): boolean {
    let changed = false;
    if (
      run.controller?.phase === "creating" &&
      run.controller.createdAt + CONTROLLER_SETUP_TIMEOUT_MS <= now
    ) {
      this.beginControllerRelease(run, "controller_release", now);
      changed = true;
    }
    for (const viewer of Object.values(run.viewers)) {
      if (viewer.phase !== "closing" && viewer.expiresAt <= now) {
        viewer.phase = "closing";
        if (run.controller?.viewerId === viewer.id) {
          this.beginControllerRelease(run, "viewer_expired", now);
        }
        this.markCleanup(run, "viewer_expired", now);
        changed = true;
      }
    }

    if (changed) run.updatedAt = now;
    return changed;
  }

  beginControllerRelease(
    run: RunState,
    reason: CleanupPending["reason"],
    now: number,
  ): void {
    if (run.controller && run.controller.phase !== "releasing") {
      run.controller.phase = "releasing";
      run.controllerGeneration += 1;
    }
    this.markCleanup(run, reason, now);
    run.updatedAt = now;
  }

  beginRunCleanup(
    run: RunState,
    reason: CleanupPending["reason"],
    terminalStatus: "failed" | "stopped",
    containerStopped: boolean,
    now: number,
  ): void {
    for (const viewer of Object.values(run.viewers)) {
      viewer.phase = "closing";
    }
    if (run.controller) {
      this.beginControllerRelease(run, reason, now);
    }
    this.markCleanup(run, reason, now, terminalStatus, containerStopped);
    run.status = "stopping";
    run.updatedAt = now;
  }

  markCleanup(
    run: RunState,
    reason: CleanupPending["reason"],
    now: number,
    terminalStatus?: "failed" | "stopped",
    containerStopped = false,
  ): void {
    const existing = run.cleanupPending;
    if (!existing) {
      run.cleanupPending = {
        attempt: 0,
        ...(terminalStatus ? { containerStopped, terminalStatus } : {}),
        reason,
        requestedAt: now,
      };
      return;
    }
    if (terminalStatus) {
      if (!existing.terminalStatus) {
        existing.attempt = 0;
        existing.reason = reason;
        existing.requestedAt = now;
      }
      existing.terminalStatus =
        existing.terminalStatus === "failed" || terminalStatus === "failed"
          ? "failed"
          : "stopped";
      existing.containerStopped =
        existing.containerStopped === true || containerStopped;
    }
  }

  async attemptCleanup(run: RunState, requestId: string): Promise<void> {
    await this.cleanup.attempt(run, requestId);
  }

  async maintain(payload: MaintenancePayload): Promise<void> {
    const run = this.storedState.run;
    if (
      !run ||
      run.id !== payload.runId ||
      run.generation !== payload.generation
    ) {
      return;
    }

    const now = Date.now();
    this.markExpiredResources(run, now);
    let shouldStop = false;
    if (
      !run.cleanupPending?.terminalStatus &&
      (run.status === "starting" || run.status === "running")
    ) {
      const reason = terminalReason(run, now);
      if (reason) {
        if (reason === "startup_timeout") {
          this.log.error(
            "startup timed out",
            { run },
            {
              phase:
                run.containerReadyAt === undefined ? "container" : "publisher",
            },
          );
        }
        this.beginRunCleanup(
          run,
          reason,
          reason === "publisher_stale" || reason === "startup_timeout"
            ? "failed"
            : "stopped",
          false,
          now,
        );
        shouldStop = true;
      }
    } else if (
      run.cleanupPending?.terminalStatus &&
      !run.cleanupPending.containerStopped
    ) {
      shouldStop = true;
    }

    if (!shouldStop) {
      await this.attemptCleanup(run, "scheduled-maintenance");
      await this.schedule(run);
      return;
    }

    await this.persistAndSchedule(run, 1);
    try {
      if (
        run.cleanupPending &&
        run.cleanupPending.requestedAt + FORCE_STOP_AFTER_MS <= Date.now()
      ) {
        await this.dependencies.destroyContainer();
      } else {
        await this.dependencies.stopContainer();
      }
    } catch {
      this.log.error("scheduled container stop failed", { run });
    }
    await this.attemptCleanup(run, "scheduled-maintenance");
    await this.schedule(run);
  }

  async onStart(): Promise<void> {
    const run = this.storedState.run;
    if (run && !isTerminal(run.status)) {
      await this.schedule(run);
    }
  }

  async onContainerStop(params: StopParams): Promise<void> {
    const run = this.storedState.run;
    if (!run || (isTerminal(run.status) && !run.cleanupPending)) return;
    const now = Date.now();
    const failed =
      params.exitCode !== 0 && run.cleanupPending?.terminalStatus !== "stopped";
    this.beginRunCleanup(
      run,
      "container_exit",
      failed ? "failed" : "stopped",
      true,
      now,
    );
    if (failed) run.failureCode = "container_exit_failed";
    await this.attemptCleanup(run, "container-stop");
    await this.schedule(run);
  }

  async onContainerError(): Promise<void> {
    const run = this.storedState.run;
    if (!run || (isTerminal(run.status) && !run.cleanupPending)) return;
    const now = Date.now();
    run.failureCode = "container_runtime_error";
    this.beginRunCleanup(run, "container_error", "failed", false, now);
    await this.attemptCleanup(run, "container-error");
    await this.schedule(run, 1);
  }

  private markContainerStoppedIfInactive(run: RunState): void {
    if (
      run.cleanupPending?.terminalStatus &&
      !this.dependencies.isContainerRunning()
    ) {
      run.cleanupPending.containerStopped = true;
    }
  }
}

export function nextMaintenanceDelaySeconds(
  run: RunState,
  now = Date.now(),
): number {
  const deadlines = [
    run.expiresAt,
    run.lastInteractiveAt + IDLE_TIMEOUT_MS,
    run.status === "starting"
      ? startupDeadline(run)
      : run.publisher
        ? run.publisher.heartbeatAt + PUBLISHER_STALE_MS
        : startupDeadline(run),
    ...Object.values(run.viewers)
      .filter((viewer) => viewer.phase !== "closing")
      .map((viewer) => viewer.expiresAt),
    ...(run.controller?.phase === "creating"
      ? [run.controller.createdAt + CONTROLLER_SETUP_TIMEOUT_MS]
      : []),
  ];
  const nextDeadline = Math.min(...deadlines);
  return Math.max(1, Math.min(15, Math.ceil((nextDeadline - now) / 1_000)));
}

function terminalReason(
  run: RunState,
  now: number,
):
  | "idle"
  | "maximum_runtime"
  | "publisher_stale"
  | "startup_timeout"
  | undefined {
  if (run.expiresAt <= now) return "maximum_runtime";
  if (
    run.status === "starting" &&
    startupDeadline(run) <= now
  ) {
    return "startup_timeout";
  }
  if (
    run.status === "running" &&
    (!run.publisher ||
      run.publisher.heartbeatAt + PUBLISHER_STALE_MS <= now)
  ) {
    return "publisher_stale";
  }
  return run.lastInteractiveAt + IDLE_TIMEOUT_MS <= now ? "idle" : undefined;
}

function startupDeadline(run: RunState): number {
  return run.containerReadyAt === undefined
    ? run.startedAt + CONTAINER_START_TIMEOUT_MS
    : run.containerReadyAt + PUBLISHER_STARTUP_TIMEOUT_MS;
}

function isTerminal(
  status: RunState["status"],
): status is "failed" | "stopped" {
  return status === "failed" || status === "stopped";
}

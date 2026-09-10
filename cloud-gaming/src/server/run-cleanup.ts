import type { RunState, SfuSessionLedger } from "./game-state";
import { ContextLogger } from "./logger";
import {
  RealtimeSfuClient,
  SfuRequestError,
} from "./realtime";
import { setViewerReplyPermission } from "./reply-permission";
import { unique } from "./sfu-results";

type RunCleanupDependencies = {
  persist: () => Promise<void>;
  sfu: () => RealtimeSfuClient;
};

const TERMINAL_CLEANUP_GRACE_MS = 60_000;

export class RunCleanup {
  private readonly log = new ContextLogger("cleanup");

  constructor(private readonly dependencies: RunCleanupDependencies) {}

  async attempt(run: RunState, requestId: string): Promise<void> {
    const cleanup = run.cleanupPending;
    if (!cleanup) return;
    if (
      cleanup.terminalStatus &&
      cleanup.containerStopped === true &&
      cleanup.requestedAt + TERMINAL_CLEANUP_GRACE_MS <= Date.now()
    ) {
      this.log.error(
        "terminal SFU cleanup timed out; relying on inactivity collection",
        { request: { requestId }, run },
      );
      finishTerminalCleanup(run, cleanup.terminalStatus);
      await this.dependencies.persist();
      return;
    }
    cleanup.attempt += 1;
    cleanup.lastAttemptAt = Date.now();

    const publisher = run.publisher;
    const controller = run.controller;
    if (controller?.phase === "releasing") {
      const viewer = run.viewers[controller.viewerId];
      if (
        !viewer ||
        !publisher?.inputs ||
        (await this.revokeReplyPermission(run, viewer, requestId))
      ) {
        run.controller = undefined;
      }
    }

    for (const viewer of Object.values(run.viewers)) {
      if (viewer.phase !== "closing") continue;
      await this.closeSession(viewer.session, requestId);
      if (
        run.controller?.viewerId === viewer.id &&
        viewer.session.dataChannelIds.length === 0
      ) {
        run.controller = undefined;
      }
      if (
        viewer.session.dataChannelIds.length === 0 &&
        viewer.session.trackMids.length === 0 &&
        run.controller?.viewerId !== viewer.id
      ) {
        delete run.viewers[viewer.id];
      }
    }

    if (cleanup.terminalStatus && publisher) {
      await this.closeSession(publisher.session, requestId);
      if (
        publisher.session.dataChannelIds.length === 0 &&
        publisher.session.trackMids.length === 0
      ) {
        run.publisher = undefined;
      }
    }

    const scopedPending =
      Boolean(run.controller?.phase === "releasing") ||
      Object.values(run.viewers).some((viewer) => viewer.phase === "closing");
    const terminalResourcesPending =
      Boolean(cleanup.terminalStatus) &&
      (Boolean(run.publisher) ||
        Boolean(run.controller) ||
        Object.keys(run.viewers).length > 0 ||
        cleanup.containerStopped !== true);

    if (!scopedPending && !terminalResourcesPending) {
      const terminalStatus = cleanup.terminalStatus;
      run.cleanupPending = undefined;
      if (terminalStatus) {
        run.controller = undefined;
        run.publisher = undefined;
        run.status = terminalStatus;
        run.viewers = {};
        this.log.info(
          "run cleanup completed",
          { request: { requestId }, run },
          { status: terminalStatus },
        );
      }
    }
    run.updatedAt = Date.now();
    await this.dependencies.persist();
  }

  private async closeSession(
    session: SfuSessionLedger,
    requestId: string,
  ): Promise<void> {
    await this.closeDataChannelSubset(
      session,
      session.dataChannelIds,
      requestId,
    );
    if (session.trackMids.length === 0) return;
    try {
      const result = await this.dependencies
        .sfu()
        .closeTracks(session.id, session.trackMids);
      const closed = new Set(result.closed);
      session.trackMids = session.trackMids.filter((mid) => !closed.has(mid));
      if (result.failures.length > 0) {
        this.log.error(
          "SFU track cleanup incomplete",
          { request: { requestId } },
          {
            codes: unique(result.failures.map((failure) => failure.code)).join(
              ",",
            ),
            sessionId: session.id,
          },
        );
      }
    } catch (error) {
      this.logCleanupError(error, requestId, session.id, "tracks");
    }
  }

  private async closeDataChannelSubset(
    session: SfuSessionLedger,
    ids: number[],
    requestId: string,
  ): Promise<void> {
    const requested = unique(ids);
    if (requested.length === 0) return;
    try {
      const result = await this.dependencies
        .sfu()
        .closeDataChannels(session.id, requested);
      const closed = new Set(result.closed);
      session.dataChannelIds = session.dataChannelIds.filter(
        (id) => !closed.has(id),
      );
      if (result.failures.length > 0) {
        this.log.error(
          "SFU DataChannel cleanup incomplete",
          { request: { requestId } },
          {
            codes: unique(result.failures.map((failure) => failure.code)).join(
              ",",
            ),
            sessionId: session.id,
          },
        );
      }
    } catch (error) {
      this.logCleanupError(error, requestId, session.id, "datachannels");
    }
  }

  private async revokeReplyPermission(
    run: RunState,
    viewer: RunState["viewers"][string],
    requestId: string,
  ): Promise<boolean> {
    const publisher = run.publisher;
    if (!publisher?.inputs) return true;

    try {
      await setViewerReplyPermission(
        this.dependencies.sfu(),
        run,
        viewer,
        false,
      );
      return true;
    } catch (error) {
      if (
        error instanceof SfuRequestError &&
        (error.status === 404 || error.status === 410)
      ) {
        return true;
      }
      this.logCleanupError(
        error,
        requestId,
        viewer.session.id,
        "datachannels",
      );
      return false;
    }
  }

  private logCleanupError(
    error: unknown,
    requestId: string,
    sessionId: string,
    resource: "datachannels" | "tracks",
  ): void {
    if (error instanceof SfuRequestError) {
      this.log.error(
        "SFU cleanup request failed",
        { request: { requestId } },
        {
          code: error.code,
          resource,
          sessionId,
          status: error.status,
        },
      );
      return;
    }
    this.log.error(
      "cleanup failed unexpectedly",
      { request: { requestId } },
      { resource, sessionId },
    );
  }
}

function finishTerminalCleanup(
  run: RunState,
  status: "failed" | "stopped",
): void {
  run.cleanupPending = undefined;
  run.controller = undefined;
  run.publisher = undefined;
  run.status = status;
  run.updatedAt = Date.now();
  run.viewers = {};
}

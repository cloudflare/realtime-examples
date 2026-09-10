import type {
  ControlClaimResponse,
  ControlLeaseResponse,
} from "../shared/protocol";
import { INPUT_CHANNEL_PROFILES } from "../shared/input-channels";
import { RequestError } from "./auth";
import type { ControllerState } from "./game-state";
import { setViewerReplyPermission } from "./reply-permission";
import { RunLifecycle } from "./run-lifecycle";
import type { ControlClaimRpcContext, ControlRpcContext } from "./rpc";
import { ViewerDomain } from "./viewer-domain";

export class ControllerDomain {
  constructor(
    private readonly lifecycle: RunLifecycle,
    private readonly viewers: ViewerDomain,
  ) {}

  async claim(
    context: ControlClaimRpcContext,
  ): Promise<ControlClaimResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    await this.lifecycle.expireAndClean(run, now, context.requestId);
    const viewer = await this.viewers.requireViewer(run, context, false, now);
    if (
      run.status !== "running" ||
      viewer.inputPhase !== "ready" ||
      viewer.inputs.length !== INPUT_CHANNEL_PROFILES.length
    ) {
      throw new RequestError(
        409,
        "game_not_ready",
        "Control is available only after the game and viewer input channels are ready.",
      );
    }

    if (run.controller) {
      if (
        run.controller.phase === "active" &&
        run.controller.viewerId === viewer.id
      ) {
        return { leaseGeneration: run.controller.leaseGeneration };
      }
      throw new RequestError(
        409,
        run.controller.phase === "releasing"
          ? "controller_cleanup_pending"
          : "controller_unavailable",
        run.controller.phase === "releasing"
          ? "The previous controller is still cleaning up."
          : "Another viewer already holds control.",
        true,
      );
    }

    const leaseGeneration = run.controllerGeneration + 1;
    const controller: ControllerState = {
      createdAt: now,
      leaseGeneration,
      phase: "creating",
      viewerId: viewer.id,
    };
    run.controller = controller;
    run.controllerGeneration = leaseGeneration;
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run);

    try {
      await setViewerReplyPermission(
        this.lifecycle.sfu(),
        run,
        viewer,
        true,
      );
      controller.phase = "active";
      run.lastInteractiveAt = now;
      run.updatedAt = now;
      await this.lifecycle.persistAndSchedule(run);
      this.lifecycle.renewActivity();
      return { leaseGeneration };
    } catch (error) {
      this.lifecycle.beginControllerRelease(run, "controller_release", now);
      await this.lifecycle.persistAndSchedule(run, 1);
      await this.lifecycle.attemptCleanup(run, context.requestId);
      await this.lifecycle.schedule(run);
      throw error;
    }
  }

  async release(context: ControlRpcContext): Promise<ControlLeaseResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    await this.lifecycle.expireAndClean(run, now, context.requestId);
    const viewer = await this.viewers.requireViewer(run, context, true, now);
    const controller = run.controller;

    if (controller) {
      if (controller.viewerId !== viewer.id) {
        throw new RequestError(
          409,
          "controller_not_owned",
          "This viewer does not hold the current controller assignment.",
        );
      }
      this.lifecycle.beginControllerRelease(run, "controller_release", now);
      await this.lifecycle.persistAndSchedule(run, 1);
      await this.lifecycle.attemptCleanup(run, context.requestId);
    }

    await this.lifecycle.schedule(run);
    return {
      cleanupPending: Boolean(run.controller),
      leaseGeneration:
        run.controller?.leaseGeneration ?? run.controllerGeneration,
      released: true,
    };
  }
}

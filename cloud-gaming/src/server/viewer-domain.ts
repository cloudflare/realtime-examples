import type {
  ViewerHeartbeatResponse,
  ViewerInputResponse,
  ViewerJoinRequest,
  ViewerJoinResponse,
  ViewerLeaveResponse,
  ViewerTransportCompleteRequest,
  ViewerTransportResponse,
} from "../shared/protocol";
import { SFU_SERVER_EVENTS_CHANNEL } from "../shared/protocol";
import {
  INPUT_CHANNEL_PROFILES,
  VIEWER_INPUT_SUBSCRIPTION,
} from "../shared/input-channels";
import { RequestError } from "./auth";
import {
  capabilityMatches,
  createCapability,
  hashCapability,
} from "./capabilities";
import { sessionLedger, type RunState, type ViewerState } from "./game-state";
import { MAX_VIEWERS, RunLifecycle, VIEWER_TTL_MS } from "./run-lifecycle";
import type { GameRpcContext, ViewerRpcContext } from "./rpc";
import {
  assertDataChannelItemsSucceeded,
  assertTrackItemsSucceeded,
} from "./realtime";
import {
  requireAnswer,
  requireDataChannelId,
  requireOffer,
  requireTrackMid,
  unique,
} from "./sfu-results";

export class ViewerDomain {
  constructor(private readonly lifecycle: RunLifecycle) {}

  async join(
    context: GameRpcContext,
    input: ViewerJoinRequest,
  ): Promise<ViewerJoinResponse> {
    const run = this.lifecycle.requireViewableRun();
    await this.lifecycle.expireAndClean(run, Date.now(), context.requestId);
    if (run.status !== "running") {
      throw new RequestError(
        409,
        "game_not_ready",
        "Viewers can join only while the game is running.",
      );
    }
    const media = run.publisher?.media;
    if (!media || !run.publisher?.inputs) {
      throw new Error("A running game is missing publisher resources.");
    }
    if (activeViewerCount(run) >= MAX_VIEWERS) {
      throw new RequestError(
        429,
        "viewer_limit_reached",
        "This game already has the maximum number of viewers.",
        true,
      );
    }

    const now = Date.now();
    const viewerId = crypto.randomUUID();
    const viewerCapability = createCapability();
    const viewerSessionId = await this.lifecycle.sfu().createSession();
    const viewer: ViewerState = {
      capabilityHash: await hashCapability(viewerCapability),
      createdAt: now,
      expiresAt: Math.min(now + VIEWER_TTL_MS, run.expiresAt),
      id: viewerId,
      inputPhase: "none",
      inputs: [],
      phase: "creating",
      principalSubject: context.principal.subject,
      session: sessionLedger(viewerSessionId),
      tracks: [],
    };
    run.viewers[viewerId] = viewer;
    run.updatedAt = now;
    await this.lifecycle.persist();

    try {
      const requested = [media.video, ...(media.audio ? [media.audio] : [])];
      const response = await this.lifecycle.sfu().addTracks(viewerSessionId, {
        sessionDescription: input.sessionDescription,
        tracks: requested.map((track) => ({
          location: "remote",
          sessionId: run.publisher!.session.id,
          trackName: track.trackName,
        })),
      });
      viewer.session.trackMids = unique([
        ...viewer.session.trackMids,
        ...response.tracks.flatMap((track) => (track.mid ? [track.mid] : [])),
      ]);
      await this.lifecycle.persist();
      assertTrackItemsSucceeded(response, "viewer subscription");
      const answer = requireAnswer(
        response.sessionDescription,
        response.requiresImmediateRenegotiation,
        "viewer_subscription_negotiation_invalid",
      );
      viewer.tracks = requested.map((track) => ({
        kind: track.kind,
        mid: requireTrackMid(response.tracks, track.trackName),
      }));
      viewer.session.trackMids = unique([
        ...viewer.session.trackMids,
        ...viewer.tracks.map((track) => track.mid),
      ]);
      viewer.phase = "active";
      run.lastInteractiveAt = now;
      run.updatedAt = now;
      await this.lifecycle.persistAndSchedule(run);
      this.lifecycle.renewActivity();
      return {
        expiresAt: viewer.expiresAt,
        runGeneration: run.generation,
        runId: run.id,
        sessionDescription: answer,
        tracks: viewer.tracks,
        viewerCapability,
        viewerId,
      };
    } catch (error) {
      viewer.phase = "closing";
      this.lifecycle.markCleanup(run, "viewer_leave", now);
      await this.lifecycle.attemptCleanup(run, context.requestId);
      await this.lifecycle.schedule(run);
      throw error;
    }
  }

  async establishInputTransport(
    context: ViewerRpcContext,
  ): Promise<ViewerTransportResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    await this.lifecycle.expireAndClean(run, now, context.requestId);
    const viewer = await this.requireViewer(run, context, false, now);
    if (viewer.inputPhase === "ready") {
      throw new RequestError(
        409,
        "viewer_transport_ready",
        "This viewer already established its DataChannel transport.",
      );
    }
    if (viewer.inputPhase === "negotiating") {
      throw new RequestError(
        409,
        "viewer_transport_pending",
        "This viewer already has a DataChannel transport negotiation in progress.",
      );
    }

    viewer.inputPhase = "negotiating";
    run.updatedAt = now;
    await this.lifecycle.persist();

    try {
      const response = await this.lifecycle
        .sfu()
        .establishDataChannels(viewer.session.id, {
          dataChannel: {
            dataChannelName: SFU_SERVER_EVENTS_CHANNEL,
            location: "remote",
          },
        });
      assertDataChannelItemsSucceeded(
        response,
        "viewer transport establishment",
      );
      return {
        sessionDescription: requireOffer(
          response.sessionDescription,
          response.requiresImmediateRenegotiation,
          "viewer_transport_negotiation_invalid",
        ),
      };
    } catch (error) {
      viewer.phase = "closing";
      this.lifecycle.markCleanup(run, "viewer_leave", now);
      await this.lifecycle.attemptCleanup(run, context.requestId);
      await this.lifecycle.schedule(run);
      throw error;
    }
  }

  async completeInputTransport(
    context: ViewerRpcContext,
    input: ViewerTransportCompleteRequest,
  ): Promise<ViewerInputResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    await this.lifecycle.expireAndClean(run, now, context.requestId);
    const viewer = await this.requireViewer(run, context, false, now);
    if (viewer.inputPhase === "ready") {
      return { inputs: viewer.inputs };
    }
    if (viewer.inputPhase !== "negotiating") {
      throw new RequestError(
        409,
        "viewer_transport_not_pending",
        "Establish the viewer DataChannel transport before completing it.",
      );
    }

    try {
      await this.lifecycle
        .sfu()
        .renegotiate(viewer.session.id, input.sessionDescription);
      const publisher = run.publisher;
      if (
        !publisher?.inputs ||
        publisher.inputs.dataChannels.length !== INPUT_CHANNEL_PROFILES.length
      ) {
        throw new RequestError(
          409,
          "publisher_inputs_missing",
          "The publisher input DataChannels are not ready.",
          true,
        );
      }
      const requestedInputs = INPUT_CHANNEL_PROFILES.map((profile) => {
        const published = publisher.inputs!.dataChannels.find(
          (channel) => channel.kind === profile.kind,
        );
        if (!published || published.dataChannelName !== profile.dataChannelName) {
          throw new RequestError(
            502,
            "publisher_inputs_invalid",
            "The publisher input DataChannels do not match the application profile.",
            true,
          );
        }
        return {
          ...profile,
          ...VIEWER_INPUT_SUBSCRIPTION,
          location: "remote" as const,
          sessionId: publisher.session.id,
        };
      });
      const response = await this.lifecycle
        .sfu()
        .addDataChannels(viewer.session.id, {
          dataChannels: requestedInputs.map(
            ({ kind: _kind, ...channel }) => channel,
          ),
        });
      viewer.session.dataChannelIds = unique([
        ...viewer.session.dataChannelIds,
        ...response.dataChannels.flatMap((channel) =>
          channel.id === undefined ? [] : [channel.id],
        ),
      ]);
      await this.lifecycle.persist();
      assertDataChannelItemsSucceeded(response, "viewer input channel creation");
      if (response.requiresImmediateRenegotiation) {
        throw new RequestError(
          502,
          "viewer_input_negotiation_invalid",
          "Realtime SFU unexpectedly required another viewer negotiation.",
          true,
        );
      }

      viewer.inputs = requestedInputs.map((requested) => ({
        dataChannelName: requested.dataChannelName,
        id: requireDataChannelId(
          response.dataChannels,
          requested.dataChannelName,
        ),
        kind: requested.kind,
        ...(requested.maxRetransmits === undefined
          ? {}
          : { maxRetransmits: requested.maxRetransmits }),
        ordered: requested.ordered,
      }));
      viewer.session.dataChannelIds = unique([
        ...viewer.session.dataChannelIds,
        ...viewer.inputs.map((channel) => channel.id),
      ]);
      viewer.inputPhase = "ready";
      run.updatedAt = now;
      await this.lifecycle.persistAndSchedule(run);
      return { inputs: viewer.inputs };
    } catch (error) {
      viewer.phase = "closing";
      this.lifecycle.markCleanup(run, "viewer_leave", now);
      await this.lifecycle.attemptCleanup(run, context.requestId);
      await this.lifecycle.schedule(run);
      throw error;
    }
  }

  async heartbeat(context: ViewerRpcContext): Promise<ViewerHeartbeatResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    await this.lifecycle.expireAndClean(run, now, context.requestId);
    const viewer = await this.requireViewer(run, context, false, now);
    viewer.expiresAt = Math.min(now + VIEWER_TTL_MS, run.expiresAt);
    run.lastInteractiveAt = now;
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run);
    this.lifecycle.renewActivity();
    return { ok: true };
  }

  async leave(context: ViewerRpcContext): Promise<ViewerLeaveResponse> {
    const run = this.lifecycle.requireViewableRun();
    const now = Date.now();
    if (!run.viewers[context.viewerId]) {
      return { cleanupPending: false, left: true };
    }
    const viewer = await this.requireViewer(run, context, true, now);
    viewer.phase = "closing";
    if (run.controller?.viewerId === viewer.id) {
      this.lifecycle.beginControllerRelease(run, "viewer_leave", now);
    }
    this.lifecycle.markCleanup(run, "viewer_leave", now);
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run, 1);
    await this.lifecycle.attemptCleanup(run, context.requestId);
    await this.lifecycle.schedule(run);
    return {
      cleanupPending: Boolean(
        run.viewers[viewer.id] || run.controller?.viewerId === viewer.id,
      ),
      left: true,
    };
  }

  async requireViewer(
    run: RunState,
    context: ViewerRpcContext,
    allowClosing: boolean,
    now: number,
  ): Promise<ViewerState> {
    const viewer = run.viewers[context.viewerId];
    if (
      !viewer ||
      viewer.principalSubject !== context.principal.subject ||
      !(await capabilityMatches(
        context.viewerCapability,
        viewer.capabilityHash,
      ))
    ) {
      throw new RequestError(
        403,
        "viewer_capability_invalid",
        "The viewer capability is invalid or expired.",
      );
    }
    if (
      !allowClosing &&
      (viewer.phase !== "active" || viewer.expiresAt <= now)
    ) {
      throw new RequestError(
        409,
        "viewer_expired",
        "This viewer session has expired. Join again to create a fresh SFU session.",
      );
    }
    return viewer;
  }
}

function activeViewerCount(run: RunState): number {
  return Object.values(run.viewers).filter(
    (viewer) => viewer.phase === "active",
  ).length;
}

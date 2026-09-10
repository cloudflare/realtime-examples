import {
  SFU_SERVER_EVENTS_CHANNEL,
  type PublisherAckResponse,
  type PublisherControllerPollResponse,
  type PublisherInputResponse,
  type PublisherPublishRequest,
  type PublisherPublishResponse,
  type PublisherRegisterRequest,
  type PublisherRegisterResponse,
  type PublisherTransportCompleteRequest,
  type PublisherTransportResponse,
} from "../shared/protocol";
import { INPUT_CHANNEL_PROFILES } from "../shared/input-channels";
import { RequestError } from "./auth";
import { ContextLogger } from "./logger";
import {
  sessionLedger,
  type PublisherState,
  type RunState,
} from "./game-state";
import { RunLifecycle } from "./run-lifecycle";
import type { PublisherRpcContext } from "./rpc";
import {
  assertDataChannelItemsSucceeded,
  assertTrackItemsSucceeded,
} from "./realtime";
import {
  requireAnswer,
  requireDataChannelId,
  requireOffer,
  responseTrack,
  unique,
} from "./sfu-results";

export class PublisherDomain {
  private readonly log = new ContextLogger("publisher");

  constructor(private readonly lifecycle: RunLifecycle) {}

  async register(
    context: PublisherRpcContext,
    _input: PublisherRegisterRequest,
  ): Promise<PublisherRegisterResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    if (run.publisher) return publisherRegistration(run);

    const now = Date.now();
    const sessionId = await this.lifecycle.sfu().createSession();
    run.publisher = {
      heartbeatAt: now,
      registeredAt: now,
      session: sessionLedger(sessionId),
    };
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run);
    this.log.info("registered", { request: context, run });
    return publisherRegistration(run);
  }

  async publish(
    context: PublisherRpcContext,
    request: PublisherPublishRequest,
  ): Promise<PublisherPublishResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    const publisher = requirePublisher(run);
    if (publisher.media) {
      if (
        samePublishedTrack(publisher.media.video, request.video) &&
        sameOptionalPublishedTrack(publisher.media.audio, request.audio)
      ) {
        return publisher.media.response;
      }
      throw new RequestError(
        409,
        "publisher_already_published",
        "This run already published media with different track locators.",
      );
    }

    const now = Date.now();
    try {
      const requested = [
        { ...request.video, kind: "video" as const },
        ...(request.audio
          ? [{ ...request.audio, kind: "audio" as const }]
          : []),
      ];
      const response = await this.lifecycle
        .sfu()
        .addTracks(publisher.session.id, {
          sessionDescription: request.sessionDescription,
          tracks: requested.map((track) => ({
            location: "local",
            mid: track.mid,
            trackName: track.trackName,
          })),
        });
      publisher.session.trackMids = unique([
        ...publisher.session.trackMids,
        ...response.tracks.flatMap((track) => (track.mid ? [track.mid] : [])),
      ]);
      await this.lifecycle.persist();
      assertTrackItemsSucceeded(response, "publisher media creation");
      const answer = requireAnswer(
        response.sessionDescription,
        response.requiresImmediateRenegotiation,
        "publisher_negotiation_invalid",
      );
      const published = requested.map((track) => ({
        kind: track.kind,
        mid: responseTrack(response.tracks, track.trackName)?.mid ?? track.mid,
        trackName: track.trackName,
      }));
      publisher.session.trackMids = unique([
        ...publisher.session.trackMids,
        ...published.map((track) => track.mid),
      ]);
      const video = published.find((track) => track.kind === "video");
      if (!video) {
        throw new RequestError(
          502,
          "publisher_video_missing",
          "Realtime SFU did not confirm the publisher video track.",
          true,
        );
      }
      publisher.media = {
        audio: published.find((track) => track.kind === "audio"),
        response: { sessionDescription: answer },
        video,
      };
      publisher.heartbeatAt = now;
      run.updatedAt = now;
      await this.lifecycle.persistAndSchedule(run);
      this.log.info("media ready", { request: context, run });
      return publisher.media.response;
    } catch (error) {
      run.failureCode = "publisher_media_failed";
      this.lifecycle.beginRunCleanup(
        run,
        "container_error",
        "failed",
        false,
        now,
      );
      await this.lifecycle.persistAndSchedule(run, 1);
      throw error;
    }
  }

  async heartbeat(context: PublisherRpcContext): Promise<PublisherAckResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    const publisher = requirePublisher(run);
    const now = Date.now();
    publisher.heartbeatAt = now;
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run);
    return { ok: true };
  }

  async establishDataChannels(
    context: PublisherRpcContext,
  ): Promise<PublisherTransportResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    const publisher = requirePublisher(run);
    if (publisher.transport) {
      throw new RequestError(
        409,
        "publisher_transport_exists",
        "This publisher already started its DataChannel transport.",
      );
    }

    const now = Date.now();
    publisher.transport = { phase: "negotiating" };
    run.updatedAt = now;
    await this.lifecycle.persistAndSchedule(run);
    try {
      const response = await this.lifecycle
        .sfu()
        .establishDataChannels(publisher.session.id, {
          dataChannel: {
            dataChannelName: SFU_SERVER_EVENTS_CHANNEL,
            location: "remote",
          },
        });
      assertDataChannelItemsSucceeded(
        response,
        "publisher transport establishment",
      );
      const offer = requireOffer(
        response.sessionDescription,
        response.requiresImmediateRenegotiation,
        "publisher_transport_negotiation_invalid",
      );
      const serverEventsId = response.dataChannel?.id;
      if (serverEventsId === undefined) {
        throw new RequestError(
          502,
          "publisher_transport_channel_missing",
          "Realtime SFU did not identify the publisher transport channel.",
          true,
        );
      }
      this.log.info("DataChannel offer ready", { request: context, run });
      return { sessionDescription: offer };
    } catch (error) {
      run.failureCode = "publisher_transport_failed";
      this.lifecycle.beginRunCleanup(
        run,
        "container_error",
        "failed",
        false,
        now,
      );
      await this.lifecycle.persistAndSchedule(run, 1);
      throw error;
    }
  }

  async pollController(
    context: PublisherRpcContext,
  ): Promise<PublisherControllerPollResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    const publisher = requirePublisher(run);
    const now = Date.now();
    await this.lifecycle.expireAndSchedule(run, now);
    if (!publisher.inputs) {
      throw new RequestError(
        409,
        "publisher_inputs_missing",
        "Create the publisher input DataChannels before polling for control.",
      );
    }
    const controller =
      run.controller?.phase === "active" ? run.controller : undefined;
    return {
      controller: controller
        ? {
            generation: controller.leaseGeneration,
            id: controller.viewerId,
          }
        : null,
      generation: run.controllerGeneration,
    };
  }

  async completeDataChannels(
    context: PublisherRpcContext,
    input: PublisherTransportCompleteRequest,
  ): Promise<PublisherInputResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
    );
    const publisher = requirePublisher(run);
    if (publisher.transport?.phase !== "negotiating") {
      throw new RequestError(
        409,
        "publisher_transport_not_pending",
        "Establish the publisher DataChannel transport before completing it.",
      );
    }

    const now = Date.now();
    const requestedChannels = INPUT_CHANNEL_PROFILES.map((profile) => ({
      ...profile,
      location: "local" as const,
    }));

    try {
      await this.lifecycle
        .sfu()
        .renegotiate(publisher.session.id, input.sessionDescription);
      const response = await this.lifecycle
        .sfu()
        .addDataChannels(publisher.session.id, {
          dataChannels: requestedChannels.map(
            ({ kind: _kind, ...channel }) => channel,
          ),
        });
      publisher.session.dataChannelIds = unique([
        ...publisher.session.dataChannelIds,
        ...response.dataChannels.flatMap((channel) =>
          channel.id === undefined ? [] : [channel.id],
        ),
      ]);
      await this.lifecycle.persist();
      assertDataChannelItemsSucceeded(response, "publisher input channel creation");
      if (response.requiresImmediateRenegotiation) {
        throw new RequestError(
          502,
          "publisher_input_negotiation_invalid",
          "Realtime SFU unexpectedly required another publisher negotiation.",
          true,
        );
      }
      publisher.inputs = {
        dataChannels: requestedChannels.map((requested) => ({
          dataChannelName: requested.dataChannelName,
          id: requireDataChannelId(
            response.dataChannels,
            requested.dataChannelName,
          ),
          kind: requested.kind,
        })),
      };
      publisher.transport.phase = "ready";
      publisher.session.dataChannelIds = unique([
        ...publisher.session.dataChannelIds,
        ...publisher.inputs.dataChannels.map((channel) => channel.id),
      ]);
      publisher.heartbeatAt = now;
      run.status = "running";
      run.updatedAt = now;
      await this.lifecycle.persistAndSchedule(run);
      this.log.info(
        "ready",
        { request: context, run },
        { dataChannels: publisher.inputs.dataChannels.length },
      );
      return publisher.inputs;
    } catch (error) {
      run.failureCode = "publisher_inputs_failed";
      this.lifecycle.beginRunCleanup(
        run,
        "container_error",
        "failed",
        false,
        now,
      );
      await this.lifecycle.persistAndSchedule(run, 1);
      throw error;
    }
  }

  async stop(context: PublisherRpcContext): Promise<PublisherAckResponse> {
    const run = this.lifecycle.requirePublisherRun(
      context.runId,
      context.runGeneration,
      true,
    );
    const now = Date.now();
    this.lifecycle.beginRunCleanup(
      run,
      "publisher_stop",
      "stopped",
      false,
      now,
    );
    await this.lifecycle.persistAndSchedule(run, 1);
    this.log.info("requested stop", { request: context, run });
    return { ok: true };
  }
}

function publisherRegistration(run: RunState): PublisherRegisterResponse {
  const publisher = requirePublisher(run);
  return {
    sessionId: publisher.session.id,
  };
}

function requirePublisher(run: RunState): PublisherState {
  if (!run.publisher) {
    throw new RequestError(
      409,
      "publisher_not_registered",
      "Register the publisher before using this operation.",
    );
  }
  return run.publisher;
}

function samePublishedTrack(
  left: { mid: string; trackName: string },
  right: { mid: string; trackName: string },
): boolean {
  return left.mid === right.mid && left.trackName === right.trackName;
}

function sameOptionalPublishedTrack(
  left: { mid: string; trackName: string } | undefined,
  right: { mid: string; trackName: string } | undefined,
): boolean {
  return left === undefined && right === undefined
    ? true
    : Boolean(left && right && samePublishedTrack(left, right));
}

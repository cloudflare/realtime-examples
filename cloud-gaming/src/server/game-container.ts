import {
  Container,
  type ContainerStartConfigOptions,
  type StopParams,
} from "@cloudflare/containers";

import {
  GAME_SETTINGS,
  type ControlClaimResponse,
  type ControlLeaseResponse,
  type GameSnapshot,
  type PublisherAckResponse,
  type PublisherControllerPollResponse,
  type PublisherInputResponse,
  type PublisherPublishRequest,
  type PublisherPublishResponse,
  type PublisherRegisterRequest,
  type PublisherRegisterResponse,
  type PublisherTransportCompleteRequest,
  type PublisherTransportResponse,
  type RpcResult,
  type ViewerHeartbeatResponse,
  type ViewerInputResponse,
  type ViewerJoinRequest,
  type ViewerJoinResponse,
  type ViewerLeaveResponse,
  type ViewerTransportCompleteRequest,
  type ViewerTransportResponse,
} from "../shared/protocol";
import { ControllerDomain } from "./controller-domain";
import type { RunState } from "./game-state";
import { PublisherDomain } from "./publisher-domain";
import { RealtimeSfuClient, type RealtimeEnv } from "./realtime";
import {
  expectedRpcError,
  type ControlClaimRpcContext,
  type ControlRpcContext,
  type GameRpcContext,
  type OperatorRpcContext,
  type PublisherRpcContext,
  type ViewerRpcContext,
} from "./rpc";
import {
  nextMaintenanceDelaySeconds,
  RunLifecycle,
  CONTAINER_START_TIMEOUT_MS,
  type MaintenancePayload,
  type PendingContainerStart,
} from "./run-lifecycle";
import { RequestError } from "./auth";
import { ContextLogger } from "./logger";
import { SerialQueue } from "./serial-queue";
import { ViewerDomain } from "./viewer-domain";

type GameContainerEnv = Env & RealtimeEnv;

const STATE_KEY = "cloud-gaming-state";
const MAINTENANCE_CALLBACK = "maintainRun";
const CLEANUP_RETRY_SECONDS = 5;
const PUBLISHER_HEALTH_PORT = 8080;
const CONTAINER_START_POLL_MS = 1_000;

export class GameContainer extends Container<GameContainerEnv> {
  defaultPort = PUBLISHER_HEALTH_PORT;
  pingEndpoint = "container/health";
  requiredPorts = [PUBLISHER_HEALTH_PORT];
  sleepAfter = "35m";

  private readonly controllers: ControllerDomain;
  private readonly lifecycle: RunLifecycle;
  private readonly log = new ContextLogger("container");
  private readonly operations = new SerialQueue();
  private readonly publisher: PublisherDomain;
  private readonly ready: Promise<void>;
  private sfuClient?: RealtimeSfuClient;
  private startup?: {
    abort: AbortController;
    generation: number;
  };
  private readonly viewers: ViewerDomain;

  constructor(ctx: DurableObjectState<{}>, env: GameContainerEnv) {
    super(ctx, env);
    this.lifecycle = new RunLifecycle({
      destroyContainer: () => this.destroy(),
      isContainerRunning: () => this.ctx.container?.running === true,
      persist: (state) => this.ctx.storage.put(STATE_KEY, state),
      renewActivity: () => this.renewActivityTimeout(),
      scheduleMaintenance: (run, delay) =>
        this.#scheduleMaintenance(run, delay),
      sfu: () => this.#sfu(),
      stopContainer: () => this.stop("SIGTERM"),
    });
    this.viewers = new ViewerDomain(this.lifecycle);
    this.controllers = new ControllerDomain(this.lifecycle, this.viewers);
    this.publisher = new PublisherDomain(this.lifecycle);
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.lifecycle.restore(await this.ctx.storage.get<unknown>(STATE_KEY));
    });
  }

  getSnapshot(context: GameRpcContext): Promise<RpcResult<GameSnapshot>> {
    return this.#runRead(context, () => this.lifecycle.snapshot());
  }

  startGame(context: OperatorRpcContext): Promise<RpcResult<GameSnapshot>> {
    return this.#runOperation(context, async () => {
      const current = this.lifecycle.snapshot();
      if (
        (current.status === "failed" || current.status === "stopped") &&
        !current.cleanupPending &&
        this.ctx.container?.running === true
      ) {
        throw new RequestError(
          409,
          "container_cleanup_pending",
          "The previous game container is still stopping. Retry shortly.",
          true,
        );
      }
      const pending = await this.lifecycle.beginStart(context.principal);
      if (pending) this.#startContainer(pending, context.requestId);
      return this.lifecycle.snapshot();
    });
  }

  stopGame(context: OperatorRpcContext): Promise<RpcResult<GameSnapshot>> {
    return this.#runOperation(context, async () => {
      const snapshot = await this.lifecycle.stop();
      this.#cancelContainerStart(snapshot.runGeneration);
      if (snapshot.runId) {
        this.log.info(
          "stop accepted",
          {
            request: context,
            run: {
              generation: snapshot.runGeneration,
              id: snapshot.runId,
            },
          },
          { status: snapshot.status },
        );
      }
      return snapshot;
    });
  }

  joinViewer(
    context: GameRpcContext,
    input: ViewerJoinRequest,
  ): Promise<RpcResult<ViewerJoinResponse>> {
    return this.#runOperation(context, () => this.viewers.join(context, input));
  }

  heartbeatViewer(
    context: ViewerRpcContext,
  ): Promise<RpcResult<ViewerHeartbeatResponse>> {
    return this.#runOperation(context, () => this.viewers.heartbeat(context));
  }

  leaveViewer(
    context: ViewerRpcContext,
  ): Promise<RpcResult<ViewerLeaveResponse>> {
    return this.#runOperation(context, () => this.viewers.leave(context));
  }

  establishViewerInputTransport(
    context: ViewerRpcContext,
  ): Promise<RpcResult<ViewerTransportResponse>> {
    return this.#runOperation(context, () =>
      this.viewers.establishInputTransport(context),
    );
  }

  completeViewerInputTransport(
    context: ViewerRpcContext,
    input: ViewerTransportCompleteRequest,
  ): Promise<RpcResult<ViewerInputResponse>> {
    return this.#runOperation(context, () =>
      this.viewers.completeInputTransport(context, input),
    );
  }

  claimControl(
    context: ControlClaimRpcContext,
  ): Promise<RpcResult<ControlClaimResponse>> {
    return this.#runOperation(context, () => this.controllers.claim(context));
  }

  releaseControl(
    context: ControlRpcContext,
  ): Promise<RpcResult<ControlLeaseResponse>> {
    return this.#runOperation(context, () => this.controllers.release(context));
  }

  registerPublisher(
    context: PublisherRpcContext,
    input: PublisherRegisterRequest,
  ): Promise<RpcResult<PublisherRegisterResponse>> {
    return this.#runOperation(context, () =>
      this.publisher.register(context, input),
    );
  }

  publishMedia(
    context: PublisherRpcContext,
    input: PublisherPublishRequest,
  ): Promise<RpcResult<PublisherPublishResponse>> {
    return this.#runOperation(context, () =>
      this.publisher.publish(context, input),
    );
  }

  publisherHeartbeat(
    context: PublisherRpcContext,
  ): Promise<RpcResult<PublisherAckResponse>> {
    return this.#runOperation(context, () => this.publisher.heartbeat(context));
  }

  establishPublisherDataChannels(
    context: PublisherRpcContext,
  ): Promise<RpcResult<PublisherTransportResponse>> {
    return this.#runOperation(context, () =>
      this.publisher.establishDataChannels(context),
    );
  }

  pollPublisherController(
    context: PublisherRpcContext,
  ): Promise<RpcResult<PublisherControllerPollResponse>> {
    return this.#runOperation(context, () =>
      this.publisher.pollController(context),
    );
  }

  completePublisherDataChannels(
    context: PublisherRpcContext,
    input: PublisherTransportCompleteRequest,
  ): Promise<RpcResult<PublisherInputResponse>> {
    return this.#runOperation(context, () =>
      this.publisher.completeDataChannels(context, input),
    );
  }

  publisherStop(
    context: PublisherRpcContext,
  ): Promise<RpcResult<PublisherAckResponse>> {
    return this.#runOperation(context, () => this.publisher.stop(context));
  }

  async maintainRun(payload: MaintenancePayload): Promise<void> {
    await this.ready;
    this.deleteSchedules(MAINTENANCE_CALLBACK);
    await this.operations.run(() => this.lifecycle.maintain(payload));
  }

  override onStart(): void {
    this.ctx.waitUntil(
      this.ready.then(() =>
        this.operations.run(() => this.lifecycle.onStart()),
      ),
    );
  }

  override onStop(params: StopParams): void {
    this.#cancelContainerStart();
    this.ctx.waitUntil(
      this.ready.then(() =>
        this.operations.run(async () => {
          const run = this.lifecycle.state.run;
          this.log.info(
            "container stopped",
            { run },
            {
              exitCode: params.exitCode,
              reason: params.reason,
            },
          );
          await this.lifecycle.onContainerStop(params);
        }),
      ),
    );
  }

  override onError(_error: unknown): void {
    this.#cancelContainerStart();
    this.ctx.waitUntil(
      this.ready.then(() =>
        this.operations.run(async () => {
          const run = this.lifecycle.state.run;
          this.log.error("container reported an error", { run });
          await this.lifecycle.onContainerError();
        }),
      ),
    );
  }

  async #runOperation<T>(
    context: { requestId: string },
    operation: () => Promise<T>,
  ): Promise<RpcResult<T>> {
    try {
      await this.ready;
      const value = await this.operations.run(operation);
      return { type: "ok", value };
    } catch (error) {
      const expected = expectedRpcError(error, context.requestId);
      if (expected) return { type: "error", error: expected };
      throw error;
    }
  }

  async #runRead<T>(
    context: { requestId: string },
    operation: () => Promise<T> | T,
  ): Promise<RpcResult<T>> {
    try {
      await this.ready;
      return { type: "ok", value: await operation() };
    } catch (error) {
      const expected = expectedRpcError(error, context.requestId);
      if (expected) return { type: "error", error: expected };
      throw error;
    }
  }

  #sfu(): RealtimeSfuClient {
    if (!this.sfuClient) {
      this.sfuClient = new RealtimeSfuClient(this.env);
    }
    return this.sfuClient;
  }

  #startContainer(
    pending: PendingContainerStart,
    requestId: string,
  ): void {
    const abort = new AbortController();
    this.startup = {
      abort,
      generation: pending.generation,
    };
    const logContext = {
      request: { requestId },
      run: { generation: pending.generation, id: pending.runId },
    };
    this.log.info("container acquisition started", logContext);
    const timeout = setTimeout(
      () => abort.abort(),
      CONTAINER_START_TIMEOUT_MS,
    );
    this.ctx.waitUntil(
      this.startAndWaitForPorts({
        cancellationOptions: {
          abort: abort.signal,
          instanceGetTimeoutMS: CONTAINER_START_TIMEOUT_MS,
          portReadyTimeoutMS: CONTAINER_START_TIMEOUT_MS,
          waitInterval: CONTAINER_START_POLL_MS,
        },
        ports: PUBLISHER_HEALTH_PORT,
        startOptions: containerStartOptions(pending),
      })
        .then(() => {
          this.log.info("container health port ready", logContext);
          return this.operations.run(() =>
            this.lifecycle.recordContainerReady(pending),
          );
        })
        .catch((error) =>
          this.operations.run(() =>
            this.lifecycle.recordStartFailure(pending, requestId, error),
          ),
        )
        .finally(() => {
          clearTimeout(timeout);
          if (this.startup?.generation === pending.generation) {
            this.startup = undefined;
          }
        }),
    );
  }

  #cancelContainerStart(generation?: number): void {
    if (
      this.startup &&
      (generation === undefined || this.startup.generation === generation)
    ) {
      this.startup.abort.abort();
    }
  }

  async #scheduleMaintenance(
    run: RunState,
    delaySeconds?: number,
  ): Promise<void> {
    if (isTerminal(run) && !run.cleanupPending) {
      this.deleteSchedules(MAINTENANCE_CALLBACK);
      return;
    }
    const delay =
      delaySeconds ??
      (run.cleanupPending
        ? CLEANUP_RETRY_SECONDS
        : nextMaintenanceDelaySeconds(run));
    const existing = (
      await this.listSchedules<MaintenancePayload>(MAINTENANCE_CALLBACK)
    )[0];
    const desiredTime = Math.floor(Date.now() / 1_000 + delay);
    if (
      existing &&
      existing.payload.runId === run.id &&
      existing.payload.generation === run.generation &&
      existing.time <= desiredTime
    ) {
      return;
    }
    this.deleteSchedules(MAINTENANCE_CALLBACK);
    await this.schedule<MaintenancePayload>(
      Math.max(1, delay),
      MAINTENANCE_CALLBACK,
      {
        generation: run.generation,
        runId: run.id,
      },
    );
  }
}

function isTerminal(run: RunState): boolean {
  return run.status === "failed" || run.status === "stopped";
}

export function containerStartOptions(
  pending: PendingContainerStart,
): ContainerStartConfigOptions {
  return {
    enableInternet: true,
    entrypoint: [
      "/usr/local/bin/cloud-gaming-publisher",
      "--width",
      String(GAME_SETTINGS.width),
      "--height",
      String(GAME_SETTINGS.height),
      "--fps",
      String(GAME_SETTINGS.fps),
    ],
    envVars: {
      GAME_RUN_GENERATION: String(pending.generation),
      GAME_RUN_ID: pending.runId,
    },
    labels: {
      application: "cloud-gaming",
    },
  };
}

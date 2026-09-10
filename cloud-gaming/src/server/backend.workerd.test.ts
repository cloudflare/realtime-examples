import { env, exports as workerExports } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

import type { ApiErrorBody } from "../shared/protocol";
import worker from "../worker";
import { hashCapability } from "./capabilities";
import { ControllerDomain } from "./controller-domain";
import { containerStartOptions } from "./game-container";
import type { RunState } from "./game-state";
import { PublisherDomain } from "./publisher-domain";
import { RealtimeSfuClient } from "./realtime";
import {
  PUBLISHER_STARTUP_TIMEOUT_MS,
  RunLifecycle,
} from "./run-lifecycle";
import { ViewerDomain } from "./viewer-domain";

const ORIGIN = "http://localhost";

afterEach(async () => {
  await reset();
});

test("browser APIs require Access identity", async () => {
  const response = await workerExports.default.fetch(
    new Request(`${ORIGIN}/api/game`, {
      headers: { origin: ORIGIN },
    }),
  );

  expect(response.status).toBe(401);
  await expect(response.json<ApiErrorBody>()).resolves.toMatchObject({
    error: { code: "access_identity_required" },
  });
});

test("local control binds one viewer tab to one authenticated principal", async () => {
  let claimContext: Record<string, unknown> | undefined;
  const localResponse = await worker.fetch(
    new Request(`${ORIGIN}/api/control`, {
      headers: {
        origin: ORIGIN,
        "x-cloud-gaming-local-identity": "developer",
        "x-cloud-gaming-viewer-capability": "v".repeat(43),
        "x-cloud-gaming-viewer-id": "123e4567-e89b-42d3-a456-426614174000",
      },
      method: "POST",
    }),
    {
      ASSETS: { fetch: () => new Response("asset") },
      AUTH_MODE: "local",
      GAME_CONTAINER: {
        getByName: () => ({
          claimControl: async (context: Record<string, unknown>) => {
            claimContext = context;
            return {
              error: {
                code: "game_not_running",
                message: "No game is running.",
                retryable: false,
                status: 409,
              },
              type: "error",
            } as const;
          },
        }),
      },
      REALTIME_SFU_APP_ID: "<test-app-id>",
      REALTIME_SFU_BEARER_TOKEN: "<test-token>",
    } as unknown as Env,
  );

  expect(localResponse.status).toBe(409);
  expect(claimContext).toMatchObject({
    principal: { subject: "local:developer" },
    viewerId: "123e4567-e89b-42d3-a456-426614174000",
  });
});

test("typed Durable Object snapshots restore persisted state after eviction", async () => {
  const stub = env.GAME_CONTAINER.getByName("default");
  const now = Date.now();
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("cloud-gaming-state", {
      generation: 4,
      run: {
        controllerGeneration: 2,
        expiresAt: now + 60_000,
        generation: 4,
        id: "123e4567-e89b-42d3-a456-426614174000",
        lastInteractiveAt: now,
        startedAt: now,
        startedBy: {
          displayHint: "test@example.com",
          subject: "access:test",
        },
        status: "running",
        updatedAt: now,
        viewers: {},
      },
      version: 2,
    });
  });

  await evictDurableObject(stub);
  await expect(
    stub.getSnapshot({
      principal: {
        displayHint: "test@example.com",
        subject: "access:test",
      },
      requestId: "eviction-check",
    }),
  ).resolves.toEqual({
    type: "ok",
    value: expect.objectContaining({
      controllerGeneration: 2,
      runGeneration: 4,
      runId: "123e4567-e89b-42d3-a456-426614174000",
      status: "running",
    }),
  });
});

test("close_track_error converges track and DataChannel cleanup", async () => {
  const responses = [
    Response.json({
      tracks: [{ errorCode: "close_track_error", mid: "video-mid" }],
    }),
    Response.json({
      dataChannels: [{ errorCode: "close_track_error", id: 7 }],
    }),
  ];
  const client = new RealtimeSfuClient(
    {
      REALTIME_SFU_APP_ID: "<test-app-id>",
      REALTIME_SFU_BEARER_TOKEN: "<test-token>",
    },
    async () => responses.shift()!,
  );

  await expect(
    client.closeTracks("publisher-session", ["video-mid"]),
  ).resolves.toEqual({
    closed: ["video-mid"],
    failures: [],
  });
  await expect(
    client.closeDataChannels("publisher-session", [7]),
  ).resolves.toEqual({
    closed: [7],
    failures: [],
  });
});

test("start records state before launch and a failed launch converges", async () => {
  const lifecycle = new RunLifecycle({
    destroyContainer: async () => {},
    isContainerRunning: () => false,
    persist: async () => {},
    renewActivity: () => {},
    scheduleMaintenance: async () => {},
    sfu: () => ({}) as RealtimeSfuClient,
    stopContainer: async () => {},
  });

  const pending = await lifecycle.beginStart({
    displayHint: "developer",
    subject: "local:developer",
  });
  expect(pending).toBeDefined();
  expect(lifecycle.snapshot()).toMatchObject({
    cleanupPending: false,
    status: "starting",
  });
  await lifecycle.recordContainerReady(pending!);
  expect(lifecycle.state.run?.containerReadyAt).toEqual(expect.any(Number));

  const options = containerStartOptions(pending!);
  await lifecycle.recordStartFailure(
    pending!,
    "startup-failure",
    new Error("test startup failure"),
  );

  expect(options.entrypoint?.[0]).toBe(
    "/usr/local/bin/cloud-gaming-publisher",
  );
  expect(lifecycle.snapshot()).toMatchObject({
    cleanupPending: false,
    status: "failed",
  });
});

test("publisher heartbeats do not extend the startup deadline", async () => {
  let stopped = false;
  const lifecycle = new RunLifecycle({
    destroyContainer: async () => {},
    isContainerRunning: () => false,
    persist: async () => {},
    renewActivity: () => {},
    scheduleMaintenance: async () => {},
    sfu: () => ({}) as RealtimeSfuClient,
    stopContainer: async () => {
      stopped = true;
    },
  });
  const pending = await lifecycle.beginStart({
    displayHint: "developer",
    subject: "local:developer",
  });
  const run = lifecycle.state.run!;
  run.containerReadyAt = Date.now() - PUBLISHER_STARTUP_TIMEOUT_MS;
  run.publisher = {
    heartbeatAt: Date.now(),
    registeredAt: Date.now(),
    session: {
      dataChannelIds: [],
      id: "publisher-session",
      trackMids: [],
    },
  };

  await lifecycle.maintain(pending!);

  expect(stopped).toBe(true);
  expect(lifecycle.snapshot().status).toBe("stopping");
  await lifecycle.onContainerStop({ exitCode: 0, reason: "exit" });
  expect(lifecycle.snapshot().status).toBe("failed");
});

test("viewer transport follows establish, renegotiate, then remote channel creation", async () => {
  const calls: Array<{ body: Record<string, unknown>; operation: string }> = [];
  const sfu = {
    async addDataChannels(_sessionId: string, body: Record<string, unknown>) {
      calls.push({ body, operation: "add" });
      return {
        dataChannels: [
          {
            dataChannelName: "keyboard-input",
            id: 21,
            location: "remote",
          },
          {
            dataChannelName: "pointer-input",
            id: 22,
            location: "remote",
          },
        ],
      };
    },
    async establishDataChannels(
      _sessionId: string,
      body: Record<string, unknown>,
    ) {
      calls.push({ body, operation: "establish" });
      return {
        dataChannel: {
          dataChannelName: "server-events",
          id: 0,
          location: "remote",
        },
        requiresImmediateRenegotiation: true,
        sessionDescription: { sdp: "transport-offer", type: "offer" },
      };
    },
    async renegotiate(_sessionId: string, answer: Record<string, unknown>) {
      calls.push({ body: answer, operation: "renegotiate" });
    },
  };
  const { context, lifecycle, run } = await seededLifecycle(sfu);
  const viewers = new ViewerDomain(lifecycle);

  await expect(viewers.establishInputTransport(context)).resolves.toEqual({
    sessionDescription: { sdp: "transport-offer", type: "offer" },
  });
  expect(run.viewers[context.viewerId]!.session.dataChannelIds).toEqual([]);

  await expect(
    viewers.completeInputTransport(context, {
      sessionDescription: { sdp: "transport-answer", type: "answer" },
    }),
  ).resolves.toMatchObject({
    inputs: [
      { id: 21, kind: "keyboard", ordered: true },
      { id: 22, kind: "pointer", maxRetransmits: 0, ordered: false },
    ],
  });

  expect(calls[0]).toEqual({
    body: {
      dataChannel: {
        dataChannelName: "server-events",
        location: "remote",
      },
    },
    operation: "establish",
  });
  expect(calls[2]).toMatchObject({
    body: {
      dataChannels: [
        {
          canReply: false,
          dataChannelName: "keyboard-input",
          location: "remote",
          sessionId: "publisher-session",
          waitForAck: true,
        },
        {
          canReply: false,
          dataChannelName: "pointer-input",
          location: "remote",
          maxRetransmits: 0,
          ordered: false,
          sessionId: "publisher-session",
          waitForAck: true,
        },
      ],
    },
    operation: "add",
  });
  expect(run.viewers[context.viewerId]!.session.dataChannelIds).toEqual([
    21, 22,
  ]);
});

test("the run becomes running only after publisher input channels are ready", async () => {
  const sfu = {
    async addDataChannels() {
      return {
        dataChannels: [
          { dataChannelName: "keyboard-input", id: 11, location: "local" },
          { dataChannelName: "pointer-input", id: 12, location: "local" },
        ],
      };
    },
    async renegotiate() {},
  };
  const { lifecycle, run } = await seededLifecycle(sfu);
  run.status = "starting";
  run.publisher!.inputs = undefined;
  run.publisher!.transport = { phase: "negotiating" };
  const publisher = new PublisherDomain(lifecycle);

  await expect(
    publisher.completeDataChannels(
      {
        requestId: "publisher-ready",
        runGeneration: run.generation,
        runId: run.id,
      },
      {
        sessionDescription: {
          sdp: "publisher-transport-answer",
          type: "answer",
        },
      },
    ),
  ).resolves.toMatchObject({
    dataChannels: [
      { kind: "keyboard" },
      { kind: "pointer" },
    ],
  });

  expect(run.status).toBe("running");
});

test("controller assignment toggles canReply on existing viewer channels", async () => {
  const replyUpdates: boolean[][] = [];
  const sfu = {
    async updateDataChannels(
      _sessionId: string,
      body: {
        dataChannels: Array<{ canReply: boolean }>;
      },
    ) {
      replyUpdates.push(body.dataChannels.map((channel) => channel.canReply));
      return {
        dataChannels: [
          { dataChannelName: "keyboard-input", id: 21, location: "remote" },
          { dataChannelName: "pointer-input", id: 22, location: "remote" },
        ],
      };
    },
  };
  const { context, lifecycle, run } = await seededLifecycle(sfu, "ready");
  const viewers = new ViewerDomain(lifecycle);
  const controllers = new ControllerDomain(lifecycle, viewers);

  await expect(controllers.claim(context)).resolves.toEqual({
    leaseGeneration: 1,
  });
  expect(run.controller).toMatchObject({
    leaseGeneration: 1,
    phase: "active",
    viewerId: context.viewerId,
  });

  await expect(controllers.release(context)).resolves.toEqual({
    cleanupPending: false,
    leaseGeneration: 2,
    released: true,
  });
  expect(replyUpdates).toEqual([
    [true, true],
    [false, false],
  ]);
  expect(run.controller).toBeUndefined();
  expect(run.controllerGeneration).toBe(2);
});

async function seededLifecycle(
  sfu: object,
  inputPhase: "none" | "ready" = "none",
): Promise<{
  context: {
    principal: { displayHint: string; subject: string };
    requestId: string;
    viewerCapability: string;
    viewerId: string;
  };
  lifecycle: RunLifecycle;
  run: RunState;
}> {
  const now = Date.now();
  const viewerCapability = "v".repeat(43);
  const viewerId = "123e4567-e89b-42d3-a456-426614174000";
  const run: RunState = {
    controllerGeneration: 0,
    expiresAt: now + 60_000,
    generation: 1,
    id: "223e4567-e89b-42d3-a456-426614174000",
    lastInteractiveAt: now,
    publisher: {
      heartbeatAt: now,
      inputs: {
        dataChannels: [
          {
            dataChannelName: "keyboard-input",
            id: 11,
            kind: "keyboard",
          },
          {
            dataChannelName: "pointer-input",
            id: 12,
            kind: "pointer",
          },
        ],
      },
      media: {
        response: {
          sessionDescription: { sdp: "publisher-answer", type: "answer" },
        },
        video: {
          kind: "video",
          mid: "video-mid",
          trackName: "video-track",
        },
      },
      registeredAt: now,
      session: {
        dataChannelIds: [11, 12],
        id: "publisher-session",
        trackMids: ["video-mid"],
      },
      transport: {
        phase: "ready",
      },
    },
    startedAt: now,
    startedBy: {
      displayHint: "developer",
      subject: "local:developer",
    },
    status: "running",
    updatedAt: now,
    viewers: {
      [viewerId]: {
        capabilityHash: await hashCapability(viewerCapability),
        createdAt: now,
        expiresAt: now + 45_000,
        id: viewerId,
        inputPhase,
        inputs:
          inputPhase === "ready"
            ? [
                {
                  dataChannelName: "keyboard-input",
                  id: 21,
                  kind: "keyboard",
                  ordered: true,
                },
                {
                  dataChannelName: "pointer-input",
                  id: 22,
                  kind: "pointer",
                  maxRetransmits: 0,
                  ordered: false,
                },
              ]
            : [],
        phase: "active",
        principalSubject: "local:developer",
        session: {
          dataChannelIds: inputPhase === "ready" ? [21, 22] : [],
          id: "viewer-session",
          trackMids: ["viewer-video-mid"],
        },
        tracks: [{ kind: "video", mid: "viewer-video-mid" }],
      },
    },
  };
  const lifecycle = new RunLifecycle({
    destroyContainer: async () => {},
    isContainerRunning: () => false,
    persist: async () => {},
    renewActivity: () => {},
    scheduleMaintenance: async () => {},
    sfu: () => sfu as RealtimeSfuClient,
    stopContainer: async () => {},
  });
  lifecycle.restore({ generation: 1, run, version: 2 });
  return {
    context: {
      principal: { displayHint: "developer", subject: "local:developer" },
      requestId: "test-request",
      viewerCapability,
      viewerId,
    },
    lifecycle,
    run,
  };
}

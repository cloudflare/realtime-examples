import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ApiError, RoomApi } from "../../src/client/api";
import { MediaSessions } from "../../src/client/media";

test("publish retries its prepared offer without waiting for an answer first", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  installPeerConnections(context);
  const api = new RoomApi("demo", "alice");
  const requests: Parameters<RoomApi["publish"]>[0][] = [];
  context.mock.method(
    api,
    "publish",
    async (request: Parameters<RoomApi["publish"]>[0]) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new ApiError("sfu_request_failed", "Try again.", true);
      }
      return {
        mutationId: request.mutationId,
        sessionDescription: {
          sdp: "publisher-answer",
          type: "answer" as const,
        },
        tracks: [],
      };
    },
  );
  const media = new MediaSessions(
    api,
    1,
    localStream(),
    () => {},
    () => {},
  );
  const publishing = media.publish();
  void publishing.catch(() => {});
  try {
    await flush();
    assert.equal(requests.length, 1);
    const producer = FakePeerConnection.instances[1]!;
    assert.equal(producer.signalingState, "have-local-offer");
    context.mock.timers.tick(250);
    await flush();
    assert.equal(requests.length, 2);
    await publishing;
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(producer.createdOffers, 1);
    assert.equal(producer.signalingState, "stable");
  } finally {
    media.close();
    context.mock.timers.tick(15_000);
    await publishing.catch(() => {});
  }
});

function installPeerConnections(context: TestContext): void {
  FakePeerConnection.instances = [];
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "RTCPeerConnection",
  );
  Object.defineProperty(globalThis, "RTCPeerConnection", {
    configurable: true,
    value: FakePeerConnection,
    writable: true,
  });
  context.after(() => {
    if (original)
      Object.defineProperty(globalThis, "RTCPeerConnection", original);
    else Reflect.deleteProperty(globalThis, "RTCPeerConnection");
  });
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  createdOffers = 0;
  transceivers: Array<{ mid: string; sender: { track: MediaStreamTrack } }> =
    [];

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(track: MediaStreamTrack) {
    const transceiver = {
      mid: String(this.transceivers.length),
      sender: { track },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.createdOffers += 1;
    return { sdp: "publisher-offer", type: "offer" };
  }

  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-local-offer" : "stable";
    this.dispatchEvent(new Event("signalingstatechange"));
  }

  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-remote-offer" : "stable";
    this.dispatchEvent(new Event("signalingstatechange"));
  }

  close(): void {
    this.connectionState = "closed";
    this.signalingState = "closed";
    this.dispatchEvent(new Event("signalingstatechange"));
  }
}

function localStream(): MediaStream {
  return {
    getTracks: () => [{ kind: "audio" }, { kind: "video" }],
  } as MediaStream;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

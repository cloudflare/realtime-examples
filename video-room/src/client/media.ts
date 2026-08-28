import type {
  RoomSnapshot,
  SessionDescription,
  TrackReference,
} from "../shared/protocol";
import { ApiError, RoomApi } from "./api";
import { SerialMutationQueue } from "./mutation-queue";

type RemoteTrackHandler = (
  reference: TrackReference,
  track: MediaStreamTrack,
) => void;

export class MediaSessions {
  private readonly abortController = new AbortController();
  private readonly consumer = createPeerConnection();
  private readonly consumerQueue = new SerialMutationQueue(retryDecision);
  private readonly disconnectedTimers = new Set<
    ReturnType<typeof setTimeout>
  >();
  private readonly producer = createPeerConnection();
  private readonly producerQueue = new SerialMutationQueue(retryDecision);
  private readonly referencesByMid = new Map<string, TrackReference>();
  private closed = false;

  constructor(
    private readonly api: RoomApi,
    private readonly generation: number,
    private readonly localStream: MediaStream,
    private readonly onRemoteTrack: RemoteTrackHandler,
    onConnectionLost: () => void,
  ) {
    this.consumer.addEventListener("track", (event) => {
      if (this.closed) return;
      const mid = event.transceiver.mid;
      const reference = mid ? this.referencesByMid.get(mid) : undefined;
      if (reference) this.onRemoteTrack(reference, event.track);
    });
    for (const peer of [this.producer, this.consumer]) {
      let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
      peer.addEventListener("connectionstatechange", () => {
        if (this.closed) return;
        if (peer.connectionState === "failed") onConnectionLost();
        if (peer.connectionState === "disconnected") {
          disconnectedTimer ??= setTimeout(() => {
            if (!this.closed) onConnectionLost();
          }, 5_000);
          this.disconnectedTimers.add(disconnectedTimer);
        } else if (disconnectedTimer) {
          clearTimeout(disconnectedTimer);
          this.disconnectedTimers.delete(disconnectedTimer);
          disconnectedTimer = undefined;
        }
      });
    }
  }

  async publish(): Promise<void> {
    const mutation = mutationId();
    let prepared:
      | {
          offer: SessionDescription;
          tracks: Array<{ kind: "audio" | "video"; mid: string }>;
        }
      | undefined;
    let response:
      | Awaited<ReturnType<RoomApi["publish"]>>
      | undefined;
    await this.producerQueue.enqueue(async () => {
      await waitForStable(this.producer);
      if (!prepared) {
        const transceivers = this.localStream.getTracks().map((track) =>
          this.producer.addTransceiver(track, { direction: "sendonly" }),
        );
        const offer = await this.producer.createOffer();
        await this.producer.setLocalDescription(offer);
        prepared = {
          offer: description(offer, "offer"),
          tracks: transceivers.map((transceiver) => ({
            kind: transceiver.sender.track!.kind as "audio" | "video",
            mid: requiredMid(transceiver),
          })),
        };
      }
      response ??= await this.api.publish({
        generation: this.generation,
        mutationId: mutation,
        sessionDescription: prepared.offer,
        tracks: prepared.tracks,
      }, this.abortController.signal);
      if (!this.producer.remoteDescription) {
        await this.producer.setRemoteDescription(response.sessionDescription);
      }
    });
  }

  async syncSubscriptions(snapshot: RoomSnapshot, selfId: string): Promise<void> {
    const desired = snapshot.participants
      .filter((participant) => participant.id !== selfId)
      .flatMap((participant) => participant.published)
      .map((track) => track.key)
      .sort();
    const mutation = mutationId();
    let response:
      | Awaited<ReturnType<RoomApi["subscribe"]>>
      | undefined;
    let answer: SessionDescription | undefined;
    await this.consumerQueue.enqueue(async () => {
      await waitForStable(this.consumer);
      response ??= await this.api.subscribe(
        this.generation,
        mutation,
        desired,
        this.abortController.signal,
      );
      this.referencesByMid.clear();
      for (const subscription of response.subscriptions) {
        this.referencesByMid.set(subscription.mid, {
          key: subscription.key,
          kind: subscription.kind,
          participantId: subscription.participantId,
        });
      }
      if (!response.requiresImmediateRenegotiation) return;
      if (!response.sessionDescription) {
        throw new Error("The subscription offer is missing.");
      }
      if (!answer) {
        await this.consumer.setRemoteDescription(response.sessionDescription);
        const localAnswer = await this.consumer.createAnswer();
        await this.consumer.setLocalDescription(localAnswer);
        answer = description(localAnswer, "answer");
      }
      await this.api.renegotiate(
        this.generation,
        mutation,
        answer,
        this.abortController.signal,
      );
    });
  }

  idle(): Promise<void> {
    return Promise.all([
      this.producerQueue.onIdle(),
      this.consumerQueue.onIdle(),
    ]).then(() => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.producerQueue.close();
    this.consumerQueue.close();
    this.abortController.abort(
      new DOMException("The media session was closed.", "AbortError"),
    );
    for (const timer of this.disconnectedTimers) clearTimeout(timer);
    this.disconnectedTimers.clear();
    this.producer.close();
    this.consumer.close();
  }

  async closeAndWait(timeoutMs: number): Promise<void> {
    this.close();
    await Promise.race([this.idle(), delay(timeoutMs)]);
  }
}

function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    bundlePolicy: "max-bundle",
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  });
}

function description(
  value: RTCSessionDescriptionInit,
  type: SessionDescription["type"],
): SessionDescription {
  if (!value.sdp) throw new Error("The browser did not create SDP.");
  return { sdp: value.sdp, type };
}

function mutationId(): string {
  return `m_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requiredMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) {
    throw new Error("The browser did not assign a media section identifier.");
  }
  return transceiver.mid;
}

function retryDecision(error: unknown, attempt: number) {
  const retry =
    error instanceof ApiError && error.retryable && attempt < 2;
  return { delayMs: 250 * 2 ** attempt, retry };
}

async function waitForStable(peer: RTCPeerConnection): Promise<void> {
  if (peer.signalingState === "stable") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("signalingstatechange", changed);
      reject(new Error("WebRTC signaling did not return to stable."));
    }, 15_000);
    const changed = () => {
      if (peer.signalingState !== "stable") return;
      clearTimeout(timeout);
      peer.removeEventListener("signalingstatechange", changed);
      resolve();
    };
    peer.addEventListener("signalingstatechange", changed);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

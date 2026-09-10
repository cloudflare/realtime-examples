import type { SessionDescription } from "../shared/protocol";

const ICE_GATHERING_TIMEOUT_MS = 10_000;

export async function createGatheredOffer(
  peer: RTCPeerConnection,
): Promise<SessionDescription> {
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);
  const local = peer.localDescription;
  if (!local || local.type !== "offer" || local.sdp.length === 0) {
    throw new Error("The browser did not produce a complete WebRTC offer.");
  }
  return { sdp: local.sdp, type: "offer" };
}

export async function createGatheredAnswer(
  peer: RTCPeerConnection,
): Promise<SessionDescription> {
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await waitForIceGathering(peer);
  const local = peer.localDescription;
  if (!local || local.type !== "answer" || local.sdp.length === 0) {
    throw new Error("The browser did not produce a complete WebRTC answer.");
  }
  return { sdp: local.sdp, type: "answer" };
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      if (hasIceCandidate(peer.localDescription?.sdp)) {
        resolve();
      } else {
        reject(
          new Error("The browser did not gather a usable ICE candidate."),
        );
      }
    }, ICE_GATHERING_TIMEOUT_MS);
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
    };
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function hasIceCandidate(sdp: string | undefined): boolean {
  return sdp?.split(/\r?\n/).some((line) => line.startsWith("a=candidate:")) ===
    true;
}

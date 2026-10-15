export class MediaConnectionError extends Error {
  name = 'MediaConnectionError';
}

function waitForPeer(
  pc: RTCPeerConnection,
  check: () => boolean,
  timeout: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const events = [
      'icecandidate',
      'icegatheringstatechange',
      'connectionstatechange',
      'signalingstatechange',
    ];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.forEach((event) => pc.removeEventListener(event, changed));
      signal.removeEventListener('abort', aborted);
      if (error && error.name !== 'AbortError') {
        console.warn('[Voice ICE]', {
          connection: pc.connectionState,
          ice: pc.iceConnectionState,
          gathering: pc.iceGatheringState,
          signaling: pc.signalingState,
          candidateCount: (pc.localDescription?.sdp.match(/^a=candidate:/gm) ?? []).length,
        });
      }
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        finish(new MediaConnectionError('The audio connection closed. Please try again.'));
      } else {
        try {
          if (check()) finish();
        } catch (error) {
          finish(error as Error);
        }
      }
    };
    const aborted = () => finish(new DOMException('Call cancelled', 'AbortError'));
    const timer = setTimeout(
      () =>
        finish(
          new MediaConnectionError(
            'No audio connection was established. Check your network and try again.',
          ),
        ),
      timeout,
    );
    events.forEach((event) => pc.addEventListener(event, changed));
    signal.addEventListener('abort', aborted, { once: true });
    signal.aborted ? aborted() : changed();
  });
}

export async function firstCandidate(
  pc: RTCPeerConnection,
  type: 'offer' | 'answer',
  signal: AbortSignal,
  timeout = 10_000,
): Promise<RTCSessionDescriptionInit> {
  await waitForPeer(
    pc,
    () => {
      if (pc.localDescription?.type !== type)
        throw new MediaConnectionError('The media offer could not be created.');
      if (/^a=candidate:/m.test(pc.localDescription.sdp)) return true;
      if (pc.iceGatheringState === 'complete')
        throw new MediaConnectionError('No network path was found for audio.');
      return false;
    },
    timeout,
    signal,
  );
  console.info('[Voice ICE]', {
    description: type,
    gathering: pc.iceGatheringState,
    candidates: (pc.localDescription!.sdp.match(/^a=candidate:/gm) ?? []).length,
  });
  return { type, sdp: pc.localDescription!.sdp };
}

export function connected(pc: RTCPeerConnection, signal: AbortSignal) {
  return waitForPeer(pc, () => pc.connectionState === 'connected', 15_000, signal);
}

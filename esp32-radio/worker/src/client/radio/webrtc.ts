import type { Answer } from '@/shared/contracts/signaling.ts';

export async function gatheredAnswer(peer: RTCPeerConnection): Promise<Answer> {
  await peer.setLocalDescription(await peer.createAnswer());
  if (peer.iceGatheringState !== 'complete')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Connection setup timed out. Try again.'));
      }, 10000);
      const changed = () => {
        if (peer.iceGatheringState === 'complete') {
          cleanup();
          resolve();
        }
      };
      const closed = () => {
        if (peer.connectionState === 'closed') {
          cleanup();
          reject(new Error('Connection cancelled.'));
        }
      };
      function cleanup() {
        clearTimeout(timer);
        peer.removeEventListener('icegatheringstatechange', changed);
        peer.removeEventListener('connectionstatechange', closed);
      }
      peer.addEventListener('icegatheringstatechange', changed);
      peer.addEventListener('connectionstatechange', closed);
      changed();
      closed();
    });
  if (!peer.localDescription?.sdp) throw new Error('Could not set up the connection. Try again.');
  return { type: 'answer', sdp: peer.localDescription.sdp };
}

export async function acknowledge(channel: RTCDataChannel): Promise<void> {
  if (channel.readyState !== 'open')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`The ${channel.label} channel did not open. Try again.`));
      }, 15000);
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error('Data channel closed during setup. Try again.'));
      };
      function cleanup() {
        clearTimeout(timer);
        channel.removeEventListener('open', opened);
        channel.removeEventListener('close', failed);
        channel.removeEventListener('error', failed);
      }
      channel.addEventListener('open', opened);
      channel.addEventListener('close', failed);
      channel.addEventListener('error', failed);
      if (channel.readyState === 'closed' || channel.readyState === 'closing') failed();
    });
  channel.send('ack');
}

import {
  isSessionDescription,
  type SessionDescription,
} from "../shared/protocol";
import { RequestError } from "./auth";
import type { SfuDataChannel, SfuTrack } from "./realtime";

export function requireAnswer(
  value: unknown,
  immediate: boolean | undefined,
  code: string,
): SessionDescription {
  if (immediate || !isSessionDescription(value, "answer")) {
    throw new RequestError(
      502,
      code,
      "Realtime SFU returned an unexpected negotiation response.",
      true,
    );
  }
  return value;
}

export function requireOffer(
  value: unknown,
  immediate: boolean | undefined,
  code: string,
): SessionDescription {
  if (immediate !== true || !isSessionDescription(value, "offer")) {
    throw new RequestError(
      502,
      code,
      "Realtime SFU returned an unexpected negotiation response.",
      true,
    );
  }
  return value;
}

export function requireTrackMid(tracks: SfuTrack[], trackName: string): string {
  const mid = responseTrack(tracks, trackName)?.mid;
  if (!mid) {
    throw new RequestError(
      502,
      "sfu_track_missing",
      "Realtime SFU did not identify a media track.",
      true,
    );
  }
  return mid;
}

export function responseTrack(
  tracks: SfuTrack[],
  trackName: string,
): SfuTrack | undefined {
  return tracks.find((track) => track.trackName === trackName);
}

export function requireDataChannelId(
  channels: SfuDataChannel[],
  dataChannelName: string,
): number {
  const id = channels.find(
    (channel) => channel.dataChannelName === dataChannelName,
  )?.id;
  if (id === undefined) {
    throw new RequestError(
      502,
      "sfu_datachannel_missing",
      "Realtime SFU did not identify a DataChannel.",
      true,
    );
  }
  return id;
}

export function unique<Value>(values: Value[]): Value[] {
  return [...new Set(values)];
}

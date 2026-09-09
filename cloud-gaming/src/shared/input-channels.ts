import type { InputKind } from "./protocol";

export type InputChannelProfile = {
  readonly dataChannelName: string;
  readonly kind: InputKind;
  readonly maxRetransmits?: number;
  readonly ordered: boolean;
};

export const INPUT_CHANNEL_PROFILES: readonly InputChannelProfile[] = [
  {
    dataChannelName: "keyboard-input",
    kind: "keyboard",
    ordered: true,
  },
  {
    dataChannelName: "pointer-input",
    kind: "pointer",
    maxRetransmits: 0,
    ordered: false,
  },
];

export const VIEWER_INPUT_SUBSCRIPTION = {
  canReply: false,
  waitForAck: true,
} as const;

export function inputChannelProfile(kind: InputKind): InputChannelProfile {
  const profile = INPUT_CHANNEL_PROFILES.find(
    (candidate) => candidate.kind === kind,
  );
  if (!profile) throw new Error(`Unknown input channel kind: ${kind}`);
  return profile;
}

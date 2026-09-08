export type ChannelProfileId =
  | "reliable-ordered"
  | "unreliable-unordered";

export type DataChannelLocation = "local" | "remote";

export interface ChannelReliability {
  readonly ordered: boolean;
  readonly maxRetransmits?: number;
}

export interface ChannelRemoteOptions {
  readonly waitForAck?: boolean;
  readonly canReply?: boolean;
}

export interface ChannelProfile {
  readonly id: ChannelProfileId;
  readonly label: string;
  readonly dataChannelName: string;
  readonly description: string;
  readonly reliability: ChannelReliability;
  readonly remoteOptions: ChannelRemoteOptions;
}

export interface LocalSfuDataChannel extends ChannelReliability {
  location: "local";
  dataChannelName: string;
}

export interface RemoteSfuDataChannel extends ChannelReliability {
  location: "remote";
  dataChannelName: string;
  sessionId: string;
  waitForAck?: boolean;
  canReply?: boolean;
}

export type SfuDataChannel =
  | LocalSfuDataChannel
  | RemoteSfuDataChannel;

export interface BrowserDataChannelOptions extends RTCDataChannelInit {
  negotiated: true;
  id: number;
}

export interface ProfileTeachingConfig {
  localApi: LocalSfuDataChannel;
  remoteApi: RemoteSfuDataChannel;
  browser: ChannelReliability & {
    negotiated: true;
    id: string;
  };
}

const RELIABLE_ORDERED = Object.freeze({
  id: "reliable-ordered",
  label: "Reliable + ordered",
  dataChannelName: "reliable-ordered",
  description:
    "Default reliable, ordered delivery. The remote subscriber also uses waitForAck and canReply.",
  reliability: Object.freeze({
    ordered: true,
  }),
  remoteOptions: Object.freeze({
    waitForAck: true,
    canReply: true,
  }),
}) satisfies ChannelProfile;

const UNRELIABLE_UNORDERED = Object.freeze({
  id: "unreliable-unordered",
  label: "Unordered + no retransmissions",
  dataChannelName: "latest-state",
  description:
    "Partial reliability for replaceable state: messages may arrive out of order or not arrive.",
  reliability: Object.freeze({
    ordered: false,
    maxRetransmits: 0,
  }),
  remoteOptions: Object.freeze({}),
}) satisfies ChannelProfile;

export const CHANNEL_PROFILES: Readonly<
  Record<ChannelProfileId, ChannelProfile>
> = Object.freeze({
  [RELIABLE_ORDERED.id]: RELIABLE_ORDERED,
  [UNRELIABLE_UNORDERED.id]: UNRELIABLE_UNORDERED,
});

export function getChannelProfile(
  profileId: ChannelProfileId,
): ChannelProfile {
  const profile = (
    CHANNEL_PROFILES as Partial<Record<string, ChannelProfile>>
  )[profileId];
  if (!profile) {
    throw new TypeError(`Unknown DataChannel profile: ${profileId}`);
  }
  return profile;
}

export function buildSfuDataChannel(
  profileId: ChannelProfileId,
  location: "local",
  publisherSessionId?: undefined,
): LocalSfuDataChannel;
export function buildSfuDataChannel(
  profileId: ChannelProfileId,
  location: "remote",
  publisherSessionId: string,
): RemoteSfuDataChannel;
export function buildSfuDataChannel(
  profileId: ChannelProfileId,
  location: DataChannelLocation,
  publisherSessionId?: string,
): SfuDataChannel;
export function buildSfuDataChannel(
  profileId: ChannelProfileId,
  location: DataChannelLocation,
  publisherSessionId?: string,
): SfuDataChannel {
  const profile = getChannelProfile(profileId);
  if (location === "local") {
    return {
      location,
      dataChannelName: profile.dataChannelName,
      ...profile.reliability,
    };
  }

  if (
    typeof publisherSessionId !== "string" ||
    publisherSessionId.length === 0
  ) {
    throw new TypeError(
      "A publisher session ID is required for a remote DataChannel",
    );
  }
  return {
    location,
    dataChannelName: profile.dataChannelName,
    ...profile.reliability,
    sessionId: publisherSessionId,
    ...profile.remoteOptions,
  };
}

export function buildBrowserDataChannelOptions(
  profileId: ChannelProfileId,
  id: number,
): BrowserDataChannelOptions {
  if (!Number.isInteger(id) || id < 0 || id > 65_534) {
    throw new TypeError(`Invalid negotiated DataChannel ID: ${id}`);
  }

  return {
    negotiated: true,
    id,
    ...getChannelProfile(profileId).reliability,
  };
}

export function getProfileTeachingConfig(
  profileId: ChannelProfileId,
): ProfileTeachingConfig {
  const profile = getChannelProfile(profileId);
  return {
    localApi: buildSfuDataChannel(profileId, "local"),
    remoteApi: buildSfuDataChannel(
      profileId,
      "remote",
      "<publisher-session-id>",
    ),
    browser: {
      negotiated: true,
      id: "<id returned by the API>",
      ...profile.reliability,
    },
  };
}

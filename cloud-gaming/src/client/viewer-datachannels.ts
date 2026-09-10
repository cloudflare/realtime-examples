import type {
  ControlInputChannel,
  ViewerInputResponse,
} from "../shared/protocol";
import {
  INPUT_CHANNEL_PROFILES,
  inputChannelProfile,
} from "../shared/input-channels";
import { CloudGamingApi, type ViewerCredentials } from "./api";
import { createGatheredAnswer } from "./webrtc";

const DATA_CHANNEL_OPEN_TIMEOUT_MS = 20_000;

export type ViewerControlEndpoint = {
  credentials: ViewerCredentials;
  keyboard: RTCDataChannel;
  pointer: RTCDataChannel;
};

export async function setupViewerDataChannels(
  api: CloudGamingApi,
  peer: RTCPeerConnection,
  credentials: ViewerCredentials,
): Promise<Omit<ViewerControlEndpoint, "credentials">> {
  const transport = await api.establishViewerDataChannels(credentials);
  await peer.setRemoteDescription(transport.sessionDescription);
  const answer = await createGatheredAnswer(peer);
  const inputResponse = await api.completeViewerDataChannels(
    credentials,
    answer,
  );
  const channels = createInputChannels(peer, inputResponse);
  await Promise.all([
    acknowledgeRemoteChannel(channels.keyboard, "keyboard"),
    acknowledgeRemoteChannel(channels.pointer, "pointer"),
  ]);
  return channels;
}

function createInputChannels(
  peer: RTCPeerConnection,
  response: ViewerInputResponse,
): { keyboard: RTCDataChannel; pointer: RTCDataChannel } {
  const { keyboard, pointer } = requireInputChannels(response.inputs);
  return {
    keyboard: peer.createDataChannel(keyboard.dataChannelName, {
      id: keyboard.id,
      negotiated: true,
      ...channelOptions(keyboard),
    }),
    pointer: peer.createDataChannel(pointer.dataChannelName, {
      id: pointer.id,
      negotiated: true,
      ...channelOptions(pointer),
    }),
  };
}

function requireInputChannels(inputs: ControlInputChannel[]): {
  keyboard: ControlInputChannel;
  pointer: ControlInputChannel;
} {
  if (inputs.length !== INPUT_CHANNEL_PROFILES.length) {
    throw new Error(
      "The viewer response did not contain the required input channels.",
    );
  }
  for (const input of inputs) {
    const profile = inputChannelProfile(input.kind);
    if (
      input.dataChannelName !== profile.dataChannelName ||
      input.ordered !== profile.ordered ||
      input.maxRetransmits !== profile.maxRetransmits
    ) {
      throw new Error(
        "The viewer response did not contain the required input channels.",
      );
    }
  }
  const keyboard = inputs.find((input) => input.kind === "keyboard");
  const pointer = inputs.find((input) => input.kind === "pointer");
  if (!keyboard || !pointer) {
    throw new Error(
      "The viewer response did not contain the required input channels.",
    );
  }
  return { keyboard, pointer };
}

function channelOptions(channel: ControlInputChannel): RTCDataChannelInit {
  const profile = inputChannelProfile(channel.kind);
  return {
    ...(profile.maxRetransmits === undefined
      ? {}
      : { maxRetransmits: profile.maxRetransmits }),
    ordered: profile.ordered,
  };
}

async function acknowledgeRemoteChannel(
  channel: RTCDataChannel,
  label: string,
): Promise<void> {
  if (channel.readyState === "open") {
    channel.send("ack");
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`The ${label} input channel did not open in time.`));
    }, DATA_CHANNEL_OPEN_TIMEOUT_MS);
    const onOpen = () => {
      cleanup();
      try {
        channel.send("ack");
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`The ${label} input channel closed during setup.`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`The ${label} input channel failed during setup.`));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onError);
  });
}

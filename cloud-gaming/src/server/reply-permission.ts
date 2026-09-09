import { INPUT_CHANNEL_PROFILES } from "../shared/input-channels";
import { RequestError } from "./auth";
import type { RunState, ViewerState } from "./game-state";
import {
  assertDataChannelItemsSucceeded,
  type RealtimeSfuClient,
} from "./realtime";
import { requireDataChannelId } from "./sfu-results";

export async function setViewerReplyPermission(
  sfu: RealtimeSfuClient,
  run: RunState,
  viewer: ViewerState,
  canReply: boolean,
): Promise<void> {
  const publisher = run.publisher;
  if (
    !publisher?.inputs ||
    publisher.inputs.dataChannels.length !== INPUT_CHANNEL_PROFILES.length
  ) {
    throw new RequestError(
      409,
      "publisher_inputs_missing",
      "The publisher input DataChannels are not ready.",
      true,
    );
  }

  const response = await sfu.updateDataChannels(viewer.session.id, {
    dataChannels: publisher.inputs.dataChannels.map((channel) => ({
      canReply,
      dataChannelName: channel.dataChannelName,
      location: "remote",
      sessionId: publisher.session.id,
    })),
  });
  assertDataChannelItemsSucceeded(response, "controller reply permission");
  for (const channel of publisher.inputs.dataChannels) {
    requireDataChannelId(response.dataChannels, channel.dataChannelName);
  }
  if (response.requiresImmediateRenegotiation) {
    throw new RequestError(
      502,
      "controller_update_negotiation_invalid",
      "Realtime SFU unexpectedly required controller renegotiation.",
      true,
    );
  }
}

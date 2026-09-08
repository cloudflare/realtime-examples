import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBrowserDataChannelOptions,
  buildSfuDataChannel,
} from "../channel-config.ts";

test("reliable ordered profile combines waitForAck and canReply only remotely", () => {
  assert.deepEqual(buildSfuDataChannel("reliable-ordered", "local"), {
    location: "local",
    dataChannelName: "reliable-ordered",
    ordered: true,
  });
  assert.deepEqual(
    buildSfuDataChannel(
      "reliable-ordered",
      "remote",
      "publisher_session",
    ),
    {
      location: "remote",
      dataChannelName: "reliable-ordered",
      ordered: true,
      sessionId: "publisher_session",
      waitForAck: true,
      canReply: true,
    },
  );
  assert.deepEqual(buildBrowserDataChannelOptions("reliable-ordered", 3), {
    negotiated: true,
    id: 3,
    ordered: true,
  });
});

test("unreliable unordered profile matches local, remote, and browser settings", () => {
  const reliability = {
    ordered: false,
    maxRetransmits: 0,
  };
  assert.deepEqual(buildSfuDataChannel("unreliable-unordered", "local"), {
    location: "local",
    dataChannelName: "latest-state",
    ...reliability,
  });
  assert.deepEqual(
    buildSfuDataChannel(
      "unreliable-unordered",
      "remote",
      "publisher_session",
    ),
    {
      location: "remote",
      dataChannelName: "latest-state",
      ...reliability,
      sessionId: "publisher_session",
    },
  );
  assert.deepEqual(
    buildBrowserDataChannelOptions("unreliable-unordered", 4),
    {
      negotiated: true,
      id: 4,
      ...reliability,
    },
  );
});

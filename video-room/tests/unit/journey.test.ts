import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleControlState } from "../../src/client/lifecycle";
import { openAnotherParticipant } from "../../src/client/open-participant";

test("opens the same room in a fresh noopener tab", () => {
  const calls: unknown[][] = [];
  openAnotherParticipant(
    "https://room.example/rooms/demo",
    ((...args: unknown[]) => {
      calls.push(args);
      return null;
    }) as typeof window.open,
  );

  assert.deepEqual(calls, [
    ["https://room.example/rooms/demo", "_blank", "noopener"],
  ]);
});

test("reconnect keeps terminal controls available and terminal work disables them", () => {
  assert.deepEqual(lifecycleControlState("reconnect", true), {
    displayNameDisabled: false,
    joinDisabled: true,
    leaveDisabled: false,
    terminateDisabled: false,
  });
  assert.deepEqual(lifecycleControlState("leave", true), {
    displayNameDisabled: false,
    joinDisabled: true,
    leaveDisabled: true,
    terminateDisabled: true,
  });
  assert.deepEqual(lifecycleControlState(undefined, false), {
    displayNameDisabled: false,
    joinDisabled: false,
    leaveDisabled: true,
    terminateDisabled: true,
  });
});

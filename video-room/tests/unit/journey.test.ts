import assert from "node:assert/strict";
import test from "node:test";

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

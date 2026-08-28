import { reset } from "cloudflare:test";
import { afterAll, afterEach, beforeAll } from "vitest";

import { network } from "./network";

beforeAll(async () => {
  network.configure({ onUnhandledFrame: "error" });
  await network.enable();
});

afterEach(async () => {
  network.resetHandlers();
  await reset();
});

afterAll(async () => {
  await network.disable();
});

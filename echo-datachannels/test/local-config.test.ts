import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  loadRealtimeSfuCredentials,
  LocalConfigurationError,
} from "../local-config.ts";

type TestEnvironment = Record<string, string | undefined>;

const APP_ID_VARIABLE = "REALTIME_SFU_APP_ID";
const TOKEN_VARIABLE = "REALTIME_SFU_BEARER_TOKEN";

async function createDevVars(
  t: TestContext,
  contents: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "echo-datachannels-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, ".dev.vars");
  await writeFile(filePath, contents, "utf8");
  return filePath;
}

test("loads Realtime SFU credentials from .dev.vars", async (t) => {
  const filePath = await createDevVars(
    t,
    [
      "REALTIME_SFU_APP_ID=file-app-id",
      "REALTIME_SFU_BEARER_TOKEN=file-token-value",
      "",
    ].join("\n"),
  );
  const environment: TestEnvironment = {};

  assert.deepEqual(
    await loadRealtimeSfuCredentials({ filePath, environment }),
    {
      appId: "file-app-id",
      token: "file-token-value",
    },
  );
});

test("already-set environment variables take precedence over .dev.vars", async (t) => {
  const filePath = await createDevVars(
    t,
    [
      "REALTIME_SFU_APP_ID=file-app-id",
      "REALTIME_SFU_BEARER_TOKEN=file-token-value",
      "PORT=9999",
    ].join("\n"),
  );
  const environment: TestEnvironment = {
    [APP_ID_VARIABLE]: "environment-app-id",
    [TOKEN_VARIABLE]: "environment-token-value",
    PORT: "8787",
  };

  assert.deepEqual(
    await loadRealtimeSfuCredentials({ filePath, environment }),
    {
      appId: "environment-app-id",
      token: "environment-token-value",
    },
  );
  assert.equal(environment.PORT, "8787");
});

test("a missing .dev.vars is optional but missing credentials fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-datachannels-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, ".dev.vars");

  assert.deepEqual(
    await loadRealtimeSfuCredentials({
      filePath,
      environment: {
        [APP_ID_VARIABLE]: "environment-app-id",
        [TOKEN_VARIABLE]: "environment-token-value",
      },
    }),
    {
      appId: "environment-app-id",
      token: "environment-token-value",
    },
  );

  await assert.rejects(
    () =>
      loadRealtimeSfuCredentials({
        filePath,
        environment: {},
      }),
    (error) =>
      error instanceof LocalConfigurationError &&
      error.code === "missing_sfu_credentials" &&
      error.message.includes(".dev.vars") &&
      error.message.includes("server environment"),
  );
});

test("malformed .dev.vars reports the line without exposing values", async (t) => {
  const filePath = await createDevVars(
    t,
    [
      "REALTIME_SFU_APP_ID=file-app-id",
      "this line has no assignment",
      "REALTIME_SFU_BEARER_TOKEN=file-token-value",
    ].join("\n"),
  );

  await assert.rejects(
    () =>
      loadRealtimeSfuCredentials({
        filePath,
        environment: {},
      }),
    (error) =>
      error instanceof LocalConfigurationError &&
      error.code === "malformed_dev_vars" &&
      error.message.includes("line 2") &&
      !error.message.includes("file-token-value"),
  );
});

test("unreadable .dev.vars produces an actionable sanitized error", async () => {
  const readError = Object.assign(new Error("sensitive filesystem detail"), {
    code: "EACCES",
  });

  await assert.rejects(
    () =>
      loadRealtimeSfuCredentials({
        filePath: "/unused/.dev.vars",
        environment: {},
        readTextFile: async () => {
          throw readError;
        },
      }),
    (error) =>
      error instanceof LocalConfigurationError &&
      error.code === "unreadable_dev_vars" &&
      error.message.includes("readable regular file") &&
      !error.message.includes("sensitive filesystem detail"),
  );
});

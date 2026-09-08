import { expect, test, type Page } from "@playwright/test";

type ApiFailure = {
  code?: string;
  path: string;
  retryable?: boolean;
  status: number;
};

test.skip(
  !process.env.LIVE_VIDEO_ROOM_URL,
  "Set LIVE_VIDEO_ROOM_URL to the local Vite origin.",
);

test("two fresh tabs in one browser context publish, subscribe, refresh, and leave", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const roomPath = `/rooms/validation-${Date.now()}`;
  const context = await browser.newContext();
  const apiFailures: Array<Promise<ApiFailure>> = [];
  context.on("response", (response) => {
    if (
      response.status() >= 400 &&
      new URL(response.url()).pathname.startsWith("/api/")
    ) {
      apiFailures.push(readApiFailure(response));
    }
  });
  const alice = await context.newPage();
  await join(alice, "Alice", roomPath);
  const aliceClientId = await clientId(alice);

  const bobPage = context.waitForEvent("page");
  await alice
    .getByRole("button", { name: "Open another participant" })
    .click();
  const bob = await bobPage;
  await bob.waitForLoadState();
  await expect(bob).toHaveURL(new RegExp(`${roomPath}$`));
  await expect(bob.getByLabel("Display name")).toHaveValue("");
  assertFreshClientId(aliceClientId, await clientId(bob));
  await join(bob, "Bob");

  await expect(alice.locator(".tile-label", { hasText: "Bob" })).toBeVisible();
  await expect(bob.locator(".tile-label", { hasText: "Alice" })).toBeVisible();
  await expect
    .poll(() => activeRemoteTrackCount(alice, "video"))
    .toBeGreaterThan(0);
  await expect
    .poll(() => activeRemoteTrackCount(bob, "video"))
    .toBeGreaterThan(0);
  await expect
    .poll(() => activeRemoteTrackCount(alice, "audio"))
    .toBeGreaterThan(0);
  await expect
    .poll(() => activeRemoteTrackCount(bob, "audio"))
    .toBeGreaterThan(0);

  await alice.reload();
  try {
    await expect(alice.getByRole("button", { name: "Leave" })).toBeVisible({
      timeout: 20_000,
    });
  } catch (error) {
    throw new Error(
      `Refresh did not rejoin: ${JSON.stringify({
        apiFailures: await Promise.all(apiFailures),
        status: await alice.locator("#status").textContent(),
      })}`,
      { cause: error },
    );
  }
  await expect(alice.locator(".video-tile")).toHaveCount(2);
  await expect(alice.locator(".tile-label", { hasText: "Alice" })).toHaveCount(1);
  await expect.poll(
    () => activeRemoteTrackCount(alice, "video"),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => activeRemoteTrackCount(alice, "audio"),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  const bobFramesAfterRefresh = await remoteVideoFrameCount(bob);
  await expect.poll(
    () => activeRemoteTrackCount(bob, "video"),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => activeRemoteTrackCount(bob, "audio"),
    { timeout: 20_000 },
  ).toBeGreaterThan(0);
  await expect.poll(
    () => remoteVideoFrameCount(bob),
    { timeout: 20_000 },
  ).toBeGreaterThan(bobFramesAfterRefresh + 5);

  await bob.getByRole("button", { name: "Leave" }).click();
  await expect(alice.locator(".video-tile")).toHaveCount(1, {
    timeout: 20_000,
  });

  await bob.getByRole("button", { name: "Join room" }).click();
  await expect(bob.getByRole("button", { name: "Leave" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(alice.locator(".video-tile")).toHaveCount(2);

  alice.once("dialog", (dialog) => dialog.accept());
  await alice.getByRole("button", { name: "terminate room" }).click();
  await expect(alice.getByText("Room terminated.")).toBeVisible({
    timeout: 20_000,
  });
  await expect(alice.getByRole("button", { name: "Join room" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    bob.getByText("The room creator terminated this room."),
  ).toBeVisible({ timeout: 20_000 });
  await expect(bob.getByRole("button", { name: "Join room" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(alice.locator(".video-tile")).toHaveCount(0);
  await expect(bob.locator(".video-tile")).toHaveCount(0);

  await context.close();
});

async function join(
  page: Page,
  displayName: string,
  roomPath?: string,
): Promise<void> {
  if (roomPath) await page.goto(roomPath);
  await page.getByLabel("Display name").fill(displayName);
  await page.getByRole("button", { name: "Join room" }).click();
  await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
  await expect(page.locator(".tile-label", { hasText: displayName })).toBeVisible();
}

async function clientId(page: Page): Promise<string | null> {
  return page.evaluate(() => sessionStorage.getItem("video-room-client"));
}

async function readApiFailure(
  response: import("@playwright/test").Response,
): Promise<ApiFailure> {
  const result: ApiFailure = {
    path: new URL(response.url()).pathname,
    status: response.status(),
  };
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
        retryable?: unknown;
      };
    };
    if (typeof body.error?.code === "string") result.code = body.error.code;
    if (typeof body.error?.retryable === "boolean") {
      result.retryable = body.error.retryable;
    }
  } catch {
    // The status and path remain useful when an error body is unreadable.
  }
  return result;
}

function assertFreshClientId(
  aliceClientId: string | null,
  bobClientId: string | null,
): void {
  expect(aliceClientId).toBeTruthy();
  expect(bobClientId).toBeTruthy();
  expect(bobClientId).not.toBe(aliceClientId);
}

async function activeRemoteTrackCount(
  page: Page,
  kind: "audio" | "video",
): Promise<number> {
  return page.locator("video:not([muted])").evaluateAll(
    (videos, trackKind) =>
      videos.reduce((count, video) => {
        const stream = (video as HTMLVideoElement)
          .srcObject as MediaStream | null;
        const tracks =
          trackKind === "video"
            ? stream?.getVideoTracks() ?? []
            : stream?.getAudioTracks() ?? [];
        return (
          count +
          tracks.filter(
            (track) => track.readyState === "live" && !track.muted,
          ).length
        );
      }, 0),
    kind,
  );
}

async function remoteVideoFrameCount(page: Page): Promise<number> {
  return page.locator("video:not([muted])").evaluateAll((videos) =>
    videos.reduce(
      (count, video) =>
        count +
        (video as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
      0,
    ),
  );
}

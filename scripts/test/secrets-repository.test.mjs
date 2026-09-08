import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  scanBrowserAssets,
  scanRepositoryForSecrets,
} from "../lib/secrets.mjs";

const FAKE_SECRET =
  "REALTIME_SFU_BEARER_TOKEN=not-a-real-secret-value-1234567890";

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 50,
    });
  }
});

function createTemporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "calls-secret-scan-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function createGitRepository() {
  const repoRoot = createTemporaryDirectory();
  execFileSync("git", ["init", "--quiet", repoRoot]);
  return repoRoot;
}

function hasFindingFor(findings, file) {
  return findings.some((finding) => finding.file === file);
}

test("repository scanner does not open ignored untracked .dev.vars", () => {
  const repoRoot = createGitRepository();
  const ignoredPath = path.join(repoRoot, ".dev.vars");
  fs.writeFileSync(
    path.join(repoRoot, ".gitignore"),
    ".dev.vars\n**/.dev.vars\n",
  );
  fs.writeFileSync(ignoredPath, FAKE_SECRET);

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function readFileSync(filePath, ...args) {
    if (path.resolve(filePath) === ignoredPath) {
      assert.fail("ignored .dev.vars was opened");
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };

  try {
    assert.deepEqual(scanRepositoryForSecrets(repoRoot), []);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});

test("repository scanner reports an unignored untracked secret", () => {
  const repoRoot = createGitRepository();
  fs.writeFileSync(path.join(repoRoot, "local-notes.txt"), FAKE_SECRET);

  const findings = scanRepositoryForSecrets(repoRoot);

  assert.equal(hasFindingFor(findings, "local-notes.txt"), true);
});

test("repository scanner reports a force-tracked ignored-name file", () => {
  const repoRoot = createGitRepository();
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), ".dev.vars\n");
  fs.writeFileSync(path.join(repoRoot, ".dev.vars"), FAKE_SECRET);
  execFileSync("git", ["-C", repoRoot, "add", "--force", ".dev.vars"]);

  const findings = scanRepositoryForSecrets(repoRoot);

  assert.equal(hasFindingFor(findings, ".dev.vars"), true);
});

test("browser scanner inspects an explicitly declared ignored asset path", () => {
  const repoRoot = createGitRepository();
  const assetDirectory = path.join(repoRoot, "dist");
  fs.mkdirSync(assetDirectory);
  fs.writeFileSync(path.join(repoRoot, ".gitignore"), "dist/\n");
  fs.writeFileSync(
    path.join(assetDirectory, "client.js"),
    "const token = env.REALTIME_SFU_BEARER_TOKEN;",
  );

  const findings = scanBrowserAssets(repoRoot, ["dist"]);

  assert.equal(hasFindingFor(findings, path.join("dist", "client.js")), true);
});

test("repository scanner falls back for a non-git directory", () => {
  const repoRoot = createTemporaryDirectory();
  fs.writeFileSync(path.join(repoRoot, "local-notes.txt"), FAKE_SECRET);

  const findings = scanRepositoryForSecrets(repoRoot);

  assert.equal(hasFindingFor(findings, "local-notes.txt"), true);
});

import { spawnSync } from "node:child_process";
import path from "node:path";

import { isPathInside } from "./lib/files.mjs";
import { validateRepositoryMetadata } from "./lib/metadata.mjs";
import { scanBrowserAssets } from "./lib/secrets.mjs";

const repoRoot = process.cwd();
const requestedPath = process.argv[2];
if (!requestedPath) {
  console.error("Usage: node scripts/run-blueprint-checks.mjs <blueprint-path>");
  process.exit(1);
}

const blueprintPath = path.resolve(repoRoot, requestedPath);
if (!isPathInside(repoRoot, blueprintPath) || blueprintPath === repoRoot) {
  console.error("Blueprint path must be inside the repository.");
  process.exit(1);
}

const result = validateRepositoryMetadata(repoRoot);
if (result.errors.length > 0) {
  for (const error of result.errors) {
    console.error(error);
  }
  process.exit(1);
}

const blueprint = result.blueprints.find(
  (item) => path.resolve(repoRoot, item.relativePath) === blueprintPath,
);
if (!blueprint) {
  console.error(`No blueprint metadata found for ${requestedPath}.`);
  process.exit(1);
}

function run(command, label) {
  console.log(`\n[${blueprint.metadata.id}] ${label}: ${command}`);
  const completed = spawnSync(command, {
    cwd: blueprintPath,
    env: process.env,
    shell: true,
    stdio: "inherit",
  });
  if (completed.status !== 0) {
    process.exit(completed.status ?? 1);
  }
}

run(blueprint.metadata.ci.install, "install");
for (const check of blueprint.metadata.ci.checks) {
  run(check.run, check.name);
}

const browserAssetPaths = blueprint.metadata.ci.browser_asset_paths.map(
  (assetPath) => path.join(requestedPath, assetPath),
);
const findings = scanBrowserAssets(repoRoot, browserAssetPaths);
if (findings.length > 0) {
  console.error("\nBrowser asset secret scan failed. Values are redacted:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.type}`);
  }
  process.exit(1);
}

console.log(`\nValidated blueprint: ${blueprint.metadata.id}`);

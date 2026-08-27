import path from "node:path";

import {
  scanBrowserAssets,
  scanRepositoryForSecrets,
} from "./lib/secrets.mjs";

function parseArguments(argv) {
  const options = {
    repoRoot: process.cwd(),
    browserAssetPaths: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      options.repoRoot = path.resolve(argv[index + 1]);
      index += 1;
    } else if (argument === "--browser-path") {
      options.browserAssetPaths.push(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

const options = parseArguments(process.argv.slice(2));
const findings =
  options.browserAssetPaths.length > 0
    ? scanBrowserAssets(options.repoRoot, options.browserAssetPaths)
    : scanRepositoryForSecrets(options.repoRoot);

if (findings.length > 0) {
  console.error("Secret scan failed. Values are redacted:");
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}: ${finding.type}`);
  }
  process.exit(1);
}

if (options.browserAssetPaths.length > 0) {
  console.log(
    `Scanned ${options.browserAssetPaths.length} browser asset path(s) for credentials.`,
  );
} else {
  console.log("Scanned repository files for likely credentials.");
}

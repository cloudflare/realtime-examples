import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  isPathInside,
  lineNumberAt,
  readTextFile,
  walkFiles,
} from "./files.mjs";

const SENSITIVE_NAME =
  "(?:REALTIME_SFU_BEARER_TOKEN|REALTIME_SFU_APP_SECRET|CALLS_APP_(?:TOKEN|SECRET)|APP_(?:TOKEN|SECRET)|OPENAI_API_KEY|ELEVENLABS_API_KEY|CF_API_TOKEN|CLOUDFLARE_API_TOKEN|SEMGREP_APP_TOKEN)";

const HIGH_CONFIDENCE_PATTERNS = [
  {
    type: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    type: "OpenAI API key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    type: "GitHub token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  },
  {
    type: "GitHub fine-grained token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  },
  {
    type: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    type: "literal bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/g,
  },
];

const ASSIGNMENT_PATTERN = new RegExp(
  `\\b(${SENSITIVE_NAME})\\b\\s*(?::|=)\\s*["'\`]([^"'\\\`\\n]+)["'\`]`,
  "g",
);

const LINE_ASSIGNMENT_PATTERN = new RegExp(
  `^\\s*(${SENSITIVE_NAME})\\s*(?::|=)\\s*([^#\\n]+)`,
  "gm",
);

const BROWSER_SFU_MARKER = new RegExp(`\\b${SENSITIVE_NAME}\\b`, "g");

function isInGitWorkTree(rootPath) {
  let currentPath = path.resolve(rootPath);
  while (true) {
    if (fs.existsSync(path.join(currentPath, ".git"))) {
      return true;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return false;
    }
    currentPath = parentPath;
  }
}

function listRepositoryFiles(repoRoot) {
  const result = spawnSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  if (result.status === 0) {
    return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
  }

  if (isInGitWorkTree(repoRoot)) {
    const reason = result.error?.code ?? `exit status ${result.status}`;
    throw new Error(`Unable to enumerate repository files with git (${reason}).`);
  }

  return walkFiles(repoRoot);
}

function isPlaceholder(value) {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "string" ||
    normalized.includes("${") ||
    normalized.includes("$app_") ||
    normalized.includes("<") ||
    normalized.includes(">") ||
    normalized.includes("example") ||
    normalized.includes("placeholder") ||
    normalized.includes("replace") ||
    normalized.includes("tbd") ||
    normalized.includes("your-") ||
    normalized.includes("your_")
  );
}

export function scanTextForSecrets(content, options = {}) {
  const findings = [];

  for (const definition of HIGH_CONFIDENCE_PATTERNS) {
    for (const match of content.matchAll(definition.pattern)) {
      findings.push({
        type: definition.type,
        line: lineNumberAt(content, match.index),
      });
    }
  }

  for (const match of content.matchAll(ASSIGNMENT_PATTERN)) {
    if (!isPlaceholder(match[2])) {
      findings.push({
        type: `literal value assigned to ${match[1]}`,
        line: lineNumberAt(content, match.index),
      });
    }
  }

  for (const match of content.matchAll(LINE_ASSIGNMENT_PATTERN)) {
    const value = match[2].trim().replace(/^["'`]|["'`,;]$/g, "");
    if (!isPlaceholder(value)) {
      findings.push({
        type: `literal value assigned to ${match[1]}`,
        line: lineNumberAt(content, match.index),
      });
    }
  }

  if (options.browserAsset) {
    for (const match of content.matchAll(BROWSER_SFU_MARKER)) {
      findings.push({
        type: "SFU or provider secret name in browser asset",
        line: lineNumberAt(content, match.index),
      });
    }

    if (
      content.includes("rtc.live.cloudflare.com") &&
      /\b(?:Authorization|Bearer)\b/.test(content)
    ) {
      findings.push({
        type: "direct authenticated Realtime API use in browser asset",
        line: 1,
      });
    }
  }

  return findings;
}

function scanFiles(repoRoot, filePaths, options = {}) {
  const findings = [];
  for (const filePath of filePaths) {
    const absoluteFile = path.resolve(repoRoot, filePath);
    if (!isPathInside(repoRoot, absoluteFile)) {
      findings.push({
        file: filePath,
        line: 1,
        type: "scan path escapes repository",
      });
      continue;
    }
    if (
      !fs.existsSync(absoluteFile) ||
      !fs.lstatSync(absoluteFile).isFile()
    ) {
      continue;
    }

    const content = readTextFile(absoluteFile);
    if (content === null) {
      continue;
    }
    for (const finding of scanTextForSecrets(content, options)) {
      findings.push({
        file: path.relative(repoRoot, absoluteFile),
        ...finding,
      });
    }
  }

  return findings;
}

function scanPaths(repoRoot, paths, options = {}) {
  const findings = [];
  for (const targetPath of paths) {
    const absoluteTarget = path.resolve(repoRoot, targetPath);
    if (!isPathInside(repoRoot, absoluteTarget)) {
      findings.push({
        file: targetPath,
        line: 1,
        type: "scan path escapes repository",
      });
      continue;
    }
    if (!fs.existsSync(absoluteTarget)) {
      findings.push({
        file: targetPath,
        line: 1,
        type: "declared browser asset path does not exist",
      });
      continue;
    }

    findings.push(
      ...scanFiles(repoRoot, walkFiles(absoluteTarget), options),
    );
  }

  return findings;
}

export function scanRepositoryForSecrets(repoRoot) {
  return scanFiles(repoRoot, listRepositoryFiles(repoRoot), {
    browserAsset: false,
  });
}

export function scanBrowserAssets(repoRoot, browserAssetPaths) {
  return scanPaths(repoRoot, browserAssetPaths, { browserAsset: true });
}

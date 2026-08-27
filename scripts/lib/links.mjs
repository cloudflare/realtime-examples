import fs from "node:fs";
import path from "node:path";

import { isPathInside, readTextFile, walkFiles } from "./files.mjs";

const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#)/i;
const MARKDOWN_LINK = /!?\[[^\]]*]\(([^)\n]+)\)/g;

function normalizeTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }

  const titleIndex = target.search(/\s+["']/);
  if (titleIndex !== -1) {
    target = target.slice(0, titleIndex);
  }

  target = target.split("#", 1)[0].split("?", 1)[0];
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function existsWithExactCase(candidatePath) {
  const absolutePath = path.resolve(candidatePath);
  const parsed = path.parse(absolutePath);
  const parts = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;

  for (const part of parts) {
    if (!fs.existsSync(current)) {
      return false;
    }
    const names = fs.readdirSync(current);
    if (!names.includes(part)) {
      return false;
    }
    current = path.join(current, part);
  }

  return fs.existsSync(current);
}

export function validateLocalLinks(repoRoot) {
  const errors = [];
  const markdownFiles = walkFiles(repoRoot).filter((filePath) =>
    filePath.toLowerCase().endsWith(".md"),
  );

  for (const filePath of markdownFiles) {
    const content = readTextFile(filePath);
    if (content === null) {
      continue;
    }

    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = normalizeTarget(match[1]);
      if (!target || EXTERNAL_TARGET.test(target)) {
        continue;
      }

      const resolved = path.resolve(path.dirname(filePath), target);
      const relativeFile = path.relative(repoRoot, filePath);
      if (!isPathInside(repoRoot, resolved)) {
        errors.push(`${relativeFile}: local link escapes repository: ${target}`);
        continue;
      }
      if (!existsWithExactCase(resolved)) {
        errors.push(`${relativeFile}: broken local link: ${target}`);
      }
    }
  }

  return errors;
}

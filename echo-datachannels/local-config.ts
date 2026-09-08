import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const DEV_VARS_FILE_NAME = ".dev.vars";
const DEFAULT_DEV_VARS_URL = new URL(DEV_VARS_FILE_NAME, import.meta.url);

type Environment = Record<string, string | undefined>;
type ReadTextFile = (path: string | URL) => Promise<string>;

interface LoadLocalEnvironmentOptions {
  filePath?: string | URL;
  environment?: Environment;
  readTextFile?: ReadTextFile;
}

export interface RealtimeSfuCredentials {
  appId: string;
  token: string;
}

export class LocalConfigurationError extends Error {
  readonly code:
    | "malformed_dev_vars"
    | "unreadable_dev_vars"
    | "missing_sfu_credentials";

  constructor(
    code: LocalConfigurationError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalConfigurationError";
    this.code = code;
  }
}

export async function loadRealtimeSfuCredentials({
  filePath = DEFAULT_DEV_VARS_URL,
  environment = process.env,
  readTextFile = readUtf8File,
}: LoadLocalEnvironmentOptions = {}): Promise<RealtimeSfuCredentials> {
  await loadOptionalDevVars({
    filePath,
    environment,
    readTextFile,
  });

  const appId = environment.REALTIME_SFU_APP_ID;
  const token = environment.REALTIME_SFU_BEARER_TOKEN;
  if (!appId || !token) {
    throw new LocalConfigurationError(
      "missing_sfu_credentials",
      "Set both REALTIME_SFU_APP_ID and REALTIME_SFU_BEARER_TOKEN in .dev.vars or in the server environment before running npm start.",
    );
  }
  return { appId, token };
}

async function loadOptionalDevVars({
  filePath,
  environment,
  readTextFile,
}: Required<LoadLocalEnvironmentOptions>): Promise<void> {
  let source: string;
  try {
    source = await readTextFile(filePath);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }
    throw new LocalConfigurationError(
      "unreadable_dev_vars",
      "Could not read .dev.vars. Check that it is a readable regular file, then run npm start again.",
      { cause: error },
    );
  }

  const assignmentKeys = validateDevVars(source);
  let parsed: Record<string, string | undefined>;
  try {
    parsed = parseEnv(source);
  } catch (error) {
    throw new LocalConfigurationError(
      "malformed_dev_vars",
      "Could not parse .dev.vars. Use one KEY=value assignment per line.",
      { cause: error },
    );
  }

  for (const key of assignmentKeys) {
    const value = parsed[key.name];
    if (value === undefined) {
      throw malformedLine(
        key.lineNumber,
        `Node could not parse the ${key.name} assignment`,
      );
    }
    if (environment[key.name] === undefined) {
      environment[key.name] = value;
    }
  }
}

function validateDevVars(
  source: string,
): Array<{ name: string; lineNumber: number }> {
  if (source.includes("\0")) {
    throw new LocalConfigurationError(
      "malformed_dev_vars",
      ".dev.vars contains a null byte. Use plain UTF-8 KEY=value assignments.",
    );
  }

  const assignments: Array<{ name: string; lineNumber: number }> = [];
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      line,
    );
    if (!assignment) {
      throw malformedLine(lineNumber, "expected KEY=value");
    }
    const [, name, rawValue] = assignment;
    if (name === undefined || rawValue === undefined) {
      throw malformedLine(lineNumber, "expected KEY=value");
    }
    validateValue(rawValue, lineNumber);
    assignments.push({ name, lineNumber });
  }
  return assignments;
}

function validateValue(rawValue: string, lineNumber: number): void {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    return;
  }

  const closingQuote = value.lastIndexOf(quote);
  if (closingQuote === 0) {
    throw malformedLine(
      lineNumber,
      "quoted values must close on the same line",
    );
  }
  const trailing = value.slice(closingQuote + 1).trim();
  if (trailing.length > 0 && !trailing.startsWith("#")) {
    throw malformedLine(
      lineNumber,
      "unexpected text after the quoted value",
    );
  }
}

function malformedLine(
  lineNumber: number,
  detail: string,
): LocalConfigurationError {
  return new LocalConfigurationError(
    "malformed_dev_vars",
    `Malformed .dev.vars line ${lineNumber}: ${detail}. Use one KEY=value assignment per line.`,
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function readUtf8File(path: string | URL): Promise<string> {
  return readFile(path, "utf8");
}

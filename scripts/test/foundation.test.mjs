import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import Ajv from "ajv";

import { validateLocalLinks } from "../lib/links.mjs";
import { buildBlueprintMatrix } from "../lib/matrix.mjs";
import {
  loadYaml,
  validateRepositoryMetadata,
} from "../lib/metadata.mjs";
import { scanTextForSecrets } from "../lib/secrets.mjs";

const repoRoot = process.cwd();

test("repository catalog and metadata are valid", () => {
  const result = validateRepositoryMetadata(repoRoot);
  assert.deepEqual(result.errors, []);
});

test("repository Markdown links are valid", () => {
  assert.deepEqual(validateLocalLinks(repoRoot), []);
});

test("blueprint schema rejects missing required metadata", () => {
  const schema = JSON.parse(
    fs.readFileSync(`${repoRoot}/schemas/blueprint.schema.json`, "utf8"),
  );
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate({ version: 1 }), false);
  assert.equal(
    validate.errors.some(
      (error) =>
        error.keyword === "required" &&
        error.params.missingProperty === "ci",
    ),
    true,
  );
});

test("catalog requires blueprints to live under blueprints", () => {
  const schema = JSON.parse(
    fs.readFileSync(`${repoRoot}/schemas/catalog.schema.json`, "utf8"),
  );
  const catalog = loadYaml(`${repoRoot}/catalog.yaml`);
  catalog.examples[0].kind = "blueprint";
  const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

  assert.equal(validate(catalog), false);
  assert.equal(
    validate.errors.some(
      (error) =>
        error.instancePath.endsWith("/path") &&
        error.keyword === "pattern",
    ),
    true,
  );
});

test("CI includes active experimental blueprints", () => {
  const blueprint = {
    relativePath: "blueprints/example",
    metadata: {
      id: "example",
      status: "active",
      maturity: "experimental",
      ci: { node_version: "22" },
    },
  };
  const archived = {
    ...blueprint,
    relativePath: "blueprints/archived",
    metadata: {
      ...blueprint.metadata,
      id: "archived",
      status: "archived",
    },
  };

  assert.deepEqual(buildBlueprintMatrix([blueprint, archived]), [
    {
      id: "example",
      path: "blueprints/example",
      node_version: "22",
    },
  ]);
});

test("secret scanner allows documented placeholders", () => {
  const content = `
REALTIME_SFU_BEARER_TOKEN = "<your-realtime-sfu-token>"
CALLS_APP_SECRET = "$APP_SECRET"
`;
  assert.deepEqual(scanTextForSecrets(content), []);
});

test("secret scanner rejects literal provider keys", () => {
  const fakeKey = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
  const content = `OPENAI_API_KEY = "${fakeKey}"`;
  assert.notDeepEqual(scanTextForSecrets(content), []);
});

test("secret scanner rejects unquoted sensitive assignments", () => {
  const content = "REALTIME_SFU_BEARER_TOKEN: actual-secret-value-1234567890";
  assert.notDeepEqual(scanTextForSecrets(content), []);
});

test("browser scanner rejects SFU secret markers", () => {
  const content = "const token = env.REALTIME_SFU_BEARER_TOKEN;";
  assert.notDeepEqual(scanTextForSecrets(content, { browserAsset: true }), []);
});

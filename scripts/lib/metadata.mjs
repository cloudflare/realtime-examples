import fs from "node:fs";
import path from "node:path";

import Ajv from "ajv";
import YAML from "yaml";

const INFRASTRUCTURE_DIRECTORIES = new Set([
  "blueprints",
  "docs",
  "node_modules",
  "schemas",
  "scripts",
]);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

function formatAjvErrors(prefix, errors = []) {
  return errors.map((error) => {
    const location = error.instancePath || "/";
    return `${prefix}${location}: ${error.message}`;
  });
}

function listTopLevelItems(repoRoot) {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        return false;
      }
      if (INFRASTRUCTURE_DIRECTORIES.has(entry.name)) {
        return false;
      }
      return fs.existsSync(path.join(repoRoot, entry.name, "README.md"));
    })
    .map((entry) => entry.name)
    .sort();
}

function listBlueprintMetadata(repoRoot, entries) {
  const discovered = new Map();
  for (const entry of entries.filter((item) => item.kind === "blueprint")) {
    discovered.set(entry.path, {
      directory: path.basename(entry.path),
      relativePath: entry.path,
      metadataPath: path.join(repoRoot, entry.path, "blueprint.yaml"),
    });
  }

  const blueprintsRoot = path.join(repoRoot, "blueprints");
  if (fs.existsSync(blueprintsRoot)) {
    for (const entry of fs.readdirSync(blueprintsRoot, {
      withFileTypes: true,
    })) {
      const relativePath = path.posix.join("blueprints", entry.name);
      const metadataPath = path.join(blueprintsRoot, entry.name, "blueprint.yaml");
      if (entry.isDirectory() && fs.existsSync(metadataPath)) {
        discovered.set(relativePath, {
          directory: entry.name,
          relativePath,
          metadataPath,
        });
      }
    }
  }

  return [...discovered.values()].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}

function expectedStatusLabel(maturity) {
  return maturity[0].toUpperCase() + maturity.slice(1);
}

function validateReadmeTier(repoRoot, entry, errors) {
  const readmePath = path.join(repoRoot, entry.path, "README.md");
  if (!fs.existsSync(readmePath)) {
    errors.push(`${entry.path}: missing README.md`);
    return;
  }

  const readme = fs.readFileSync(readmePath, "utf8");
  const expected = expectedStatusLabel(entry.maturity);
  const tierPattern = new RegExp(
    `Example status:\\s*\\*\\*${expected}\\*\\*`,
    "i",
  );
  if (!tierPattern.test(readme)) {
    errors.push(
      `${entry.path}/README.md: missing visible "Example status: ${expected}" label`,
    );
  }
}

export function validateRepositoryMetadata(repoRoot) {
  const errors = [];
  const catalogPath = path.join(repoRoot, "catalog.yaml");
  const catalogSchemaPath = path.join(
    repoRoot,
    "schemas",
    "catalog.schema.json",
  );
  const blueprintSchemaPath = path.join(
    repoRoot,
    "schemas",
    "blueprint.schema.json",
  );

  for (const requiredPath of [
    catalogPath,
    catalogSchemaPath,
    blueprintSchemaPath,
  ]) {
    if (!fs.existsSync(requiredPath)) {
      errors.push(`missing required file: ${path.relative(repoRoot, requiredPath)}`);
    }
  }

  if (errors.length > 0) {
    return { errors, catalog: null, blueprints: [] };
  }

  let catalog;
  try {
    catalog = loadYaml(catalogPath);
  } catch (error) {
    return {
      errors: [`catalog.yaml: ${error.message}`],
      catalog: null,
      blueprints: [],
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: true });
  const validateCatalog = ajv.compile(loadJson(catalogSchemaPath));
  if (!validateCatalog(catalog)) {
    errors.push(...formatAjvErrors("catalog.yaml", validateCatalog.errors));
  }

  const entries = Array.isArray(catalog?.examples) ? catalog.examples : [];
  const ids = new Set();
  const paths = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) {
      errors.push(`catalog.yaml: duplicate example id "${entry.id}"`);
    }
    if (paths.has(entry.path)) {
      errors.push(`catalog.yaml: duplicate example path "${entry.path}"`);
    }
    ids.add(entry.id);
    paths.add(entry.path);

    const examplePath = path.join(repoRoot, entry.path);
    if (!fs.existsSync(examplePath)) {
      errors.push(`catalog.yaml: path does not exist: ${entry.path}`);
      continue;
    }
    if (
      entry.architecture &&
      !fs.existsSync(path.join(repoRoot, entry.architecture))
    ) {
      errors.push(
        `catalog.yaml: architecture path does not exist: ${entry.architecture}`,
      );
    }
    validateReadmeTier(repoRoot, entry, errors);
  }

  if (!entries.some((entry) => entry.recommended_starting_point === true)) {
    errors.push("catalog.yaml: at least one starting point must be recommended");
  }

  const discoveredExamples = listTopLevelItems(repoRoot);
  const catalogExamples = entries
    .filter((entry) => !entry.path.includes("/"))
    .map((entry) => entry.path)
    .sort();

  for (const examplePath of discoveredExamples) {
    if (!catalogExamples.includes(examplePath)) {
      errors.push(`catalog.yaml: uncataloged example directory: ${examplePath}`);
    }
  }
  for (const examplePath of catalogExamples) {
    if (!discoveredExamples.includes(examplePath)) {
      errors.push(
        `catalog.yaml: top-level entry does not match a repository directory: ${examplePath}`,
      );
    }
  }

  const validateBlueprint = ajv.compile(loadJson(blueprintSchemaPath));
  const blueprints = [];
  for (const blueprint of listBlueprintMetadata(repoRoot, entries)) {
    let metadata;
    try {
      metadata = loadYaml(blueprint.metadataPath);
    } catch (error) {
      errors.push(`${blueprint.relativePath}/blueprint.yaml: ${error.message}`);
      continue;
    }

    if (!validateBlueprint(metadata)) {
      errors.push(
        ...formatAjvErrors(
          `${blueprint.relativePath}/blueprint.yaml`,
          validateBlueprint.errors,
        ),
      );
    }
    if (metadata?.id !== blueprint.directory) {
      errors.push(
        `${blueprint.relativePath}/blueprint.yaml: id must match directory name`,
      );
    }

    const catalogEntry = entries.find(
      (entry) => entry.path === blueprint.relativePath,
    );
    if (!catalogEntry) {
      errors.push(
        `catalog.yaml: missing blueprint entry for ${blueprint.relativePath}`,
      );
    } else {
      if (catalogEntry.kind !== "blueprint") {
        errors.push(
          `catalog.yaml: ${blueprint.relativePath} must use kind "blueprint"`,
        );
      }
      if (catalogEntry.id !== metadata?.id) {
        errors.push(
          `catalog.yaml: blueprint id does not match ${blueprint.relativePath}/blueprint.yaml`,
        );
      }
      if (catalogEntry.maturity !== metadata?.maturity) {
        errors.push(
          `catalog.yaml: maturity does not match ${blueprint.relativePath}/blueprint.yaml`,
        );
      }
    }

    blueprints.push({
      ...blueprint,
      metadata,
    });
  }

  const discoveredBlueprintPaths = blueprints.map(
    (blueprint) => blueprint.relativePath,
  );
  for (const entry of entries.filter((item) => item.kind === "blueprint")) {
    if (!discoveredBlueprintPaths.includes(entry.path)) {
      errors.push(`catalog.yaml: blueprint metadata not found at ${entry.path}`);
    }
  }

  return { errors, catalog, blueprints };
}

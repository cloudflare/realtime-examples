export function buildBlueprintMatrix(blueprints) {
  return blueprints
    .filter((blueprint) => blueprint.metadata.status === "active")
    .map((blueprint) => ({
      id: blueprint.metadata.id,
      path: blueprint.relativePath,
      node_version: blueprint.metadata.ci.node_version,
    }));
}

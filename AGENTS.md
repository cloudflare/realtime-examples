# Realtime Examples Agent Instructions

These instructions apply to the entire repository.

## Developer experience

- Complete application blueprints live alongside examples as top-level
  directories. `catalog.yaml` and the local `blueprint.yaml` identify them.
- Preserve existing example paths unless a separately approved migration
  provides redirects.
- When an existing example becomes a blueprint, prefer growing it at its
  current path. If another implementation supersedes it, keep the old directory
  as a compatibility entry instead of maintaining two divergent references.
- Treat examples labeled `legacy` in `catalog.yaml` as educational or historical
  material, not recommended architecture.
- Write README content for developers first. `catalog.yaml` and `AGENTS.md`
  should expose the same facts to coding agents.
- Keep example status, known limitations, and declared checks accurate.

## Security invariants

- Realtime SFU, AI provider, and Cloudflare API secrets must remain on trusted
  server-side infrastructure.
- Do not place secrets in browser code, generated browser assets, public
  variables, URLs, logs, screenshots, or checked-in configuration.
- Room, session, track, and user-controlled identifiers are not authorization.
- Publishing, control, resource creation, and destructive operations require a
  documented authorization policy in complete application blueprints.

## Scope

- Use raw Realtime SFU primitives. Do not introduce a conferencing abstraction
  or large application SDK.
- PartyTracks and PartyKit are out of scope. Do not add them as dependencies or
  recommend them.
- Do not hide known limitations or imply that example status certifies an
  application for every production environment.
- Do not add unsupported performance, scaling, or availability claims.

## Required checks

Run the repository foundation checks after catalog, metadata, or documentation
changes:

```bash
npm ci
npm run check
```

Blueprint-specific commands are declared in each `blueprint.yaml` and executed
by repository CI.

# Realtime SFU Blueprints

Blueprints are deployable applications that show how to compose Realtime SFU
into a specific product topology.

We are currently building the first application blueprints. For runnable code
today, choose a starting point from the
[repository catalog](../README.md#best-places-to-start).

Each blueprint is designed for developers using the repository directly and for
coding agents adapting the implementation. Both audiences should be able to
answer the same questions from the checked-in files:

- What does the application do?
- What appears after deployment?
- How do media and data move?
- Which component owns signaling and state?
- Where do credentials live?
- What happens during reconnect and cleanup?
- Which commands prove the application still works?

## Use a blueprint

1. Open the blueprint README and review its prerequisites.
2. Deploy the application using the checked-in instructions.
3. Connect the documented endpoints to prove media or data flow.
4. Review `ARCHITECTURE.md` before changing the topology.
5. Run the declared checks after adapting the application.

The implementation, architecture, and tests are authoritative. Metadata exists
to help repository tools and coding agents find the same information.

## Blueprint contents

```text
blueprints/<id>/
  README.md
  ARCHITECTURE.md
  PRODUCTION.md
  TROUBLESHOOTING.md
  AGENTS.md
  blueprint.yaml
  package.json
  src/
  tests/
```

- `README.md` provides the shortest path to a working application.
- `ARCHITECTURE.md` explains topology, signaling, state, and lifecycle.
- `PRODUCTION.md` explains security and application integration boundaries.
- `TROUBLESHOOTING.md` maps visible failures to checks.
- `AGENTS.md` identifies invariants and verification commands for coding agents.
- `blueprint.yaml` exposes searchable metadata and CI commands.

## Security model

Realtime SFU and provider credentials stay on trusted server-side
infrastructure.

A blueprint does not prescribe one identity provider. It does identify where
an application authenticates a request and enforces the permissions required by
the topology. Public viewing can be anonymous when intentional. Publishing,
interactive control, resource creation, and destructive operations require a
documented policy.

Local or public-demo behavior must be distinct from production integration
guidance.

## Metadata

Each blueprint includes `blueprint.yaml`:

```yaml
version: 1
id: video-room
title: Custom video room
summary: Publish and subscribe to browser audio and video in a custom room.
maturity: experimental
status: active

topology:
  publishers: many
  subscribers: many
  media:
    - audio
    - video
  datachannels: false

components:
  - browser
  - Worker
  - Durable Object
  - Realtime SFU

entrypoints:
  source: https://github.com/cloudflare/realtime-examples/tree/main/blueprints/video-room
  demo: null
  docs: null

security:
  browser_has_sfu_secret: false
  authentication: PRODUCTION.md#authentication
  authorization: PRODUCTION.md#authorization

lifecycle:
  reconnect: ARCHITECTURE.md#reconnect
  cleanup: ARCHITECTURE.md#cleanup

ci:
  node_version: "22"
  install: npm ci
  checks:
    - name: Check
      run: npm run check
  browser_asset_paths:
    - public/assets

maintainer: null
```

The schema is in
[`../schemas/blueprint.schema.json`](../schemas/blueprint.schema.json).

Repository CI runs the declared checks for every active blueprint, including
experimental applications. Build, deployment, media flow, reconnect, cleanup,
and security results belong in revision-specific validation evidence rather
than metadata claims.

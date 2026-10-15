# Voice agent development

This project uses Python Workers/Pipecat and a React 19/Tailwind CSS 4 frontend. Browser audio uses WebRTC through the SFU; only SFU adapters connect to media WebSockets.

## Working locally

Source `~/.nvm/nvm.sh` and run `nvm use` when Node is managed by nvm. Follow [the development guide](docs/development.md) for preview, live calls, and checks. Use preview scenarios for UI work that does not need a real call.

To remove the orb, spoken fillers, typing sound, or a tool, follow [Optional features](docs/optional-features.md).

Run `npm run format` and `npm run check` for frontend or documentation changes. Python changes also need `npm run format:python`, `npm run lint:python`, and `npm run test:python` after `uv sync --locked`.

## Boundaries

- Preserve this example's [DESIGN.md](DESIGN.md), which is used by Impeccable. Use its Tailwind palette and shared controls; do not add custom theme colors or fonts.
- Keep components independent of media and HTTP code. Model state and conversation variants with tagged unions. Keep preview code excluded from deployment builds.
- Prefer plain ASCII punctuation in authored prose. Keep meaningful Unicode symbols, names, and test data readable, and preserve user and provider text.
- Keep browser authentication behind the server and frontend provider contracts. Preserve call ownership, same-origin mutations, cancellation, and the local proxy's loopback restrictions.
- Keep adapter authentication independent of browser login. An edge authentication exception must preserve the adapter's per-call token checks.
- Keep credentials out of browser bundles, fixtures, logs, and checked-in files. Do not log raw SDP, callback URLs, or full provider responses.

## Documentation

Keep the README focused on the project, its architecture diagram, and getting started. Put task-specific guidance in `docs/`. Explain constraints, gotchas, and workarounds that are not obvious from the code; link to source instead of restating it. Keep change histories, validation ledgers, and research evidence outside this repository.

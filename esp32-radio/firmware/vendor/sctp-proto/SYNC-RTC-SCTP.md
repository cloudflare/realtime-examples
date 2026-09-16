# Syncing sctp-proto with rtc-sctp

This document describes how to compare and synchronize changes between
`sctp-proto` (standalone SCTP implementation) and `rtc-sctp` (SCTP module
within the rtc monorepo).

## Repository Information

| Repo | URL | Commit at last sync |
|------|-----|---------------------|
| sctp-proto | https://github.com/webrtc-rs/sctp-proto | `0f3be08` (v0.6.0) |
| rtc (contains rtc-sctp) | https://github.com/webrtc-rs/rtc | `c0badad` |

## Setup for Comparison

To set up the repositories for comparison:

```bash
# Clone both repositories side by side
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/webrtc-rs/sctp-proto.git
git clone https://github.com/webrtc-rs/rtc.git

# Create symlink for easy comparison (optional)
cd sctp-proto
ln -s ../rtc/rtc-sctp rtc-sctp
```

## Finding New Changes Since Last Sync

The commits listed above are the state at the time of the last sync. To find
changes that have happened SINCE then:

```bash
# See what changed in rtc-sctp since the last sync
cd ~/dev/rtc
git log c0badad..HEAD -- rtc-sctp/

# See the actual diff of new changes
git diff c0badad..HEAD -- rtc-sctp/src/
```

Then compare those changes against the current sctp-proto to see what needs
to be brought over.

## Comparing the Codebases

The SCTP implementation lives in:
- `sctp-proto/src/` - standalone version
- `rtc/rtc-sctp/src/` - rtc monorepo version

To find all differences:

```bash
diff -rq sctp-proto/src rtc/rtc-sctp/src
```

To see detailed diff for a specific file:

```bash
diff -u sctp-proto/src/association/mod.rs rtc/rtc-sctp/src/association/mod.rs
```

## Key Architectural Differences

1. **Error handling**: sctp-proto has local `src/error.rs`; rtc-sctp uses `shared::error`
2. **Transport**: sctp-proto uses `Transmit` struct; rtc-sctp uses `TransportMessage<Payload>`
3. **Dependencies**: sctp-proto uses `FxHashMap`; rtc-sctp uses `HashMap`

## Sync Policy

When syncing, we bring over:
- Bug fixes (always)
- New features (case by case)
- Refactoring (only if beneficial)

We do NOT adopt:
- Architectural changes that would add external dependencies
- Changes to transport abstractions
- Changes that remove flexibility (e.g., hardcoded constants vs configurable)

## Last Sync: 2026-01-17

Changes brought from rtc-sctp to sctp-proto:
- Bug fix: Remove invalid `Eq` derive from `AssociationError`
- Bug fix: Change `poll_timeout` to take `&self`
- Bug fix: Propagate `handle_data()` return value
- Feature: `StreamEvent::BufferedAmountHigh` with threshold methods
- Feature: Stream ID in `StreamEvent::Opened`
- Feature: Stream ID in `Event::AssociationLost`
- Feature: `Event::HandshakeFailed` variant
- Feature: `Stream::close()` convenience method
- Feature: `Association::stream_ids()` method

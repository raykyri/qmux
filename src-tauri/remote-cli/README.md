# Bundled remote `qmux-cli`

Linux-musl binaries that qmux can push to a remote host live here after
`scripts/build-remote-cli.sh`. Shipping builds (`scripts/build.sh`) run that
script so the app bundle always contains:

- `aarch64-unknown-linux-musl/qmux-cli`
- `x86_64-unknown-linux-musl/qmux-cli`

`tauri dev` does not require these files. If the remote already has a matching
`~/.qmux/bin/qmux-cli`, Test connection skips the bundle. A Linux host that
needs an install will error with `run scripts/build-remote-cli.sh`.

`scripts/build.sh` zigbuilds when an artifact is missing or older than
`crates/qmux-cli`, `crates/qmux-proto`, or `Cargo.lock`. `scripts/release.sh`
sets `QMUX_REBUILD_REMOTE_CLI=1` to rebuild regardless. Requires Zig
(`brew install zig`) and `cargo install cargo-zigbuild`.

## Remote hook delivery

With `QMUX_REMOTE=1`, `notify` saves lifecycle events to a private, credential-
and pane-scoped outbox under `~/.qmux-hook-outbox` before returning. One detached
worker per outbox sends events in order through the reverse SSH socket, with a
two-second request timeout and retry backoff capped at 30 seconds. Successful
delivery requires an explicit acknowledgment carrying the event ID. Live
delivery also requires a short-lived lease measured on the desktop's monotonic
clock: requests buffered by SSH past that lease become replay observations.
Local hooks continue to use synchronous delivery.

Outboxes hold at most 512 events / 8 MiB; events expire after 24 hours. Storage
or capacity failures still return an error; connectivity failures do not block
the hook. Event files are private, atomically replaced, and synced to disk.
An attempted marker is saved before network IO so a worker or desktop restart
cannot turn an uncertain delivery into a new lifecycle action.

After an outage, the worker persists a reconciliation snapshot while draining
the backlog. The desktop uses only the final snapshot to recover session and
status observations. It does not replay queued sends, fork releases, or research
completion actions. Recovery itself never sends queued follow-ups. Codex Stop
hooks remain nonterminal, since Codex can emit them between jobs within a turn;
its transcript remains the completion authority. Remote transcript catch-up
retains its existing protection against historical lifecycle actions.

Workers remove expired events, and subsequent enqueue/health operations sweep
expired data in inactive outboxes. If no qmux CLI process runs, cleanup waits
until the next invocation. Queues belong to retained pane credentials; rotating
the token or socket creates a new scope rather than transferring old events to
a different authority.

The desktop checks hook health every 30 seconds while attached, restarts a
stopped delivery worker, and repairs a missing reverse socket without replacing
the terminal. A failed ping alone does not justify cancelling an existing
forward. Connection details include sanitized delivery errors and the last
successful delivery time. Managed CLI provisioning checks
`--hook-delivery-version`, so an older binary with the same package version is
updated as well.

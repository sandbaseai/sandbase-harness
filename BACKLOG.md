# Roadmap

This public roadmap tracks product work for `managed-agents`. It describes
project-owned features only.

## Near Term

- Improve API compatibility coverage and documented response shapes.
- Improve template validation and authoring commands.
- Add richer runtime metrics for model usage, tool duration, and session state.

## Runtime

- Add optional workspace snapshots for file-system recovery.
- Add optional long-term memory provider support.
- Expand context-window metadata and compaction controls.
- Improve graceful shutdown reporting for in-flight turns.
- Re-evaluate the state database's write durability only together with its
  contract. Connections hold `journal_mode=WAL`, `foreign_keys=ON`,
  `busy_timeout=5000`, `synchronous=FULL` and `trusted_schema=OFF`, and
  `src/core/db/pragmas.ts` refuses a connection that cannot show those values.
  `synchronous=FULL` is deliberate: local write volume is low and writes are
  serialized by an immediate transaction, so one fsync per commit is affordable
  and it covers the host crash that `NORMAL` does not. Changing a value means
  changing that rationale, the expected value in the pragma spec and the
  recovery guarantee together; dropping `busy_timeout` or the immediate
  transaction would reintroduce the deferred-transaction conflict the CLI and
  the server hit when they share one `data.db`. `fullfsync` and
  `checkpoint_fullfsync` are the one part of the recipe this runtime does not
  claim, because Node's bundled SQLite defines no
  `SQLITE_ENABLE_FULLFSYNC` and the pragma verifies as a plain flag either way;
  add them, to the spec and the verification together, when a Node release
  enables F_FULLFSYNC and a macOS host can confirm it.

## Sandboxes

- Harden local sandbox defaults. The local backend now wraps commands in
  `sandbox-exec` (macOS) or `bubblewrap` (Linux) when the tool is present —
  writes confined to the workdir — but that is a best-effort boundary, not a
  VM. Remaining hardening: network namespacing (today the egress proxy is
  env-level), resource limits, and a confinement story for Windows hosts.
- Expand Docker examples and resource-limit coverage.
- Run the Kubernetes live-cluster suites in CI. They exist and pass against a
  real cluster, but they skip when no cluster is reachable, so nothing currently
  enforces them. See CONTRIBUTING.md for how to run them locally.
- Handle Pod eviction and node pressure mid-session. Provision now fails fast on
  terminal image and config errors, but a Pod evicted after a session is running
  surfaces only as command failures.
- Add network egress controls per Environment for the container backends.
- Add incremental command output (`streamingExec`) once a consumer exists for
  it: today tool results reach the model as a single value, so the capability is
  declared and reported as unsupported rather than implemented.
- Improve self-hosted worker ergonomics.
- Add provider packages for additional isolated execution backends.

## Dashboard

- Repair the stale fixtures in the Console-touching test files listed under
  `exclude` in `tsconfig.tests.json` (agents without `multiagent`, sessions
  without `budget`, and similar drifted literals) so they rejoin the
  type-checked program.
- Add clearer error and reconnect states.
- Add model, skill, and MCP status panels.
- Add read-only configuration inspection.

## CLI and SDK

- Add session lifecycle subcommands.
- Add model and environment inspection commands.
- Add richer SDK examples.
- Add typed helpers for event filtering and replay cursors.

## Documentation

- Keep public documentation in English.
- Keep public documentation focused on this project.
- Keep public documentation focused on release-facing project behavior.
- Add deployment guides after the runtime behavior is stable.
- Add a versioned compatibility matrix before the first stable release.

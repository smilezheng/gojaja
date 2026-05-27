# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking v2.0.0; see [docs/ROADMAP](./docs/ROADMAP.md) for PR sequencing.

### Planned next

- PR2: `claim`, `plan`, `ack`, `report`, `worklog`, `release`.

## [2.0.0-alpha.0] — 2026-05-27

### Added (PR1 — storage core)

- TypeScript-based `agentctl` CLI replacing the v0.1 bash prototype.
- `Store` interface (`src/core/store.ts`) shaped to allow a future HTTP
  transport without command-layer changes.
- `LocalFsStore` (`src/core/local-fs-store.ts`):
  - Atomic write-and-rename for all single-file mutations.
  - Immutable per-record event files in `comms/events/<ulid>.json`.
  - File-based per-resource lock with lease (default 30 s), PID
    liveness, and stale-break with `LOCK_BROKEN` audit event.
  - Cursor read/update under per-role lock; monotonic advancement
    enforced.
  - Session claim/release/heartbeat with `SESSION_CLAIMED`,
    `SESSION_RELEASED`, `SESSION_TAKEOVER` events.
- ULID id generation (monotonic process-local factory).
- Strict path validation: `resolveInside` rejects absolute paths and
  `..` escapes; role-id and lock-key whitelists.
- CLI commands: `agentctl --version`, `agentctl help`, `agentctl init`,
  `agentctl version`. All commands support `--json`.
- Stable error class → exit code map (see [DESIGN](./docs/DESIGN.md#errors-and-exit-codes)).
- Documentation set: `docs/DESIGN.md`, `docs/SCHEMA.md`,
  `docs/PROTOCOL.md`, `docs/ROADMAP.md`, this changelog.
- Vitest test harness with 19 cases covering concurrent appends, cursor
  monotonicity, stale-lock takeover, session lifecycle, and path/role-id
  validation.

### Removed

- The entire v0.1 bash prototype: `templates/multi-agent/` (scripts,
  protocol markdown, role files, RFC templates), `skills/`, the
  `.multi-agent → templates/multi-agent` symlink, and the
  `bin/multi-agent.js` installer.
- The AGENTS.md "multi-agent-bridge" block (replaced by repo-level dev
  notes; the new bridge is reintroduced as part of PR6's installer).

### Notes

- This release is an alpha. The wire protocol between CLI and agent is
  still in flux; do not depend on it from production tooling.
- v0.1 is not supported. No migration path is provided. Anyone who used
  v0.1 should start fresh with `agentctl init`.

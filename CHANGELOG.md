# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking v2.0.0; see [docs/ROADMAP](./docs/ROADMAP.md) for PR sequencing.

### Planned next

- PR8: installer / upgrade / reset, AGENTS.md bridge versioned block.

## [2.0.0-alpha.6] — 2026-05-27

### Added (PR7 — ownership enforcement)

- `config.yaml:roles[<role>].owns` and `mustNotEdit` are now **runtime
  gates** for state-mutating commands, not just documentation.
- New `ForbiddenError` class (exit code 9), distinct from `UsageError`
  (exit 2), so callers can branch on "you are not allowed" vs "you said
  it wrong".
- New `Store.writeStateFile({ actor, relPath, content })`:
  - `relPath` must live under `state/`.
  - Atomic write (write tmp + rename); reader never sees partial.
  - Gated by `owns` (exact path OR directory-prefix match for entries
    ending in `/`).
  - Refused if the path also appears in `mustNotEdit` (defence in
    depth, even if `owns` also contains it).
  - `actor === "SYSTEM"` bypasses the gate so the human running the
    CLI manually can bootstrap or repair state.
- Task mutations are now gated:
  - `createTask` and `assignTask` require ownership of
    `state/task_board.yaml`.
  - `setTaskStatus` has a **task-owner exception**: a role may always
    update its OWN task's status, even without blanket task-board
    ownership. This lets engineering roles (Backend, QA, ...) report
    progress without being granted PM-level scope.
- New CLI `agentctl write-state --file <state/path> [--content <text>]`:
  - Content comes from `--content` if given, otherwise from stdin.
  - Identity from `MA_SESSION` (or `"SYSTEM"` if unset).
- 14 new vitest cases (`tests/ownership.test.ts`): writeStateFile
  allow/deny per role, mustNotEdit override, SYSTEM bypass, refusal
  outside `state/`, path-traversal refusal, directory-prefix matching,
  unknown actor refusal, task createTask/assignTask gating, task-owner
  exception, refusal for unrelated roles on status changes.
- 81 -> 115 tests total.

### Hardened

- `withFileLock`'s `detectStale` and `releaseIfOwned` now tolerate
  partial reads of the lock file (the lock is written non-atomically
  via `O_EXCL + write + close`, so a concurrent reader can briefly
  observe an empty/half-written file). Parse failures are treated as
  "record not yet observable" — never a reason to break a lock. Removes
  a latent flake under high test concurrency.

## [2.0.0-alpha.5] — 2026-05-27

### Added (PR6 — RFC state machine)

- Per-RFC directory `.multi-agent/rfcs/RFC-NNNN-<slug>/` with
  `proposal.yaml`, `comments/<role>.json`, and `decision.json` (created
  on decide / reject).
- New `agentctl rfc` command group:
  - `rfc new <slug> --title <text> --deciders <r1,...>
      --options <A:summary,B:summary> [--voters <r1,...>] [--deadline <iso>]`
  - `rfc comment <rfc-id> --rationale <text> [--option <opt>]`
  - `rfc decide <rfc-id> --option <opt> --rationale <text>`
  - `rfc reject <rfc-id> --rationale <text>`
  - `rfc list [--status open|accepted|rejected|superseded]`
  - `rfc show <rfc-id>`
- New `Store` methods: `createRfc`, `commentRfc`, `decideRfc`,
  `rejectRfc`, `readRfc`, `listRfcs`.
- New types: `RfcStatus`, `RfcOption`, `RfcProposal`, `RfcComment`,
  `RfcDecision`, `RfcSummary`, plus payload types.
- New event payloads emitted: `RFC_CREATED`, `RFC_COMMENT`,
  `RFC_DECIDED`.
- `ProjectConfig.rfcCounter` persists the auto-id allocator (so
  deleting an RFC dir does not recycle its id).
- Manifest carries a new `rfcs` array (`RfcSummary[]`): open RFCs
  needing this role's action (voter that hasn't commented, or
  decider until close). Fields are minimal (`id`, `title`, `status`,
  `role: "voter" | "decider"`, `commented: boolean`); full proposal +
  comments + decision come from `agentctl rfc show <id>`.
- 20 new vitest cases (`tests/rfc.test.ts`); 81 -> 101 total.

### Design choices for the RFC layer

- **No automatic tally.** The deciders pick. `decide` does not read
  comments and there is no "all voters must comment before decide" gate
  — real teams have a tech lead who can call it whenever they think
  enough input has been gathered.
- **Status machine is small.** `open -> accepted | rejected`. Both
  terminal in v2; `superseded` is reserved for v2.x.
- **Non-voters may comment.** Voter list is advisory, not gated; real
  teams often get useful cross-cutting input from outside the named set.
- **Slug uniqueness enforced** across RFCs (refuses reuse), so any
  later command that takes `<rfc-id-or-slug>` would be unambiguous.

## [2.0.0-alpha.4] — 2026-05-27

### Added (PR5 — task board)

- New on-disk artifact: `.multi-agent/state/task_board.yaml`. Schema:
  `schemaVersion`, `nextId` (auto-allocator counter), and a `tasks`
  map keyed by `T-NNNN` id with `title`, `status`, `owner`, `priority`,
  `dependsOn`, `acceptance`, `createdAt`, `updatedAt`. Statuses:
  `Backlog | Ready | InProgress | Blocked | Review | Done`.
- New CLI surface `agentctl task`:
  - `task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
    [--depends-on T-NNNN,...] [--acceptance <text>]`.
  - `task assign <task-id> --to <role>`.
  - `task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>`.
  - `task list [--owner <role>] [--status <s>]`.
  - `task show <task-id>`.
- New event types `TASK_CREATED`, `TASK_ASSIGNED`,
  `TASK_STATUS_CHANGED`, all emitted automatically by the
  corresponding command. `from` is the role bound to `MA_SESSION` when
  available, otherwise `"SYSTEM"`.
- Manifest carries a new `tasks` array (`TaskSummary[]`): tasks where
  `owner == role` AND `status ∈ {Ready, InProgress, Blocked, Review}`.
  Each summary keeps just `id`, `title`, `status`, `priority`, and
  `blockedBy` (the subset of `dependsOn` that is not yet `Done`).
  Full task records are fetched on demand via `agentctl task show <id>`.
- New `Store` methods: `readTaskBoard`, `createTask`, `assignTask`,
  `setTaskStatus`, `readTask`. All mutations go through a `task-board`
  lock; auto-id allocation is monotonic even across crashes.
- 14 new vitest cases covering id allocation, event emission, role-id
  validation, status validation, idempotent no-op assigns, and
  manifest filtering / `blockedBy` derivation.

### Notes

- Task status transitions are unrestricted in v2 by design — any role
  may set any status. A constrained state machine (PR7+) can layer on
  top of this once ownership enforcement lands.
- `agentctl init` now seeds an empty `state/task_board.yaml` alongside
  `VERSION` and `config.yaml`.

## [2.0.0-alpha.3] — 2026-05-27

### Added (PR4 — manifest self-anchoring)

- `Manifest.roleReminder`: a compact identity block embedded in every
  `agentctl plan` output. Carries `id`, `title`, optional `owns`,
  `mustNotEdit`, `reportsTo`, plus a 95-char `protocol` one-liner.
  Empty fields are intentionally omitted to keep agent prompts tight
  (a fully populated reminder serialises to under 300 bytes).
- `PROTOCOL_ONE_LINER` constant in `src/core/types.ts` — the single
  source of truth for the protocol string the reminder embeds.
- Test coverage: reminder presence, content from `config.yaml`,
  empty-field omission, and serialised-size budget.

### Rationale

A context-compressed agent that has lost its role contract can now
recover its identity by running `agentctl plan` once. The reminder
trades ~250 bytes per manifest for an order-of-magnitude reduction
in "agent forgot which role it is" failure modes.

## [2.0.0-alpha.2] — 2026-05-27

### Added (PR3 — role / prompt / wait)

- `agentctl role create <id> [<title>] [--description] [--owns]
  [--reports-to] [--must-not-edit]` provisions a role end-to-end: it
  registers `<id>` in `.multi-agent/config.yaml` AND writes the human
  contract under `.multi-agent/roles/<id>.md`. Refuses duplicates.
- `agentctl role list` and `agentctl role show <id>`.
- `agentctl prompt <role> --target codex|claude|cursor|generic`
  prints an activation prompt. With `--write`, it also installs the
  host-specific persistent artifact:
  - `codex`: `${CODEX_HOME:-~/.codex}/skills/multi-agent-runtime/`
    SKILL.md + agents/openai.yaml.
  - `claude`: a marker-block `<!-- multi-agent-runtime:BEGIN..END -->`
    inside `<project>/CLAUDE.md`, preserving surrounding content.
  - `cursor`: `<project>/.cursor/rules/multi-agent-runtime.mdc` with
    `alwaysApply: true`.
  - `generic`: prints only.
  The persistent artifacts are role-agnostic (they teach the agent how
  to find its identity via `MA_SESSION`); a per-window activation
  snippet binds the role.
- `agentctl wait [--idle <min>] [--mode block|exit]` provides the
  cheap-keepalive primitive. `block` does a shell-level sleep, then
  one cursor-free check, exits 0 with `ATTENTION` or `IDLE`. `exit`
  writes a `.wait` sentinel and returns immediately. Never overloads
  exit codes; never mutates the cursor (closes v0.1 wait bugs).
- New Store methods: `createRole`, `readRoleFile`, `readConfig`,
  `writeConfig`, `writeWaitSentinel`.
- New on-disk artifact: `.multi-agent/config.yaml` (created by
  `agentctl init`). See [docs/SCHEMA.md → config.yaml](./docs/SCHEMA.md#configyaml).
- New on-disk artifact: `.multi-agent/comms/pending/<role>/.wait`
  sentinel (written by `agentctl wait --mode exit`).
- New dependency: `js-yaml` (plus `@types/js-yaml`) for config.yaml
  round-tripping.
- New `src/cli/prompts/` module: `core.ts` (shared body) + per-target
  wrappers (`codex.ts`, `claude.ts`, `cursor.ts`, `generic.ts`) + a
  small write engine that handles atomic replace and marker-block
  upsert with refuse-to-clobber-unrelated-files protection.
- 25 additional vitest cases (`tests/role.test.ts`,
  `tests/prompt.test.ts`, `tests/wait.test.ts`); 64/64 total.

### Changed

- `agentctl init` now also seeds `.multi-agent/config.yaml` with the
  current schemaVersion and an empty `roles` map.
- `agentctl help` reorganised around the three real audiences: things
  the user runs once (init / role / prompt), things the user runs once
  per window (claim / release), and things the agent runs on every turn
  (plan / ack / report / worklog / wait).
- ROADMAP re-sequenced. PR4 is now "manifest self-anchoring", PR5 is
  task board, PR6 is RFC, PR7 is ownership enforcement, PR8 is
  installer, PR9 is doctor/history/archival, PR10 is chaos/soak.

## [2.0.0-alpha.1] — 2026-05-27

### Added (PR2 — claim / plan / ack / report / worklog)

- `agentctl claim <role> [--ttl <s>] [--force]` leases a role for the
  current shell and prints the session id.
- `agentctl release [<role>]` ends the current session.
- `agentctl plan [<role>]` produces a JSON `Manifest` of unread events
  scoped to the role, persists it under
  `comms/pending/<role>/<ack-token>.json`, and stamps
  `cursor.pendingManifest`. Idempotent: calling twice in a row returns
  the same manifest with the same `ackToken`.
- `agentctl ack [<role>] --token <t>` advances the cursor exactly to
  the manifest's `advanceCursorTo`. Token mismatch is rejected;
  events that arrived between `plan` and `ack` are preserved unread.
- `agentctl report --to <role> --message <text> [--ref <id>]`
  publishes a REPORT event. `from` is derived from `MA_SESSION`; the
  agent cannot impersonate another role.
- `agentctl worklog --message <text>` broadcasts a WORKLOG event and
  also writes `worklog/<role>/<id>.md` for git-readable history.
- `MA_SESSION` environment variable carries identity between commands;
  `src/cli/identity.ts:resolveIdentity` enforces it.
- New `Store` methods: `findSessionById`, `publishReport`,
  `publishWorklog`, `openOrCreatePlan`, `ackManifest`.
- New types: `Manifest`, `ReportPayload`, `WorklogPayload`.
- 20 additional vitest cases (`tests/plan-ack.test.ts`,
  `tests/identity.test.ts`) — 39/39 total. Key regression tests:
  - `does NOT skip events that arrived after plan` — covers the
    v0.1 ack-race bug.
  - `is idempotent across retry` — covers crash-and-restart.
  - `never loses an event across a fast publish/plan/ack loop` —
    30-event property test.
  - `filters events by recipient, excludes self-sent` — sender does
    not re-process its own broadcasts.

### Changed

- Inbox is now a derived view (filter on the event stream by
  `to ∈ {role, "*"} && from !== role`). The `comms/inbox/<role>/`
  directory and the `Paths.inboxDir` constant are gone. See
  [docs/SCHEMA.md → Inbox is a derived view](./docs/SCHEMA.md#inbox-is-a-derived-view-not-files)
  for the rationale.

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

# Roadmap

Cross-references: [DESIGN](./DESIGN.md), [PROTOCOL](./PROTOCOL.md),
[SCHEMA](./SCHEMA.md), [CHANGELOG](../CHANGELOG.md).

This roadmap is a rolling artifact. Items move from "planned" to "in
progress" to "done" via PRs that land on `v2`.

## v2.0.0 — minimum viable rewrite

The goal of v2.0.0 is a coordinated-but-not-yet-feature-complete layer
that an agent team can use end-to-end without hitting the v0.1 sharp
edges (cursor races, TSV corruption, global lock, slug traversal).

### Done

- **PR1 — storage core.**
  - `Store` interface; `LocalFsStore` implementation.
  - ULID-named immutable event files; directory-as-queue.
  - Atomic write-and-rename helpers.
  - Per-resource file lock with lease + PID liveness + stale break.
  - `LOCK_BROKEN` audit event on recovery.
  - Cursor read/update with monotonic invariant enforced.
  - Session claim/release/heartbeat with `SESSION_TAKEOVER` events.
  - Strict path / role-id / lock-key validation.
  - CLI skeleton: `agentctl --version | help | init | version`.

- **PR2 — claim / plan / ack / report / worklog.**
  - `agentctl claim <role>` / `agentctl release`.
  - `MA_SESSION` environment-variable identity, resolved via
    `Store.findSessionById`.
  - `agentctl plan [<role>]` with manifest emission,
    `pendingManifest` stamp, idempotent across retry.
  - `agentctl ack [<role>] --token <t>` with bounded cursor advance —
    fixes the v0.1 "ack races concurrent write" loss.
  - `agentctl report --to <role> --message <text> [--ref <id>]`.
  - `agentctl worklog --message <text>` plus a markdown copy under
    `worklog/<role>/<id>.md`.
  - Design simplification: inbox is now a derived filter on the event
    stream, not a separate file tree. See
    [SCHEMA: Inbox is a derived view](./SCHEMA.md#inbox-is-a-derived-view-not-files).
  - 39 vitest cases across storage, plan/ack, and identity resolution.

- **PR3 — role / prompt / wait.**
  - `agentctl role create / list / show` plus a backing `config.yaml`
    that registers each role's title, owns, reportsTo, and mustNotEdit.
  - `agentctl prompt <role> --target codex|claude|cursor|generic`
    [`--write`], producing host-specific persistent artifacts: Codex
    skill, Claude `CLAUDE.md` marker block, Cursor
    `.cursor/rules/multi-agent-runtime.mdc`. Role-agnostic install +
    per-window activation snippet.
  - `agentctl wait` (block + exit modes) with no exit-code overloading
    and no cursor mutation.
  - `js-yaml` dependency added for `config.yaml` round-tripping.
  - 25 new vitest cases (`tests/role.test.ts`, `tests/prompt.test.ts`,
    `tests/wait.test.ts`); 64/64 total.

- **PR4 — manifest self-anchoring.**
  - `agentctl plan` output now embeds a compact `roleReminder`
    (`id`, `title`, optional `owns`/`mustNotEdit`/`reportsTo`, plus a
    95-char protocol one-liner). Empty fields are omitted.
  - Goal: a context-compressed agent recovers full identity by
    running `agentctl plan` once.

- **PR5 — task board.**
  - `state/task_board.yaml` schema with id, status, owner, priority,
    dependsOn, acceptance, createdAt, updatedAt.
  - `agentctl task new / assign / status / list / show`.
  - `plan` manifest now carries a `tasks` array filtered to
    `owner == role && status ∈ {Ready, InProgress, Blocked, Review}`,
    with `blockedBy` derived from dependsOn entries that are not Done.
  - New event types: `TASK_CREATED`, `TASK_ASSIGNED`,
    `TASK_STATUS_CHANGED`.

- **PR6 — RFC state machine.**
  - Per-RFC directory `rfcs/RFC-NNNN-<slug>/` with `proposal.yaml`,
    `comments/<role>.json`, and `decision.json`.
  - `agentctl rfc new / comment / decide / reject / list / show`.
  - Status machine `open -> accepted | rejected`, enforced; no
    automatic tally — a role in the proposal's `deciders` list calls
    `decide` or `reject`.
  - `plan` manifest carries an `rfcs` array of open RFCs needing this
    role's action (voter that has not commented, or decider until the
    RFC closes).
  - Event types: `RFC_CREATED`, `RFC_COMMENT`, `RFC_DECIDED`.

- **PR7 — ownership enforcement.**
  - `config.yaml:roles[<role>].owns` and `mustNotEdit` become runtime
    gates for state writes and task mutations.
  - `agentctl write-state --file <state/path>` writes atomically into
    the state subtree, gated by ownership; `SYSTEM` (no MA_SESSION)
    bypasses for human bootstrap.
  - `agentctl task new` / `task assign` require ownership of
    `state/task_board.yaml`. `task status` has a task-owner exception
    (a role may always update its own task's status).
  - New `ForbiddenError` class with stable exit code 9.

- **PR7a — prompt / activate split.**
  - `agentctl prompt` is now strictly role-free (`--target X [--write]`);
    a new `agentctl activate <role> --target X` prints the per-window
    chat-paste snippet without ever touching disk.
  - Enforces the architectural invariant "role binding lives at the
    window/shell layer, never at the project layer" — two Cursor chats
    in the same project can hold different roles independently.
  - Regression test scans the runtime body and every written file for
    role-id leaks; any future contributor who embeds a role in the
    template gets caught at CI.

- **PR8a — collaboration handbook.**
  - New `src/cli/prompts/handbook.ts` exporting a ~7 KB UTF-8
    `COLLABORATION_HANDBOOK` string. Role-neutral; concrete triggers;
    mostly "don'ts".
  - Default-injected into every `agentctl prompt --target X --write`
    artifact (Cursor rules, Codex skill, Claude CLAUDE.md block, generic
    stdout). `--no-handbook` opts out.
  - Covers: turn shape, worklog rules, report vs RFC, disagreement,
    push-upstream / escalation, user-vs-agent escalation whitelist,
    task lifecycle micro-rules, idle/stale-manifest handling, build/test
    breakage, hard "don't"s. See [HANDBOOK.md](./HANDBOOK.md).

- **PR8b — critical correctness pass.**
  - Ten independent fixes from two consolidated reviews. argv boolean
    flag whitelist, ULID cross-process watermark, stale-lock
    conditional restore, RFC self-heal on inconsistent on-disk shape,
    `MA_SESSION` strict semantics, session lease + auto-heartbeat,
    atomic `createRole`, `wait` refusal with pending manifest,
    `claim` / `publishReport` recipient-role validation, TTY-aware
    `plan` default + tasks/RFCs in text output.

- **PR8c — review correctness + UX.**
  - Fourteen independent fixes from a third reviewer pass plus a
    business-process simulation: path-canonicalisation enforcement,
    `link(2)`-based stale-lock restore, RFC self-heal under lock,
    `Store.updateConfig` for atomic config-yaml RMW, Cursor target
    `wait --mode exit`, `task new` default Ready on owner, `claim`
    error de-advertises `--force`, Codex SKILL.md project-agnostic,
    RFC deciders gate → `FORBIDDEN`, fail-closed corrupt heartbeat,
    `task new` / `task assign` owner registration check, `release`
    `unset MA_SESSION` hint, `claim --eval` mode, handbook review
    handoff + role-neutrality regex guard. Suite 150 → 169.

- **PR8d — prompt UX gate + role delete.**
  - Runtime body opens with an "only when bound to a role" gate so an
    unactivated agent window does not reflexively run agentctl.
  - `prompt --write` prints a "restart any open agent windows" caveat
    on every successful write; JSON adds `requiresWindowRestart`.
  - "SKIPPED" renamed to "UNCHANGED (already up to date)"; new
    `--force-rewrite` flag overrides the byte-equal short-circuit.
  - New `agentctl role delete <id>` (SYSTEM-only): removes config /
    md / live session and emits `ROLE_DELETED`. Open task assignments
    are left in place by design so re-creating the same id reinherits
    them.
  - Suite 169 → 185.

### Planned, in priority order

- **PR8e — README rewrite.**
  - Restructure README.md / README.zh-CN.md around the user / agent
    boundary; explicitly document that `state/project_state.md` is
    not auto-created; add upgrade and troubleshooting sections.

- **PR8f — schema-level deferments from PR8c.**
  - Task `reviewers` field so a Review handoff can sign off without
    needing task-board ownership.
  - `STATE_UPDATED` event when `state/*` files change.
  - `dependsOn` cycle detection in task board.
  - Schema-version compatibility check on `agentctl plan`.

- **PR8 — installer & upgrade.**
  - `agentctl upgrade` driving `src/migrations/<from>-<to>.ts`.
  - `agentctl reset --confirm <project-name>` for destructive nukes.
  - AGENTS.md bridge insertion with versioned marker block, re-written
    on every upgrade.

- **PR9 — operational tooling.**
  - `agentctl doctor`: JSON parse all records, validate cursor reachability,
    detect orphan manifests, surface stale locks.
  - `agentctl history --role <role> [--since <ulid>]`.
  - Event archival (`comms/events/_archive/YYYY-MM-DD/`) with a configurable
    retention floor.

- **PR10 — chaos / soak.**
  - Multi-process integration tests under `vitest`'s pool=forks running
    real concurrent claim/plan/ack cycles.
  - Random-kill harness asserting `agentctl doctor` stays green.

After PR10 we tag `v2.0.0`.

## v2.x — deferred but slot-reserved

- **HTTP transport.** `HttpStore` implementing the same `Store`
  interface; an `agentctl serve` mode that wraps a `LocalFsStore` behind
  a REST API. Authentication, TLS, and account model are out of scope
  for this layer — to be designed by the consuming team.
- **Heartbeat watcher.** `agentctl watch` daemon that downgrades stale
  sessions and emits `attention_required` events when an offline role
  has waiting inbox items.
- **Multi-machine safety review.** Verify rename / lock semantics under
  the storage backends people actually use (local disk, NFSv4, Dropbox,
  iCloud). Mark unsupported configurations explicitly.
- **Windows support.** Test rename-onto-open and PID liveness on
  Windows; gate on green CI before claiming support.
- **Schema migrations engine.** Today's migrations directory is empty;
  add the runner, backup-before-migrate, and dry-run mode.

## Explicit non-goals (for now)

- A built-in LLM call layer.
- A built-in agent-prompt template engine.
- A web UI.
- Replacement for `git` as audit storage; the framework only adds an
  in-tree `audit.log`, not a content-addressable store.

## Sequencing notes

PR1–PR7 + PR8a establish the protocol surface (events, sessions,
plan/ack, tasks, RFCs, ownership, handbook). PR7a / PR8b / PR8c / PR8d
are correctness + UX hardening that introduce no new protocol surface.
PR8e is documentation. PR8f–PR10 harden the layer for everyday use;
PR8f is the only remaining schema-affecting PR before `v2.0.0`.
Anything past `v2.0.0` only ships after the chaos suite (PR10) is
green.

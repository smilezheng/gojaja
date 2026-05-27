# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking v2.0.0; see [docs/ROADMAP](./docs/ROADMAP.md) for PR sequencing.

### Planned next

- PR8f: schema-level features deferred from PR8c (task `reviewers`
  field, `STATE_UPDATED` event, `dependsOn` cycle detection,
  schema-version compatibility check).

## [2.0.0-alpha.12] — 2026-05-27

### First-run UX (PR8e)

Surfaces a number of silent-failure modes first-time users hit, plus a
README rewrite around the user-vs-agent boundary. Suite 185 -> 198.

- **`role create` nags about TBD sections.** Freshly rendered
  `roles/<id>.md` carries TBD in the Role description and
  Responsibilities sections — the agent's main self-introduction.
  Without filling them, the agent runs with only its id and title,
  and asks the user trivial role-clarifying questions every turn.
  Create output now prints a TODO block pointing at the file; JSON
  output carries `needsFill: true` and `rolePath`.
- **`role list` annotates TBD rows.** Rows for roles whose markdown
  still has TBD show `(TBD: fill role markdown)`. JSON output carries
  `needsFill` per row.
- **`agentctl activate <role>` refuses while the role contract has TBD.**
  Hard refusal at the most actionable moment — the user is about to
  bind the role to a window and would otherwise discover the missing
  self-introduction much later via every-turn agent confusion.
- **`activate` output gets explicit dividers + clipboard copy.**
  Snippet now appears between `═══ BEGIN PASTE TO AGENT ═══` and
  `═══ END PASTE TO AGENT ═══` so it is obvious where the paste
  payload begins and ends. Auto-copied to the system clipboard via
  `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip.exe` when
  available; `--no-copy` flag to skip. JSON output carries
  `copiedToClipboard` and `clipboardTool` fields.
- **Activation snippet rewritten for the agent's perspective.** Now
  reads `You are the <role> agent for ...` (second person, addresses
  the agent directly). Three numbered steps: claim via `--eval`, run
  `agentctl role show <role>` to learn its own contract, run
  `agentctl -h` to learn the CLI surface. Closes the gap where weak
  models skipped the export step or never read their own contract.
- **`agentctl -h` rewritten.** Opens with a one-paragraph description
  of what the tool is, then a runnable Quickstart, then per-section
  command listings with inline tips (`eval "$(... --eval)"`,
  `unset MA_SESSION` after release, Cursor `wait --mode exit`). Adds
  an exit-codes table with agent-actionable hints (USAGE / FORBIDDEN
  / STATE_CORRUPTION) and a See-also block to the doc set.
- **Handbook adds task-assignment rules.** New section "Task
  assignment is push, not pull" telling agents that tasks are
  assigned by the task-board owner (or a human), not self-claimed.
  New section "Multi-role task pattern" documenting the lead +
  sub-tasks + parent Blocked + report-to-assigner workflow for work
  that spans multiple roles, built on the existing single-owner
  schema. New hard don't: do not self-assign via
  `task assign --to <yourself>`.
- **README.md and README.zh-CN.md rewritten** around the user-vs-agent
  boundary (7 sections). Adds an explicit "Your job vs the agent's
  job" table, a "What you still need to write by hand" section
  highlighting that `state/project_state.md` is not auto-created, a
  "Common situations" troubleshooting block, and `npm link` /
  `npm run watch` guidance under Develop locally.
- **SCHEMA.md** flags `state/project_state.md` as not auto-created
  with an explanation of the downstream effect (agents bounce
  acceptance questions back to the user every turn).

### Cross-cutting

- New CLI flag `--no-copy` (booleans whitelisted in argv).
- New util `src/cli/util/clipboard.ts` (no new dependencies).
- 13 new tests across `tests/role-cli.test.ts`, `tests/activate.test.ts`,
  `tests/help.test.ts`, `tests/handbook.test.ts`,
  `tests/prompt.test.ts`.

## [2.0.0-alpha.11] — 2026-05-27

### Prompt UX hardening + role delete (PR8d)

- **Runtime body adds an "only-if-activated" gate.** Previous wording
  ("You play one role per window. Your role is bound by ...") assumed
  every agent window that loaded the rule had been claimed for a role.
  In practice users open agent windows for unrelated work too; without
  a gate, those windows would reflexively run `agentctl plan` /
  `claim` against random roles. New leading section limits the
  protocol to windows where either `MA_SESSION` is exported or the
  user has explicitly told the agent its role. Test in
  [tests/handbook.test.ts](./tests/handbook.test.ts) asserts every
  target body carries the gate.
- **`prompt --write` now prints a window-restart caveat.** Cursor,
  Claude Code, and Codex inject rule files into the agent's system
  prompt only when the agent window opens. Running `prompt --write`
  AFTER opening the window leaves the new rule with no effect there.
  Successful writes now print a clearly-marked IMPORTANT block telling
  the user to restart any open agent windows. JSON output carries the
  same signal as `requiresWindowRestart: true`.
- **"SKIPPED" renamed to "UNCHANGED (already up to date)".** The
  byte-equal short-circuit fired with the message "SKIPPED", which
  reads as "tool refused to do anything" when it actually means "tool
  decided nothing needed to change". Wording is now explicit.
  `writeArtifactFile` returns `"unchanged"` instead of `"skipped"`;
  CLI surface follows.
- **New `--force-rewrite` flag for `prompt --write`.** Bypasses the
  byte-equal short-circuit so the operator can confirm the on-disk
  file came from the current template (useful while debugging install
  drift). Refuses without `--write` to keep semantics narrow.
- **New `agentctl role delete <id>` command.** Removes the role from
  `config.yaml`, deletes `roles/<id>.md`, deletes the live session
  file (so any lingering `MA_SESSION` fails fast on the next command),
  and emits a `ROLE_DELETED` system event. Open task assignments are
  left in place — recreating the same role id reinherits them.
  Restricted to `SYSTEM` (no `MA_SESSION` exported); CLI refuses if
  the calling shell has a session exported, with a clear hint to
  `unset MA_SESSION`. Nine tests in
  [tests/role-delete.test.ts](./tests/role-delete.test.ts) cover
  config / md / session cleanup, ROLE_DELETED audit, orphan-task
  survival, non-SYSTEM rejection, MA_SESSION fail-fast after delete,
  and concurrent `deleteRole` + `createRfc` under `config-yaml` lock.

### Cross-cutting

- New event type `ROLE_DELETED` (in `EventType` union).
- `Store` interface gains `deleteRole(input)`.
- `writeArtifactFile` accepts `{ force?: boolean }` for the
  force-rewrite path.
- Suite size 169 → 185.

## [2.0.0-alpha.10] — 2026-05-27

### Third correctness + UX pass (PR8c)

Fourteen independent fixes from a third reviewer pass plus a
business-process simulation. Every fix is covered by a regression test
(suite grew from 150 to 169).

#### A. Safety / consistency

- **H1 — mustNotEdit path-normalisation bypass.** `state//architecture.md`
  used to slip past `pathMatches` (string compare against
  `state/architecture.md` failed) yet resolved to the protected path on
  disk via `path.resolve`. `requireOwnership` now refuses any input
  that is not its own POSIX-normalised form, and explicitly refuses
  trailing-slash file targets. Three tests in `tests/ownership.test.ts`.
- **H2 — stale-lock restore could clobber a fresh owner.** `tryBreakStale`
  previously used `rename(2)` to restore the aside record, which
  silently overwrites a destination installed by a racing process.
  Now uses `link(2)` + `unlink`: `link(2)` fails with `EEXIST` on a
  populated target, leaving the new owner intact and the aside file as
  forensic evidence. New regression test in `tests/local-fs-store.test.ts`.
- **H3 — RFC self-heal raced under concurrent readers.** N concurrent
  `readRfc` calls observing the same inconsistent shape used to each
  emit `RFC_REPAIRED` and each rewrite `proposal.yaml`. Self-heal now
  enters the `rfc-${id}` lock and re-verifies inside the lock; only
  one writer commits the repair. New 10-concurrent-reader test in
  `tests/rfc.test.ts`.
- **Step 11 — concurrent `config.yaml` RMW lost writes.** `createRole`
  and `createRfc` both did read-modify-write on the same file under
  *different* resource locks (`roles-create`, `rfcs`); concurrent
  execution dropped writes. New `Store.updateConfig(mutator)` API
  serialises ALL config-yaml mutations under a dedicated
  `config-yaml` lock. Both 50× concurrent `createRfc` and mixed
  role/RFC concurrency tests pass.

#### B. Behaviour changes that fix first-run demo

- **Step 5b — `task new --owner X` defaults to `Ready`, not `Backlog`.**
  Manifest filters `Backlog` out by design, so the README's PM example
  (`task new --owner Backend`) would leave the assignee unable to see
  the task. Tasks created without an owner still default to `Backlog`
  (unassigned product idea pending triage). Two new tests; one
  existing test's `previousStatus` assertion adjusted.
- **Step 6 — Cursor runtime body now recommends `wait --mode exit`.**
  Cursor's chat shell kills long-running tool calls within seconds, so
  the default block-mode `agentctl wait` (10-minute idle) was always
  killed. `runtimeLoopBody` takes a `target` argument; only the Cursor
  artifact swaps to exit mode. Codex / Claude / Generic keep cheaper
  block mode. Two new tests in `tests/prompt.test.ts`.
- **Step 4b — `claim` against a live peer no longer advertises `--force`.**
  Error message used to say "Pass --force to take over", which LLM
  agents immediately did, silently killing peer windows. New message:
  "ask the user — do NOT silently take over a peer." `--force` still
  works for humans who pass it explicitly. New test in
  `tests/claim.test.ts`.

#### C. Safety / consistency P1

- **M1 — Codex `SKILL.md` is now project-agnostic.** The skill installs
  to `~/.codex/skills/multi-agent-runtime/`, a user-level singleton,
  so the previous baking of `projectRoot` meant `prompt --write` from
  project B overwrote project A's install. Skill body now says "the
  project where this skill is activated (discovered from cwd at
  runtime)"; one install services every project. Per-project context
  travels via the per-window `activate` snippet. Cross-project
  byte-equality test in `tests/prompt.test.ts`.
- **M2 — RFC deciders gate now raises `ForbiddenError`.** Previously
  raised `UsageError` (exit 2) for permission denial; should always
  have been `FORBIDDEN` (exit 9) so the handbook's escalation rule
  applies. Test assertion updated.
- **M3 — corrupt `heartbeatAt` no longer fails open.** `findSessionById`
  guarded the lease check with `if (Number.isFinite(heartbeatMs) &&
  expired)`, which silently skipped the entire check on a NaN
  heartbeat — sessions with malformed timestamps were perpetually
  valid. Now fails closed: any non-finite heartbeat → `null`. New
  test in `tests/identity.test.ts`.
- **Step 12 — `task new` / `task assign` reject unregistered owners.**
  `--owner Forntend` (typo) used to be accepted; the resulting
  `TASK_ASSIGNED` event went to a role no manifest could route. Now
  `createTask` and `assignTask` check `config.roles[owner]` after
  syntactic validation and throw `UsageError` with a hint. Two new
  tests in `tests/task-board.test.ts`.

#### D. UX

- **Step 10 — `release` reminds you to `unset MA_SESSION`.** Without
  the hint, the shell still has the stale session id exported and
  every subsequent command fails with "session not found." Output
  now includes the exact shell-runnable line.
- **Step 4a — new `agentctl claim --eval` mode.** Outputs exactly
  `export MA_SESSION=<ulid>\n` for shell `eval`:
  ```
  eval "$(agentctl claim PM --eval)"
  ```
  Single-step claim+export so weaker LLM agents cannot forget to
  copy the export line manually. Regular text output now also shows
  the `--eval` tip. Strict format test in `tests/claim.test.ts`.
- **Step 7 — handbook gets a `Review handoff` temporary protocol.**
  Role-neutral text that tells agents how to hand a Review task off
  to a task-board-owning role, then wait for that role to mark Done.
  Also adds a hard don't to `Hard "don't"s`: seeing "already claimed
  by a live session ..." means STOP and ask the user, not retry
  with `--force`.
- **Handbook role-neutrality regex.** Existing test only checked five
  hardcoded role ids (`PM`, `TL`, `Backend`, `QA`, `DevOps`); custom
  project roles slipped through. New test scans for the generic
  pattern `<Capital> should|must|will|may|owns|...` and rejects any
  match that isn't an allowlisted grammatical word.

### Cross-cutting

- Suite size 150 → 169.
- Three exit codes get a clearer mapping to agent action in
  the handbook: `USAGE` (fix your call), `FORBIDDEN` (escalate, do
  not retry), `STATE_CORRUPTION` (stop and ask the user).
- `Store` interface gains `updateConfig`; existing `writeConfig`
  is now documented as caller-must-hold-`config-yaml`-lock.

## [2.0.0-alpha.9] — 2026-05-27

### Critical correctness pass (PR8b)

Ten independent fixes from two consolidated reviews (one external
text-based, one canvas-based). Each maps to a regression test.

- **C-03 argv boolean-flag whitelist.** `agentctl plan --json PM` used
  to greedily consume `PM` as the value of `--json`, silently losing
  the role argument. New `BOOLEAN_FLAGS` set in
  [src/cli/argv.ts](./src/cli/argv.ts) keeps known booleans (`--json`,
  `--write`, `--force`, `--no-handbook`, `--no-wait`, `--help`,
  `--version`) from ever consuming the next token. 6 new tests in
  `tests/argv.test.ts`.
- **ULID cross-process race watermark.** Process-local monotonic ULIDs
  do not guarantee global ordering; two writers in the same millisecond
  can produce ids whose lexicographic order is reversed relative to
  write order, which in turn lets the cursor advance past an event no
  one has seen. `LocalFsStore` now defers events newer than
  `safetyMarginMs` (default 200 ms) to the next `plan`, preserving the
  cursor-never-skips invariant. Configurable via the constructor;
  tests pass 0 for deterministic visibility.
- **Stale lock conditional restore.** `tryBreakStale` no longer
  unconditionally unlinks the renamed-aside file. If the record on
  disk has changed under us (a fresh process legitimately took the
  lock after our detect-stale), the function renames the new record
  back in place and leaves any unrecoverable copy on disk as forensic
  evidence — never silently de-locking a live owner.
- **C-01 / lease + auto-heartbeat.** `findSessionById` now refuses
  sessions whose `heartbeatAt + leaseTtlSeconds * 1000` is in the past;
  `resolveIdentity` automatically calls `touchHeartbeat` on every
  successful resolution, so any authenticated command refreshes the
  lease. An active agent no longer gets silently taken over after the
  default 30-minute TTL just because it never explicitly heartbeats.
- **C-02 RFC self-heal on read.** `finaliseRfc` writes `decision.json`
  before updating `proposal.yaml`; a crash between those two writes
  used to leave the proposal `open` with a decision already on disk,
  letting the next `decide` overwrite the prior decision. `readRfc`
  now detects that inconsistent shape, forward-completes the proposal
  status from the decision's outcome, and emits a new `RFC_REPAIRED`
  event for the audit trail.
- **MA_SESSION strict / `resolveActor` helper.** Replaced the
  `try { resolveIdentity(...) } catch { actor = "SYSTEM" }` pattern in
  `task`, `rfc`, and `write-state` commands with a strict helper:
  `MA_SESSION` set → must resolve successfully; only unset means
  SYSTEM bypass. A stale or invalid `MA_SESSION` token no longer
  silently downgrades to SYSTEM, which had been an effective ownership
  bypass.
- **H-01 createRole atomic order + recovery.** Write order is now
  config-first, markdown-second. The "config has, markdown missing"
  shape is no longer permanently wedged — `createRole` detects it and
  finishes writing the markdown (preserving any hand-edited config
  fields). The "markdown without config" shape still refuses (legacy /
  hand-edit case requiring user action).
- **H-04 wait refuses pending manifest.** `wait --mode block` now
  errors out (USAGE) when `cursor.pendingManifest` is non-null. Before
  this the count was computed against the pre-plan cursor, so every
  event already in the pending manifest contributed to `count > 0`,
  producing a permanent false ATTENTION verdict and an agent loop.
- **claim + report registration gate.** `agentctl claim` now refuses
  unknown role ids (typo `claim Forntend` no longer creates a phantom
  session). `Store.publishReport` now refuses an unknown recipient
  role, matching the PROTOCOL.md contract.
- **plan TTY-aware output.** `agentctl plan` defaults to JSON whenever
  `process.stdout.isTTY` is false — agents invoking via shell now get
  the structured manifest the runtime contract promises. The
  human-text rendering additionally prints `Tasks (N)` and
  `RFCs (N)` sections, since the prior text body only showed events.

### Tests

127 → 150 (`tests/argv.test.ts` × 6, `tests/claim.test.ts` × 2, plus
targeted additions across existing files). Several existing tests had
to seed roles or pass `safetyMarginMs: 0` to remain deterministic
under the new gates.

### Docs

- [docs/SCHEMA.md](./docs/SCHEMA.md): new `RFC_REPAIRED` row.
- [docs/DESIGN.md](./docs/DESIGN.md): "Known limitations" gains the
  watermark trade-off note.

### Notes

PR8b is purely correctness; the larger PR8 (installer / upgrade /
reset) is unaffected. PR8c (secondary correctness + polish) is queued.

## [2.0.0-alpha.8] — 2026-05-27

### Changed — BREAKING (prompt / activate split)

`agentctl prompt` was overloaded: it built both the host-shared runtime
artifact (role-free) AND the per-window activation snippet (role-bound).
The role positional made it look as if the persistent file contained
role-specific instructions, which it never did. This release splits the
two responsibilities into separate commands so role identifiers cannot
leak into project-shared files.

- `agentctl prompt` is now strictly role-free:
  - Signature: `prompt --target codex|claude|cursor|generic [--write] [--no-handbook] [--json]`.
  - Refuses any positional argument with a USAGE error pointing at the
    new `activate` command (no silent fallback or back-compat alias —
    we don't want a "two ways to do the same thing" period).
- `agentctl activate <role> --target <host>` (new):
  - Prints the chat-paste snippet that binds `<role>` to one specific
    agent window. Never writes to disk.
  - For codex/claude/cursor, the snippet is short (a few hundred
    bytes); the runtime body lives in the persistent file installed
    by `prompt --write`.
  - For `--target generic`, the snippet bundles the runtime body too,
    since generic has no install location.
  - Validates the role exists in `config.yaml`; refuses unknown roles.
- `src/cli/prompts/*` refactored:
  - `RuntimeArtifact = { body, files }` is role-free.
  - `buildRuntime(target, projectRoot, opts)` builds the artifact.
  - `buildActivation(target, role, projectRoot, opts)` returns the
    per-window snippet as a plain string.
  - Each per-target wrapper exports `build<Target>Runtime` and
    `build<Target>Activation` as two distinct functions.

### Why

Two Cursor chat windows in the same project are two agents. Anything
written to `.cursor/rules/`, `<proj>/CLAUDE.md`, or `~/.codex/skills/`
is shared across windows, so it MUST be role-agnostic. The old
`prompt PM --target cursor --write` accepted a role even though the
file it wrote contained no role information — confusing and inviting
future bugs where a contributor accidentally embeds the role in the
template. Splitting the commands makes the constraint inexpressible at
the CLI surface.

### Tests (121 -> 127)

- New regression in `tests/prompt.test.ts`:
  "every target body contains plan + MA_SESSION **but never a role id**".
  The test scans the runtime body and every written file against every
  role id in `config.yaml`. Future contributors who accidentally embed
  a role will see CI go red.
- `prompt` rejects positional role argument with USAGE.
- `prompt --target generic --write` rejected (no install location).
- `activate` rejects when role is missing or unknown.
- `activate` for codex/claude/cursor produces short snippets
  (< 800 bytes; no handbook embedded).
- `activate` for generic bundles the full body (with or without the
  handbook depending on `--no-handbook`).
- Codex activation includes the `$multi-agent-runtime` skill-trigger
  phrase.

### Migration

For anyone scripting the previous CLI: replace
`agentctl prompt PM --target cursor --write` with the two-step pair:

```bash
agentctl prompt --target cursor --write   # once per host, no role
agentctl activate PM --target cursor      # per agent window, role only
```

The shapes of the on-disk artifacts (Cursor rule, CLAUDE.md block,
Codex skill) are unchanged.

## [2.0.0-alpha.7] — 2026-05-27

### Added (PR8a — collaboration handbook)

Up to PR7 the framework taught agents the **mechanism** (which command,
what events). This release adds the **policy** layer: a compact, role-
neutral handbook that tells the agent **when** to choose which tool.

- New `src/cli/prompts/handbook.ts` exporting `COLLABORATION_HANDBOOK`
  (~7 KB of UTF-8 markdown). Sections:
  - Core stance.
  - Turn shape (the canonical per-turn order).
  - When to write a worklog (do / don't).
  - When to send a report (do / don't).
  - When to open an RFC instead of a report.
  - Disagreement (with assignments, accepted RFCs, other reports).
  - When to push upstream (concrete 2-turn trigger).
  - When to escalate up (by problem nature, not by role name).
  - When to bounce to the user — whitelist of 5 scenarios, plus a
    list of common temptations that are NOT the user's job.
  - Task lifecycle micro-rules (Backlog/InProgress/Done discipline,
    acceptance-ambiguity rule).
  - Idle / lifecycle (wait vs release; stale-manifest re-plan rule).
  - Build / test breakage (halt + report, never push on top).
  - Hard "don't"s.
- Wired into the runtime body so every host artifact carries it by
  default:
  - `agentctl prompt <role> --target codex|claude|cursor|generic`
    output bodies include the handbook.
  - `--write` persists it into `.cursor/rules/multi-agent-runtime.mdc`,
    `~/.codex/skills/multi-agent-runtime/SKILL.md`, and the marker
    block inside `<project>/CLAUDE.md`.
- New flag `agentctl prompt --no-handbook` for projects with their own
  behavioural standards or unusually tight context budgets. Dropping
  the handbook shrinks each artifact by ~3 KB.
- New `docs/HANDBOOK.md` documenting the policy layer and the
  authoring principles future edits must follow.
- 6 new vitest cases (`tests/handbook.test.ts`); 121/121 total. The
  test suite asserts that key trigger phrases survive future edits
  (`Blocked on T-XXXX (no movement 2t)`, `exit code 9 (FORBIDDEN)`,
  `Do NOT release the role`, `Don't hand-edit anything under
  .multi-agent`, ...), that the handbook is role-neutral (no PM / TL /
  Backend / QA / DevOps mentions), and that the total size stays under
  the 8 KB budget.

### Rationale

Without a policy layer, agents tend to (a) over-communicate
(worklog-spam, RFCs for trivial questions) and (b) over-defer to the
human user. The handbook gives the LLM concrete, observable triggers
("blocked for 2 turns", "exit 9 FORBIDDEN", "stale manifest 5+ turns
old") so behaviour stops depending on which model is in the window.

Loaded **once per session** into the host's persistent area, so the
context cost is paid once and survives chat compression — it is never
shipped per turn the way `manifest.roleReminder` is.

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

# Changelog

All notable changes to this project are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Tracking v2.0.0; see [docs/ROADMAP](./docs/ROADMAP.md) for PR sequencing.

### Cross-host collaboration: dashboard, identity escape hatch, safer init (PR8x)

Hardening for the core use case — several agent windows (Cursor /
Claude Code / Codex CLI) coordinating on one machine.

- **`gojaja watch` — read-only web dashboard.** Starts a local HTTP
  server (127.0.0.1:7421 by default, falls back to a free port) and
  opens the browser. One screen shows every role's session
  (live / stale / idle-waiting + pid/host/heartbeat), the task board by
  status, open RFCs, and a live newest-first activity feed across all
  windows. On a single machine nothing can wake a turn-ended agent, so
  the human is the scheduler; this is their view. `--port` / `--host` /
  `--no-open`. Never mutates state.
- **`--session <id>` global flag.** Identity is normally read from
  `GOJAJA_SESSION`, but some hosts run each command in a fresh shell and
  drop the `export` from `claim`. Agents on those hosts can now pass the
  id explicitly on every command. Dispatch sets it into the environment
  so all existing resolution works unchanged; an explicit flag overrides
  an inherited env var. Documented in the runtime body, activation
  snippet, PROTOCOL, and the help text.
- **`gojaja init` git safety gate.** Refuses to run when the project
  has uncommitted git changes (commit/stash first for a clean revert
  point); when the project is not a git repo, warns and asks for y/n
  confirmation (or requires `--force` when stdin is not a TTY).
  `--force` bypasses both checks.
- **`.gojaja/.gitignore` written at init.** Excludes machine-specific
  runtime state (`locks/`, `comms/sessions/`, `comms/pending/`,
  `comms/heartbeats/`, `comms/cursors/`) so a committed `.gojaja/` does
  not resurrect a stale "live" session that blocks `claim`, or stale
  locks/read-cursors, on another checkout. The audit trail (events,
  worklog, rfcs, state, roles, config) stays committable.
- **Session TTL 30 min → 2 h.** Long agent tasks can keep a window busy
  well past 30 minutes without emitting a command; every authenticated
  command still auto-renews, so this only governs how long a *silent*
  session stays claimable by others.
- **Codex skill is now reference-counted.** The user-level skill at
  `~/.codex/skills/gojaja-runtime/` is shared across projects.
  `prompt --target codex --write` registers the project; `reset`
  de-registers it and `reset --purge-codex-skill` deletes the skill
  only when no other project still uses it (otherwise it is kept and
  the user is told which projects depend on it). `--force` deletes
  regardless. This replaces "delete and hope no other project needed
  it" with a safe ref-count.
- **Fixed: a second project's `prompt --target codex --write` was
  refused.** The artifact-recognition guard only accepted files
  containing "gojaja plan", but the shared `agents/openai.yaml` does
  not contain it — so once one project had written the user-level
  skill, every other project (and re-runs) hit "does not look like a
  gojaja artifact". Recognition now also accepts the "gojaja-runtime"
  marker, which all generated artifacts carry. This was what blocked
  the Codex ref-count flow above from ever seeing a second project.
- Docs: README (EN + zh-CN) gain a `watch` section, a cross-host
  identity troubleshooting entry, and the human `claim --force`
  takeover path; roadmap updated.

### Project-wide audit fixes (PR8w)

A full scan surfaced a batch of contract/text drift and two real
concurrency bugs. No compile errors and the suite was green before;
these are correctness/consistency fixes.

Behaviour / concurrency:

- **RFC self-heal no longer self-deadlocks.** `readRfcUnchecked`'s
  crash-recovery (decision.json present but proposal still `open`)
  re-entered `withLock(\`rfc-<id>\`)`. Mutating callers
  (`commentRfc` / `decideRfc` / `addOption` / `revise` / `edit` /
  `link`/`unlink-task`) already hold that non-reentrant lock, so the
  repair would hang until `LOCK_TIMEOUT`. Extracted
  `repairFinalisedRfc` (lockless) and gave `readRfcUnchecked` a
  `lockHeld` flag; locked callers repair inline. Added a regression
  test exercising the locked path.
- **`gojaja state edit` is now serialised per file.** The
  append/replace read-modify-write (and overwrite) now run under a
  per-file lock, so two concurrent edits to the same state file can no
  longer lose each other's bytes (lost update). Unrelated files still
  edit in parallel.
- **Subcommand `--help` / `-h` no longer executes the command.**
  `gojaja wait --help` used to fall through and actually block on a
  wait; `gojaja init --help` could initialise the project. A
  `--help`/`-h` anywhere now prints help and exits 0 before dispatch.

Text / contract accuracy (agent- and user-facing):

- Fixed the `gojaja -h` exit-code table to match `errors.ts`
  (`NOT_INIT=3`, `LOCK_TIMEOUT=6`, `PATH_INVALID=7`, `STATE_CORRUPT=8`,
  `FORBIDDEN=9`). It previously claimed `NOT_INIT=6` and
  `STATE_CORRUPTION=10`, which would mislead agents/scripts branching
  on the code.
- Rewrote the `rfc comment` help text that wrongly said a plain
  comment auto-reopens an RFC and "silence is consent" — the ACK gate
  requires explicit `rfc ack` / `rfc object`; silence is never consent.
- Removed the reference to a non-existent `gojaja task reviewer ...`
  command from the FORBIDDEN error on owner-Done.
- Removed the dead `--no-wait` boolean flag (no consumer).
- Docs: `PROTOCOL.md` now uses `gojaja prompt --target` (the role-free
  form) and documents the real `claim --json` shape
  (`{ status, session }`); `SCHEMA.md` VERSION example, RFC options
  ("may be empty" / brainstorm), and the `rfcs/` tree (`comments.yaml`,
  not `comments/<role>.json`) are corrected; `RFC.md` command table
  marks `--options` / `decide --option` as conditional.
- `gojaja init` re-init message now says "gojaja" (not "multi-agent")
  and points at `gojaja reset`.

### Drop back-compat hints + dead migration code (PR8v)

The project has no released users, so accumulated "migrate from
PR8X" hints and back-compat code paths were costing context budget
and clarity without buying anything.

- Removed every `PR8x` / `pre-PR8x` / `legacy ...` / `alpha-only`
  reference from user-facing artifacts: `gojaja -h`, the runtime
  prompt body, the collaboration handbook, READMEs, and the user
  docs (`PROTOCOL`, `SCHEMA`, `RFC`, `HANDBOOK`, `DESIGN`). The
  history-by-design `CHANGELOG` and `ROADMAP` are unchanged.
- Removed the dead `assignedBy → creator` promotion in
  `backfillTaskFields`. A task missing `creator` on disk now
  defaults to `"SYSTEM"` rather than `null`, and `Task.creator`
  drops the `| null` member from its type.
- Removed the `task.creator === null` fallback in `setTaskStatus`:
  the new Done-permission gate applies uniformly. A hand-edited
  task missing `creator` is treated as SYSTEM-created and refuses
  owner-Done; the task-board-owner path still works for sign-off.
- Removed the `proposal.yaml status: pre-decide` and the
  `preDecision: {...}` field detectors from `readRfc`, plus the
  `comments/<role>.json` directory detector and the
  `rfcLegacyCommentsDir` helper from `paths.ts`. Those on-disk
  shapes were ephemeral pre-release shapes.
- Source-level scaffolding comments (`// PR8x: ...`) were stripped
  in bulk; the design comments themselves are preserved, just no
  longer date-stamped.

### Planned next

- PR8h: schema-level features previously slated for PR8g (task
  `reviewers` field, `STATE_UPDATED` event, `dependsOn` cycle
  detection, schema-version compatibility check). `--description`
  becoming hard-required on `rfc new` also lands here. Maybe a
  read-only `gojaja rfc audit <id>` to surface
  "who has acked / objected / not responded yet" without the agent
  having to read `rfc show`.
- PR8k: org-hierarchy ergonomics. `directReports` reverse field,
  multi-target `report --to`, role-level RFC `decisionScopes`. Goal:
  3+ layer organisations are pleasant rather than noisy. PR8n
  subsumed the original "idle-broadcast retargeting" sub-task.
- PR8m: gate `gojaja role create` behind ownership of
  `config.yaml`, so an HR/Admin role can be granted role-creation
  authority via the normal ownership model.

## [2.0.0-alpha.26] — 2026-05-28

### Reviewers + Done permission (PR8u)

Three related changes turn the previously-temporary Review handoff
protocol into a first-class part of the task model:

**1. `task.reviewers: RoleId[]` field.** Set at create time
(`task new --reviewer X --reviewer Y`). Each reviewer must be a
registered role; duplicates are deduped. Reviewers can mark the task
`Done` regardless of ownership AND become automatic stakeholders —
\`TASK_STATUS_CHANGED\` events on the task surface in their manifest
without the owner sending an explicit report. (The previous
"task-board-owner protocol" stays as a fallback for tasks with no
reviewers.)

**2. `task.assignedBy` renamed to `task.creator`.** Same semantics
(populated from \`actor\` at \`createTask\` time, NOT updated by
\`assignTask\`). The new name reflects the field's purpose better —
it's the original creator, not "the most recent assigner".
\`readTaskBoard\` auto-promotes the legacy \`assignedBy\` value on
read, so pre-PR8u boards round-trip cleanly.

**3. Stricter Done permission.** Previously the owner-exception let
any task's owner unilaterally mark their own task Done. Now Done is a
sign-off act and requires one of:

- SYSTEM (human user running the CLI without a session),
- actor is in \`task.reviewers\`,
- actor is owner AND actor is creator (self-managed task — you both
  created it and own it; you can ship it yourself),
- actor owns \`state/task_board.yaml\` (legacy / coordinator route),
- (back-compat: legacy tasks with \`creator === null\` on disk keep
  the pre-PR8u owner-Done behaviour so existing alpha boards work).

Other transitions (InProgress / Blocked / Review / Backlog / Ready)
keep the owner-exception. Reviewers also gain non-Done permission so
they can push back to InProgress when rejecting, without a
report-then-owner-reverts dance.

A non-permitted owner trying to Done gets a clear \`FORBIDDEN\` (exit
9) that names the configured reviewers (or recommends escalation if
none).

> **Behaviour change (alpha-only).** Owner can no longer Done their
> own task unconditionally. New flow: add reviewers at create time,
> or let an explicit reviewer / task-board owner do the final Done.

Manifest changes:

- \`TaskSummary\` gains optional \`reviewers\` so the agent sees who
  else can Done their task without opening the full record.
- PR8n visibility filter: reviewers are now stakeholders, so
  \`TASK_STATUS_CHANGED\` (and \`TASK_DELIVERABLE_BYPASSED\`,
  \`TASK_CREATED\`) on a task they review automatically land in their
  manifest.

CLI:

- \`task new --reviewer <role>\` (repeatable).
- \`task show\` renders \`creator\` and \`reviewers\` when present.

Suite 321 -> 331 (10 new PR8u tests in \`task-board.test.ts\`;
PR8j-era deliverable tests updated to use PM as the Done-er
since Frontend can no longer self-Done).

## [2.0.0-alpha.25] — 2026-05-28

### RFC creator is automatically a voter (PR8t)

`createRfc` now unconditionally adds the creator (`createdBy`) to the
`voters` set (deduped against `--voters` so explicitly listing the
creator does not double-list). Semantically: opening an RFC asserts
interest in its outcome — the creator both sees manifest events for
the RFC AND owes an ack/object on any pre-decision (the ACK gate is
computed over `voters ∪ deciders`).

> **Behaviour change (alpha-only).** Pre-PR8t RFCs where the creator
> was deliberately omitted from voters had a quirky property: PM
> could open an RFC with deciders=[TL] and voters=[Backend, DevOps],
> then TL could pre-decide + Backend/DevOps could ack and TL would
> decide — with PM completely outside the audit trail of the final
> consensus. PR8t closes this; PM is now a required participant.

Edge cases handled:

- Creator passing themselves in `--voters` explicitly: deduplicated,
  no double-listing.
- SYSTEM-created RFCs (no `GOJAJA_SESSION`, CLI run by the user
  directly): SYSTEM is NOT auto-added — it's not a role and cannot
  ack/object. The voters list is exactly what was passed in.
- Creator who is also the pre-decider: the ACK gate still excludes
  the pre-decider, so they don't owe themselves an ack.
- Creator who is also a decider: same as above, normal decider rules.

No opt-out. If a creator genuinely is a relay, run the command from
the role that should be on record, not as a side-channel.

5 new tests in `rfc-v2.test.ts` cover the auto-add, dedup, SYSTEM
exclusion, ACK gate inclusion, and pre-decider exclusion paths. 4
existing tests updated where they hard-asserted the old voter set.

Suite 316 -> 321.

## [2.0.0-alpha.24] — 2026-05-28

### Fix dead doc references in user-facing artifacts (PR8s)

Five places leaked relative paths like \`docs/HANDBOOK.md\` or
\`protocol/PROTOCOL.md\` into user-facing output. Those files live in
the gojaja **source** repo on GitHub, not in the user's project; an
agent following the reference would look at \`<project>/docs/...\`
and find nothing.

Fixed:

- \`src/cli/prompts/handbook.ts\` intro: dropped "Mechanism is in
  protocol/PROTOCOL.md ... Full long-form rationale: docs/HANDBOOK.md".
  The handbook block is self-contained; the new intro just says
  "Judgement layer ... rules below are self-contained; full long-form
  rationale lives in the gojaja source repo on GitHub (you do not
  need it to follow the rules)."
- \`src/cli/help.ts\` "See:" section: replaced bare relative paths
  with an explicit GitHub URL prefix
  (\`https://github.com/smilezheng/gojaja\`) and a clear "none of
  these files are shipped into your project" note.
- \`src/core/role-template.ts\`: removed
  \`[docs/PROTOCOL.md](../../docs/PROTOCOL.md)\` from the role
  markdown skeleton. The role file is the agent's self-introduction;
  the protocol contract is in the runtime body (Cursor rule /
  CLAUDE.md / Codex skill) which the new line points at instead.
- \`PROJECT_STATE_SKELETON\` (state/project_state.md template):
  dropped "see docs/HANDBOOK.md". The acceptance criteria in that
  file are authoritative; no external link needed.
- RFC pre-PR8g migration errors: replaced "See docs/RFC.md
  Migration section" with the full GitHub URL
  (\`https://github.com/smilezheng/gojaja/blob/main/docs/RFC.md\`).

Suite 316 -> 316.

## [2.0.0-alpha.23] — 2026-05-28

### Prompt artifact compression + path portability (PR8q + PR8r)

Two related fixes for the runtime body and handbook that `gojaja
prompt --write` lands at `.cursor/rules/gojaja-runtime.mdc` and inside
the `CLAUDE.md` marker block. Both files are committed to the repo,
so they have to (a) fit a reasonable budget for CLAUDE.md (~200-line
target per Anthropic guidance) and (b) be portable across machines.

#### PR8q — handbook & runtime body compression

The pre-PR8q runtime body had accumulated rationale paragraphs and
parallel "when to use X" sections across PR8b → PR8n. Net effect:

```
.cursor/rules/gojaja-runtime.mdc:   520 lines / 22.8 KB
CLAUDE.md marker block:             516 lines / 22.6 KB
```

PR8q compresses by ~44%:

```
.cursor/rules/gojaja-runtime.mdc:   295 lines / 13.0 KB
CLAUDE.md marker block:             291 lines / 12.8 KB
```

Changes:

- Three parallel "when to use X" sections (worklog / report / RFC) →
  one three-column table.
- Three escalation paths (push upstream / escalate up / bounce to
  user) → one two-column "escalation ladder" table.
- All \`(PR8x)\` version markers removed (internal scaffolding).
- Rationale paragraphs dropped from the prompt; the long-form policy
  rationale lives in \`docs/HANDBOOK.md\` in the source repo, linked
  from the prompt's intro.
- "Idle and lifecycle" + "Idle (no work)" merged.
- Runtime body's verbose wait verdict table → one line ("RESUME means
  re-run the printed wait command").
- Identity / When-this-section-applies sections collapsed to ~3 lines
  each from ~15 lines each.

Handbook size budget tightened from 20 KB to 12 KB. Trigger-phrase
tests loosened where the compressed phrasing wraps differently across
lines.

#### PR8r — no absolute paths in committed prompt artifacts

Previously the Cursor rule and CLAUDE.md block baked the project root
path into their text:

\`\`\`
You participate in a multi-agent coordination layer rooted at:

  /Users/alice/projects/foo
\`\`\`

Both files are committed to git, so this broke immediately when the
project was checked out on another machine, moved to a different
location, or synced via Dropbox / Syncthing.

Fix: \`runtimeLoopBody\` now always renders the cwd-discovery message
("for whichever project this window is currently working in (gojaja
discovers the project root from the shell's cwd)"). The Codex skill
already did this (intentionally — it's user-level shared); Cursor and
Claude now match.

The activation snippet (\`gojaja activate\`) still includes the path
— it's pasted per-window into chat by the user and is never committed,
so a machine-specific path is correct there.

Suite 316 -> 316.

## [2.0.0-alpha.22] — 2026-05-28

### Rename — `multi-agent-coordination` → `gojaja` (过家家)

Project, CLI, layer directory, env vars, and host artifacts all
rename in one sweep. The name 过家家 (gòu-jiā-jiā) is a Chinese
phrase for kids' role-play games where each kid pretends to be a
family member — exactly what this tool lets your LLM agents do on
a shared codebase.

> **Breaking — every existing project must re-init.** No on-disk
> schema migration is provided; the directory name, env var names,
> and host artifact names all change. Alpha stage, no users, hard
> cut.

What renamed:

| Before | After |
| --- | --- |
| npm package `multi-agent-coordination` | `gojaja` |
| CLI binary `agentctl` | `gojaja` |
| Layer directory `.multi-agent/` | `.gojaja/` |
| Env var `MA_SESSION` | `GOJAJA_SESSION` |
| Env var `MA_PROJECT_ROOT` | `GOJAJA_PROJECT_ROOT` |
| Cursor rule file `multi-agent-runtime.mdc` | `gojaja-runtime.mdc` |
| Codex skill `~/.codex/skills/multi-agent-runtime/` | `~/.codex/skills/gojaja-runtime/` |
| Claude marker `<!-- multi-agent-runtime:BEGIN/END -->` | `<!-- gojaja-runtime:BEGIN/END -->` |
| Error base class `AgentctlError` | `GojajaError` |
| Repo URL `smilezheng/multi-agent-coordination` | `smilezheng/gojaja` |

What stays:

- Concept terminology — phrases like "a multi-agent collaboration
  framework" or "multi-agent project" stay; the rename targets the
  tool's self-identity, not its category.
- Schema version string `2.0.0-manifest-filter` — on-disk protocol
  marker, unaffected by branding.
- Project root directory in this repo (`codex-agent/`) — purely a
  local working name; not visible to users of the package.

Migration for any project that hand-claimed an alpha:

```bash
# In an existing project that was on alpha.21 or earlier
unset MA_SESSION          # old env var no longer recognised
agentctl reset --confirm <basename>   # if you still have the old CLI
rm -rf .multi-agent       # if reset is no longer available
npm install -g gojaja
gojaja init
# re-create roles, re-write project_state.md, etc.
```

Suite 316 -> 316 (mass token rename; no semantic changes).

## [2.0.0-alpha.21] — 2026-05-28

### `gojaja reset` — project uninstall (PR8o)

New command. Removes everything this tool installed into a project so
you can tear down the coordination layer without hand-deleting files.

Surface:

```
gojaja reset                                           # preview, no delete
gojaja reset --dry-run [--confirm <basename>]          # preview, no delete
gojaja reset --confirm <project-basename>              # delete
gojaja reset --confirm <project-basename> --purge-codex-skill
```

What it removes (when present):

- `<project>/.gojaja/` recursively — events, state, RFCs,
  worklogs, sessions, locks. Everything this tool wrote.
- `<project>/.cursor/rules/gojaja-runtime.mdc`, plus the empty
  `.cursor/rules/` and `.cursor/` directories after, so the project
  tree is not left with empty parents that belong to us.
- The `<!-- gojaja-runtime:BEGIN ... :END -->` block inside
  `<project>/CLAUDE.md`. Content outside the block is preserved.
  `CLAUDE.md` is deleted only if the marker block was its only content.
- `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/` only when
  `--purge-codex-skill` is passed. Off by default because the Codex
  skill is user-level and shared across every project the user works on.

Safety:

- `--confirm <token>` is required to actually delete. The token must
  equal `path.basename(projectRoot)`; mismatches raise `UsageError`
  (exit 2).
- `GOJAJA_SESSION` must be unset — destructive ops belong to the user, not
  to an agent (same posture as `role delete`).
- Default invocation prints a preview listing every path that would be
  touched and the exact `--confirm` token to use.

Suite 302 -> 316 (14 new reset tests + 2 helper tests).

## [2.0.0-alpha.20] — 2026-05-28

### Manifest event filter — token / attention budget (PR8n)

The events directory (`comms/events/`) stays the durable broadcast
log: every event ever produced lives there for audit and future
`gojaja doctor`. The per-role manifest is now a **projection** of
that stream onto the slice the role should attend to. Two layers,
one source of truth.

Why: pre-PR8n a busy 6-role project produced ~70 broadcast events /
role / day; each one was an LLM "should I react?" turn. WORKLOG and
RFC_DECIDED really are team-wide; everything else was over-delivered.
Net effect was bloated turns and noticeable behaviour contamination
(agents reacting to RFC threads they were not invited to, status
updates on tasks they had no stake in, session-claim noise, etc.).

Filter rules (broadcast events `to: "*"`):

- `WORKLOG`, `RFC_DECIDED` — every role (intentional team-wide
  channels).
- `RFC_CREATED`, `RFC_COMMENT`, `RFC_OPTION_ADDED`,
  `RFC_REVISION_REQUESTED`, `RFC_REVISED` — the RFC's
  `voters ∪ deciders ∪ {createdBy}`.
- `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED` — RFC participants OR the
  linked task's stakeholders.
- `TASK_CREATED` — roles owning `state/task_board.yaml` (triage set).
  The new owner already gets a directed `TASK_ASSIGNED`.
- `TASK_STATUS_CHANGED`, `TASK_DELIVERABLE_BYPASSED` — task
  stakeholders (owner, parent owner, dependants).
- `SESSION_CLAIMED`, `SESSION_RELEASED`, `SESSION_TAKEOVER`,
  `LOCK_BROKEN`, `ROLE_DELETED`, `RFC_REPAIRED` — nobody. Operational
  events; surfaced only via the event stream and (planned) doctor.
- Unknown / future event types — surfaced (forward-compatibility).

Guarantees:

- The cursor advance is computed against the pre-filter list, so
  events excluded by the per-type rule do NOT re-surface on the next
  `plan`. The event remains in `comms/events/` forever.
- `gojaja wait --for attention` uses the same projection, so wait
  fires only on events that would actually appear in the manifest.
  No more "wake the agent to look at a manifest that hides everything"
  loops.

Added:

- `Store.filterVisibleEventsForRole(events, role): Promise<Event[]>`
  exposed for `wait` to reuse the same projection.

Schema version bumped to `2.0.0-manifest-filter`. Non-breaking on
disk; manifest visibility narrows. Suite 294 -> 302.

## [2.0.0-alpha.19] — 2026-05-28

### Brainstorm-mode RFC (empty options) (PR8l)

`createRfc` no longer requires `--options`. An RFC opened without
options enters **brainstorm mode** — voters comment / reply freely
with no concrete choices on the table. The same primitive now covers
both "wide-open discussion" and the existing decision flow; no new
mechanism, no new on-disk shape, no schema break.

The two modes are mutually exclusive at decide time:

- Brainstorm-mode RFC (`options: []`): `rfc decide` accepts
  **without** `--option`. The decision is recorded as `accepted`
  with `chosenOption: null` and the rationale carries the takeaway.
- Options-bearing RFC (`options.length >= 1`): `rfc decide` requires
  `--option <id>`, same as before. Both paths are enforced
  symmetrically — passing `--option` to a brainstorm RFC, or omitting
  it on an options-bearing RFC, raises USAGE with the recovery hint.

A brainstorm RFC upgrades into a decision flow the moment anyone
runs `rfc add-option`. From that point on it behaves exactly like a
PR8g-style RFC: pre-decide works, the ACK gate arms, decide requires
`--option`.

`pre-decide` refuses on a brainstorm RFC and points at `add-option`:
nothing concrete to lock in until at least one option exists.

Schema version unchanged; this is a pure constraint relaxation. CLI
signature change is purely additive:

- `gojaja rfc new <slug> ...` — `--options` is now OPTIONAL.
- `gojaja rfc decide <id> --rationale ...` — `--option` is now
  CONDITIONAL (required iff the RFC has options).

`Store.decideRfc.chosenOption` widened to `string | null`.

Suite 284 -> 294.

## [2.0.0-alpha.18] — 2026-05-28

### Task model expansion: parent / assets / deliverables / assignedBy / tags (PR8j)

Adds the task fields a multi-layer organisation needs to decompose
work, point at reference materials, and gate hard outputs.
`setTaskStatus(... Done)` now enforces a `kind: "file"` deliverable
existence check; missing files refuse the transition with USAGE
listing every absent ref. `--force-incomplete` bypasses with a
`TASK_DELIVERABLE_BYPASSED` event emitted BEFORE the corresponding
`TASK_STATUS_CHANGED`, so "approval given, then status moved" is the
permanent audit ordering.

> **Schema break (alpha-only, no users).** `Task` records gain
> `parent`, `assignedBy`, `assets`, `deliverables`, `tags`.
> `readTaskBoard` backfills missing fields with safe defaults so
> legacy `state/task_board.yaml` files round-trip cleanly. Schema
> version bumped to `2.0.0-task-v2`.

Added:

- Task fields: `parent` (string | null), `assignedBy` (RoleId |
  "SYSTEM" | null), `assets` (TaskAsset[]), `deliverables`
  (Deliverable[]), `tags` (string[]).
- New types: `TaskAsset { kind: "file" | "url", ref, description }`,
  `Deliverable { kind: "file" | "url" | "manual", ref, description }`.
- `MAX_TASK_DEPTH = 5`. Parent chains deeper than this are refused at
  creation; `readTaskBoard` runs a cycle detector and refuses
  hand-edited yaml that contains a parent cycle.
- New event `TASK_DELIVERABLE_BYPASSED { taskId, missing: string[],
  by: RoleId | "SYSTEM" }`. Emitted ONLY when `--force-incomplete`
  was needed to mark Done.
- `TaskSummary` (manifest) gains optional `parent`, `childCounts:
  { ready, inProgress, blocked, review, done }`, `unmetDeliverables:
  number`, `tags: string[]`.
- CLI:
  - `task new ... [--parent T-NNNN] [--tag <label> ...]
    [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]`
  - `task status <id> Done [--force-incomplete]`
  - `task list [--tag <label> ...]` (OR-match)
  - `task show <id>` renders parent / children / assets / deliverables
    with on-disk `[x] / [ ] / [?]` markers.
- `argv.ts` gains `multiFlag(rawArgs, name)` helper and `rawArgs?` on
  `ParsedArgs` so accumulating flags can be parsed cleanly.

Constraints / refusals:

- Asset / deliverable file refs that escape the project tree (`..`)
  are refused at create time. Refs pointing inside `.gojaja/`
  are refused too — those are framework state, not project artifacts.
- `--force-incomplete` does not run the bypass event when all
  file deliverables are present (no bookkeeping noise for the clean
  path).
- `assignTask` does NOT change `task.assignedBy`. The field is the
  original-creator audit record; reassignment history lives in the
  event stream.

Suite 270 -> 284.

## [2.0.0-alpha.17] — 2026-05-28

### Wait redesigned around deadlines + RESUME + idle broadcast (PR8i)

Collapses the `--mode block | exit` dichotomy into a single
deadline-driven, chunked, resumable primitive. A long wait now
survives any host shell timeout: each chunk is one shell call, the
next chunk reads the same `--until` deadline off the command line
and continues. The PR8a `.wait` sentinel and its accompanying
`writeWaitSentinel` are gone, replaced by a session record at
`comms/pending/<role>/wait.json` that lets `--for task-assigned`
emit its idle WORKLOG exactly once per session even across resumes.

> **Breaking CLI / on-disk shape change (alpha-only, no users).**
> `--mode block`, `--mode exit`, `--idle <minutes>`, `--idle-seconds`,
> and the `.wait` sentinel are removed. Passing any removed flag
> raises USAGE pointing at the new shape. Schema version bumped to
> `2.0.0-wait-v2`.

Added:

- `gojaja wait [--until <ISO> | --in <duration>] [--for <condition>] [--poll-interval <duration>]`
- Conditions: `attention` (default), `rfc-decided:<id>`,
  `rfc-acked:<id>`, `task-assigned`, `report-from:<role>`,
  `event-ref:<id>`.
- Verdicts (all exit 0): `ATTENTION`, `CONDITION_MET`, `RESUME`,
  `TIMEOUT`. Each prints the exact next command to run.
- `--for task-assigned` auto-broadcasts a one-shot idle WORKLOG so
  any role with task-board ownership can re-assign the role.
- `Store.readWaitState` / `writeWaitState` / `clearWaitState`
  replace `writeWaitSentinel`.
- `argv.parseDuration` helper accepts `<n>{ms|s|m|h|d}`.

Runtime artifacts:

- Cursor runtime body pins `gojaja wait --in 10m --poll-interval 30s`
  so each chunk fits inside Cursor's shell timeout.
- Codex / Claude / generic bodies use `gojaja wait --in 10m`; a
  10-minute wait collapses to a single sleep on those hosts.
- Handbook gains a verdict table and a `wait --for task-assigned`
  guidance block; budget bumped 14 KB → 16 KB.

User-cancel of a chunked wait is intentionally not framework-handled:
the host's SIGTERM / SIGINT looks identical to a host-timeout from
inside the shell, so cancel is delegated to the host (kill the chat
or shell to stop; the next message redirects the loop).

Suite 260 -> 270.

## [2.0.0-alpha.16] — 2026-05-28

### RFC v2.1: pre-decide as structured comment + mandatory ACK gate (PR8g.1)

Walks back the PR8g `pre-decide` state-machine into a comment kind
with a hard ACK gate. PR8g modelled silence-as-consent; that turned
out to be unreliable in an async LLM-agent fleet (silence ≠ "saw it
and agreed"; could be "agent offline"). PR8g.1 requires every
required role to explicitly `rfc ack` or `rfc object` before
`rfc decide` succeeds. There is no silence-is-consent.

> **Breaking on-disk shape change (alpha-only, no users).** `readRfc`
> refuses any `proposal.yaml` with `status: pre-decide` or a
> `preDecision: {...}` field (both are PR8g shapes). Manual migration:
> edit `status: open`, drop `preDecision`; the pre-decision data is
> lost and agents should re-issue `rfc pre-decide`. Or `gojaja init`
> a fresh project.

Suite 247 -> 260.

#### State machine collapses pre-decide back to open

`RfcStatus` shrinks to 5 values: `{open, revising, accepted, rejected,
superseded}`. The status `pre-decide` is removed; pre-decisions are
now structured comments (`kind: "pre-decision"`) that live in the
ledger and are surfaced via a read-time computation.

#### Two new CLI verbs + reshape of one

- `gojaja rfc ack <rfc-id> [--rationale ...]` (new): structured
  agreement with the active pre-decision. Required-ACK roles only;
  pre-decider cannot ack their own.
- `gojaja rfc object <rfc-id> --rationale ... [--option Y]` (new):
  structured disagreement. Rationale required; optional preferred
  alternative.
- `gojaja rfc pre-decide ...` (reshaped): now posts a `kind:
  "pre-decision"` comment. RFC status stays `open`. The hard work
  happens in `decideRfc`'s ACK gate.

#### ACK gate inside `decideRfc`

When an active pre-decision exists (latest `kind: pre-decision`
comment, not invalidated by a later `RFC_OPTION_ADDED`), every role
in `(voters ∪ deciders) − {pre-decider}` must have posted a
`kind: ack` or `kind: object` comment with `ts > pre-decision.ts`.
Outstanding roles → USAGE with the full list and the recovery path.
**There is no override.** The only escape from a stalled ACK round
is `rfc reject` followed by a new RFC without the unreachable role.

#### Re-posting pre-decide invalidates all prior ACKs

Whether the decider keeps `chosenOption` or changes it, re-issuing
`rfc pre-decide` invalidates every prior `ack`/`object` because they
were responding to a now-superseded pre-decision. Every required
role must respond again. Same rule keeps things simple.

#### `add-option` while pending invalidates the pre-decision

Adding an option silently invalidates any active pre-decision because
voters were ACKing an outdated option set. The decider can re-issue
`rfc pre-decide` on the new option set. The existing
`RFC_OPTION_ADDED` event is the audit signal.

#### Regular `rfc comment` does NOT advance the ACK gate

A required-ACK role posting a regular `rfc comment` (no kind) does
not count toward the gate. Discussion is welcome; you still owe a
structured `ack` or `object`. Handbook teaches this.

#### Two PR8g event types collapsed

`RFC_PRE_DECISION` and `RFC_PRE_DECISION_OBJECTED` are removed. All
pre-decision / ack / object posts ride on `RFC_COMMENT` with
`payload.kind`. grep-friendly: `payload.kind === "pre-decision" |
"ack" | "object"`.

#### Manifest changes

`RfcSummary.pendingPreDecision` (PR8g field) now also carries
`awaitingAckFrom: RoleId[]` (outstanding required roles) and
`myAckOwed: boolean` (true iff this role still owes a structured
response). Visibility rules:

- Required-ACK role with `myAckOwed: true` → kept in manifest (they
  have structured work to do).
- Required-ACK voter who has already responded → dropped from their
  own manifest until decide / new pre-decide.
- Deciders → kept while RFC is open.

#### Schema additions

`RfcComment.kind?: "pre-decision" | "ack" | "object"`. Undefined =
regular discussion. PR8g `RfcProposal.preDecision` is removed.
`SCHEMA_VERSION` bumped to `"2.0.0-rfc-v2.1"`.

#### Tests

`tests/rfc-v2.test.ts`: rewrote 11 PR8g pre-decide-status tests as
PR8g.1 ACK-gate tests (+18 new). `tests/handbook.test.ts`: updated
trigger phrases for the new "silence does NOT count as consent" rules.
Suite 247 -> 260.

#### Docs

- `docs/RFC.md`: rewritten end-to-end (state machine, ACK gate
  semantics, 4-design-decision recap, walkthrough that exercises
  pre-decide → object → re-pre-decide → unanimous ack → decide).
- `docs/PROTOCOL.md`: RFC section adds `rfc ack` / `rfc object`
  command specs; `rfc decide` documents the ACK gate; `rfc reject`
  documents its "bypasses gate by design" role.
- `docs/SCHEMA.md`: removed `pre-decide` status enum entry + the
  PR8g `preDecision` field; added `kind` field on RfcComment with
  worked example; updated event table.
- `docs/HANDBOOK.md` and `src/cli/prompts/handbook.ts`: rewrite
  "RFC multi-round discussion" section to teach the mandatory-ACK
  semantics (no silence-as-consent; required roles must use
  `rfc ack` or `rfc object`; regular comments do not advance the
  gate; reject is the only escape).
- `gojaja -h`: RFC section updated similarly.

## [2.0.0-alpha.15] — 2026-05-28

### RFC v2: multi-round, threaded comments, mutable options, related tasks, revise (PR8g)

Substantial rework of the RFC mechanism. Suite 216 -> 247.

> **Breaking on-disk shape change (alpha-only, no users).** Comments
> moved from per-role JSON files (`rfcs/<dir>/comments/<role>.json`)
> to a single threaded ledger (`rfcs/<dir>/comments.yaml`). The CLI
> detects the legacy layout on first read and refuses with a clear
> `code: USAGE` message pointing at this entry. No auto-migrator —
> projects on alpha.14 or earlier should `gojaja init` fresh or
> hand-migrate.

#### State machine grew

`RfcStatus` expands from `{open, accepted, rejected, superseded}` to
`{open, pre-decide, revising, accepted, rejected, superseded}`. New
transitions:

- `open --rfc pre-decide--> pre-decide`
- `pre-decide --rfc comment (non-pre-decider)--> open` (auto-reopen)
- `open / pre-decide --rfc revise--> revising`
- `revising --rfc edit--> open`
- `decide` / `reject` accept additional starting states (see
  docs/RFC.md and docs/PROTOCOL.md).

#### New CLI verbs

- `gojaja rfc add-option <id>:<summary> --rationale ...` — surface
  a new option mid-discussion. Allowed in `open` or `revising`.
- `gojaja rfc pre-decide --option X --rationale ...` — decider
  posts "I lean X; any objections?". Voters either stay silent
  (consent) or comment (auto-reopens).
- `gojaja rfc revise --rationale "rewrite section X"` — decider
  kicks the proposal back without rejecting the topic.
- `gojaja rfc edit --rationale ... [--title T --description D
  --options A:s,B:s --deadline ISO]` — creator or decider applies
  the rewrite; status returns to `open`. Comments preserved.
- `gojaja rfc link-task --task T-NNNN` /
  `gojaja rfc unlink-task --task T-NNNN` — idempotent task pointers
  on the proposal; task ids validated against `state/task_board.yaml`.

#### New flags on existing verbs

- `rfc new --description <text>` — soft-required in PR8g (warn-on-
  empty); PR8h will harden to required. This is the channel for
  giving non-participants enough context to weigh in.
- `rfc new --task T-NNNN[,T-NNNN]` — link tasks at creation time.
- `rfc comment --reply-to <comment-id>` — thread under another
  comment by id (ULIDs printed by `rfc show` / `rfc comment`).
- `rfc show --no-mark-seen` — script-friendly read that does not
  advance the role's per-RFC read cursor.

#### New events

`RFC_OPTION_ADDED`, `RFC_PRE_DECISION`, `RFC_PRE_DECISION_OBJECTED`,
`RFC_REVISION_REQUESTED`, `RFC_REVISED`, `RFC_TASK_LINKED`,
`RFC_TASK_UNLINKED`. All broadcast (`to: "*"`).

#### Manifest additions

`manifest.rfcs[*]` now carries `unreadComments`, `relatedTasks`, and
(while in pre-decide) `pendingPreDecision`. Visibility rules for the
new states: voter hidden during `revising` unless they are the
creator; voter in `pre-decide` who commented after the pre-decision
ts drops from the manifest (both objection and silent-consent paths
end up clean). `gojaja rfc show <id>` advances the caller's per-RFC
read marker so `unreadComments` reflects "I am caught up".

#### Auto behaviours worth knowing

- `commentRfc` advances the commenter's read cursor automatically
  (no need to call `markRfcSeen` after commenting).
- Comments on `pre-decide` from a role other than the pre-decider
  auto-reopen the RFC and emit `RFC_PRE_DECISION_OBJECTED`. Comments
  from the pre-decider themselves do not (lets them add reasoning
  without aborting their own round).

#### Schema additions

`RfcProposal` gains `description: string`, `relatedTasks: string[]`,
optional `preDecision: { decidedBy, chosenOption, ts, rationale }`.
`RfcComment` gains `id: string` (ULID) and `replyTo: string | null`.
`RfcSummary` gains `unreadComments`, `relatedTasks`, optional
`pendingPreDecision`.

#### Handbook + docs

- `docs/RFC.md` rewritten end-to-end with the new state machine, the
  10-command surface, and a worked four-role simulation that exercises
  multi-round comments, `add-option`, `pre-decide` + objection, and a
  `revise` + `edit` cycle before a clean `decide`.
- `docs/PROTOCOL.md` RFC section: 6 new commands + flag additions on
  existing commands.
- `docs/SCHEMA.md`: new `comments.yaml` shape, new `proposal.yaml`
  fields, new per-role-per-RFC cursor file, 7 new events in the
  event table. Pre-PR8g `comments/<role>.json` layout flagged with
  migration note.
- `docs/HANDBOOK.md` and the in-prompt handbook gain "RFC multi-round
  discussion" guidance: when to pre-decide vs decide, when to revise
  vs reject, when to add an option, how to thread.

#### Other

- `SCHEMA_VERSION` bumped (RFC schema changed).
- Soft warning if `rfc new --description` is empty.

## [2.0.0-alpha.14] — 2026-05-27

### Rename write-state, surface mode flags in -h, roleReminder hint (PR8f-C)

Three small follow-ups to PR8f-B. No new behaviour beyond the rename.

- **`gojaja write-state` is renamed to `gojaja state edit`.** The
  old name was misleading once append/replace modes landed in PR8f-B
  — "write" reads as overwrite-only. The new name uses the
  subcommand-group style consistent with `task <new|assign|...>`,
  `role <create|list|...>`, `rfc <new|comment|...>`. Hard rename
  (alpha-stage; no backward-compatible alias): the old command name
  is gone and existing scripts must update. The Store-level interface
  `writeStateFile` is untouched (still the implementation hook).
- **`gojaja -h` now lists all three modes** for `state edit` with
  copy-pasteable invocations and the `--batch` semantics. The
  previous help text only showed `--content`, which was correct
  before PR8f-B but stale after it.
- **`manifest.roleReminder.protocol` carries a `role show` hint.**
  Compressed wording so the JSON-serialised reminder stays under the
  300-byte budget: now reads
  ``Loop: plan -> ack <t> -> wait. Lost your role? Run `gojaja
  role show <you>`. Writes via gojaja only; never hand-edit
  .gojaja/.`` — the new sentence routes any agent that has lost
  its self-understanding to the right CLI command, every turn.

Tests:
- `tests/state-edit.test.ts` replaces `tests/write-state.test.ts`
  (same coverage; updated imports + positional args + 2 new
  dispatcher tests for unknown / missing subcommand).
- `tests/plan-ack.test.ts` adds an assertion that
  `roleReminder.protocol` contains `gojaja role show`.

Docs:
- README.md / README.zh-CN.md cheatsheet rows.
- docs/PROTOCOL.md `state edit` section (renamed in place).
- docs/ROADMAP.md PR7 entry notes the rename.

## [2.0.0-alpha.13] — 2026-05-27

### init seeds project_state.md; write-state gains replace/append (PR8f-B)

Two related behaviour additions. Suite 198 -> 214.

- **`gojaja init` now seeds `state/project_state.md` with a TBD
  skeleton.** Previously the file was not auto-created and the
  handbook told agents to keep asking the user to make one — a slow
  failure mode. The new skeleton ships with three sections (Vision,
  Milestones, Acceptance criteria), each containing a `TBD` marker so
  it is obvious what to fill. Re-running `initialise` is still
  refused (existing AlreadyInitializedError), so the user's
  in-progress edits to the skeleton are never clobbered.
- **`gojaja write-state` gains `--append` and `--replace`/`--with`
  modes** alongside the existing `--content` (overwrite). Goal:
  agents that need to change a small fragment of a long file no
  longer have to re-emit the whole file (token cost), and accidental
  ambiguous replacements no longer go through silently.
  - `--append <text>`: appends to the existing file; absent file is
    treated as empty. No automatic newline prefix.
  - `--replace <oldText> --with <newText>`: literal-string find and
    replace. The default refuses if `oldText` appears 0 or N>1 times,
    with a clear hint to either expand the snippet or pass
    `--batch`. `--batch` allows N>1 (replaces all). `--with ""` is a
    valid deletion. No regex anywhere — purely literal strings, to
    eliminate the most common misuse class.
  - Strict mutual exclusion: at most one of `--content`/`--append`/
    `--replace` per invocation; `--with` requires `--replace`;
    `--batch` requires `--replace`. Each violation is its own USAGE
    error with the relevant hint.
  - Human output names the mode (`Wrote`/`Appended`/`Replaced N
    occurrences`); JSON output carries `mode` and (for replace)
    `replacedOccurrences`.
  - Ownership/`mustNotEdit`/path canonical-form gates all still
    apply to every mode.

### Cross-cutting

- `Store.writeStateFile` interface widened to a discriminated union.
- `Paths.projectStateFile` added (`state/project_state.md`).
- `BOOLEAN_FLAGS` whitelists `batch`.
- 16 new tests across `tests/init.test.ts` (new) and
  `tests/write-state.test.ts` (new).

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
- **`gojaja activate <role>` refuses while the role contract has TBD.**
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
  `gojaja role show <role>` to learn its own contract, run
  `gojaja -h` to learn the CLI surface. Closes the gap where weak
  models skipped the export step or never read their own contract.
- **`gojaja -h` rewritten.** Opens with a one-paragraph description
  of what the tool is, then a runnable Quickstart, then per-section
  command listings with inline tips (`eval "$(... --eval)"`,
  `unset GOJAJA_SESSION` after release, Cursor `wait --mode exit`). Adds
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
  a gate, those windows would reflexively run `gojaja plan` /
  `claim` against random roles. New leading section limits the
  protocol to windows where either `GOJAJA_SESSION` is exported or the
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
- **New `gojaja role delete <id>` command.** Removes the role from
  `config.yaml`, deletes `roles/<id>.md`, deletes the live session
  file (so any lingering `GOJAJA_SESSION` fails fast on the next command),
  and emits a `ROLE_DELETED` system event. Open task assignments are
  left in place — recreating the same role id reinherits them.
  Restricted to `SYSTEM` (no `GOJAJA_SESSION` exported); CLI refuses if
  the calling shell has a session exported, with a clear hint to
  `unset GOJAJA_SESSION`. Nine tests in
  [tests/role-delete.test.ts](./tests/role-delete.test.ts) cover
  config / md / session cleanup, ROLE_DELETED audit, orphan-task
  survival, non-SYSTEM rejection, GOJAJA_SESSION fail-fast after delete,
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
  the default block-mode `gojaja wait` (10-minute idle) was always
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
  to `~/.codex/skills/gojaja-runtime/`, a user-level singleton,
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

- **Step 10 — `release` reminds you to `unset GOJAJA_SESSION`.** Without
  the hint, the shell still has the stale session id exported and
  every subsequent command fails with "session not found." Output
  now includes the exact shell-runnable line.
- **Step 4a — new `gojaja claim --eval` mode.** Outputs exactly
  `export GOJAJA_SESSION=<ulid>\n` for shell `eval`:
  ```
  eval "$(gojaja claim PM --eval)"
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

- **C-03 argv boolean-flag whitelist.** `gojaja plan --json PM` used
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
- **GOJAJA_SESSION strict / `resolveActor` helper.** Replaced the
  `try { resolveIdentity(...) } catch { actor = "SYSTEM" }` pattern in
  `task`, `rfc`, and `write-state` commands with a strict helper:
  `GOJAJA_SESSION` set → must resolve successfully; only unset means
  SYSTEM bypass. A stale or invalid `GOJAJA_SESSION` token no longer
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
- **claim + report registration gate.** `gojaja claim` now refuses
  unknown role ids (typo `claim Forntend` no longer creates a phantom
  session). `Store.publishReport` now refuses an unknown recipient
  role, matching the PROTOCOL.md contract.
- **plan TTY-aware output.** `gojaja plan` defaults to JSON whenever
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

`gojaja prompt` was overloaded: it built both the host-shared runtime
artifact (role-free) AND the per-window activation snippet (role-bound).
The role positional made it look as if the persistent file contained
role-specific instructions, which it never did. This release splits the
two responsibilities into separate commands so role identifiers cannot
leak into project-shared files.

- `gojaja prompt` is now strictly role-free:
  - Signature: `prompt --target codex|claude|cursor|generic [--write] [--no-handbook] [--json]`.
  - Refuses any positional argument with a USAGE error pointing at the
    new `activate` command (no silent fallback or back-compat alias —
    we don't want a "two ways to do the same thing" period).
- `gojaja activate <role> --target <host>` (new):
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
  "every target body contains plan + GOJAJA_SESSION **but never a role id**".
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
- Codex activation includes the `$gojaja-runtime` skill-trigger
  phrase.

### Migration

For anyone scripting the previous CLI: replace
`gojaja prompt PM --target cursor --write` with the two-step pair:

```bash
gojaja prompt --target cursor --write   # once per host, no role
gojaja activate PM --target cursor      # per agent window, role only
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
  - `gojaja prompt <role> --target codex|claude|cursor|generic`
    output bodies include the handbook.
  - `--write` persists it into `.cursor/rules/gojaja-runtime.mdc`,
    `~/.codex/skills/gojaja-runtime/SKILL.md`, and the marker
    block inside `<project>/CLAUDE.md`.
- New flag `gojaja prompt --no-handbook` for projects with their own
  behavioural standards or unusually tight context budgets. Dropping
  the handbook shrinks each artifact by ~3 KB.
- New `docs/HANDBOOK.md` documenting the policy layer and the
  authoring principles future edits must follow.
- 6 new vitest cases (`tests/handbook.test.ts`); 121/121 total. The
  test suite asserts that key trigger phrases survive future edits
  (`Blocked on T-XXXX (no movement 2t)`, `exit code 9 (FORBIDDEN)`,
  `Do NOT release the role`, `Don't hand-edit anything under
  .gojaja`, ...), that the handbook is role-neutral (no PM / TL /
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
- New CLI `gojaja write-state --file <state/path> [--content <text>]`:
  - Content comes from `--content` if given, otherwise from stdin.
  - Identity from `GOJAJA_SESSION` (or `"SYSTEM"` if unset).
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

- Per-RFC directory `.gojaja/rfcs/RFC-NNNN-<slug>/` with
  `proposal.yaml`, `comments/<role>.json`, and `decision.json` (created
  on decide / reject).
- New `gojaja rfc` command group:
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
  comments + decision come from `gojaja rfc show <id>`.
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

- New on-disk artifact: `.gojaja/state/task_board.yaml`. Schema:
  `schemaVersion`, `nextId` (auto-allocator counter), and a `tasks`
  map keyed by `T-NNNN` id with `title`, `status`, `owner`, `priority`,
  `dependsOn`, `acceptance`, `createdAt`, `updatedAt`. Statuses:
  `Backlog | Ready | InProgress | Blocked | Review | Done`.
- New CLI surface `gojaja task`:
  - `task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
    [--depends-on T-NNNN,...] [--acceptance <text>]`.
  - `task assign <task-id> --to <role>`.
  - `task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>`.
  - `task list [--owner <role>] [--status <s>]`.
  - `task show <task-id>`.
- New event types `TASK_CREATED`, `TASK_ASSIGNED`,
  `TASK_STATUS_CHANGED`, all emitted automatically by the
  corresponding command. `from` is the role bound to `GOJAJA_SESSION` when
  available, otherwise `"SYSTEM"`.
- Manifest carries a new `tasks` array (`TaskSummary[]`): tasks where
  `owner == role` AND `status ∈ {Ready, InProgress, Blocked, Review}`.
  Each summary keeps just `id`, `title`, `status`, `priority`, and
  `blockedBy` (the subset of `dependsOn` that is not yet `Done`).
  Full task records are fetched on demand via `gojaja task show <id>`.
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
- `gojaja init` now seeds an empty `state/task_board.yaml` alongside
  `VERSION` and `config.yaml`.

## [2.0.0-alpha.3] — 2026-05-27

### Added (PR4 — manifest self-anchoring)

- `Manifest.roleReminder`: a compact identity block embedded in every
  `gojaja plan` output. Carries `id`, `title`, optional `owns`,
  `mustNotEdit`, `reportsTo`, plus a 95-char `protocol` one-liner.
  Empty fields are intentionally omitted to keep agent prompts tight
  (a fully populated reminder serialises to under 300 bytes).
- `PROTOCOL_ONE_LINER` constant in `src/core/types.ts` — the single
  source of truth for the protocol string the reminder embeds.
- Test coverage: reminder presence, content from `config.yaml`,
  empty-field omission, and serialised-size budget.

### Rationale

A context-compressed agent that has lost its role contract can now
recover its identity by running `gojaja plan` once. The reminder
trades ~250 bytes per manifest for an order-of-magnitude reduction
in "agent forgot which role it is" failure modes.

## [2.0.0-alpha.2] — 2026-05-27

### Added (PR3 — role / prompt / wait)

- `gojaja role create <id> [<title>] [--description] [--owns]
  [--reports-to] [--must-not-edit]` provisions a role end-to-end: it
  registers `<id>` in `.gojaja/config.yaml` AND writes the human
  contract under `.gojaja/roles/<id>.md`. Refuses duplicates.
- `gojaja role list` and `gojaja role show <id>`.
- `gojaja prompt <role> --target codex|claude|cursor|generic`
  prints an activation prompt. With `--write`, it also installs the
  host-specific persistent artifact:
  - `codex`: `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/`
    SKILL.md + agents/openai.yaml.
  - `claude`: a marker-block `<!-- gojaja-runtime:BEGIN..END -->`
    inside `<project>/CLAUDE.md`, preserving surrounding content.
  - `cursor`: `<project>/.cursor/rules/gojaja-runtime.mdc` with
    `alwaysApply: true`.
  - `generic`: prints only.
  The persistent artifacts are role-agnostic (they teach the agent how
  to find its identity via `GOJAJA_SESSION`); a per-window activation
  snippet binds the role.
- `gojaja wait [--idle <min>] [--mode block|exit]` provides the
  cheap-keepalive primitive. `block` does a shell-level sleep, then
  one cursor-free check, exits 0 with `ATTENTION` or `IDLE`. `exit`
  writes a `.wait` sentinel and returns immediately. Never overloads
  exit codes; never mutates the cursor (closes v0.1 wait bugs).
- New Store methods: `createRole`, `readRoleFile`, `readConfig`,
  `writeConfig`, `writeWaitSentinel`.
- New on-disk artifact: `.gojaja/config.yaml` (created by
  `gojaja init`). See [docs/SCHEMA.md → config.yaml](./docs/SCHEMA.md#configyaml).
- New on-disk artifact: `.gojaja/comms/pending/<role>/.wait`
  sentinel (written by `gojaja wait --mode exit`).
- New dependency: `js-yaml` (plus `@types/js-yaml`) for config.yaml
  round-tripping.
- New `src/cli/prompts/` module: `core.ts` (shared body) + per-target
  wrappers (`codex.ts`, `claude.ts`, `cursor.ts`, `generic.ts`) + a
  small write engine that handles atomic replace and marker-block
  upsert with refuse-to-clobber-unrelated-files protection.
- 25 additional vitest cases (`tests/role.test.ts`,
  `tests/prompt.test.ts`, `tests/wait.test.ts`); 64/64 total.

### Changed

- `gojaja init` now also seeds `.gojaja/config.yaml` with the
  current schemaVersion and an empty `roles` map.
- `gojaja help` reorganised around the three real audiences: things
  the user runs once (init / role / prompt), things the user runs once
  per window (claim / release), and things the agent runs on every turn
  (plan / ack / report / worklog / wait).
- ROADMAP re-sequenced. PR4 is now "manifest self-anchoring", PR5 is
  task board, PR6 is RFC, PR7 is ownership enforcement, PR8 is
  installer, PR9 is doctor/history/archival, PR10 is chaos/soak.

## [2.0.0-alpha.1] — 2026-05-27

### Added (PR2 — claim / plan / ack / report / worklog)

- `gojaja claim <role> [--ttl <s>] [--force]` leases a role for the
  current shell and prints the session id.
- `gojaja release [<role>]` ends the current session.
- `gojaja plan [<role>]` produces a JSON `Manifest` of unread events
  scoped to the role, persists it under
  `comms/pending/<role>/<ack-token>.json`, and stamps
  `cursor.pendingManifest`. Idempotent: calling twice in a row returns
  the same manifest with the same `ackToken`.
- `gojaja ack [<role>] --token <t>` advances the cursor exactly to
  the manifest's `advanceCursorTo`. Token mismatch is rejected;
  events that arrived between `plan` and `ack` are preserved unread.
- `gojaja report --to <role> --message <text> [--ref <id>]`
  publishes a REPORT event. `from` is derived from `GOJAJA_SESSION`; the
  agent cannot impersonate another role.
- `gojaja worklog --message <text>` broadcasts a WORKLOG event and
  also writes `worklog/<role>/<id>.md` for git-readable history.
- `GOJAJA_SESSION` environment variable carries identity between commands;
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

- TypeScript-based `gojaja` CLI replacing the v0.1 bash prototype.
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
- CLI commands: `gojaja --version`, `gojaja help`, `gojaja init`,
  `gojaja version`. All commands support `--json`.
- Stable error class → exit code map (see [DESIGN](./docs/DESIGN.md#errors-and-exit-codes)).
- Documentation set: `docs/DESIGN.md`, `docs/SCHEMA.md`,
  `docs/PROTOCOL.md`, `docs/ROADMAP.md`, this changelog.
- Vitest test harness with 19 cases covering concurrent appends, cursor
  monotonicity, stale-lock takeover, session lifecycle, and path/role-id
  validation.

### Removed

- The entire v0.1 bash prototype: `templates/multi-agent/` (scripts,
  protocol markdown, role files, RFC templates), `skills/`, the
  `.gojaja → templates/multi-agent` symlink, and the
  `bin/multi-agent.js` installer.
- The AGENTS.md "multi-agent-bridge" block (replaced by repo-level dev
  notes; the new bridge is reintroduced as part of PR6's installer).

### Notes

- This release is an alpha. The wire protocol between CLI and agent is
  still in flux; do not depend on it from production tooling.
- v0.1 is not supported. No migration path is provided. Anyone who used
  v0.1 should start fresh with `gojaja init`.

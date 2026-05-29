# Protocol

Cross-references: [DESIGN](./DESIGN.md) — why the protocol is shaped this
way. [SCHEMA](./SCHEMA.md) — files referenced here.
[HANDBOOK](./HANDBOOK.md) — when (policy) to use each tool documented
below. [RFC](./RFC.md) — narrative walkthrough of the RFC lifecycle
with a worked example (this doc is the wire spec; that doc shows the
flow).

This document is the contract between an LLM agent window and the
coordination layer. The wire-level invariants here are what `gojaja`
enforces; anything not enforced here is convention only.

## Identities

There are three identity domains:

- **Role id** — long-lived, human-meaningful (`PM`, `TL`, `Backend`).
  Stable across sessions.
- **Session id** — issued by `claim`; valid only while the lease is held.
  All authenticated commands carry the session id via the `GOJAJA_SESSION`
  environment variable.
- **Ack token** — issued by `plan`; valid until the next `plan` for that
  role or until consumed by `ack`.

An agent window asserts a role identity by holding a fresh session id
for that role.

## Project lifecycle

`gojaja init` writes `.gojaja/` into a project. `gojaja reset`
removes everything this tool installed there (and optionally the
user-level Codex skill).

### `gojaja reset [--dry-run] [--confirm <basename>] [--purge-codex-skill]`

- Without `--confirm`, prints a preview and exits without deleting.
  The preview lists every path that would be touched and tells the
  user the exact confirm token (`path.basename(projectRoot)`).
- `--dry-run` forces preview mode even when `--confirm` is present.
- `--confirm <basename>` actually deletes when the token matches the
  project root's basename. Mismatch raises `UsageError` (exit 2).
- Removes, when present:
  - `<project>/.gojaja/` (recursive — events, state, RFCs,
    worklogs, sessions, locks; everything this tool wrote).
  - `<project>/.cursor/rules/gojaja-runtime.mdc` (plus empty
    `.cursor/rules/` and `.cursor/` after, so the project tree is
    not left with empty parent directories belonging to us).
  - The `<!-- gojaja-runtime:BEGIN ... :END -->` block in
    `<project>/CLAUDE.md`. Surrounding user content is preserved;
    `CLAUDE.md` is deleted entirely only if the marker block was its
    only content.
- `--purge-codex-skill` additionally removes
  `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/`. Off by
  default because that skill is user-level and shared across every
  project the user works on; deleting it from one project's reset
  would break other projects.
- **Refuses when `GOJAJA_SESSION` is set.** Destructive ops are for the
  user, not an agent — same posture as `role delete`. Open a fresh
  shell or `unset GOJAJA_SESSION` first.

The event stream and audit log live entirely under `.gojaja/`,
so `reset` is also the canonical "delete the audit trail" operation.
If you need an archive, `cp -r .gojaja .gojaja.bak` (or git
commit it) before running reset; we do not auto-backup.

## Role lifecycle

```
gojaja claim <role>           → SessionInfo (sessionId, leaseTtlSeconds)
[ export GOJAJA_SESSION=<sessionId> ]

loop:
  gojaja plan                 → Manifest JSON (events, ackToken, ...)
                                   stamps cursor.pendingManifest=<token>
  ... agent processes manifest events ...
  gojaja ack --token <token>  → cursor advances exactly to
                                  manifest.advanceCursorTo

  (optional, between turns) gojaja wait [--until <iso> | --in <dur>]
                                          [--for <condition>]
                                          [--poll-interval <dur>]

gojaja release                → clears the session
```

`claim`, `release`, `plan`, `ack`, `report`, `worklog`, and `wait` are
all implemented.

## Claim

`gojaja claim <role> [--ttl <seconds>] [--eval] [--force]`

- Refuses if an existing session for `<role>` has a heartbeat younger
  than its `leaseTtlSeconds`. The agent should report this as a
  configuration error, not retry blindly. The error message
  deliberately does NOT mention `--force`; reflexively forcing
  takeover would silently kill a peer window doing real work.
- If the existing session has missed its lease (heartbeat older than
  `leaseTtlSeconds`) the new claim takes over automatically — no
  `--force` needed.
- `--eval` outputs a single shell line: `export GOJAJA_SESSION=<ulid>`.
  Intended use: `eval "$(gojaja claim PM --eval)"` to claim and
  export in one step.
- With `--force`, takes over any existing session and emits a
  `SESSION_TAKEOVER` event. Use only when the previous window is known
  dead.
- Returns JSON (with `--json`): `{ "status": "claimed", "session": {
  "role", "sessionId", "pid", "host", "startedAt", "heartbeatAt",
  "leaseTtlSeconds" } }`. With `--eval` it instead prints the single
  `export GOJAJA_SESSION=<ulid>` line and no JSON.

The agent **must** export `GOJAJA_SESSION` for the rest of its shell turn so
subsequent commands can verify identity.

On hosts that do not persist environment variables across separate
shell invocations (each tool call gets a fresh shell), the `export`
from `claim` is lost and every later command fails with "GOJAJA_SESSION
is required". Two ways out: run the whole loop inside one persistent
shell, or pass the id explicitly with the global `--session <id>` flag
on every command (`gojaja plan --session <id>`, etc.). An explicit
`--session` flag overrides any inherited `GOJAJA_SESSION`.

## Plan / process / ack

This is the only correct loop to consume work. It is designed so that
no event observed by `plan` can be silently skipped by `ack`.

### `gojaja plan [<role>]`

- Resolves the role: from `GOJAJA_SESSION` if set, or from the optional
  positional argument (the two must agree if both are present).
- Reads the current cursor and computes a `Manifest`:
  - events with `id > cursor.ackedThrough`, projected through the
    per-role manifest filter (see "Manifest event projection" below),
  - a compact `roleReminder` re-anchoring identity (id, title, owns,
    mustNotEdit, reportsTo, one-line protocol; empty fields omitted),
  - active tasks owned by the role,
  - open RFCs that need the role's comment or decision.
- Writes the manifest to `comms/pending/<role>/<ack-token>.json`.
- Updates the cursor with `pendingManifest = <ack-token>` (the cursor's
  `ackedThrough` is **not** moved).
- Prints the manifest to stdout (as JSON when `--json`).

#### Manifest event projection

The global event stream (`comms/events/*.json`) records every event,
broadcast or directed, for audit and future `gojaja doctor`. The
**per-role manifest** is a projection of that stream, designed to keep
each agent's per-turn attention small. Two filters apply in order:

1. **Basic visibility.** `from !== role` (no self-echo);
   `to === role` (directed) OR `to === "*"` (broadcast).
2. **Per-type business filter** (broadcast events only):

   | Event type | Surfaced to |
   | --- | --- |
   | `WORKLOG` | every role (manual team-status channel) |
   | `RFC_DECIDED` | every role (decisions are team-wide knowledge) |
   | `RFC_CREATED`, `RFC_COMMENT`, `RFC_OPTION_ADDED`, `RFC_REVISION_REQUESTED`, `RFC_REVISED` | the RFC's `voters ∪ deciders ∪ {createdBy}` |
   | `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED` | RFC participants OR the linked task's stakeholders |
   | `TASK_CREATED` | roles that own `state/task_board.yaml` (triage set) |
   | `TASK_STATUS_CHANGED`, `TASK_DELIVERABLE_BYPASSED` | task stakeholders (owner, parent owner, dependants) |
   | `SESSION_CLAIMED`, `SESSION_RELEASED`, `SESSION_TAKEOVER`, `LOCK_BROKEN`, `ROLE_DELETED`, `RFC_REPAIRED` | nobody — operational events; surfaced only via `gojaja doctor` and the event stream itself |
   | `REPORT`, `TASK_ASSIGNED` | always directed; the basic filter already handles them |

   Forward-compat: future event types we have not yet classified are
   surfaced rather than silently dropped.

Two important guarantees:

- **`advanceCursorTo` is computed from the unfiltered safe-events
  list**, not the post-filter manifest. So an event excluded by the
  per-type rule does NOT re-appear on the next `plan`; it is durably
  recorded as "seen" once the manifest is ack'd, even if nothing in
  the manifest referred to it. The event remains in `comms/events/`
  forever for audit.
- **`gojaja wait --for attention` uses the same projection.** A
  role's wait only wakes on events that its manifest would actually
  carry. Without this guarantee `wait` would fire on broadcast events
  the agent would then discover its manifest hid — guaranteed wasted
  turn.

When you need the full event history (audit / debugging), read
`comms/events/*.json` directly or use `gojaja history --role <role>`
(planned in PR9).

The `roleReminder` is intentionally tiny — a fully populated reminder
serialises to under 300 bytes. It exists so that a context-compressed
agent can recover its full operating identity by running `plan` once;
it does not duplicate the full role contract or protocol docs.

`manifest.tasks` is the role's active task list: tasks where
`owner == role` and `status ∈ {Ready, InProgress, Blocked, Review}`.
Each entry is a `TaskSummary` (`id`, `title`, `status`, `priority`,
`blockedBy`). Backlog and Done are intentionally excluded — the
former is product/PM space, the latter is history. Call
`gojaja task show <id>` for full details (acceptance criteria,
timestamps).

If a previous manifest is outstanding (`pendingManifest != null`), `plan`
returns the existing manifest verbatim and does not generate a new one.
This makes the operation idempotent across crash-and-retry.

### `gojaja ack [<role>] --token <ack-token>`

- Same role resolution as `plan`.
- Validates `<ack-token> == cursor.pendingManifest`. Mismatch → `UsageError`,
  exit 2. The agent must `plan` again to get the current token.
- Advances `cursor.ackedThrough = manifest.advanceCursorTo`.
- Clears `cursor.pendingManifest`.
- Deletes the manifest file.

Cursor advancement is bounded by the manifest, not by "current latest".
Any event with `id > manifest.advanceCursorTo` is still unread after
ack — see the regression test
`tests/plan-ack.test.ts → "does NOT skip events that arrived after plan"`.

### What the agent must do between plan and ack

- Read every item in the manifest. Items the agent ignores are still
  acked — they will not appear in the next `plan`.
- All writes to framework state must go through `gojaja` subcommands.
  Direct file edits bypass ownership checks (exit 9 from `gojaja`
  means the caller lacks the configured permission) and are not
  reflected in the event stream.

## Sending

### `gojaja report --to <role> --message <text> [--ref <id>]`

- `from` is derived from `GOJAJA_SESSION` (i.e. the session's role); the agent
  cannot pass an arbitrary `--from`.
- Writes one event record into `comms/events/`. Recipients see it via
  their next `plan`, which filters the global event stream by `to`.
- Refuses an empty message or an unknown recipient role.
- Returns the created event (full record when `--json`).

### `gojaja worklog --message <text>`

- Broadcast event (`to = "*"`).
- Also creates a `worklog/<role>/<ulid>.md` file with the body, for
  git-readable browsing by humans.
- Designed to be small and frequent; reserve large narratives for
  reports or RFC comments.

## Ownership-gated writes

`config.yaml:roles[<role>].owns` is the runtime authorization gate for
state-mutating commands. Two rules:

1. A path appears in the actor's `owns` list — exact match OR directory
   prefix (entries ending in `/` cover the subtree). Matched ⇒ allowed.
2. If the path also appears in `mustNotEdit`, the write is refused
   regardless of `owns`. Defence in depth.

Commands gated:

- `gojaja task new` / `gojaja task assign` — require the actor to
  own `state/task_board.yaml`. SYSTEM bypasses (so a human running the
  CLI outside any session can still bootstrap the board).
- `gojaja task status <task-id> <status>` — same gate, but a **task
  owner exception** also applies: a role may always move its OWN task's
  status. This lets engineering roles update progress without
  blanket task-board write access.
- `gojaja state edit --file <state/path>` — generic state editor
  gated by `owns`; `--file` must live under `state/`. See the
  `state edit` section below for the full mode specification.

`ForbiddenError` exits 9 (distinct from `UsageError`'s exit 2 so a
caller can distinguish "you said it wrong" from "you are not allowed").

### `gojaja state edit --file <state/path> [mode flags]`

Mode flags (mutually exclusive — pick exactly one; default is overwrite):

```
# overwrite (default): replace the whole file
gojaja state edit --file state/foo.md --content '<text>'
gojaja state edit --file state/foo.md            # content from stdin

# append: add to the end of the file
gojaja state edit --file state/foo.md --append '<text>'

# replace: literal-string find and replace
gojaja state edit --file state/foo.md --replace '<old>' --with '<new>'
gojaja state edit --file state/foo.md --replace '<old>' --with '<new>' --batch
```

Common rules:

- `--file` must be a relative path under `state/`. Path-traversal
  refused via the standard `resolveInside` check.
- Identity: agents authenticate via `GOJAJA_SESSION` as usual; humans
  running the CLI without a session write as `"SYSTEM"` and bypass the
  ownership gate.
- All three modes are atomic (write tmp + rename), so a reader is
  never exposed to partial content.
- Ownership/`mustNotEdit`/path canonical-form gates apply equally to
  every mode.

Mode-specific rules:

- **overwrite** replaces the entire file with the supplied content.
  Use only when you genuinely intend to rewrite from scratch.
- **append** concatenates `--append <text>` onto the existing file.
  Absent files are treated as empty. No automatic newline prefix —
  the caller decides whether to include one in the value.
- **replace** does a literal-string find-and-replace (no regex).
  - 0 matches in the file → USAGE.
  - 1 match → succeeds; `replacedOccurrences: 1`.
  - N>1 matches without `--batch` → USAGE with hint to either expand
    the snippet or pass `--batch`.
  - N>1 matches with `--batch` → all replaced; `replacedOccurrences: N`.
  - `--with ""` is allowed (deletes the matched text).

Mutual exclusion is enforced by the CLI; passing more than one of
`--content`/`--append`/`--replace` produces a USAGE error.

Human output names the mode (`Wrote / Appended / Replaced N
occurrences`); JSON output carries the `mode` field and, for replace,
`replacedOccurrences`.

## Task board

Tasks are the unit of "what should this role be working on right now".
The full schema is documented in
[SCHEMA -> task_board.yaml](./SCHEMA.md#statetask_boardyaml).

### `gojaja task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3] [--depends-on T-NNNN,...] [--acceptance <text>] [--parent T-NNNN] [--tag <label> ...] [--reviewer <role> ...] [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]`

- The store assigns the next `T-NNNN` id atomically (under a
  `task-board` lock); ids are never reused even if a task is deleted.
- Emits `TASK_CREATED` (broadcast). If `--owner` is given, also emits
  `TASK_ASSIGNED` (directed at the new owner).
- `from` for the events is the actor's role (from `GOJAJA_SESSION`) when
  available, otherwise `"SYSTEM"` (so a human one-off invocation still
  produces audit events). The same actor is recorded as the task's
  `creator`; `assignTask` does NOT update this field.
- `--parent` attaches the new task as a subtask. Parent must exist on
  the board; the chain is cycle-checked at read time and refused if
  it would exceed depth 5. Parent status is NOT auto-derived from
  children; epic owners read aggregated counts via
  `manifest.tasks[].childCounts`.
- `--tag` is repeatable; each value lands in `task.tags`. Used for
  filtered listing via `task list --tag <label>`.
- `--reviewer` is repeatable; each value lands in `task.reviewers`.
  Reviewers are the roles authorised to mark this task `Done`
  regardless of ownership AND they become automatic stakeholders for
  the task — `TASK_STATUS_CHANGED` events surface in their manifest
  without the owner needing to send an explicit report. Duplicates
  are deduped at create time; each reviewer must be a registered
  role (USAGE if not).
- `--asset` / `--deliverable` accept `kind:ref` or
  `kind:ref::description`. `::` is the separator so URLs survive
  intact. Kinds:
    - asset       — `file` (repo-relative path, validated for `..`
                    escape and refused if inside `.gojaja/`)
                    or `url` (opaque external string).
    - deliverable — same `file` / `url` kinds plus `manual` (free-text
                    requirement). `kind: "file"` deliverables are
                    GATED at `task status Done`; see below.

### `gojaja task assign <task-id> --to <role>`

- Sets `task.owner` and emits `TASK_ASSIGNED` with `previousOwner` and
  `newOwner`.
- No-op (no event) when the owner already matches.
- Does NOT change `task.creator` — that field records the original
  creator. Reassignment is auditable via the event stream alone.

### `gojaja task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done> [--force-incomplete]`

- Sets `task.status` and emits `TASK_STATUS_CHANGED`.
- v2 does not enforce status transitions; any role with write access
  may move any task between any two statuses. A constrained state
  machine is on the roadmap if it proves necessary.
- **Who is allowed to call this.** Authority is split between Done
  (sign-off) and other statuses:
    - Done: SYSTEM OR actor in `task.reviewers` OR (actor === owner
      AND actor === creator) OR actor owns `state/task_board.yaml`.
    - Other transitions: SYSTEM OR actor === owner (owner-exception)
      OR actor in `task.reviewers` (reviewer-exception, so reviewers
      can push back to InProgress without an extra report-then-revert
      hop) OR actor owns `state/task_board.yaml`.
    - A non-permitted actor for Done gets a clear `FORBIDDEN` error
      listing the configured reviewers (or recommending escalation
      if none are configured).
- On Done transitions, every `kind: "file"` deliverable on the task
  must point at an existing file in the project tree. Missing files
  refuse the transition with USAGE listing every absent ref.
- `--force-incomplete` bypasses the deliverable gate. The bypass is
  NOT silent: a `TASK_DELIVERABLE_BYPASSED` event is emitted with
  the missing refs and the actor BEFORE the `TASK_STATUS_CHANGED`
  event, so the durable audit log shows "approval given, then status
  moved". Note `--force-incomplete` does NOT bypass the permission
  gate; it only bypasses the deliverable check.

### `gojaja task list [--owner <role>] [--status <s>] [--tag <label> ...]` and `gojaja task show <id>`

- Read-only. Useful for humans browsing the project. The agent's
  per-turn view of its tasks is `manifest.tasks`; explicit list/show
  are for ad-hoc inspection.
- `--tag` filters with OR semantics; a task matches if any tag
  matches any value.
- `task show` renders parent, immediate children, assets, deliverables
  with on-disk markers (`[x]` / `[ ]` / `[?]`), plus the `creator`
  and `reviewers` fields when present.

## RFCs

The goal is "every relevant role records an opinion; a designated leader
picks; the decision is durable". There is no automatic tally.

The RFC mechanism is multi-round: comments are threaded
(`replyTo`), options can be added mid-discussion, deciders can run a
pre-decide ACK round, and deciders can send a proposal back for
rewrite (`revise` + `edit`) without rejecting the topic.

State machine (open / pre-decide / revising / accepted / rejected /
superseded), worked example, and rationale live in
[docs/RFC.md](./RFC.md). Full on-disk schema:
[SCHEMA -> rfcs/](./SCHEMA.md#rfcsrfc-nnnn-slug).

### `gojaja rfc new <slug> --title <text> --deciders <r1,...> [--options <A:summary,B:summary>] [--description <text>] [--voters <r1,...>] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]`

- Slug must match `^[a-z0-9][a-z0-9-]{0,63}$`; reuse across RFCs is refused.
- The store assigns the next sequential `RFC-NNNN` id under a `rfcs` lock
  (`rfcCounter` lives in `config.yaml`, so deleting an RFC dir does not
  recycle its id).
- `--options` is **optional**. Omitting it opens the RFC in
  **brainstorm mode** — voters comment freely, no concrete choices on
  the table. Anyone (typically a voter or the decider) can later run
  `rfc add-option` to introduce a pickable choice; that upgrades the
  RFC into a decision flow. `rfc decide` refuses `--option` on a
  brainstorm-mode RFC and requires it once options exist.
- `--description` is soft-required (warns if empty; will become
  hard-required in a future release). It is the channel where the
  creator gives non-participants enough context to weigh in.
- `--task` links one or more existing task ids; each is validated
  against `state/task_board.yaml` and refused if not found.
- Emits `RFC_CREATED` (broadcast).
- The actor (`GOJAJA_SESSION` role, or `"SYSTEM"` if no session) is recorded
  as the event's `from` and the proposal's `createdBy`.
- **The creator is automatically and unconditionally added to
  `voters`** (deduped against `--voters` so a caller that lists
  themselves explicitly does not double-list). Opening an RFC asserts
  interest in its outcome — the creator both sees manifest events for
  it AND is required to ack/object on a pre-decision (the ACK gate is
  computed over `voters ∪ deciders` by definition). SYSTEM-created
  RFCs (no `GOJAJA_SESSION`) do NOT auto-include SYSTEM, since SYSTEM
  is not a role and cannot ack/object. There is no opt-out: if you
  genuinely intend to be a relay, run the command from the role that
  should be on record, not as a side-channel for someone else.

### `gojaja rfc comment <rfc-id> --rationale <text> [--option <opt>] [--reply-to <comment-id>]`

- Posts a regular discussion comment (no `kind` field).
- The role comes from `GOJAJA_SESSION`; the framework does not allow
  ghost-commenting on behalf of another role.
- Non-voters may comment — they often add cross-cutting context that the
  named voters miss.
- Refuses on closed RFCs (`accepted` / `rejected` / `superseded`) and
  on unknown `--option`.
- `--reply-to` must reference an existing comment id in the same RFC;
  threading is enforced.
- **Append-only ledger.** Multiple comments per role are preserved in
  `comments.yaml`. The commenter's read cursor for this RFC is
  automatically advanced to the just-written comment.
- A regular `rfc comment` from a required-ACK role does NOT advance
  the `decideRfc` ACK gate. To register a position, use `rfc ack` /
  `rfc object` (which post `kind: ack` / `kind: object` comments).
  Discussion comments are welcome but do not count as consensus
  signals.
- Emits `RFC_COMMENT` (broadcast). Payload includes
  `kind: undefined` for regular comments; `kind: "pre-decision" |
  "ack" | "object"` for the structured commands documented below.

### `gojaja rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>`

- Any session can add. Allowed in `open` or `revising`. Refused in
  terminal states (`accepted`, `rejected`, `superseded`).
- Option id must be unique within the RFC.
- If there is an active pre-decision, add-option silently invalidates
  it (voters were ACKing an outdated option set). The decider can
  re-issue `rfc pre-decide` on the new option set. The
  `RFC_OPTION_ADDED` event is the audit signal.
- Emits `RFC_OPTION_ADDED`.

### `gojaja rfc pre-decide <rfc-id> --option <opt> --rationale <text>`

- Decider gate (FORBIDDEN otherwise). Valid only from `open`.
- Posts a structured comment with `kind: "pre-decision"`; does NOT
  change RFC status. The `decideRfc` ACK gate is what makes
  pre-decide load-bearing.
- Required-ACK set: `(voters ∪ deciders) − {pre-decider}`.
- Surface in `manifest.rfcs[*].pendingPreDecision` with
  `awaitingAckFrom` and per-role `myAckOwed`.
- Re-issuing pre-decide invalidates all prior `ack` / `object`
  responses — every required role must respond again.
- Emits `RFC_COMMENT` with `payload.kind = "pre-decision"`.

### `gojaja rfc ack <rfc-id> [--rationale <text>]`

- Caller must be in `(voters ∪ deciders) − {pre-decider}`. Pre-decider
  cannot ack their own pre-decision.
- Refused if there is no active pre-decision (USAGE).
- Posts a `kind: "ack"` comment; advances the ACK gate.
- Rationale optional ("yes" is meaningful).
- Emits `RFC_COMMENT` with `payload.kind = "ack"`.

### `gojaja rfc object <rfc-id> --rationale <text> [--option <preferred-opt>]`

- Same caller-set + active-required gates as `ack`.
- Rationale required. `--option` optional; when set, must be an
  existing option id.
- Posts a `kind: "object"` comment; counts as a structured response
  (advances the ACK gate too).
- Emits `RFC_COMMENT` with `payload.kind = "object"`.

### `gojaja rfc decide <rfc-id> [--option <opt>] --rationale <text>`

- Deciders gate. Valid from `open`.
- **`--option` is conditional.** When `proposal.options.length > 0`,
  `--option` is required and must reference an existing option id.
  When `proposal.options.length === 0` (brainstorm-mode RFC),
  `--option` must **not** be passed and the decision records
  `chosenOption: null` — the rationale carries the takeaway.
- **ACK gate**: if there is an active pre-decision (latest
  `kind: "pre-decision"` comment, not invalidated by a later
  add-option), every role in `(voters ∪ deciders) − {pre-decider}`
  must have posted `ack` or `object`. Outstanding roles → USAGE with
  the full list and the recovery path (ack/object, or `rfc reject`).
  (Brainstorm-mode RFCs cannot have a pre-decision, since pre-decide
  refuses when options is empty; the ACK gate is therefore a no-op
  for them.)
- Refuses on unknown `--option`.
- Status -> `accepted`; writes `decision.json`; emits `RFC_DECIDED`
  with `outcome="accepted"`.

### `gojaja rfc reject <rfc-id> --rationale <text>`

- Deciders gate. Valid from `open` / `revising`.
- **Bypasses the ACK gate by design** — this is the only escape from
  a stalled pre-decision (required role unreachable).
- Status -> `rejected`; writes `decision.json` with `outcome="rejected"`
  and `chosenOption=null`; emits `RFC_DECIDED`.

### `gojaja rfc revise <rfc-id> --rationale <text>`

- Deciders gate. Valid from `open`.
- Status -> `revising`; emits `RFC_REVISION_REQUESTED` carrying the
  rationale (which is the "what to fix" message to the creator).
- Comments are preserved untouched.

### `gojaja rfc edit <rfc-id> --rationale <text> [--title <text>] [--description <text>] [--options A:summary,B:summary] [--deadline <iso>]`

- Allowed only in `revising`. Actor must be the original `createdBy`
  OR a role in `deciders`. Other voters cannot rewrite.
- At least one of `--title` / `--description` / `--options` /
  `--deadline` must be provided.
- Status -> `open`; clears `preDecision`; emits `RFC_REVISED`
  including which fields changed.
- Comments preserved untouched.

### `gojaja rfc link-task <rfc-id> --task T-NNNN`

- Any session. Refused in terminal states.
- Task id must exist on the board (USAGE otherwise).
- Idempotent: linking an already-linked task is a no-op.
- Emits `RFC_TASK_LINKED`.

### `gojaja rfc unlink-task <rfc-id> --task T-NNNN`

- Counterpart to `link-task`. Idempotent.
- Emits `RFC_TASK_UNLINKED`.

### `gojaja rfc list [--status open|pre-decide|revising|accepted|rejected|superseded]` and `gojaja rfc show <rfc-id> [--no-mark-seen]`

- Read-only.
- `rfc show` side effect: advances this role's per-RFC read
  cursor to the latest comment, so a subsequent `plan` reports
  `unreadComments: 0` for this RFC until new discussion arrives.
  Pass `--no-mark-seen` (e.g. from a script) to inspect without
  moving the cursor.

## Wait / idle keepalive

An agent window that has nothing to do should stay alive — discussions,
reviews, blocker messages may arrive from other agents — but should not
consume tokens while idle. `wait` is the cheap-keepalive primitive.

`wait` is a single deadline-driven, chunked, resumable primitive. A
session record lives at `comms/pending/<role>/wait.json`
(see [SCHEMA](./SCHEMA.md)).

### `gojaja wait [<role>] [--until <iso> | --in <dur>] [--for <condition>] [--poll-interval <dur>] [--json]`

Role resolution follows the same rules as `plan` (GOJAJA_SESSION first;
explicit role argument must agree).

**Deadline (pick one; default `--in 10m`):**

- `--until 2026-05-28T15:00:00Z` — absolute ISO instant. Must carry
  `Z` or an explicit offset; bare local times are refused.
- `--in 30s | 10m | 4h | 1d` — relative duration. Same parser as
  `--poll-interval`.

`--until` and `--in` are mutually exclusive.

**Condition (`--for <token>`; default `attention`):**

| Token | Fires when |
| --- | --- |
| `attention` | any event with `to ∈ {role, "*"} && from !== role` |
| `rfc-decided:RFC-NNNN` | `RFC_DECIDED` with that ref |
| `rfc-acked:RFC-NNNN` | `RFC_COMMENT` on that RFC with `payload.kind ∈ {ack, object}` |
| `task-assigned` | `TASK_ASSIGNED` with the role as the new owner |
| `report-from:<role>` | `REPORT` from that role addressed to self |
| `event-ref:<id>` | any event whose `ref === id` |

`task-assigned` additionally auto-broadcasts an idle worklog the first
time wait writes its session record. The broadcast is one-shot per
session (RESUME re-invocations do not re-broadcast) and goes to `*`,
so any role with task-board ownership can pick the role up.

**Chunked polling.** Each invocation does at most one sleep of
`min(deadline - now, --poll-interval)` (default 30 s). After the sleep
it checks events and exits with one of four verdicts:

```
ATTENTION       role=<r> newEvents=<n> deadline=<iso>
                Next: gojaja plan

CONDITION_MET   condition=<token> role=<r>
                Next: gojaja plan

RESUME          deadline=<iso> chunkSleptMs=<ms>
                Next: gojaja wait --until <iso> [--for <token>]

TIMEOUT         role=<r> deadline=<iso>
                Next: end the turn cleanly, or take initiative.
```

RESUME is the only non-terminal outcome. It tells the agent to re-invoke
wait with the same deadline; the verdict line literally echoes the
command. This is how a long wait survives a host shell timeout: each
chunk is one process, the next process resumes from disk.

Exit code is `0` for all four verdicts. Use `--json` to get
`{ status: "attention" | "condition_met" | "resume" | "timeout", ... }`
when machine-parsing.

Two cardinal rules:

- **No exit-code overloading.** Exit 0 in every normal outcome.
  Non-zero is for genuine usage errors (e.g. unknown role, ISO
  without an offset).
- **No cursor mutation.** `wait` is a pure read; only `plan` + `ack`
  may move the cursor.

**Refused while a manifest is pending.** If `cursor.pendingManifest`
is non-null, wait refuses with USAGE and points at the outstanding
ack token. Otherwise every event in the pending manifest would
re-trigger ATTENTION, looping the agent.

**User-cancel is a host concern.** If the user wants to interrupt a
chunked wait early, they end the chat / kill the shell themselves;
the framework does not provide a separate cancel verb.

## Activation in different agent hosts

`gojaja prompt --target <host> [--write]` produces a prompt body and,
when `--write` is given, drops a persistent artifact into the host's
own configuration area. The artifact is **role-agnostic** (it takes no
role argument): it tells the agent how to find its identity via
`GOJAJA_SESSION` and `gojaja plan`. Per-window role binding is done
separately by `gojaja activate <role> --target <host>`, which prints a
short snippet to paste into that window's chat.

| Target | Persistent artifact location | Activation per window |
| --- | --- | --- |
| `codex` | `${CODEX_HOME:-~/.codex}/skills/gojaja-runtime/SKILL.md` and `agents/openai.yaml` | User pastes `Use $gojaja-runtime. I am the <role> agent for <project root>.` |
| `claude` | A `<!-- gojaja-runtime:BEGIN ... :END -->` marker block inside `<project>/CLAUDE.md` (preserves user content around it) | User pastes the activation snippet into the chat |
| `cursor` | `<project>/.cursor/rules/gojaja-runtime.mdc` with `alwaysApply: true` | User pastes the activation snippet into the chat |
| `generic` | Nothing written | User pastes the full prompt body into the chat |

Writing is idempotent: re-running `prompt --write` overwrites a prior
artifact in place; byte-equal re-runs report `UNCHANGED (already up to
date)` and touch no files. Pass `--force-rewrite` to overwrite even
when bytes match (useful after a CLI upgrade, to confirm the install
came from the current template). The CLI refuses to clobber an
existing file that does not look like a previous artifact (heuristic:
must contain the `gojaja plan` marker phrase).

**Window-restart caveat.** Cursor, Claude Code, and Codex inject these
rule files into the agent's system prompt only when an agent window
first opens. Running `prompt --write` AFTER opening an agent window
leaves the freshly installed rule with no effect in that window — the
user must close and re-open the window. The CLI prints an IMPORTANT
notice on every successful write, and JSON output carries
`requiresWindowRestart: true` for scripted installers.

### Runtime body gate

The installed artifact begins with an explicit gate:

> The protocol governs your behaviour **only when this window has been
> bound to a role**, which is true if and only if `GOJAJA_SESSION` is
> exported in the shell, or the user has explicitly told you in chat
> that you are playing the `<role>` for this project. Otherwise,
> ignore the protocol and respond normally — do not speculatively run
> `gojaja plan`, `claim`, or any other `gojaja` command.

This is necessary because the rule file applies to every agent window
in the project (including windows the user opens for unrelated work);
without the gate, an unactivated window would reflexively start
claiming roles on the user's behalf.

## Role lifecycle (deletion)

`gojaja role delete <id>`

- Removes the role from `config.yaml`, deletes the `roles/<id>.md`
  human contract, and unlinks the live session file under
  `comms/sessions/<id>.json`.
- Emits a `ROLE_DELETED` system event with payload
  `{ roleId, removedSessions }`.
- Does **not** touch `state/task_board.yaml`. Open task assignments
  with `owner = <deleted id>` are left as orphans on purpose:
  recreating a role with the same id reinherits them, which is usually
  what the user wants when "deleting" was actually "renaming". To
  reassign instead, the user runs
  `gojaja task assign <task-id> --to <other-role>`.
- Restricted to `SYSTEM`. The CLI refuses to run when `GOJAJA_SESSION` is
  exported in the calling shell — role deletion is a project-governance
  act, not something an agent should do on its own.
- After deletion, any agent window that still has the deleted role's
  `GOJAJA_SESSION` exported will fail with `USAGE` ("session not found")
  on its next authenticated command. The user must `unset GOJAJA_SESSION`
  or claim a new role in that window.

## Reporting format

`report` and `worklog` are free-form by design. We deliberately avoid
imposing rigid sections at this layer; the role contract markdown is the
right place to enforce a project's reporting template. The runtime layer
guarantees only delivery, ordering, and durability.

## Termination

A role's window can end its turn cleanly only when:

1. No outstanding `pendingManifest` exists for the role (i.e. the last
   `plan` was acked).
2. `wait` returned `timeout` or the user has terminated the loop.
3. Optionally, `gojaja release <role>` was called. If not called, the
   session lease will expire naturally; the next `claim` will take over.

Crash-on-mid-turn is recoverable: the next window for the role takes the
session over after the lease, finds the `pendingManifest` in the cursor,
and can re-issue `plan` to retrieve the same manifest deterministically.

## Forbidden agent actions

The framework cannot prevent these at the OS level today, but they are
out-of-contract and will be flagged by future `gojaja doctor`:

- Writing into another role's `worklog/<other>/` directory.
- Editing `comms/events/<id>.json` (events are immutable).
- Editing `comms/cursors/<other>.json`.
- Hand-rolling new entries in any `comms/` directory without going
  through `gojaja`. Even when the file shape is trivially writable,
  doing so bypasses event emission, ownership, and audit.

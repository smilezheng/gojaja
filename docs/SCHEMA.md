# On-Disk Schema (v2.0.0)

Cross-references: [DESIGN](./DESIGN.md) — architecture rationale.
[PROTOCOL](./PROTOCOL.md) — how agents use these files.

This document is the source of truth for what `.multi-agent/` looks like.
The on-disk version is recorded in the top-level `VERSION` file. Any
breaking change to a path, file name, or JSON shape requires bumping
`SCHEMA_VERSION` in `src/cli/runtime.ts` together with this document.

**Reads are unrestricted, writes are mediated.** Anything under
`.multi-agent/` can be read directly by any process — the layer is a
shared blackboard, and the agent host already has a file-read tool.
There is therefore no `agentctl read-state` command (it would only
add token cost). Writes go through `agentctl` (or `Store`) so that
ownership, atomicity, and the event-stream audit can be enforced.

## Top-level layout

```
.multi-agent/
  VERSION                              ← schema version, plain text
  config.yaml                          ← project config (roles, ownership, RFC counter)
  audit.log                            ← JSONL audit trail (planned)

  protocol/                            ← human-authored protocol docs
  roles/<role>.md                      ← role contract, one file per role
  state/                               ← shared writable state (atomic)
    project_state.md
    architecture.md
    task_board.yaml
    decisions.md
    risks.yaml
  rfcs/RFC-NNNN-<slug>/                ← one directory per RFC
    proposal.yaml                       ← carries status, description, relatedTasks, preDecision (PR8g)
    comments.yaml                       ← PR8g: append-only threaded ledger (replaces comments/<role>.json)
    decision.json                       ← present once a decider has acted
  worklog/<role>/<ulid>.md             ← one entry file per worklog entry
  comms/
    events/<ulid>.json                  ← immutable event stream
    cursors/<role>.json                 ← per-role event-stream consumer cursor
    cursors/<role>/rfc-<rfc-id>.json    ← PR8g per-role-per-RFC read marker for unreadComments
    pending/<role>/<ack-token>.json     ← outstanding manifests
    sessions/<role>.json                ← role lease metadata
    heartbeats/<role>.json              ← (planned) external watcher input
  locks/<key>.lock                     ← short-lived file lock records
```

What `LocalFsStore.initialise` creates today: every directory listed
above, plus `VERSION`, a seeded `config.yaml` with an empty `roles` map,
a seeded `state/task_board.yaml` with `nextId: 0`, and a TBD skeleton
at `state/project_state.md` (PR8f-B). The other state files
(`architecture.md`, `decisions.md`, `risks.yaml`) are listed here as
the conventional locations the project will populate over time; they
are not created up front.

> **`state/project_state.md` is auto-created as a TBD skeleton.** The
> skeleton has three sections (Vision, Milestones, Acceptance criteria),
> each containing a `TBD` placeholder. The product-owner role
> (whoever owns this file per `config.yaml`) is expected to fill them
> in. The handbook tells agents to ask the user to fill any section
> that is still marked TBD before judging a task Done.
> Re-running `agentctl init` on a project that already has the
> skeleton (or a user-edited version of it) is refused via
> `AlreadyInitializedError`; user edits are never clobbered.

## `VERSION`

Plain text, no trailing whitespace beyond a single newline.

```
2.0.0
```

Read with `agentctl version`. The CLI refuses to run against a layer
whose schema is newer than its own (planned check).

## `config.yaml`

The machine-readable project configuration. Source of truth for role
identity, ownership, and reporting structure. Markdown files under
`roles/<id>.md` are for humans and never used as a programmatic source.

```yaml
schemaVersion: 2.0.0
roles:
  PM:
    title: Product Manager
    description: Owns product scope and acceptance.
    owns:
      - state/project_state.md
      - state/task_board.yaml
    reportsTo: []
    mustNotEdit:
      - state/architecture.md
```

Field rules:

- `schemaVersion` must match the on-disk `VERSION` file.
- `roles` is `Record<RoleId, RoleConfig>`.
- `RoleConfig.owns` is **enforced at write time**. Each entry matches
  either an exact relative path (`state/project_state.md`) or a
  directory prefix (`docs/architecture/` or `docs/architecture`, with
  or without a trailing slash — `target.startsWith(entry + "/")` is
  the implementation). A whole subtree can be assigned in one entry.
- `RoleConfig.mustNotEdit` is **also enforced** with the same
  prefix semantics and takes precedence over `owns`: a path that
  appears in `mustNotEdit` is refused even if it also appears in
  `owns`. Use it to carve specific files out of a broad ownership
  grant (e.g. `--owns "src/" --must-not-edit "src/config/secrets.ts"`).
- `reportsTo` is **advisory** (not machine-enforced). It names the
  roles up the escalation chain; the collaboration handbook tells
  agents to escalate stuck work via `report` along this list.

Created and mutated only through `agentctl role create` (and future
`agentctl role edit`). Hand edits are allowed but rare; the markdown
contract in `roles/<id>.md` points the human at this file.

## `state/task_board.yaml`

The structured task list. Each task is a record keyed by its id. Auto-id
allocation uses the top-level `nextId` counter (the file's
`tasks` map is not enough on its own — deleting a task must not allow
its id to be reused).

```yaml
schemaVersion: 2.0.0-task-v2
nextId: 2
tasks:
  T-0001:
    id: T-0001
    title: Implement /login API
    status: Ready          # Backlog | Ready | InProgress | Blocked | Review | Done
    owner: Backend
    priority: P1
    dependsOn: []
    acceptance: |
      - POST /login returns JWT
      - rate-limited to 10/min
    createdAt: 2026-05-27T05:23:00.000Z
    updatedAt: 2026-05-27T05:23:00.000Z
    # PR8j fields (defaults when omitted; readTaskBoard backfills them)
    parent: null                    # parent task id, or null
    assignedBy: PM                  # who created/assigned originally
    assets:                         # info-only references; not gated
      - kind: url
        ref: https://figma.com/file/xxx
        description: Final design
    deliverables:                   # hard outputs; file-kind gated on Done
      - kind: file
        ref: apps/backend/auth/login.ts
        description: Implementation
      - kind: file
        ref: docs/api/login.md
        description: API spec
      - kind: manual
        ref: ""
        description: Demo recorded in shared drive
    tags: [q3, auth]
  T-0002:
    id: T-0002
    title: Implement signup
    status: Backlog
    owner: Backend
    priority: P2
    dependsOn: [T-0001]
    acceptance: ""
    parent: T-0001                  # subtask of T-0001
    assignedBy: PM
    assets: []
    deliverables: []
    tags: []
    createdAt: ...
    updatedAt: ...
```

Field rules:

- `id` is `T-NNNN` (zero-padded, minimum 4 digits). Assigned by the
  store; do not hand-pick.
- `status` is the union above; v2 does not enforce transitions (any
  status may move to any status). PR8j adds ONE invariant: moving to
  `Done` with a missing file-kind deliverable is refused unless
  `--force-incomplete` is passed; see PROTOCOL.md.
- `owner` is a role id or `null`. The role does not have to exist in
  `config.yaml` yet, but it must pass role-id validation.
- `dependsOn` is an array of other task ids. Cycle detection is not
  done in v2.
- `parent` (PR8j) is another task id or `null`. The task graph is
  cycle-checked at read time; chains deeper than 5 are refused. Parent
  status is NOT automatically derived from children.
- `assignedBy` (PR8j) is the role that originally created the task.
  `assignTask` does NOT update this field — the event stream carries
  reassignment history.
- `assets` (PR8j) are reference pointers the owner needs to read. Each
  entry is `{ kind: "file" | "url", ref, description }`. File refs are
  validated for path-traversal at create time but the file is not
  required to exist (it may be produced by a peer task).
- `deliverables` (PR8j) are required outputs. `kind: "file"` refs are
  existence-checked on the `Done` transition. `kind: "url"` and
  `kind: "manual"` are displayed but not auto-verified.
- `tags` (PR8j) is a free-form list of labels; `agentctl task list
  --tag <label>` filters with OR semantics.
- Hand-edits are allowed for trivial fixes, but normal mutation goes
  through `agentctl task new/assign/status`, which also emits the
  corresponding event.

A `--force-incomplete` Done emits a `TASK_DELIVERABLE_BYPASSED` event
*immediately before* the `TASK_STATUS_CHANGED` event, so the audit
ordering "approval given -> status moved" is unambiguous.

## `comms/events/<ulid>.json`

Immutable event record. The file name is the event id; it is always a
[ULID](https://github.com/ulid/spec). The file body is the event with
`id` matching the file name.

```jsonc
{
  "id": "01HX7T0Z6K7Z4S9W3GQ7M2C2KD",
  "ts": "2026-05-27T05:23:00.123Z",
  "type": "REPORT",
  "from": "PM",
  "to": "TL",
  "ref": "T-0001",
  "payload": { "message": "Goals locked in" }
}
```

Fields:

- `id` (string, ULID): canonical event id, equal to the file name stem.
- `ts` (string, ISO-8601 UTC): wall-clock time of `appendEvent`.
- `type` (string, enum, see below): event type.
- `from` (string): role id or the literal `"SYSTEM"`.
- `to` (string): role id, or `"*"` for broadcast.
- `ref` (string, optional): cross-reference (RFC id, task id, lock key).
- `payload` (object): type-specific structured data.

Event types currently emitted:

| Type                  | Emitted by                       | Notes                                          |
| --------------------- | -------------------------------- | ---------------------------------------------- |
| `REPORT`              | `agentctl report`                | Directed message; `to` = recipient role.       |
| `WORKLOG`             | `agentctl worklog`               | Broadcast (`to = "*"`).                        |
| `TASK_CREATED`        | `agentctl task new`              | Broadcast; `ref` = task id.                    |
| `TASK_ASSIGNED`       | `agentctl task new` / `assign`   | `to` = new owner; `ref` = task id.             |
| `TASK_STATUS_CHANGED` | `agentctl task status`           | Broadcast; `ref` = task id.                    |
| `TASK_DELIVERABLE_BYPASSED` | `agentctl task status ... Done --force-incomplete` | Broadcast; `ref` = task id; `payload.missing` lists the file refs that were not on disk; `payload.by` records the actor who approved the bypass. Always emitted before the corresponding `TASK_STATUS_CHANGED`. |
| `RFC_CREATED`         | `agentctl rfc new`               | Broadcast; `ref` = RFC id.                     |
| `RFC_COMMENT`         | `agentctl rfc comment` / `ack` / `object` / `pre-decide` | Broadcast; `ref` = RFC id. PR8g.1: `payload.kind` distinguishes regular discussion (undefined) from structured `"pre-decision"` / `"ack"` / `"object"` posts. |
| `RFC_DECIDED`         | `agentctl rfc decide` / `reject` | Broadcast; `ref` = RFC id; final.              |
| `RFC_REPAIRED`        | `Store.readRfc` self-heal        | Broadcast; `ref` = RFC id. Emitted when a half-written `finaliseRfc` is observed (decision.json exists but proposal.yaml still `open`) and the proposal status is forward-completed from the decision. |
| `RFC_OPTION_ADDED`    | `agentctl rfc add-option`        | Broadcast; `ref` = RFC id; payload carries new option id + summary + rationale (PR8g). Also implicitly invalidates any pending pre-decision via the read-time computation. |
| `RFC_REVISION_REQUESTED` | `agentctl rfc revise`         | Broadcast; `ref` = RFC id. Status flips to `revising`; rationale tells the creator what to fix (PR8g). |
| `RFC_REVISED`         | `agentctl rfc edit`              | Broadcast; `ref` = RFC id. Status flips back to `open`; payload lists which fields changed (PR8g). |
| `RFC_TASK_LINKED` / `RFC_TASK_UNLINKED` | `agentctl rfc link-task` / `unlink-task` | Broadcast; `ref` = RFC id; payload carries task id (PR8g). |
| `SESSION_CLAIMED`     | `Store.claimSession`             | First-time claim.                              |
| `SESSION_TAKEOVER`    | `Store.claimSession` (stale)     | After lease / PID-based break.                 |
| `SESSION_RELEASED`    | `Store.releaseSession`           | Voluntary release.                             |
| `LOCK_BROKEN`         | `Store.withLock` (stale)         | `ref` = lock key.                              |
| `SYSTEM`              | misc system actions              | Reserved for free-form internal events.        |

Records are append-only at the directory level. There is no in-place
modification; corrections are expressed as later events.

## Two layers: event stream vs per-role manifest (PR8n)

The directory `comms/events/` is the **single durable event log**. It
records every event, broadcast or directed, forever (subject to PR9
archival). External tools (`agentctl history`, `agentctl doctor`,
git-blame-style audit) read directly from this directory.

What lands in a role's per-turn `manifest.events` is a **projection**
of that stream, filtered by the visibility rules below. The projection
keeps the LLM turn small and the agent focused on what actually
demands their attention. Two layers, one source of truth.

### Manifest visibility rules

Applied in order to each event in `comms/events/` newer than the
role's `ackedThrough`:

1. **Basic.** `from !== role` (no self-echo);
   `to === role` (directed) OR `to === "*"` (broadcast).
2. **Per-type business filter** (broadcast events only):

   | Event type | Surfaced to |
   | --- | --- |
   | `WORKLOG` | every role |
   | `RFC_DECIDED` | every role |
   | `RFC_CREATED`, `RFC_COMMENT`, `RFC_OPTION_ADDED`, `RFC_REVISION_REQUESTED`, `RFC_REVISED` | `voters ∪ deciders ∪ {createdBy}` of that RFC |
   | `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED` | RFC participants OR linked task's stakeholders |
   | `TASK_CREATED` | roles owning `state/task_board.yaml` (the triage set) |
   | `TASK_STATUS_CHANGED`, `TASK_DELIVERABLE_BYPASSED` | task stakeholders (owner, parent owner, dependants) |
   | `SESSION_*`, `LOCK_BROKEN`, `RFC_REPAIRED`, `ROLE_DELETED` | nobody — operational, surfaced only via the event stream + `agentctl doctor` |
   | `REPORT`, `TASK_ASSIGNED` | always directed; handled by rule 1 |

**Cursor advance is computed against the pre-filter list.** An event
excluded by rule 2 still counts toward `advanceCursorTo`, so it does
NOT re-surface on the next `plan` — the manifest fairly admits "we
saw this event but decided you don't need to react".

The same projection is used by `agentctl wait --for attention`, so
wait fires only on events the manifest would carry.

## Inbox is a derived view, not files

A role's "inbox" is the subset of the event stream produced by the
projection above. `plan` performs the projection on the fly; there
are no separate `comms/inbox/<role>/` files in v2.0.

Rationale: events are already globally visible (the audit stream is not
ACL'd), so a per-role inbox file would be pure duplication with its own
consistency-window. Filtering at read time keeps the write path single,
crash-safe, and free of dual-write races.

If a future version introduces ACLs on event visibility, this decision
will be revisited; today's filter rule is the contract.

## `comms/cursors/<role>.json`

```jsonc
{
  "role": "PM",
  "ackedThrough": "01HX7T0Z6K7Z4S9W3GQ7M2C2KD",
  "pendingManifest": null,
  "updatedAt": "2026-05-27T05:23:00.456Z"
}
```

- `ackedThrough`: ULID of the last event the role has acknowledged.
  Empty string before the role has ever acked.
- `pendingManifest`: ULID of an outstanding `plan` manifest awaiting
  `ack`, or `null` if no plan is outstanding. Set by `plan`, cleared by
  the corresponding `ack`.
- `updatedAt`: stamped by the store on every write.

Invariants:

- `ackedThrough` is monotonically non-decreasing. The store rejects any
  mutator that returns a smaller value.
- `pendingManifest`, when non-null, must exist as a file under
  `comms/pending/<role>/<token>.json`.

## `comms/pending/<role>/<ack-token>.json`

The output of `agentctl plan <role>`, archived so `ack` can validate the
token and advance the cursor deterministically.

```jsonc
{
  "ackToken": "01HX...",
  "role": "PM",
  "generatedAt": "2026-05-27T05:23:00Z",
  "fromCursor": "01HX...PREVCURSOR",  // empty string before first ack
  "advanceCursorTo": "01HX...EVTLATEST",
  "events": [ /* Event records, oldest first, filtered for this role */ ],
  "roleReminder": {
    "id": "PM",
    "title": "Product Manager",
    "owns": ["state/project_state.md"],          // omitted if empty
    "mustNotEdit": ["state/architecture.md"],    // omitted if empty
    "reportsTo": ["TL"],                          // omitted if empty
    "protocol": "Loop: plan -> ack --token <t> -> wait. All writes via agentctl; never hand-edit .multi-agent/."
  }
}
```

Invariants:

- The file name stem equals `ackToken`.
- The cursor's `pendingManifest` equals `ackToken` while the manifest is
  outstanding.
- A manifest file is removed after a successful `ack` with its token.
- `advanceCursorTo` reflects the latest event id in the global stream at
  plan time. It may be greater than the largest id in `events` because
  the filter excludes events the role sent itself.
- `roleReminder` re-anchors the role's identity on every plan, so a
  context-compressed agent only needs to re-run `agentctl plan` to
  recover. Fields read from `config.yaml`; empty lists are intentionally
  omitted to keep the manifest tight.

The manifest also carries a `tasks` array: a list of `TaskSummary`
records filtered to those where `owner == role` and
`status ∈ {Ready, InProgress, Blocked, Review}`. Each summary carries
only `id`, `title`, `status`, `priority`, and `blockedBy` (the subset
of `dependsOn` that is not yet Done). The full task record is fetched
on demand via `agentctl task show <id>`.

Likewise, `rfcs` carries `RfcSummary` entries for **open** RFCs that
need this role's action:

- `role: "voter"` when the role is in the proposal's `voters` list AND
  has not yet commented (commented voters fall out of the action list).
- `role: "decider"` when the role is in `deciders`, until the RFC is
  closed (decided or rejected).

Each summary keeps just `id`, `title`, `status`, `role`, and
`commented` (a boolean). Full proposal + comments + decision are fetched
via `agentctl rfc show <id>`.

## `comms/sessions/<role>.json`

```jsonc
{
  "role": "PM",
  "sessionId": "01HX7TQ4MZ...",
  "pid": 41327,
  "host": "imac.local",
  "startedAt": "2026-05-27T05:20:00Z",
  "heartbeatAt": "2026-05-27T05:23:00Z",
  "leaseTtlSeconds": 1800
}
```

- `sessionId`: ULID issued by `claimSession`. The session id is
  authoritative; `pid` and `host` are diagnostic.
- A claim with `force` against a live session is refused.
- A claim against a stale session (heartbeat older than `leaseTtlSeconds`)
  succeeds and emits `SESSION_TAKEOVER`.
- `release` requires the holder's `sessionId`; a mismatched call is
  refused.

## `comms/pending/<role>/wait.json`

PR8i session record for `agentctl wait`. Written atomically on the
first chunk of a fresh wait session; kept across RESUME re-invocations;
cleared on terminal exits (ATTENTION / CONDITION_MET / TIMEOUT).
Replaces the pre-PR8i `.wait` sentinel.

```jsonc
{
  "role": "Backend",
  "deadline": "2026-05-28T15:00:00Z",
  "for": { "kind": "task-assigned" },
  "startedAt": "2026-05-28T14:00:00Z",
  "ackedThroughAtStart": "01HZ...",
  "idleBroadcastSent": true
}
```

- `for.kind` is one of `attention`, `rfc-decided`, `rfc-acked`,
  `task-assigned`, `report-from`, `event-ref`. The `ref` sub-field
  carries an RFC id / role id / event ref where applicable.
- `idleBroadcastSent` is true only after the framework has emitted the
  "I am idle" worklog for a `--for task-assigned` wait. The flag exists
  to make that broadcast one-shot across chunked invocations.

Correctness does not depend on this file: the deadline is also on the
agent's command line. Losing the file at worst causes one duplicate
idle worklog. External observers (e.g. `agentctl doctor`, planned for
PR9) read it to list "who is waiting on what and until when".

## `comms/heartbeats/<role>.json` (planned)

Created when external watchers care about role liveness for purposes
other than session takeover. v2.0.0 does not write this file yet.

## `locks/<key>.lock`

Short-lived. Holds the JSON record of the current owner. Field shape
exists only in code (`src/core/file-lock.ts:LockRecord`); we deliberately
do not document it for external consumption because nothing besides
`Store.withLock` should ever touch these files.

When a lock is broken, the framework atomically renames the existing
file to `locks/<key>.lock.dead-<break-token>` for forensic capture and
deletes it after asserting the break. A `LOCK_BROKEN` event is recorded
in the event stream.

## `worklog/<role>/<ulid>.md`

One markdown file per worklog entry. Created via `agentctl worklog`.
Body format is human-prose; no enforced sections yet.

## `roles/<role>.md`

Human-readable role contract. Created by `agentctl role create`; the
generated template lives in
[`src/core/role-template.ts`](../src/core/role-template.ts) and has
these sections: title, role id, Role (description), Responsibilities,
Scope and reporting, Startup checklist. Machine-readable scope
(`owns` / `reportsTo` / `mustNotEdit`) is intentionally NOT duplicated
here — it lives only in `config.yaml`, to avoid drift between two
sources of truth. This file is for humans and agents to read; the
framework does not parse it at runtime.

## `rfcs/RFC-NNNN-<slug>/`

```
rfcs/RFC-0001-switch-to-postgres/
  proposal.yaml      ← structured; source of truth
  comments/<role>.json
  decision.json      ← absent until the leader decides or rejects
```

`proposal.yaml` (PR8g.1 shape):

```yaml
id: RFC-0001
slug: switch-to-postgres
title: Switch primary store to Postgres
status: open                              # open | revising | accepted | rejected | superseded
voters: [PM, TL, Backend, DevOps]         # advisory: who SHOULD comment
deciders: [TL]                            # enforced: who CAN pre-decide / decide / reject / revise
options:
  - id: A
    summary: Use Postgres
  - id: B
    summary: Stay on SQLite
deadline: 2026-06-01T00:00:00.000Z        # informational (framework does NOT auto-expire)
createdAt: 2026-05-27T05:23:00.000Z
createdBy: PM
description: |
  Free-form context. Soft-required in PR8g.1 (warn-on-empty); will be
  hard-required in PR8h. This is the text non-participants read to
  weigh in; deciders are expected to `rfc revise` if it is too thin.
relatedTasks: [T-0042]                    # linked task ids; validated against task_board.yaml
```

> PR8g had a `preDecision: {...}` field and `status: pre-decide`.
> PR8g.1 removed both — pre-decisions are stored as
> `kind: "pre-decision"` comments in `comments.yaml` and the ACK gate
> on `decideRfc` enforces consensus computationally. `readRfc`
> refuses any proposal.yaml that still carries the PR8g shapes.

Status state machine (PR8g.1, enforced):

```
                  ┌─ rfc revise ─────────────────────────────────────┐
                  │                                                   ▼
   open ──comment / ack / object / add-option / pre-decide (comment) ──▶ open
       │                                                                  ▲
       │                                                                  │
       └─rfc decide (ACK gate)──▶ accepted (terminal)                 revising
       └─rfc reject (bypass gate)──▶ rejected (terminal)                  │
                                                       ◀── rfc edit ─────┘
```

- `accepted` / `rejected` / `superseded` are terminal in v2.
- `superseded` is reserved (no command produces it in v2; document
  supersession in the new RFC's rationale).
- Auto-tally is **not** implemented and is a design non-goal; deciders
  pick.
- Decider scope is **per-RFC**, set at `rfc new` time via `--deciders`.
  There is no role-level "default decider" field on `RoleConfig`; a
  role becomes a decider only by being named in a specific RFC's
  `deciders` list. A role-level decision-scope field is a PR8h
  candidate.

`comments.yaml` (PR8g.1, append-only threaded ledger with structured kinds):

```yaml
- id: 01HZA000000000000000COMM1   # ULID, globally unique; reply-to target
  rfcId: RFC-0001
  role: Backend
  ts: 2026-05-28T05:02:00.000Z
  preferred: A                     # option id; may be empty for "no preference"
  replyTo: null                    # null = reply to the RFC root
  rationale: "Migration is tractable; sharding plan ready."
  # no kind = regular discussion comment

- id: 01HZA000000000000000COMM2
  rfcId: RFC-0001
  role: TL
  ts: 2026-05-28T05:30:00.000Z
  preferred: A
  replyTo: null
  rationale: "Lean A; speak up if not."
  kind: pre-decision                # PR8g.1: structured pre-decision comment

- id: 01HZA000000000000000COMM3
  rfcId: RFC-0001
  role: PM
  ts: 2026-05-28T05:42:00.000Z
  preferred: B
  replyTo: 01HZA000000000000000COMM2
  rationale: "Prefer B; M2 slip is hard to justify."
  kind: object                      # PR8g.1: structured objection comment

- id: 01HZA000000000000000COMM4
  rfcId: RFC-0001
  role: DevOps
  ts: 2026-05-28T05:50:00.000Z
  preferred: A                      # ack: locked to the pre-decision's chosenOption
  replyTo: null
  rationale: ""                     # ack rationale optional
  kind: ack                         # PR8g.1: structured acknowledgement comment
```

Multiple comments per role are preserved (ULIDs ensure order). Normal
mutation goes through `agentctl rfc comment` (regular), `rfc
pre-decide` (kind=pre-decision; decider only), `rfc ack` (kind=ack),
`rfc object` (kind=object), all of which append to the ledger and
emit `RFC_COMMENT` with `payload.kind`. Comments on closed RFCs
(`accepted` / `rejected` / `superseded`) are refused.

**PR8g.1 ACK gate (`decideRfc`)**: when an active pre-decision exists
(latest `kind: "pre-decision"` comment with no later `RFC_OPTION_ADDED`
event), every role in `(voters ∪ deciders) − {pre-decider}` must have
a `kind: "ack"` or `kind: "object"` comment with `ts > pre-decision.ts`
before `rfc decide` will succeed. Silence never counts as consent.
There is no override; the only escape is `rfc reject` + open a fresh
RFC without the unreachable role.

> **Migration note (PR8g).** Projects that used the pre-PR8g
> `comments/<role>.json` layout are detected on read and refused with a
> clear `code: USAGE` error pointing the user at this section. Alpha-
> stage hard cut, no auto-migrator.

`comms/cursors/<role>/rfc-<rfc-id>.json` (PR8g, per-role-per-RFC read
marker):

```jsonc
{
  "lastSeenCommentId": "01HZA000000000000000COMM2"
}
```

Set by `agentctl rfc show <id>` (advances to latest comment id) and by
`agentctl rfc comment <id>` (advances to the just-written comment).
`null` means "this role has not opened this RFC yet" → all comments
count as unread. Surfaces in `manifest.rfcs[*].unreadComments`.

`decision.json` (unchanged shape):

```jsonc
{
  "rfcId": "RFC-0001",
  "decidedBy": "TL",
  "ts": "...",
  "outcome": "accepted",        // "accepted" | "rejected"
  "chosenOption": "A",          // null when outcome=rejected
  "rationale": "..."
}
```

Field rules:

- `slug` must match `^[a-z0-9][a-z0-9-]{0,63}$`. Slug reuse across RFCs is
  refused.
- `options` requires at least one entry, with unique ids. Options
  can be **added after creation** via `rfc add-option` (PR8g) while
  the RFC is `open` or `revising`.
- `deciders` requires at least one role. `agentctl rfc pre-decide /
  decide / reject / revise` refuse callers outside that list.
- `description` is soft-required (PR8g warning); will be hard-required
  in PR8h.
- `relatedTasks` entries are validated against `state/task_board.yaml`
  at write time (both at `rfc new` and at `rfc link-task`).
- The sequential id counter lives in `config.yaml` under `rfcCounter`
  (so deleting an RFC dir does NOT recycle its id).

## `audit.log` (planned)

JSONL of every state-mutating `agentctl` invocation, with the resulting
event ids and any `LOCK_BROKEN` / `SESSION_TAKEOVER` side effects. Tooled
by `agentctl doctor` (planned).

## Schema versioning rules

1. Adding new optional fields → not a breaking change.
2. Adding new event types → not a breaking change; clients should ignore
   unknown types.
3. Renaming a field, changing field type, or removing a field → breaking;
   bump `SCHEMA_VERSION` major.
4. Adding required fields → breaking.
5. Renaming a directory → breaking.

A breaking change in published code must ship with a migration in
`src/migrations/<from>-<to>.ts` and is run by `agentctl upgrade`. v2.0.0
ships with an empty migrations directory because there is no predecessor.

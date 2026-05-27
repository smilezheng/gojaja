# On-Disk Schema (v2.0.0)

Cross-references: [DESIGN](./DESIGN.md) — architecture rationale.
[PROTOCOL](./PROTOCOL.md) — how agents use these files.

This document is the source of truth for what `.multi-agent/` looks like.
The on-disk version is recorded in the top-level `VERSION` file. Any
breaking change to a path, file name, or JSON shape requires bumping
`SCHEMA_VERSION` in `src/cli/runtime.ts` together with this document.

## Top-level layout

```
.multi-agent/
  VERSION                              ← schema version, plain text
  config.yaml                          ← project config (planned, not yet emitted)
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
    proposal.yaml
    proposal.md                         ← rendered view
    comments/<role>.json
    decision.json
    decision.md                         ← rendered view
  worklog/<role>/<ulid>.md             ← one entry file per worklog entry
  comms/
    events/<ulid>.json                  ← immutable event stream
    cursors/<role>.json                ← per-role consumer cursor
    pending/<role>/<ack-token>.json    ← outstanding manifests
    sessions/<role>.json               ← role lease metadata
    heartbeats/<role>.json             ← (planned) external watcher input
  locks/<key>.lock                     ← short-lived file lock records
```

What `LocalFsStore.initialise` creates today is a strict subset of the
above: every directory above, plus the `VERSION` file. Empty files
(`task_board.yaml` etc.) appear when the relevant feature lands.

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
- `RoleConfig.owns` is **enforced at write time** as of PR7. Entries
  match an exact relative path OR a directory prefix (entries ending
  with `/` cover the entire subtree).
- `RoleConfig.mustNotEdit` is also enforced: a path that appears in
  this list is refused even if it ALSO appears in `owns`. Defence in
  depth.
- `reportsTo` is advisory; not enforced.

Created and mutated only through `agentctl role create` (and future
`agentctl role edit`). Hand edits are allowed but rare; the markdown
contract in `roles/<id>.md` points the human at this file.

## `state/task_board.yaml`

The structured task list. Each task is a record keyed by its id. Auto-id
allocation uses the top-level `nextId` counter (the file's
`tasks` map is not enough on its own — deleting a task must not allow
its id to be reused).

```yaml
schemaVersion: 2.0.0
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
  T-0002:
    id: T-0002
    title: Implement signup
    status: Backlog
    owner: Backend
    priority: P2
    dependsOn: [T-0001]
    acceptance: ""
    createdAt: ...
    updatedAt: ...
```

Field rules:

- `id` is `T-NNNN` (zero-padded, minimum 4 digits). Assigned by the
  store; do not hand-pick.
- `status` is the union above; v2 does not enforce transitions (any
  status may move to any status).
- `owner` is a role id or `null`. The role does not have to exist in
  `config.yaml` yet, but it must pass role-id validation.
- `dependsOn` is an array of other task ids. Cycle detection is not
  done in v2.
- Hand-edits are allowed for trivial fixes, but normal mutation goes
  through `agentctl task new/assign/status`, which also emits the
  corresponding event.

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

| Type                  | Emitted by                          | Notes                                              |
| --------------------- | ----------------------------------- | -------------------------------------------------- |
| `REPORT`              | `agentctl report` (PR2)             | Directed message; also writes an inbox record.     |
| `WORKLOG`             | `agentctl worklog` (PR2)            | Broadcast `to = "*"`.                              |
| `TASK_CREATED`        | `agentctl task new` (PR5)           | Broadcast; `ref` = task id.                        |
| `TASK_ASSIGNED`       | `agentctl task new/assign` (PR5)    | `to` = new owner; `ref` = task id.                 |
| `TASK_STATUS_CHANGED` | `agentctl task status` (PR5)        | Broadcast; `ref` = task id.                        |
| `RFC_CREATED`         | `agentctl rfc new` (PR6)            | `ref` = RFC id.                                    |
| `RFC_COMMENT`         | `agentctl rfc comment` (PR6)        | `ref` = RFC id.                                    |
| `RFC_DECIDED`         | `agentctl rfc decide` (PR6)         | `ref` = RFC id; final.                             |
| `SESSION_CLAIMED`     | `Store.claimSession`                | First-time claim.                                  |
| `SESSION_TAKEOVER`    | `Store.claimSession` (stale)        | After lease/PID-based break.                       |
| `SESSION_RELEASED`    | `Store.releaseSession`              | Voluntary release.                                 |
| `LOCK_BROKEN`         | `Store.withLock` (stale)            | `ref` = lock key.                                  |
| `SYSTEM`              | misc system actions                 | Reserved for free-form internal events.            |

Records are append-only at the directory level. There is no in-place
modification; corrections are expressed as later events.

## Inbox is a derived view, not files

A role's "inbox" is the subset of the event stream where
`to ∈ {role, "*"}` and `from !== role`. `plan` performs that filter
on the fly; there are no separate `comms/inbox/<role>/` files in v2.0.

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
  the corresponding `ack` (PR2).
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

The manifest also carries a `tasks` array (PR5): a list of
`TaskSummary` records filtered to those where `owner == role` and
`status ∈ {Ready, InProgress, Blocked, Review}`. Each summary carries
only `id`, `title`, `status`, `priority`, and `blockedBy` (the subset
of `dependsOn` that is not yet Done). The full task record is fetched
on demand via `agentctl task show <id>`.

Likewise, `rfcs` (PR6) carries `RfcSummary` entries for **open** RFCs
that need this role's action:

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

## `comms/pending/<role>/.wait`

Sentinel written by `agentctl wait --mode exit`. Its presence means
the role's window has voluntarily yielded between turns and is waiting
for an external trigger to resume.

```jsonc
{
  "role": "PM",
  "mode": "exit",
  "writtenAt": "2026-05-27T05:23:00Z"
}
```

The sentinel is informational only; nothing else reads it in v2.0.0.
It exists so external schedulers and `agentctl doctor` (planned) can
distinguish "idle and intentionally yielded" from "crashed" without
ambiguity.

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

One markdown file per worklog entry. Created via `agentctl worklog` (PR2).
Body format is human-prose; no enforced sections yet.

## `roles/<role>.md`

Human-authored role contract. Created by `agentctl role create` (planned).
The file structure follows the v0.1 template (Role / Responsibilities /
Writable Scope / Must Not Edit / Startup Checklist / Reporting). The
framework does **not** parse this file at runtime; it is for the agent to
read. Runtime ownership enforcement comes from `config.yaml`.

## `rfcs/RFC-NNNN-<slug>/`

```
rfcs/RFC-0001-switch-to-postgres/
  proposal.yaml      ← structured; source of truth
  comments/<role>.json
  decision.json      ← absent until the leader decides or rejects
```

`proposal.yaml`:

```yaml
id: RFC-0001
slug: switch-to-postgres
title: Switch primary store to Postgres
status: open                              # open | accepted | rejected | superseded
voters: [PM, TL, Backend, DevOps]         # advisory: who SHOULD comment
deciders: [TL]                            # enforced: who CAN decide / reject
options:
  - id: A
    summary: Use Postgres
  - id: B
    summary: Stay on SQLite
deadline: 2026-06-01T00:00:00.000Z        # informational
createdAt: 2026-05-27T05:23:00.000Z
createdBy: PM
```

Status state machine (enforced):

```
        open ──decide──▶ accepted
         │
         └──reject──▶ rejected
```

Both terminal in v2. `superseded` is reserved for a future v2.x command.
Auto-tally based on comments is **not** implemented and is a design
non-goal — the deciders are responsible for choosing.

`comments/<role>.json`:

```jsonc
{
  "rfcId": "RFC-0001",
  "role": "Backend",
  "ts": "...",
  "preferred": "A",             // option id; may be empty for "no preference"
  "rationale": "Migrations are tractable; sharding plan ready."
}
```

Hand-edits are tolerated; normal mutation goes through
`agentctl rfc comment`, which also emits `RFC_COMMENT`. A second call from
the same role overwrites the file. Comments on closed RFCs are refused.

`decision.json`:

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
- `options` requires at least one entry, with unique ids.
- `deciders` requires at least one role. `agentctl rfc decide/reject`
  refuses callers outside that list.
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

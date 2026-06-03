# Design

Status: living document; reflects the current implementation. Bump
together with code changes.

Cross-references: [SCHEMA](./SCHEMA.md) — on-disk file formats.
[PROTOCOL](./PROTOCOL.md) — agent-facing contract.
[HANDBOOK](./HANDBOOK.md) — policy layer (when to use which tool).
[ROADMAP](./ROADMAP.md) — what is implemented vs deferred.
[RFC-0001](./RFC-0001-central-root.md) — v3 storage split rationale.

## What this layer is for

A coordination substrate for **N LLM-agent windows that each play a role
inside one project** (PM, TL, Backend, Frontend, QA, DevOps, ...). The agents
do not talk to each other directly; they read and write files in the
shared on-disk layer. The framework's job is to make those reads and
writes safe, ordered, recoverable, and auditable so the agents can
behave like a real working team without a server.

Starting in v3 (PR9), the layer is split into a small git-tracked
user tree (`<project>/.gojaja/`: project id, role briefs, ownership
config, project_state) and a per-user / per-machine central tree
(`~/.gojaja/projects/<id>/`: task board, events, sessions, RFCs,
worklog, locks). See [RFC-0001](./RFC-0001-central-root.md) for
the design rationale; [SCHEMA.md](./SCHEMA.md) for the concrete
file map; this doc concentrates on the cross-cutting architecture
(events, ownership, locking, sessions) which is layout-independent.

Concretely the layer provides:

1. A typed event stream that every role can subscribe to via a per-role
   cursor.
2. A per-role inbox view derived from that stream, filtered to messages
   addressed to the role (no separate inbox files; see [the queue
   discussion below](#why-directory-as-queue-not-a-shared-append-log)).
3. Atomic shared state files (project goal, task board, decisions, risks).
4. RFCs for blocking cross-role decisions, with explicit leader sign-off.
5. Session leases so two windows cannot silently claim the same role.
6. A "wait" primitive that keeps an idle role alive without burning LLM
   tokens.

What this layer is **not**:

- It is not an LLM runtime. It does not call models, prompt them, or own
  their context windows.
- It is not a chat transport. Durable state lives only in files; chat
  scrollback is never authoritative.
- It is not multi-machine in v2.0.0. The interfaces are shaped so an HTTP
  transport can be added without changing command code (see
  [ROADMAP](./ROADMAP.md)).

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Agent window (Codex / Claude Code / Cursor / generic)       │
│   prompt: claim role, loop { plan → process → ack }, wait    │
└──────────────────────────┬───────────────────────────────────┘
                           │ shell invocation + JSON stdio
┌──────────────────────────▼───────────────────────────────────┐
│  gojaja  (Node CLI)                                        │
│   parse → validate → command handler                         │
└──────────────────────────┬───────────────────────────────────┘
                           │ method calls
┌──────────────────────────▼───────────────────────────────────┐
│  Store interface  (src/core/store.ts)                        │
│   atomic primitives: events, cursors, sessions, locks        │
└──────────────────────────┬───────────────────────────────────┘
                           │ implementations
            ┌──────────────┴──────────────┐
            │                             │
            ▼                             ▼
   LocalFsStore (v2.0)            HttpStore (planned v2.x)
   • atomic write+rename          • thin REST client
   • file-based per-key lock      • server wraps LocalFsStore
   • ULID-named record files
```

Three rules keep the layers honest:

1. **No `fs.*` in command handlers.** All filesystem access goes through
   the `Store` interface. The day we add an HTTP backend, command code
   stays untouched.
2. **No user/agent input concatenated into paths.** `resolveInside` and the
   role-id / slug whitelists are the only sanctioned ways to build a path.
3. **One file = one record.** Append-only logs are simulated by directories
   of immutable per-record files, not by a shared file with appends.

## Why directory-as-queue, not a shared append log

The v0.1 prototype kept a single `events.log` (tab-separated) and one
markdown inbox per role. Both broke in the same way: any user-provided
string with a tab or a newline corrupted parsing, sometimes irrecoverably.
Concurrent appenders also had to share one global mutex.

v2 stores each record as its own JSON file named by a ULID:

```
comms/events/01HX7T0Z6K7Z4S9W3GQ7M2C2KD.json
comms/events/01HX7T0Z6K9MR8K2N6Q3X1V4XE.json
worklog/PM/01HX7T0Z6KCJ1B0FQ2K5MNT0DA.md
```

Note: there is no separate `comms/inbox/` directory. Role inboxes are
derived views — a role's "unread messages" are simply the events in
`comms/events/` where `to == role || to == "*"` and `from != role`,
filtered by the role's cursor position. `gojaja plan` computes this
filter on demand.

Properties this buys:

- **No append concurrency.** Two processes writing at the same instant
  create two different files. ULIDs include a random tail so collisions
  are astronomically unlikely; `wx` flag on `open(2)` would catch one
  anyway.
- **No escaping.** Records are JSON. Tabs, newlines, quotes, NULs in
  payloads round-trip losslessly.
- **No torn reads.** Files are written via `write tmp + fsync + rename`.
  Readers either see the complete file or `ENOENT`.
- **Cheap incremental reads.** Listing unread events is
  `readdir + filter(id > cursor) + sort`, O(N_total) at worst and O(N_unread)
  with lex-sorted directory entries.
- **Cheap rotation.** Archival is just moving old files to a
  `comms/events/_archive/` subtree; no log re-write.

The trade-off is more inodes. Even at thousands of events per project
that is acceptable; we will add an archiver before it becomes painful.

## Locking model

`Store.withLock(key, fn)` is the only concurrency primitive command code
sees. Lock keys are arbitrary identifiers like `cursor-PM`, `session-TL`,
`state-task_board`. There is **no global lock**.

The implementation in `src/core/file-lock.ts` is a file-based exclusive
lock with three layers of protection:

1. **O_EXCL create.** Atomic; the kernel guarantees only one process
   succeeds. The created file contains the owner's metadata (owner ULID,
   PID, host, acquired-at, lease-expires-at).
2. **Lease.** Every lock has a TTL (default 30 s). After expiry the lock
   is considered abandonable. This is the multi-machine-safe fallback —
   nobody needs to poke PIDs.
3. **PID liveness.** If the lock owner ran on this host, we additionally
   check `process.kill(pid, 0)`. A crashed same-host process releases its
   lock immediately, before the lease expires.

When a lock is broken (lease expired or PID dead), the framework emits a
`LOCK_BROKEN` system event so audits can see what was reclaimed.

Held critical sections are intentionally short — single-digit milliseconds
in normal operation — so lease starvation is a non-issue. There is no
lease-renewal API. The day we need long-held locks we will add one.

## Cursor and the ack-token contract

A naïve `ack` implementation reads "current latest event id" and writes
it to the cursor. That race silently loses any event that arrived between
`sync` and `ack`. v2 closes the race with an explicit manifest:

1. `gojaja plan <role>` snapshots all unread events (filtered to those
   addressed to the role), writes the snapshot to
   `comms/pending/<role>/<ack-token>.json`, stamps the cursor's
   `pendingManifest = ack-token`, and prints the snapshot as JSON for
   the agent to act on.
2. The agent processes the listed items.
3. `gojaja ack <role> --token <ack-token>` validates that the token is
   the cursor's current `pendingManifest`, then advances `ackedThrough` to
   the manifest's `advanceCursorTo` (which was fixed at plan time). Events
   that arrived after `plan` remain unread.

Cursor monotonicity is enforced at the store layer: `updateCursor` rejects
any mutation that moves `ackedThrough` backwards. The combination of
"only-via-token" advancement and "never-backwards" ensures any event
visible to a `plan` is either processed before ack or remains unread; it
cannot be silently skipped.

## Sessions and leases

Two agent windows cannot both claim role `PM`. `claimSession(role, ttl)`
performs the analogous O_EXCL+lease dance on `comms/sessions/<role>.json`:

- A live session (heartbeat within `ttl`) blocks new claims unless `force`.
- A stale session is auto-taken-over; the framework emits `SESSION_TAKEOVER`.
- `release` requires the session id, so a successor cannot accidentally
  release the previous holder's session.

The session id is a ULID returned by `claim`. Follow-up commands in the
same shell read it from `GOJAJA_SESSION`, which ties identity to the
environment rather than to an argument the agent could accidentally omit
or forge. Impersonating a different role requires an explicit `claim` and
is recorded in the event stream.

## Wait / lifecycle

Long-running role agents need to stay alive between bursts of activity
without burning tokens. v0.1 did this by sleeping inside a shell hook,
which was correct in spirit but tangled with cursor advancement and used
exit codes to mean "more work" vs "idle".

v2 cleanly separates:

- **`ack`** — fast, atomic; only touches the cursor.
- **`wait`** — pure keepalive, deadline-driven, resumable.

### Why one blocking primitive instead of block / exit modes

An earlier design exposed a `--mode block | exit` dichotomy: block
slept inside the same shell process; exit dropped a `.wait` sentinel
and returned immediately, deferring resumption to the host. Two modes
existed because Cursor's chat-mode shell kills any long-running tool
call at the host's shell-timeout (seconds), while Codex / Claude /
generic shells can sleep through minutes without complaint. The agent
had to know which mode to use, and the runtime body had to be
target-specific.

The current design is one blocking primitive. A single `wait`
invocation:

1. Resolves a deadline: `--until <ISO>`, `--in <duration>`, or — with
   neither flag — **indefinite** (`deadline: null`; blocks until an
   event/condition or a host kill). With no flag and a session already
   on disk, it instead resumes that session's deadline.
2. **Blocks**, re-checking the event stream every `--poll-interval`
   (default 30 s, an in-process cadence) and sleeping in between, until
   it can return a verdict. The check is the same projection `plan`
   uses (`Store.filterVisibleEventsForRole`): wait wakes on any event
   the role would actually see in its manifest, never anything else,
   never less.
3. Returns ATTENTION (a new event for the role landed) or
   CONDITION_MET (a new event landed AND it satisfies the named
   `--for` predicate); a finite wait also returns TIMEOUT at its
   deadline. An indefinite wait never times out.

**`--for` is not a filter.** It is (a) a verdict tag — when a visible
wake event also satisfies the predicate, the verdict upgrades from
`ATTENTION` to `CONDITION_MET` so the agent can tell "what I was
specifically waiting for arrived" from "something else woke me, now
go plan" — and (b) for `--for task-assigned`, a side-effect that
emits a one-shot idle WORKLOG at session open. Treating `--for` as a
filter would have a designed-in correctness bug: a developer parked
on `--for task-assigned` could miss a CTO-led, all-hands RFC because
the event "didn't match". Both verdicts mean "run plan next"; the
distinction is informational, not a gate.

The key property: **one `wait` is one tool call for the entire wait**,
so a parked agent burns no LLM turns / tokens while idle — that was the
whole point. The earlier shape mistakenly exited after a single
poll-interval ("RESUME") and made the agent re-invoke every interval,
which reintroduced a per-poll LLM turn and defeated the token savings.

`--poll-interval` is therefore *only* a detection-latency knob (how
soon a parked wait notices a new event), not a re-invocation interval.
It is uniform across hosts — no per-host `--poll-interval` tuning.

**Resumption is for host kills only.** If the host harness kills the
long-blocking call (its own tool-timeout), the agent re-runs
`gojaja wait` with no deadline flags; that reads the in-progress
deadline + condition back off `comms/pending/<role>/wait.json` and
continues. The session record also makes the `--for task-assigned`
idle worklog one-shot across such a resume.

**The host kill is a useful signal, not just an interruption.** Its
timing equals the host's per-tool-call timeout, so an agent that counts
its own re-runs can wait as long as possible while keeping idle cost
bounded: e.g. a ~10-min host timeout × a ~5-resume ceiling ≈ 50 min of
waiting on ~5 turns; a ~3-min timeout ≈ 15 min. The CLI does not
enforce this — it is guidance carried in the runtime body + handbook,
because only the agent can see and count its own turns. An agent that
trusts this can drop `--in`/`--until` entirely and just block
indefinitely, letting events (or the host) decide when it wakes.
User-cancel (ending the chat / killing the shell) needs no framework
verb — the next user message redirects the loop anyway.

## Per-role manifest is a projection, not the source of truth

`comms/events/*.json` is the durable event log: append-only, every
event ever produced lives there, audit-friendly, eventually read by
`gojaja history` and `gojaja doctor`. The per-role manifest in
`comms/pending/<role>/<ack-token>.json` is **a projection** of that
log onto the slice an individual role should attend to.

Two layers because of two competing forces:

1. **Audit demands everything is recorded.** Decisions, status moves,
   session lifecycle, lock recoveries — git history reading later
   wants the full story.
2. **LLM turns are expensive.** Every event in a manifest is one LLM
   "should I react?" decision. Broadcasting indiscriminately turns a
   busy project into thousands of per-event LLM calls of noise.

An earlier shape treated the manifest as "everything since my
cursor, filtered only by `from !== self` + `to ∈ {self, '*'}`".
That collapsed both layers into one. In a 6-role project a typical
day produces ~70 broadcast events / role / day; each broadcast
triggers an LLM turn on every other agent. The Frontend agent
reading 50 worklogs about backend work was the predictable failure
mode.

The current design splits them: events are still all broadcast on
disk, but `openOrCreatePlan` runs a per-type filter to decide whether
a broadcast event belongs in this role's manifest. The cursor
advances past hidden events anyway, so a role does NOT re-see them;
it just treats them as "noted, moving on".

The classification is conservative — operational events
(SESSION_*, LOCK_BROKEN, RFC_REPAIRED) hide from everyone; "real
broadcasts" (WORKLOG, RFC_DECIDED) stay broadcast; everything else
goes only to stakeholders (RFC participants, task owners /
parents / dependants, board triagers). Unknown event types are
forward-compatibly surfaced — better to over-deliver than to silently
drop a future event.

`wait --for attention` uses the same projection, so a wait fires only
on events that the manifest would actually carry. Otherwise a
broadcast event would wake the agent into a no-op turn (plan shows
nothing new → end the turn). Same projection in both places keeps the
"wait → plan" invariant clean.

## Task model: hierarchy without auto-state-propagation

A natural multi-layer org wants a task tree: CTO -> PM/TL epic ->
per-worker subtasks. The `parent` field on the Task record makes
that tree expressible on the existing single board. Three design
choices are worth flagging because the obvious alternatives were
rejected:

1. **No auto status propagation.** A parent task's `status` is NOT
   derived from its children. We considered "parent goes Done when all
   children are Done" and rejected it. Reasons: (a) it removes the
   epic owner's decision about whether the epic needs an additional
   polish pass; (b) state-machine coupling between rows tends to
   surface as production-incident debugging fodder later; (c) starting
   independent and later adding propagation is cheaper than starting
   coupled and walking it back. Aggregation lives in `TaskSummary.childCounts`
   instead, which the epic owner reads to decide manually.

2. **No reparenting yet.** `createTask --parent` accepts the field,
   but there is no `task reparent` command. Reparenting introduces
   concurrency on the parent's `childCounts` aggregation that we do
   not need yet. The chain is cycle-checked at read time as a defence
   against hand edits.

3. **Deliverables are gates, not lifecycle states.** We considered
   introducing a `PendingDeliverable` status between `Review` and
   `Done`. Rejected: keeps the status enum tight, lets the gate fire
   from ANY transition into Done (not just Review->Done), and the
   audit log carries the bypass explanation via the
   `TASK_DELIVERABLE_BYPASSED` event without polluting state. The
   one design cost is that the gate is invisible until the user runs
   `task status ... Done` and sees the USAGE refusal; `task show`
   mitigates this by always rendering `[x]` / `[ ]` markers next to
   each file deliverable.

User-cancel of a forced bypass — i.e. "I changed my mind after firing
`--force-incomplete`" — is intentionally not a feature. The audit event
is immutable; rolling back means moving the status back to Review and
producing the file.

## RFC: opinions in, leader decision out

Real engineering teams gather opinions, then a tech lead or PM picks.
v2's RFC model mirrors that:

- `rfc new <slug>` creates a structured proposal with explicit `voters`
  (who should comment) and `deciders` (who can close it).
- `rfc comment <id> --rationale <text> [--option <opt>]` records any
  role's opinion. Non-voters may also comment — the framework does not
  restrict who can leave input.
- `rfc decide <id> --option <id> --rationale <text>` transitions the RFC
  to `accepted`. Only a role in the proposal's `deciders` list may call
  this; everyone else is refused.
- `rfc reject <id> --rationale <text>` transitions to `rejected`, same
  deciders gate.

There is no quorum function, no automatic tally, no implicit acceptance.
This avoids the v0.1 mistake of pretending to have a state machine while
actually leaving final outcomes to free-form markdown.

## Path validation

`src/core/paths.ts:resolveInside` is the only sanctioned way to turn a
relative path into an absolute one. It refuses absolute inputs, refuses
`..` components, and refuses any resolved path outside the layer root.
Role ids match `[A-Za-z][A-Za-z0-9_-]{0,63}` with a reserved-word
blacklist; RFC slugs match the stricter `[a-z0-9][a-z0-9-]{0,63}`. Any
user/agent string used in a path goes through these checks before it
reaches `fs.*`.

This eliminates an entire class of bugs that v0.1 was vulnerable to:
slug-driven directory traversal in `new-rfc`, sed-delimiter conflicts in
title substitution, role-id case ambiguity.

## Errors and exit codes

The CLI maps every typed error to a stable exit code so scripts and
agents can branch deterministically.

| Class                    | Exit | When                                               |
| ------------------------ | ---- | -------------------------------------------------- |
| `GojajaError` (base)   |    1 | Generic protocol failure.                          |
| `UsageError`             |    2 | Bad arguments, bad role id, invalid lock key.      |
| `NotInitializedError`    |    3 | Layer not found under the resolved root.           |
| `AlreadyInitializedError`|    4 | `init` against an existing layer.                  |
| `UnknownRoleError`       |    5 | Role file missing in `roles/`.                     |
| `LockTimeoutError`       |    6 | Lock acquire exceeded `timeoutMs`.                 |
| `PathValidationError`    |    7 | Path escapes layer root or is malformed.           |
| `StateCorruptionError`   |    8 | On-disk record fails its expected shape.           |
| `ForbiddenError`         |    9 | Authenticated caller lacks the configured permission. |
| _internal_error_         |   99 | Unexpected exception (bug).                        |

Exit codes never overlap with successful informational outcomes. In
particular, neither "no unread events" nor "attention required" exit
non-zero (cf. v0.1's `turn-end` returning 1 for the normal busy case).

## Known limitations (v2.0.0)

- **Single machine.** The locking and rename semantics assume one host.
  Running the layer across NFS / Dropbox / iCloud will silently break
  lock detection.
- **POSIX only in v2.0.** Windows support depends on rename-onto-open
  semantics; needs follow-up testing.
- **No long-held locks.** Lease renewal is not implemented; critical
  sections must complete inside the default 30 s lease.
- **No automatic event archival.** `comms/events/` grows monotonically
  until manually trimmed. An archiver is on the roadmap.
- **Schema migrations are stubs.** `gojaja upgrade` will arrive when we
  have a non-trivial schema delta to migrate.
- **Cross-process event-visibility lag.** ULIDs are only process-locally
  monotonic; two processes writing in the same millisecond can produce
  ids whose lexicographic order is reversed relative to write order. To
  preserve cursor monotonicity the store defers any event newer than
  `safetyMarginMs` (default 200 ms) to the next `plan`. Tests pass 0 for
  deterministic visibility. Tunable per `LocalFsStore` instance.

## Extension points reserved for v2.x

- **HTTP transport.** Implement `Store` against a remote gojaja process.
  Command code is already store-agnostic; only the entry point that
  constructs the store needs to learn about the new option.
- **Heartbeat watcher.** A separate `gojaja watch` process that scans
  heartbeats and downgrades stale sessions, independent of any agent
  window.

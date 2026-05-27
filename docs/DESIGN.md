# Design

Status: living document; reflects the current implementation. Bump
together with code changes.

Cross-references: [SCHEMA](./SCHEMA.md) — on-disk file formats.
[PROTOCOL](./PROTOCOL.md) — agent-facing contract. [ROADMAP](./ROADMAP.md) —
what is implemented vs deferred.

## What this layer is for

A coordination substrate for **N LLM-agent windows that each play a role
inside one project** (PM, TL, Backend, Frontend, QA, DevOps, ...). The agents
do not talk to each other directly; they read and write files inside a
project-local `.multi-agent/` directory. The framework's job is to make
those reads and writes safe, ordered, recoverable, and auditable so the
agents can behave like a real working team without a server.

Concretely the layer provides:

1. A typed event stream that every role can subscribe to via a per-role
   cursor.
2. Per-role inboxes for directed messages.
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
│  agentctl  (Node CLI)                                        │
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
comms/inbox/PM/01HX7T0Z6KCJ1B0FQ2K5MNT0DA.json
```

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

1. `agentctl plan <role>` snapshots all unread events and inbox messages,
   writes the snapshot to `comms/pending/<role>/<ack-token>.json`, stamps
   the cursor's `pendingManifest = ack-token`, and prints the snapshot as
   JSON for the agent to act on.
2. The agent processes the listed items.
3. `agentctl ack <role> --token <ack-token>` validates that the token is
   the cursor's current `pendingManifest`, then advances `ackedThrough` to
   the manifest's `advanceCursorTo` (which was fixed at plan time). Events
   that arrived after `plan` remain unread.

Cursor monotonicity is enforced at the store layer: `updateCursor` rejects
any mutation that moves `ackedThrough` backwards. The combination of
"only-via-token" advancement and "never-backwards" ensures any event
visible to a `plan` is either processed before ack or remains unread; it
cannot be silently skipped.

Note: this PR establishes the cursor invariants in storage. The `plan` and
`ack` CLI commands land in PR2.

## Sessions and leases

Two agent windows cannot both claim role `PM`. `claimSession(role, ttl)`
performs the analogous O_EXCL+lease dance on `comms/sessions/<role>.json`:

- A live session (heartbeat within `ttl`) blocks new claims unless `force`.
- A stale session is auto-taken-over; the framework emits `SESSION_TAKEOVER`.
- `release` requires the session id, so a successor cannot accidentally
  release the previous holder's session.

The session id is a ULID returned by `claim`. Future CLI commands will pin
it into an environment variable (`MA_SESSION`) so that follow-up commands
in the same shell automatically identify themselves; this makes
impersonation of `from-role` cost an explicit override rather than a
silent ambiguity.

## Wait / lifecycle

Long-running role agents need to stay alive between bursts of activity
without burning tokens. v0.1 did this by sleeping inside a shell hook,
which was correct in spirit but tangled with cursor advancement and used
exit codes to mean "more work" vs "idle".

v2 cleanly separates:

- **`ack`** — fast, atomic; only touches the cursor.
- **`wait <role>`** (planned in PR3) — pure keepalive. Two modes:
  - `--mode block` (default for Codex/Claude shells): shell-level `sleep`
    for `idle` minutes, then a single re-check. New events → exit 0 with
    "attention" hint, no new events → exit 0 with "idle" hint. Never uses
    exit 1 to mean "normal more-work outcome".
  - `--mode exit` (for Cursor and similar hosts that timeout shell turns):
    write a `pending_wait` sentinel and exit immediately; an external
    trigger or the next user message resumes the loop.

The blocking sleep is the cheap part: zero LLM tokens consumed while
asleep. Keeping it independent from `ack` means a host with a short shell
timeout can opt out of the sleep without losing safe cursor semantics.

## RFC: opinions in, leader decision out

Real engineering teams gather opinions, then a tech lead or PM picks.
v2's RFC model (planned in PR4) mirrors that:

- `rfc new <slug>` creates a structured proposal.
- `rfc comment <id> --option <a|b|...> --rationale <text>` records any
  role's opinion in `rfcs/<id>/comments/<role>.json`.
- `rfc decide <id> --by <leader-role> --option <id> --rationale <text>`
  is the only command that can transition the RFC state to
  `accepted` / `rejected`. The `--by` role must appear in
  `config.yaml`'s `rfc.decision_makers`, otherwise the call is refused.

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
| `AgentctlError` (base)   |    1 | Generic protocol failure.                          |
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
- **Schema migrations are stubs.** `agentctl upgrade` will arrive when we
  have a non-trivial schema delta to migrate.

## Extension points reserved for v2.x

- **HTTP transport.** Implement `Store` against a remote agentctl process.
  Command code is already store-agnostic; only the entry point that
  constructs the store needs to learn about the new option.
- **Heartbeat watcher.** A separate `agentctl watch` process that scans
  heartbeats and downgrades stale sessions, independent of any agent
  window.
- **`config.yaml`-driven ownership enforcement.** All `write-state` calls
  will validate `roles[caller].owns` includes the target file. The schema
  is sketched but not yet enforced.

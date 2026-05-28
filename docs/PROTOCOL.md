# Protocol

Cross-references: [DESIGN](./DESIGN.md) — why the protocol is shaped this
way. [SCHEMA](./SCHEMA.md) — files referenced here.
[HANDBOOK](./HANDBOOK.md) — when (policy) to use each tool documented
below. [RFC](./RFC.md) — narrative walkthrough of the RFC lifecycle
with a worked example (this doc is the wire spec; that doc shows the
flow).

This document is the contract between an LLM agent window and the
coordination layer. The wire-level invariants here are what `agentctl`
enforces; anything not enforced here is convention only.

## Identities

There are three identity domains:

- **Role id** — long-lived, human-meaningful (`PM`, `TL`, `Backend`).
  Stable across sessions.
- **Session id** — issued by `claim`; valid only while the lease is held.
  All authenticated commands carry the session id via the `MA_SESSION`
  environment variable.
- **Ack token** — issued by `plan`; valid until the next `plan` for that
  role or until consumed by `ack`.

An agent window asserts a role identity by holding a fresh session id
for that role.

## Role lifecycle

```
agentctl claim <role>           → SessionInfo (sessionId, leaseTtlSeconds)
[ export MA_SESSION=<sessionId> ]

loop:
  agentctl plan                 → Manifest JSON (events, ackToken, ...)
                                   stamps cursor.pendingManifest=<token>
  ... agent processes manifest events ...
  agentctl ack --token <token>  → cursor advances exactly to
                                  manifest.advanceCursorTo

  (optional, between turns) agentctl wait [--mode block|exit] [--idle <min>]

agentctl release                → clears the session
```

`claim`, `release`, `plan`, `ack`, `report`, `worklog`, and `wait` are
all implemented.

## Claim

`agentctl claim <role> [--ttl <seconds>] [--eval] [--force]`

- Refuses if an existing session for `<role>` has a heartbeat younger
  than its `leaseTtlSeconds`. The agent should report this as a
  configuration error, not retry blindly. The error message
  deliberately does NOT mention `--force`; reflexively forcing
  takeover would silently kill a peer window doing real work.
- If the existing session has missed its lease (heartbeat older than
  `leaseTtlSeconds`) the new claim takes over automatically — no
  `--force` needed.
- `--eval` outputs a single shell line: `export MA_SESSION=<ulid>`.
  Intended use: `eval "$(agentctl claim PM --eval)"` to claim and
  export in one step.
- With `--force`, takes over any existing session and emits a
  `SESSION_TAKEOVER` event. Use only when the previous window is known
  dead.
- Returns JSON: `{ "role", "sessionId", "leaseTtlSeconds", "startedAt" }`.

The agent **must** export `MA_SESSION` for the rest of its shell turn so
subsequent commands can verify identity.

## Plan / process / ack

This is the only correct loop to consume work. It is designed so that
no event observed by `plan` can be silently skipped by `ack`.

### `agentctl plan [<role>]`

- Resolves the role: from `MA_SESSION` if set, or from the optional
  positional argument (the two must agree if both are present).
- Reads the current cursor and computes a `Manifest`:
  - all events with `id > cursor.ackedThrough`
    where `to ∈ {role, "*"}` AND `from !== role`,
  - a compact `roleReminder` re-anchoring identity (id, title, owns,
    mustNotEdit, reportsTo, one-line protocol; empty fields omitted),
  - active tasks owned by the role,
  - open RFCs that need the role's comment or decision.
- Writes the manifest to `comms/pending/<role>/<ack-token>.json`.
- Updates the cursor with `pendingManifest = <ack-token>` (the cursor's
  `ackedThrough` is **not** moved).
- Prints the manifest to stdout (as JSON when `--json`).

The `roleReminder` is intentionally tiny — a fully populated reminder
serialises to under 300 bytes. It exists so that a context-compressed
agent can recover its full operating identity by running `plan` once;
it does not duplicate the full role contract or protocol docs.

`manifest.tasks` is the role's active task list: tasks where
`owner == role` and `status ∈ {Ready, InProgress, Blocked, Review}`.
Each entry is a `TaskSummary` (`id`, `title`, `status`, `priority`,
`blockedBy`). Backlog and Done are intentionally excluded — the
former is product/PM space, the latter is history. Call
`agentctl task show <id>` for full details (acceptance criteria,
timestamps).

If a previous manifest is outstanding (`pendingManifest != null`), `plan`
returns the existing manifest verbatim and does not generate a new one.
This makes the operation idempotent across crash-and-retry.

### `agentctl ack [<role>] --token <ack-token>`

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
- All writes to framework state must go through `agentctl` subcommands.
  Direct file edits bypass ownership checks (exit 9 from `agentctl`
  means the caller lacks the configured permission) and are not
  reflected in the event stream.

## Sending

### `agentctl report --to <role> --message <text> [--ref <id>]`

- `from` is derived from `MA_SESSION` (i.e. the session's role); the agent
  cannot pass an arbitrary `--from`.
- Writes one event record into `comms/events/`. Recipients see it via
  their next `plan`, which filters the global event stream by `to`.
- Refuses an empty message or an unknown recipient role.
- Returns the created event (full record when `--json`).

### `agentctl worklog --message <text>`

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

- `agentctl task new` / `agentctl task assign` — require the actor to
  own `state/task_board.yaml`. SYSTEM bypasses (so a human running the
  CLI outside any session can still bootstrap the board).
- `agentctl task status <task-id> <status>` — same gate, but a **task
  owner exception** also applies: a role may always move its OWN task's
  status. This lets engineering roles update progress without
  blanket task-board write access.
- `agentctl state edit --file <state/path>` — generic state editor
  gated by `owns`; `--file` must live under `state/`. Renamed from
  `agentctl write-state` in PR8f-C; see the `state edit` section below
  for the full mode specification.

`ForbiddenError` exits 9 (distinct from `UsageError`'s exit 2 so a
caller can distinguish "you said it wrong" from "you are not allowed").

### `agentctl state edit --file <state/path> [mode flags]`

Mode flags (mutually exclusive — pick exactly one; default is overwrite):

```
# overwrite (default): replace the whole file
agentctl state edit --file state/foo.md --content '<text>'
agentctl state edit --file state/foo.md            # content from stdin

# append: add to the end of the file
agentctl state edit --file state/foo.md --append '<text>'

# replace: literal-string find and replace
agentctl state edit --file state/foo.md --replace '<old>' --with '<new>'
agentctl state edit --file state/foo.md --replace '<old>' --with '<new>' --batch
```

Common rules:

- `--file` must be a relative path under `state/`. Path-traversal
  refused via the standard `resolveInside` check.
- Identity: agents authenticate via `MA_SESSION` as usual; humans
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

### `agentctl task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3] [--depends-on T-NNNN,...] [--acceptance <text>]`

- The store assigns the next `T-NNNN` id atomically (under a
  `task-board` lock); ids are never reused even if a task is deleted.
- Emits `TASK_CREATED` (broadcast). If `--owner` is given, also emits
  `TASK_ASSIGNED` (directed at the new owner).
- `from` for the events is the actor's role (from `MA_SESSION`) when
  available, otherwise `"SYSTEM"` (so a human one-off invocation still
  produces audit events).

### `agentctl task assign <task-id> --to <role>`

- Sets `task.owner` and emits `TASK_ASSIGNED` with `previousOwner` and
  `newOwner`.
- No-op (no event) when the owner already matches.

### `agentctl task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>`

- Sets `task.status` and emits `TASK_STATUS_CHANGED`.
- v2 does not enforce status transitions; any role with write access
  may move any task between any two statuses. A constrained state
  machine is on the roadmap if it proves necessary.

### `agentctl task list [--owner <role>] [--status <s>]` and `agentctl task show <id>`

- Read-only. Useful for humans browsing the project. The agent's
  per-turn view of its tasks is `manifest.tasks`; explicit list/show
  are for ad-hoc inspection.

## RFCs

The goal is "every relevant role records an opinion; a designated leader
picks; the decision is durable". There is no automatic tally.

PR8g made the RFC mechanism multi-round: comments are threaded
(`replyTo`), options can be added mid-discussion, deciders can run a
pre-decide ACK round, and deciders can send a proposal back for
rewrite (`revise` + `edit`) without rejecting the topic.

State machine (open / pre-decide / revising / accepted / rejected /
superseded), worked example, and rationale live in
[docs/RFC.md](./RFC.md). Full on-disk schema:
[SCHEMA -> rfcs/](./SCHEMA.md#rfcsrfc-nnnn-slug).

### `agentctl rfc new <slug> --title <text> --deciders <r1,...> --options <A:summary,B:summary> [--description <text>] [--voters <r1,...>] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]`

- Slug must match `^[a-z0-9][a-z0-9-]{0,63}$`; reuse across RFCs is refused.
- The store assigns the next sequential `RFC-NNNN` id under a `rfcs` lock
  (`rfcCounter` lives in `config.yaml`, so deleting an RFC dir does not
  recycle its id).
- `--description` is soft-required in PR8g (warns if empty; PR8h
  hardens to required). It is the channel where the creator gives
  non-participants enough context to weigh in.
- `--task` links one or more existing task ids; each is validated
  against `state/task_board.yaml` and refused if not found.
- Emits `RFC_CREATED` (broadcast).
- The actor (`MA_SESSION` role, or `"SYSTEM"` if no session) is recorded
  as the event's `from` and the proposal's `createdBy`.

### `agentctl rfc comment <rfc-id> --rationale <text> [--option <opt>] [--reply-to <comment-id>]`

- The role comes from `MA_SESSION`; the framework does not allow
  ghost-commenting on behalf of another role.
- Non-voters may comment — they often add cross-cutting context that the
  named voters miss.
- Refuses on closed RFCs (`accepted` / `rejected` / `superseded`) and
  on unknown `--option`.
- `--reply-to` must reference an existing comment id in the same RFC;
  threading is enforced.
- PR8g: **append-only ledger**. Multiple comments per role are
  preserved in `comments.yaml`. The commenter's read cursor for this
  RFC is automatically advanced to the just-written comment.
- During `pre-decide`: a comment from a role **other than** the
  pre-decider auto-reopens the RFC to `open` and emits
  `RFC_PRE_DECISION_OBJECTED`. A comment from the pre-decider
  themselves does not.
- Emits `RFC_COMMENT` (broadcast).

### `agentctl rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>` (PR8g)

- Any session can add. Allowed in `open` or `revising`. Refused in
  `pre-decide` (use comment to reopen first), `accepted`, `rejected`,
  `superseded`.
- Option id must be unique within the RFC.
- Emits `RFC_OPTION_ADDED`.

### `agentctl rfc pre-decide <rfc-id> --option <opt> --rationale <text>` (PR8g)

- Decider gate (FORBIDDEN otherwise). Valid only from `open`.
- Sets the proposal's `preDecision` field (`decidedBy`, `chosenOption`,
  `ts`, `rationale`) and status to `pre-decide`. Surface in
  `manifest.rfcs[*].pendingPreDecision`.
- Emits `RFC_PRE_DECISION`.

### `agentctl rfc decide <rfc-id> --option <opt> --rationale <text>`

- Deciders gate. Valid from `open` or `pre-decide`.
- Refuses on unknown `--option`.
- Status -> `accepted`; writes `decision.json`; clears `preDecision`;
  emits `RFC_DECIDED` with `outcome="accepted"`.

### `agentctl rfc reject <rfc-id> --rationale <text>`

- Deciders gate. Valid from `open` / `pre-decide` / `revising`
  (the last so a decider can give up on the topic mid-revision).
- Status -> `rejected`; writes `decision.json` with `outcome="rejected"`
  and `chosenOption=null`; clears `preDecision`; emits `RFC_DECIDED`.

### `agentctl rfc revise <rfc-id> --rationale <text>` (PR8g)

- Deciders gate. Valid from `open` or `pre-decide`.
- Status -> `revising`; clears `preDecision`; emits
  `RFC_REVISION_REQUESTED` carrying the rationale (which is the
  "what to fix" message to the creator).
- Comments are preserved untouched.

### `agentctl rfc edit <rfc-id> --rationale <text> [--title <text>] [--description <text>] [--options A:summary,B:summary] [--deadline <iso>]` (PR8g)

- Allowed only in `revising`. Actor must be the original `createdBy`
  OR a role in `deciders`. Other voters cannot rewrite.
- At least one of `--title` / `--description` / `--options` /
  `--deadline` must be provided.
- Status -> `open`; clears `preDecision`; emits `RFC_REVISED`
  including which fields changed.
- Comments preserved untouched.

### `agentctl rfc link-task <rfc-id> --task T-NNNN` (PR8g)

- Any session. Refused in terminal states.
- Task id must exist on the board (USAGE otherwise).
- Idempotent: linking an already-linked task is a no-op.
- Emits `RFC_TASK_LINKED`.

### `agentctl rfc unlink-task <rfc-id> --task T-NNNN` (PR8g)

- Counterpart to `link-task`. Idempotent.
- Emits `RFC_TASK_UNLINKED`.

### `agentctl rfc list [--status open|pre-decide|revising|accepted|rejected|superseded]` and `agentctl rfc show <rfc-id> [--no-mark-seen]`

- Read-only.
- `rfc show` side effect (PR8g): advances this role's per-RFC read
  cursor to the latest comment, so a subsequent `plan` reports
  `unreadComments: 0` for this RFC until new discussion arrives.
  Pass `--no-mark-seen` (e.g. from a script) to inspect without
  moving the cursor.

## Wait / idle keepalive

An agent window that has nothing to do should stay alive — discussions,
reviews, blocker messages may arrive from other agents — but should not
consume tokens while idle. `wait` is the cheap-keepalive primitive.

### `agentctl wait [<role>] [--idle <minutes>] [--mode block|exit]`

Role resolution follows the same rules as `plan` (MA_SESSION first;
explicit role argument must agree).

`--mode block` (default):

1. Shell-level `setTimeout` blocks for `--idle` minutes. No LLM tokens
   are consumed while sleeping.
2. After waking, `wait` reads the cursor and lists events newer than it,
   applying the same recipient filter as `plan` (`to ∈ {role, "*"} &&
   from !== role`). The cursor is **not** modified, no manifest is
   generated.
3. Output (always exit 0):
   - `ATTENTION role=<r> newEvents=<n> ...` if any new event matched.
     The agent should then run `agentctl plan` to consume them.
   - `IDLE role=<r> newEvents=0 ...` if none did. The agent may end the
     turn.
4. Use `--json` for machine-readable output (`status: "attention" | "idle"`).

`--mode exit` (for Cursor and other hosts with short shell timeouts):

1. Writes a sentinel `comms/pending/<role>/.wait`. See [SCHEMA](./SCHEMA.md).
2. Exits 0 immediately. The agent window's outer loop is expected to be
   resumed by the next user message (or an external scheduler in v2.x).

Two cardinal rules — both fix v0.1 bugs:

- **No exit-code overloading.** Exit 0 in every normal outcome. Non-zero
  is for genuine usage errors (e.g. unknown role).
- **No cursor mutation.** `wait` is a pure read; only `plan` + `ack`
  may move the cursor.

## Activation in different agent hosts

`agentctl prompt <role> --target <host> [--write]` produces a prompt body
and, when `--write` is given, drops a persistent artifact into the host's
own configuration area. The artifact is **role-agnostic**: it tells the
agent how to find its identity via `MA_SESSION` and `agentctl plan`.
Per-window role binding is done by pasting a short activation snippet
into that window's chat.

| Target | Persistent artifact location | Activation per window |
| --- | --- | --- |
| `codex` | `${CODEX_HOME:-~/.codex}/skills/multi-agent-runtime/SKILL.md` and `agents/openai.yaml` | User pastes `Use $multi-agent-runtime. I am the <role> agent for <project root>.` |
| `claude` | A `<!-- multi-agent-runtime:BEGIN ... :END -->` marker block inside `<project>/CLAUDE.md` (preserves user content around it) | User pastes the activation snippet into the chat |
| `cursor` | `<project>/.cursor/rules/multi-agent-runtime.mdc` with `alwaysApply: true` | User pastes the activation snippet into the chat |
| `generic` | Nothing written | User pastes the full prompt body into the chat |

Writing is idempotent: re-running `prompt --write` overwrites a prior
artifact in place; byte-equal re-runs report `UNCHANGED (already up to
date)` and touch no files. Pass `--force-rewrite` to overwrite even
when bytes match (useful after a CLI upgrade, to confirm the install
came from the current template). The CLI refuses to clobber an
existing file that does not look like a previous artifact (heuristic:
must contain the `agentctl plan` marker phrase).

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
> bound to a role**, which is true if and only if `MA_SESSION` is
> exported in the shell, or the user has explicitly told you in chat
> that you are playing the `<role>` for this project. Otherwise,
> ignore the protocol and respond normally — do not speculatively run
> `agentctl plan`, `claim`, or any other `agentctl` command.

This is necessary because the rule file applies to every agent window
in the project (including windows the user opens for unrelated work);
without the gate, an unactivated window would reflexively start
claiming roles on the user's behalf.

## Role lifecycle (deletion)

`agentctl role delete <id>`

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
  `agentctl task assign <task-id> --to <other-role>`.
- Restricted to `SYSTEM`. The CLI refuses to run when `MA_SESSION` is
  exported in the calling shell — role deletion is a project-governance
  act, not something an agent should do on its own.
- After deletion, any agent window that still has the deleted role's
  `MA_SESSION` exported will fail with `USAGE` ("session not found")
  on its next authenticated command. The user must `unset MA_SESSION`
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
2. `wait` returned `idle` or the user has terminated the loop.
3. Optionally, `agentctl release <role>` was called. If not called, the
   session lease will expire naturally; the next `claim` will take over.

Crash-on-mid-turn is recoverable: the next window for the role takes the
session over after the lease, finds the `pendingManifest` in the cursor,
and can re-issue `plan` to retrieve the same manifest deterministically.

## Forbidden agent actions

The framework cannot prevent these at the OS level today, but they are
out-of-contract and will be flagged by future `agentctl doctor`:

- Writing into another role's `worklog/<other>/` directory.
- Editing `comms/events/<id>.json` (events are immutable).
- Editing `comms/cursors/<other>.json`.
- Hand-rolling new entries in any `comms/` directory without going
  through `agentctl`. Even when the file shape is trivially writable,
  doing so bypasses event emission, ownership, and audit.

# Protocol

Cross-references: [DESIGN](./DESIGN.md) — why the protocol is shaped this
way. [SCHEMA](./SCHEMA.md) — files referenced here.

This document is the contract between an LLM agent window and the
coordination layer. The wire-level invariants here are what `agentctl`
enforces; anything not enforced here is convention only.

## Identities

There are three identity domains:

- **Role id** — long-lived, human-meaningful (`PM`, `TL`, `Backend`).
  Stable across sessions.
- **Session id** — issued by `claim`; valid only while the lease is held.
  All authenticated commands carry the session id (currently via the
  `MA_SESSION` environment variable; planned for PR2).
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

`claim`, `release`, `plan`, `ack`, `report`, `worklog` are implemented
in v2.0.0-alpha.1. `wait` lands in PR3.

## Claim

`agentctl claim <role> [--ttl <seconds>] [--force]`

- Refuses if an existing session for `<role>` has a heartbeat younger
  than its `leaseTtlSeconds`. The agent should report this as a
  configuration error, not retry blindly.
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
  - tasks the role is assigned (PR4, not yet emitted),
  - RFCs awaiting action from the role (PR4, not yet emitted).
- Writes the manifest to `comms/pending/<role>/<ack-token>.json`.
- Updates the cursor with `pendingManifest = <ack-token>` (the cursor's
  `ackedThrough` is **not** moved).
- Prints the manifest to stdout (as JSON when `--json`).

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
- Side effects on framework state should be performed through agentctl
  subcommands; raw filesystem edits skip ownership checks and are not
  reflected in the event stream until the next mutation. The store does
  not enforce this yet; ownership enforcement is on the roadmap.

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

## RFCs (planned PR4)

The goal is "every relevant role records an opinion; a designated leader
picks; the decision is durable". There is no automatic tally.

```
agentctl rfc new <slug> --title <text> --voters <r1,r2,...> --deciders <r>
agentctl rfc comment <id> --option <id> --rationale <text>
agentctl rfc decide  <id> --by <role> --option <id> --rationale <text>
agentctl rfc status  <id>
```

Rules:

- `rfc decide` is the only command that can transition status to
  `accepted` / `rejected`. The `--by` role must be in the proposal's
  `deciders` list.
- Comments are append-once per role; a second comment from the same role
  overwrites the first (with the previous version preserved in the audit
  log).
- The proposal's `deadline` is informational; the framework does not
  auto-decide on expiry.
- Roles must not implement work assigned to an RFC while its status is
  `open` or `draft`. This is enforced at the task-claim level (planned),
  not in `agentctl rfc`.

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

Writing is idempotent — re-running `prompt --write` overwrites a
prior artifact in place, and skips no-op rewrites. The CLI refuses
to clobber an existing file that does not look like a previous artifact
(heuristic: must contain the `agentctl plan` marker phrase).

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

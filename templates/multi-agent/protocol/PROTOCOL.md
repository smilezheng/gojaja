# .multi-agent/protocol/PROTOCOL.md

This project uses an agent-agnostic multi-agent coordination protocol.

## Main Rule

Each participating agent window acts as one main agent with one role. This can be Codex, Claude Code, Cursor, or another file-capable agent. Every agent must read its role file, shared state, worklog, and inbox before doing work.

## Role Model

Roles are dynamic. A role exists when these files exist:

- `roles/<role>.md`
- `comms/inbox/<role>.md`
- `comms/cursors/<role>.cursor`
- `comms/status/<role>.md`
- `worklog/<role>.md`

The starter roles in this repository are examples:

- PM
- TL
- Backend
- Frontend
- QA
- DevOps

Projects may add, remove, or rename roles. Do not assume the starter roles are mandatory.

Project users create a new role with:

```bash
.multi-agent/scripts/create-role <role> "<title>"
```

Runtime agents should not create roles.

Start an existing role agent window with:

```bash
.multi-agent/scripts/start-role --target codex <role>
.multi-agent/scripts/start-role --target claude <role>
.multi-agent/scripts/start-role --target cursor <role>
.multi-agent/scripts/start-role --target generic <role>
```

List active roles with:

```bash
.multi-agent/scripts/agentctl roles
```

## Source of Truth

Chat messages are not durable project state.

Only these files count as durable state:

- `state/project_state.md`
- `state/task_board.md`
- `state/architecture.md`
- `state/decisions.md`
- `state/risks.md`
- `comms/events.log`
- `comms/cursors/<role>.cursor`
- `comms/status/<role>.md`
- Accepted RFC decision files under `rfcs/`

## Coordination Rules

- Role ownership is defined by each project in the role files and `state/task_board.md`.
- Shared state owners are project-defined, not hard-coded.
- Agents must not directly edit state owned by another role unless explicitly assigned.
- Agents must run `.multi-agent/scripts/agentctl sync <role>` at the start of each work turn.
- Agents must run `.multi-agent/scripts/agentctl ack <role>` only after processing sync output.
- Cross-role blockers must use the RFC process.
- Related implementation pauses while an RFC is open.
- Agents must report meaningful progress to the roles defined by the active project protocol.
- Shared-state writes must use `.multi-agent/scripts/with_lock.sh` or `.multi-agent/scripts/agentctl`.

## Per-Turn Startup

The user triggers this protocol by pasting the prompt printed by:

```bash
.multi-agent/scripts/start-role --target <target> <role>
```

into a participating agent window.

For Codex targets, the printed prompt explicitly invokes `$multi-agent-runtime`, which provides the repeated runtime loop for assigned role agents. For Claude Code, Cursor, and generic targets, the printed prompt embeds the runtime loop directly because Codex skills are not available there.

Every agent starts each work session by reading:

1. Its role file in `roles/`.
2. `state/project_state.md`.
3. `state/task_board.md`.
4. `state/decisions.md`.
5. `state/risks.md`.
6. Its inbox in `comms/inbox/`.
7. Its worklog in `worklog/`.

Then run:

```bash
.multi-agent/scripts/agentctl sync <role>
```

After processing unread events, inbox items, assigned tasks, and RFC actions, run:

```bash
.multi-agent/scripts/agentctl ack <role>
```

## Sync Timing

Agents should sync:

- At new window startup.
- At the start of every user turn.
- Before editing files.
- After sending a report, worklog, RFC, or vote.
- When blocked.
- Before claiming a task is complete.

Management or coordination roles should also run:

```bash
.multi-agent/scripts/agentctl digest <role>
```

on their review cadence.

## Lifecycle Hooks

Where the host agent tool supports hooks, register the turn-end sync as a hook instead of relying only on the model remembering it.

At the end of a substantive turn, call:

```bash
.multi-agent/hooks/turn-end <role> 10
```

or:

```bash
.multi-agent/scripts/agentctl hook turn-end <role> 10
```

The hook runs a final sync. If unread events exist, it marks `comms/status/<role>.md` as `attention_required` and the role must process the events before ending. If there are no unread events, it acks the current event id, marks the role `idle_pending`, blocks for the requested wait period, then automatically runs idle-check in the same process.

After the wait, the hook runs:

```bash
.multi-agent/hooks/idle-check <role>
```

If no unread events arrived during the idle wait, the role is marked `offline`. If new events arrived, it is marked `attention_required` and must continue processing.

For host tools that cannot block inside a hook, use:

```bash
.multi-agent/hooks/turn-end <role> 10 --no-wait
```

and schedule `.multi-agent/hooks/idle-check <role>` externally.

## Reporting Format

Reports should include:

- Role
- Time
- Completed work
- Current task
- Blockers
- Decisions needed
- Files changed
- Next step

## Completion Rule

The project is not complete until the active project protocol says it is complete. By default:

- All success criteria in `state/project_state.md` are met.
- The task board has no required open work.
- `state/risks.md` has no unresolved release-blocking risks.
- The roles responsible for product, technical, quality, and release approval have accepted the result.

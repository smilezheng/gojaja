---
name: multi-agent-runtime
description: Runtime behavior for a Codex window assigned to a role in a project-local .multi-agent coordination layer. Use when a Codex prompt says the agent is a specific multi-agent role, references .multi-agent/protocol/PROTOCOL.md, asks to continue a role agent, or includes a Codex-target start-role prompt.
---

# Multi-Agent Runtime

Use this skill only after a Codex window has been assigned a concrete role in a project-local `.multi-agent` layer.

This skill is not for installation. Installation is handled by the package CLI:

```bash
npx multi-agent-coordination install .
```

## Required Runtime Loop

At the start of every user turn:

1. Identify your assigned role from the conversation or `.multi-agent/roles/<role>.md`.
2. Read or refresh:
   - `.multi-agent/protocol/PROTOCOL.md`
   - `.multi-agent/roles/<role>.md`
   - `.multi-agent/state/project_state.md`
   - `.multi-agent/state/task_board.md`
   - `.multi-agent/state/decisions.md`
   - `.multi-agent/state/risks.md`
   - `.multi-agent/comms/inbox/<role>.md`
   - `.multi-agent/worklog/<role>.md`
3. Run:

```bash
.multi-agent/scripts/agentctl sync <role>
```

4. Process unread events, inbox items, task board changes, RFC actions, and pending votes.
5. Run:

```bash
.multi-agent/scripts/agentctl ack <role>
```

Only ack after processing the sync output.

## Before Final Response

Before ending a substantive work turn:

1. If you made meaningful progress, write a worklog entry.
2. If progress, blockers, changed files, decisions, or handoffs matter, report to the project-defined coordination roles.
3. Run the blocking turn-end hook. It performs the final sync, waits, then runs the second sync/idle-check before returning.
4. If the hook reports `attention_required`, process the new events before ending.
5. If the hook reports `offline`, the role may end the turn.

Commands:

```bash
.multi-agent/scripts/agentctl worklog <role> "summary"
.multi-agent/scripts/agentctl report <role> <target-role> "message"
.multi-agent/hooks/turn-end <role> 10
```

The turn-end hook marks `comms/status/<role>.md` as `offline` only if no new unread events arrived during the wait. Use `.multi-agent/hooks/turn-end <role> 10 --no-wait` only when the host tool cannot block and an external scheduler will call `.multi-agent/hooks/idle-check <role>`.

## Blockers And RFCs

When blocked by product, architecture, API contract, migration, deployment, or cross-role dependency:

1. Do not guess.
2. Create or comment on an RFC.
3. Report the blocker to coordination roles.

Useful commands:

```bash
.multi-agent/scripts/agentctl new-rfc <number> <slug> "title"
.multi-agent/scripts/agentctl rfc-status <rfc-id>
.multi-agent/scripts/agentctl vote-rfc <role> <rfc-id> approve|reject|abstain "reason"
```

## Role Boundaries

- Do not create, remove, or rename roles.
- Do not edit another role's worklog.
- Do not edit state owned by another role unless task board or accepted decision explicitly assigns it.
- Prefer `agentctl` commands over manually appending communication files.
- Prefer lifecycle hooks over manually remembering final sync/ack.

## Missing Runtime Layer

If `.multi-agent` is missing, say the project-local layer is not installed and ask the user to run `npx multi-agent-coordination install .` from the project root.

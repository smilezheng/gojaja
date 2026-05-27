# AGENTS.md

This repository may use a project-local multi-agent coordination layer at:

```text
.multi-agent/
```

In this package repository, `.multi-agent` is a symlink to `templates/multi-agent`, the canonical template installed by the `npx` CLI. The repository's normal project instructions remain authoritative. The multi-agent layer is an additional agent-agnostic control plane used only when an agent window is assigned a specific multi-agent role.

## Multi-Agent Bridge

When assigned a multi-agent role in Codex, Claude Code, Cursor, or another file-capable agent, first read:

- `.multi-agent/protocol/PROTOCOL.md`
- `.multi-agent/roles/<role>.md`
- `.multi-agent/state/project_state.md`
- `.multi-agent/state/task_board.md`
- `.multi-agent/state/decisions.md`
- `.multi-agent/state/risks.md`
- `.multi-agent/comms/inbox/<role>.md`
- `.multi-agent/worklog/<role>.md`

Then run:

```bash
.multi-agent/scripts/agentctl sync <role>
```

After processing sync output, run:

```bash
.multi-agent/scripts/agentctl ack <role>
```

Runtime agents must not create, remove, or rename roles. Role management is a user-side setup action handled by:

```bash
.multi-agent/scripts/create-role <role> "<title>"
```

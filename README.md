# Multi-Agent Coordination

Agent-agnostic file-system coordination for Codex, Claude Code, Cursor, and other file-capable agents.

## Install

From a project root:

```bash
npx multi-agent-coordination install .
```

This installs the coordination layer at:

```text
.multi-agent/
```

The package maintains one canonical template at:

```text
templates/multi-agent/
```

In this repository, `.multi-agent` is a symlink to that template so local testing and packaged installs use the same files.

## Use

Create a role:

```bash
.multi-agent/scripts/create-role --target codex PM "Product Manager"
```

Start an existing role agent:

```bash
.multi-agent/scripts/start-role --target codex PM
.multi-agent/scripts/start-role --target claude Backend
.multi-agent/scripts/start-role --target cursor Frontend
.multi-agent/scripts/start-role --target generic QA
```

Runtime commands:

```bash
.multi-agent/scripts/agentctl sync PM
.multi-agent/scripts/agentctl ack PM
.multi-agent/hooks/turn-end PM 10
```

Codex users may also install/use `skills/multi-agent-runtime/` for runtime behavior. Installation itself is handled by the `npx` command, not a skill.

# Communications

This directory is the shared communication layer for multiple Codex windows.

## Rules

- Each role has one inbox in `comms/inbox/`.
- All cross-role activity is mirrored into `comms/events.log`.
- Each role tracks processed events in `comms/cursors/<role>.cursor`.
- Each role publishes lifecycle state in `comms/status/<role>.md`.
- Use `.multi-agent/scripts/agentctl sync <role>` to read unread events, relevant inbox, assigned tasks, and RFC actions.
- Use `.multi-agent/scripts/agentctl ack <role>` only after sync output has been processed.
- Use `.multi-agent/scripts/agentctl digest <role>` for management or coordination summaries.
- Use `.multi-agent/hooks/turn-end <role> 10` at turn end and `.multi-agent/hooks/idle-check <role>` for delayed idle rechecks.
- Reports should be sent through `.multi-agent/scripts/agentctl report`.
- Long reports may be written as individual files under `comms/reports/`.
- Shared writes must use `.multi-agent/scripts/with_lock.sh` or `.multi-agent/scripts/agentctl`.
- Do not use chat-only decisions as durable state.

## Event Log

`comms/events.log` is append-only and tab-delimited:

```text
id timestamp type from to ref message
```

Event ids are assigned by `.multi-agent/scripts/agentctl` using `comms/events.seq`.

## Cursor Rule

`sync` does not move the cursor. This prevents lost messages if an agent is interrupted.

`ack` moves `comms/cursors/<role>.cursor` to the latest event id.

## Role Status

`comms/status/<role>.md` is readable by all roles and contains one of:

- `online`
- `attention_required`
- `idle_pending`
- `offline`

Useful commands:

```bash
.multi-agent/scripts/agentctl mark-online <role> "note"
.multi-agent/hooks/turn-end <role> 10
.multi-agent/hooks/idle-check <role>
```

## Message Format

```md
## YYYY-MM-DD HH:MM:SS +TZ - From -> To

Message text.
```

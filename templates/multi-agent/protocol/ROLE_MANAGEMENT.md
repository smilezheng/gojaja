# Role Management

This file is for the human project user who configures the multi-agent workspace.

Runtime agents should use `.multi-agent/scripts/agentctl` for reading roles, inboxes, reports, worklogs, and RFCs. Runtime agents should not create roles.

## Create A Role

```bash
.multi-agent/scripts/create-role UX "UX Research Agent"
```

This creates:

- `roles/UX.md`
- `comms/inbox/UX.md`
- `comms/cursors/UX.cursor`
- `comms/status/UX.md`
- `worklog/UX.md`

After creation, edit `roles/UX.md` to define the role's responsibilities, write scope, reporting targets, and constraints.

The command also prints a ready-to-use prompt for the Codex window that will run this role. Use that prompt after editing the role file.

## Start A Role

For an existing role, print its startup prompt with:

```bash
.multi-agent/scripts/start-role UX
```

Choose the target agent tool:

```bash
.multi-agent/scripts/start-role --target codex UX
.multi-agent/scripts/start-role --target claude UX
.multi-agent/scripts/start-role --target cursor UX
.multi-agent/scripts/start-role --target generic UX
```

Paste the printed prompt into the agent window assigned to that role. This is the explicit trigger that tells the agent to enter the multi-agent protocol.

## List Roles

```bash
.multi-agent/scripts/agentctl roles
```

The framework discovers active roles from `roles/<role>.md`.

## Role Naming

Use simple role ids:

- `PM`
- `TechLead`
- `backend`
- `qa-automation`
- `ux_research`

Allowed characters are letters, numbers, `_`, and `-`.

## Starter Roles

The repository includes starter role files for PM, TL, Backend, Frontend, QA, and DevOps. They are examples only. You can keep, edit, rename, or replace them for your project.

## Removing A Role

There is no removal script by design. Removing a role is a project governance action. Manually review and delete or archive:

- `roles/<role>.md`
- `comms/inbox/<role>.md`
- `comms/cursors/<role>.cursor`
- `comms/status/<role>.md`
- `worklog/<role>.md`

Also update `state/task_board.md`, open RFCs, and any project documentation that references the role.

# multi-agent-coordination

**Languages:** English · [简体中文](./README.zh-CN.md)

> A local CLI tool that lets multiple AI agent windows work together on the same project — without a server, without a database, just files in your repo.

---

## The problem it solves

You open Cursor for frontend work, Claude Code for backend, Codex for a PM role. They all read the same codebase but they don't talk to each other. They duplicate work, make conflicting decisions, and there's no record of what was agreed.

This tool gives each agent a **role** (PM, Tech Lead, Backend, QA…), a private inbox, and a shared task board. Agents communicate through a local CLI called `agentctl`. Every message, decision, and status change is saved as a plain file you can `git diff`.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Cursor     │  │  Claude     │  │  Codex      │  │  Cursor     │
│  role: PM   │  │  role: TL   │  │  role: BE   │  │  role: QA   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                                 ▼
              .multi-agent/   ← plain files, committed to git
              ├── state/        shared project state
              ├── comms/        events and messages between agents
              ├── rfcs/         proposals and decisions
              └── worklog/      each agent's activity log
```

---

## Who this is for

Use it if:

- You run **two or more AI agent windows** in the same project and they keep stepping on each other.
- You want a **record of decisions** — who proposed what, who approved, why — visible as normal files in git.
- You want agents to have **defined roles and responsibilities**, and to escalate cross-role decisions through a proper process.
- You want all of this to work **without any external service** — no API key, no account, no cloud.

Skip it if you only run one agent at a time, or if you're already using a hosted multi-agent platform (LangGraph, AutoGen, CrewAI). Those solve a different coordination problem.

---

## Install

Requires **Node.js 20+**.

```bash
npm install -g multi-agent-coordination
```

During alpha, you can also clone the repo and build locally — see [Develop locally](#develop-locally).

---

## Setup (four steps, done once per project)

After setup, you only chat with the agents. The CLI commands below are for your terminal, not for the agents.

### Step 1 — Initialise

```bash
cd /path/to/your/project
agentctl init
```

This creates a `.multi-agent/` folder with all the coordination state. It's safe to commit to git.

### Step 2 — Create roles

```bash
agentctl role create PM  "Product Manager"  --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL  "Tech Lead"        --owns "state/architecture.md"
agentctl role create Backend "Backend Engineer"
agentctl role create QA  "Quality Assurance"

agentctl role list
# PM       Product Manager
# TL       Tech Lead
# Backend  Backend Engineer
# QA       Quality Assurance
```

The `--owns` flag controls which files each role is allowed to write. Agents calling the CLI cannot write outside their assigned scope.

### Step 3 — Install the runtime for each agent tool you use

Run **once per agent tool**. The installed file is
role-agnostic and shared by every window of that tool — two Cursor chats
in the same project read the same rule.

```bash
# If you use Cursor:
agentctl prompt --target cursor --write
# writes .cursor/rules/multi-agent-runtime.mdc

# If you use Claude Code:
agentctl prompt --target claude --write
# upserts a block in CLAUDE.md

# If you use Codex CLI:
agentctl prompt --target codex --write
# writes ~/.codex/skills/multi-agent-runtime/

# Any other shell-capable agent:
agentctl prompt --target generic
# prints the body for you to inspect; skip --write (nothing to install)
```

### Step 4 — Activate one role per agent window

Role binding is per-window, never persisted to a project-shared file.
Open one agent window per role you want to staff, then in that window
paste the snippet printed by `activate`:

```bash
agentctl activate PM --target cursor       # paste into the Cursor window for PM
agentctl activate TL --target claude       # paste into the Claude window for TL
agentctl activate Backend --target codex   # paste into the Codex window for Backend
agentctl activate QA --target cursor       # another Cursor window, this time for QA
```

The pasted snippet tells that specific window to run `agentctl claim
<role>`, export `MA_SESSION`, and enter the runtime loop. Two windows
of the same tool can hold different roles independently.

That's it. From this point, just chat with the agents normally.

---

## What happens when agents are running

Each agent, at the start of every response:

1. Checks its inbox for new messages from other agents.
2. Reads its active tasks from the shared task board.
3. Reads any open proposals (RFCs) it needs to comment on or decide.
4. Does its work, then sends messages, updates task statuses, and logs progress.
5. Goes into a low-cost standby until the next message arrives.

You don't manage any of this — the agents handle it themselves using `agentctl` commands.

### Try it manually

You can drive the whole flow by hand to see how it works:

**Window A — acting as PM:**

```bash
agentctl claim PM
export MA_SESSION=<session id printed by claim>

# Create a task and assign it
agentctl task new --title "Build /login endpoint" --owner Backend --priority P1

# Send a message to TL
agentctl report --to TL --message "Auth scope confirmed. Backend is unblocked."
```

**Window B — acting as Backend:**

```bash
agentctl claim Backend
export MA_SESSION=<session id>

# See everything waiting for you
agentctl plan

# Update the task as you work
agentctl task status T-0001 InProgress
# ... write the code ...
agentctl task status T-0001 Review
agentctl worklog --message "T-0001 done, see commit abc123"

# Confirm you've read and processed everything
agentctl ack --token <token from plan>

# Go standby
agentctl wait
```

---

## How agents make shared decisions (RFCs)

When a decision affects multiple roles — changing the architecture, adjusting scope, picking between two approaches — an agent opens an RFC instead of just acting unilaterally.

```bash
# Any agent can open a proposal
agentctl rfc new switch-to-postgres \
  --title "Move primary store from SQLite to Postgres" \
  --options "A:Migrate now,B:Stay on SQLite" \
  --voters "Backend,DevOps" \
  --deciders "TL"

# Other agents comment
agentctl rfc comment RFC-0001 --option A --rationale "Migration is straightforward."

# Only the designated decider can close it
agentctl rfc decide RFC-0001 --option A --rationale "Agreed. Proceed with migration."
```

Each agent's next `agentctl plan` automatically shows which RFCs need their attention. No one has to track it manually.

---

## What it doesn't do

- **Doesn't work across multiple machines.** Everything runs on one computer. Multi-machine support is planned for a future version.
- **Doesn't call LLMs.** It's a coordination layer. Your existing tool (Cursor, Claude Code, Codex) handles the AI part.
- **Doesn't run a background server.** Every `agentctl` command starts and exits immediately.
- **Doesn't prevent direct file edits.** Agents using `agentctl` can't write outside their assigned scope, but anyone with a terminal and a text editor can still edit files directly.
- **Doesn't run on Windows yet.** Linux and macOS only for now.

---

## Roadmap

| What | Status |
| --- | --- |
| Storage, events, sessions, per-role permissions | Done |
| Agent communication commands (`claim`, `plan`, `ack`, `report`, `worklog`, `wait`) | Done |
| Role setup and prompt generation (`role`, `prompt`) | Done |
| Task board (`task new/assign/status/list/show`) | Done |
| Proposals and decisions (`rfc new/comment/decide/reject`) | Done |
| Collaboration handbook (built-in guidance for agents on when to use which command) | Done |
| Upgrade and reset commands | Up next |
| Health check and event history (`doctor`, `history`) | Planned |
| Multi-machine support via HTTP | Future |

Full details: [docs/ROADMAP.md](./docs/ROADMAP.md)

---

## Documentation

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | The full agent loop — every command the agent uses and when |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | Judgement calls — when to worklog vs report vs open an RFC, when to ask the user |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | What every file under `.multi-agent/` contains |
| [docs/DESIGN.md](./docs/DESIGN.md) | Why things are designed the way they are |
| [CHANGELOG.md](./CHANGELOG.md) | Release history |

---

## Develop locally

```bash
git clone <this repo>
cd codex-agent
npm install
npm run build
npm test
./bin/agentctl --help
```

See [AGENTS.md](./AGENTS.md) for the code layout and contribution conventions.

---

## License

MIT

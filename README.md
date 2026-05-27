# multi-agent-coordination

**Languages:** English · [简体中文](./README.zh-CN.md)

> Let several LLM-agent windows (Codex / Claude Code / Cursor / any
> shell-capable agent) **collaborate on one project** as a team —
> without a server, just files.

You open four IDE windows, point each at the same git repo, and tell
each one which role it plays:

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Codex      │  │  Claude     │  │  Cursor     │  │  Cursor     │
│  role: PM   │  │  role: TL   │  │  role: BE   │  │  role: QA   │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │                │
       └────────┬───────┴────────┬───────┴────────────────┘
                ▼                ▼
           ┌──────────────────────────────────────┐
           │  .multi-agent/   (committed to git)  │
           │    events  │  inbox  │  rfcs         │
           │    state   │  worklog │  sessions    │
           └──────────────────────────────────────┘
```

The PM agent files an RFC, the TL agent comments, the Backend agent
implements once a decision lands, the QA agent reads the worklog and
opens defect reports. Every cross-window message goes through one local
CLI — `agentctl` — so you get atomic writes, ordered events, no lost
messages, and a git-diff-able paper trail of every decision.

---

## When to use this

Pick this up if you:

- Run **multiple LLM agent windows** in the same project and they keep
  stepping on each other or duplicating work.
- Want a **paper trail** of who proposed what, who decided, and why —
  reviewable as plain files in git.
- Need agents to be **role-aware** (PM, tech lead, backend, QA, …) and
  to escalate cross-role decisions properly.
- Want this to work **without a server, without an API key, without a
  database** — just files in your repo.

Skip this if you only have one agent, or if your agents already talk to
each other through a hosted multi-agent framework (LangGraph, AutoGen,
CrewAI, …). This package solves a different problem: making _shell-only,
file-only_ agents safe to combine.

---

## Status

**v2.0.0-alpha.2.** The storage core, the per-turn agent loop
(`claim` / `plan` / `ack` / `report` / `worklog` / `release` /
`wait`), and the user-facing setup commands (`role create / list /
show`, `prompt --target codex|claude|cursor|generic --write`) are
implemented and covered by 64 tests. Still to come: per-turn role
reminder, task board, RFCs, ownership enforcement, doctor — see
[docs/ROADMAP](./docs/ROADMAP.md).

If you want to follow along, watch the `v2` branch.

---

## Install

Requires Node.js 20 or newer.

```bash
# Install globally for the agentctl command:
npm install -g multi-agent-coordination

# …or run on demand with npx:
npx multi-agent-coordination --help
```

(During alpha you can clone this repo instead — see
[Develop locally](#develop-locally).)

---

## Quickstart

The user does steps 1–4 **once** per project. After that, the user only
opens agent windows and drops in the activation snippets; the agents
themselves call the rest of the CLI on every turn.

### 1. Initialise the project

```bash
cd /path/to/your/project
agentctl init
# Initialised multi-agent layer (v2.0.0) at /path/to/your/project/.multi-agent
```

The created `.multi-agent/` tree is plain text + JSON, safe to commit
to git. Full schema: [docs/SCHEMA.md](./docs/SCHEMA.md).

### 2. Create the roles you want

```bash
agentctl role create PM "Product Manager"   --description "Owns scope and acceptance"
agentctl role create TL "Tech Lead"         --description "Owns architecture and integration order"
agentctl role create Backend "Backend Engineer"
agentctl role create QA "Quality Assurance"

agentctl role list
# PM           Product Manager
# TL           Tech Lead
# Backend      Backend Engineer
# QA           Quality Assurance
```

Each `role create` writes both `.multi-agent/config.yaml` (machine
truth) and `.multi-agent/roles/<id>.md` (human contract). Edit
`config.yaml` to set `owns`, `reportsTo`, `mustNotEdit`.

### 3. Install the runtime artifact for each agent host

For every agent host you plan to use, run `prompt --write` once. The
artifact is role-agnostic; you do not run this per role.

```bash
# If you use Cursor:
agentctl prompt PM --target cursor --write
# → writes .cursor/rules/multi-agent-runtime.mdc (alwaysApply: true)

# If you use Claude Code:
agentctl prompt PM --target claude --write
# → upserts a marker block inside CLAUDE.md

# If you use Codex CLI:
agentctl prompt PM --target codex --write
# → writes ~/.codex/skills/multi-agent-runtime/{SKILL.md, agents/openai.yaml}

# For any other shell-capable agent:
agentctl prompt PM --target generic
# → prints the full prompt for you to paste manually
```

`prompt` also prints a short **activation snippet** at the end. You
paste that snippet into each agent window's chat to bind it to a role.

### 4. Open one agent window per role

For example, if PM is a Cursor window and Backend is a Codex window:

- Open a Cursor window in this project. The runtime rule loads
  automatically. Paste the activation snippet from
  `agentctl prompt PM --target cursor`. The agent will then run
  `agentctl claim PM`, export `MA_SESSION`, and enter its loop.
- Open a Codex shell in this project. Paste the activation snippet from
  `agentctl prompt Backend --target codex`. The agent activates the
  `$multi-agent-runtime` skill and does the same.

That is the full setup. From here on **the user only chats with the
agents**; the CLI is theirs.

### What the agent does every turn

Documented in [docs/PROTOCOL.md](./docs/PROTOCOL.md). The short version:

```bash
agentctl plan                          # JSON manifest of unread work + ackToken
# ... agent processes events, may call:
agentctl report  --to <role> --message "<text>"
agentctl worklog --message "<text>"
# ... then:
agentctl ack --token <ackToken>        # advance cursor exactly to the manifest snapshot
agentctl wait                          # block-sleep without burning tokens; ATTENTION or IDLE
```

### Bonus: see it work without agents

You can drive the same loop by hand in two shells to feel out the
protocol.

**Shell A (PM):**

```bash
agentctl claim PM
export MA_SESSION=<paste session id from claim>
agentctl report  --to TL --message "Goals locked in for Q3"
agentctl worklog --message "Drafted acceptance for T-0001"
```

**Shell B (TL):**

```bash
agentctl claim TL
export MA_SESSION=<paste session id>
agentctl plan                              # sees PM's report + worklog
agentctl ack --token <ackToken from plan>
agentctl wait --idle 1                     # IDLE after a 1-minute sleep
```

---

## Core ideas in 60 seconds

- **Roles, not agents.** A role like `PM` is permanent and lives in
  the repo. Any LLM window can be assigned to play it by holding a
  fresh _session lease_.
- **One CLI mediates everything.** Agents never touch `.multi-agent/`
  with raw `cat`/`sed`/`echo`. They call `agentctl`, which atomically
  writes JSON and emits events. This is what makes the coordination
  layer safe across concurrent windows.
- **Events are immutable JSON files.** One event = one file in
  `comms/events/`, named by a sortable ULID. No shared log file means
  no torn reads, no escaping bugs, no global mutex.
- **Cursors advance only by token.** Each agent calls `plan` to get a
  manifest of what is unread, then `ack --token` to advance. The
  cursor cannot skip past anything the agent did not see — fixing the
  classic "ack races a concurrent write" footgun.
- **RFCs gather opinions, a leader decides.** Any role can comment on
  an RFC. Only roles listed in `deciders` can transition the RFC to
  `accepted` / `rejected`. No automatic tallies.

Full architectural reasoning: [docs/DESIGN.md](./docs/DESIGN.md).

---

## Capability boundaries

What this layer does, and the things it intentionally does not do.

**It does:**

- Coordinate any number of agent windows in **one git repository on one
  machine**.
- Survive crashes mid-turn: the next window for a role can pick up the
  outstanding manifest deterministically.
- Provide stable exit codes for every error class — scripts and agents
  can branch on `2` (usage), `3` (not initialised), `6` (lock timeout),
  etc.
- Work with **any agent runtime that can run a shell command and read
  JSON**. There is nothing Codex- or Cursor-specific in the core.

**It does not:**

- **Run on multiple machines.** The locking and rename semantics assume
  one host. NFS / Dropbox / iCloud will silently break lock detection.
  HTTP transport is on the roadmap (v2.x).
- **Call LLMs.** This is a coordination layer, not an agent framework.
  Your existing tool (Codex / Claude Code / Cursor) does the LLM calls.
- **Run a daemon.** Every command is a short-lived process. (An
  optional `agentctl watch` for stale-session cleanup is v2.x.)
- **Enforce role write-scope at the OS level today.** The contract is
  already in `config.yaml` (introduced in PR3), but write-time
  enforcement lands in PR7; until then, agents are expected to follow it.
- **Support Windows out of the box yet.** Code targets POSIX semantics
  (rename onto open file, `process.kill(pid, 0)`). Windows is on the
  v2.x roadmap.
- **Replace git.** Audit lives inside the repo as plain files so you
  use git to review and revert.

If any of these are a deal-breaker, see
[docs/ROADMAP.md](./docs/ROADMAP.md) — most are scheduled.

---

## Roadmap highlights

| Milestone | What lands | Status |
| --- | --- | --- |
| PR1  | Storage core, locks, events, cursors, sessions | **Done** |
| PR2  | `claim` / `plan` / `ack` / `report` / `worklog` | **Done** |
| PR3  | `role create / list / show`, `prompt --target … --write`, `wait` | **Done** |
| PR4  | Manifest `roleReminder` for context-compressed agents | Next up |
| PR5  | Task board (`state/task_board.yaml`, `agentctl task *`) | Planned |
| PR6  | RFC state machine (comments + leader decides) | Planned |
| PR7  | `config.yaml`-driven role ownership enforcement | Planned |
| PR8  | `agentctl upgrade` / `reset`, schema migrations | Planned |
| PR9  | `agentctl doctor`, history, event archival | Planned |
| PR10 | Chaos / concurrency soak suite | Planned |
| v2.x | HTTP transport, watcher daemon, Windows, NFS | Deferred |

Full plan: [docs/ROADMAP.md](./docs/ROADMAP.md).

---

## Documentation

| Document | Read this when … |
| --- | --- |
| [docs/DESIGN.md](./docs/DESIGN.md) | You want to know _why_ the layer is shaped this way. |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | You need the exact file/JSON layout under `.multi-agent/`. |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | You are wiring an agent to talk to `agentctl`. |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | You want to know what is shipping next. |
| [CHANGELOG.md](./CHANGELOG.md) | You want release notes. |
| [AGENTS.md](./AGENTS.md) | You are editing this repo (human or agent). |

---

## Develop locally

```bash
git clone <this repo>
cd codex-agent
npm install
npm run build
npm test                # 19 vitest cases, ~1.3 s
./bin/agentctl --help
```

The package layout, coding conventions, and "do not reintroduce v0.1"
guardrails are in [AGENTS.md](./AGENTS.md).

---

## License

MIT.

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

**v2.0.0-alpha.1.** The storage core and the per-turn agent loop
(`claim` / `plan` / `ack` / `report` / `worklog` / `release`) are
implemented and covered by 39 tests. Still to come: `wait`, RFCs,
ownership enforcement, doctor — see [docs/ROADMAP](./docs/ROADMAP.md).

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

This walks through what works **today** (PR1 — storage core). You will:

1. Initialise the coordination layer in a project.
2. Inspect the layout it creates.
3. Verify the schema version.

### 1. Initialise a project

```bash
cd /path/to/your/project
agentctl init
```

You will see:

```
Initialised multi-agent layer (v2.0.0) at /path/to/your/project/.multi-agent
```

This creates the `.multi-agent/` directory and is **safe to commit to
git** — everything in it is plain text or JSON, designed for code
review.

### 2. Inspect what was created

```bash
ls .multi-agent
# VERSION  comms/  locks/  protocol/  rfcs/  roles/  state/  worklog/
```

| Path | What lives here |
| --- | --- |
| `roles/<role>.md` | The contract for each role (responsibilities, scope) |
| `state/` | Shared project state (goals, task board, decisions, risks) |
| `comms/events/` | Append-only event stream as one JSON file per event |
| `comms/inbox/<role>/` | Per-role message queue |
| `comms/cursors/<role>.json` | Each role's "last read" pointer |
| `comms/sessions/<role>.json` | Which window currently holds each role |
| `rfcs/RFC-NNNN-<slug>/` | One directory per cross-role decision |
| `worklog/<role>/` | Each role's progress journal |
| `locks/` | Short-lived file locks (transient) |

Full schema reference: [docs/SCHEMA.md](./docs/SCHEMA.md).

### 3. Check the layer's schema version

```bash
agentctl version
# agentctl 2.0.0-alpha.0
# schema   2.0.0
```

JSON output is available everywhere for scripts and LLM agents:

```bash
agentctl version --json
# {"cli":"2.0.0-alpha.0","schema":"2.0.0"}
```

### 4. Walk through a two-role scenario

Open two shells in the same project to see PM and TL collaborate.

**Shell A (PM):**

```bash
agentctl claim PM                           # prints a session id
export MA_SESSION=<paste session id>
agentctl report  --to TL --message "Goals locked in for Q3"
agentctl worklog --message "Drafted acceptance for T-0001"
```

**Shell B (TL):**

```bash
agentctl claim TL
export MA_SESSION=<paste session id>
agentctl plan                               # see PM's report + worklog
# … process the events …
agentctl ack --token <ack-token from plan>  # advances TL's cursor
agentctl plan                               # now empty
```

Every step is atomic and recorded under `.multi-agent/comms/events/`.
The agent loop preview that used to live here is now real; only
`agentctl wait` (the cheap-keepalive primitive) is still scheduled — see
the [roadmap](#roadmap-highlights).

The wire-level contract is in [docs/PROTOCOL.md](./docs/PROTOCOL.md).

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
  documented and will become enforced through `config.yaml` ownership
  checks in PR5; until then, agents are expected to follow it.
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
| PR1 | Storage core, locks, events, cursors, sessions | **Done** |
| PR2 | `claim` / `plan` / `ack` / `report` / `worklog` | **Done** |
| PR3 | `wait` for cheap token-free keepalive | Next up |
| PR4 | RFC state machine (comments + leader decides) | Planned |
| PR5 | `config.yaml`-driven role ownership enforcement | Planned |
| PR6 | Installer, `upgrade`, `reset`, AGENTS.md bridge | Planned |
| PR7 | `agentctl doctor`, history, event archival | Planned |
| PR8 | Chaos / concurrency soak suite | Planned |
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

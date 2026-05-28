# multi-agent-coordination

**Languages:** English · [简体中文](./README.zh-CN.md)

> A local CLI that lets multiple AI agent windows (Cursor, Claude Code, Codex CLI, ...) collaborate on the same project — no server, no database, just files in your repo that you `git diff`.

---

## What this is, and who it's for

You open Cursor for frontend work, Claude Code for backend, Codex CLI for a PM role. They all read the same codebase but they don't talk to each other. They duplicate work, make conflicting decisions, and there's no record of what was agreed.

This tool gives each agent a **role** (PM, Tech Lead, Backend, QA, ...), a private inbox, a shared task board, and an RFC mechanism for cross-role decisions. Agents communicate through a local CLI called `agentctl`. Every message, decision, and status change is a plain file under `.multi-agent/` in your repo.

Use it if you run two or more agent windows per project and they keep stepping on each other. Skip it if you only run one agent at a time, or if you're already on a hosted multi-agent platform (LangGraph, AutoGen, CrewAI) — those solve a different problem.

Requires Node.js 20+. Linux and macOS only for now.

---

## Mental model (three sentences)

1. **The CLI is the source of truth, not chat.** Anything that needs to outlive a conversation goes through `agentctl`.
2. **`.multi-agent/` is a shared blackboard with strict ownership.** Each role's `owns` declares which files it may write; the CLI refuses cross-role edits. You can `git diff` to see what changed.
3. **Agents run a loop you do not micromanage.** You set up roles and write project state; agents fetch their inbox, do work, log it, and idle. You only chat with them.

---

## Your job vs the agent's job

This is the most common confusion. Here is the boundary, once.

| Action | Who does it | When |
| --- | --- | --- |
| `agentctl init` | You | Once, when adopting the tool in a project |
| `agentctl role create / delete` | You | Adding or removing a team member |
| Fill in `roles/<id>.md` (description, responsibilities) | You | Right after `role create` |
| `agentctl prompt --target X --write` | You | Once per agent host (Cursor / Claude / Codex) |
| `agentctl activate <role> --target X` | You | Once per agent window you want to staff |
| Write product scope / acceptance criteria in `state/project_state.md` | You | As the project evolves |
| Upgrade the tool, re-run `prompt --write --force-rewrite`, restart windows | You | When you bump the CLI version |
| `agentctl claim / plan / ack / wait / report / worklog / task ... / rfc ...` | The agent | Every turn, automatically |
| Write code, write docs, run tests | The agent | When you give it a task |
| `agentctl state edit` to project files inside its `owns` (overwrite / append / replace modes) | The agent | When the role's contract says so |

If you find yourself running `agentctl plan` or `claim` by hand, you are probably driving the flow manually for debugging. That's fine — see [Driving it by hand](#driving-it-by-hand-for-debugging) below.

---

## One-time setup (you, in your shell)

Four steps. After this, you only chat with the agents.

### Step 1 — Initialise

```bash
cd /path/to/your-project
agentctl init
```

This creates `.multi-agent/` with the coordination state and is safe to commit to git.

### Step 2 — Register roles, then fill in their contracts

```bash
agentctl role create PM      "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL      "Tech Lead"         --owns "state/architecture.md"
agentctl role create Backend "Backend Engineer"
agentctl role create QA      "Quality Assurance"
```

Each `role create` writes a `.multi-agent/roles/<id>.md` template with two placeholder sections: **Role description** and **Responsibilities**, both marked `TBD`. **Open each file and fill them in** — they are the agent's primary self-introduction. `agentctl role list` flags rows that still contain TBD; `agentctl activate` refuses to proceed until they are filled.

The `--owns` flag controls which files the role may write. Entries are either specific file paths or directory prefixes — `--owns "docs/architecture/"` matches every file under `docs/architecture/` recursively, so a CTO/TL role can take a whole subtree without listing files one by one. Agents using `agentctl` cannot write outside their `owns`; any attempt fails with exit code `9 FORBIDDEN`.

Two more role-create flags worth knowing about:

- `--reports-to PM,TL` — the role's escalation chain. The handbook tells the agent to escalate stuck work up this chain via `report`. Example: a `Backend` role created with `--reports-to TL,PM` will escalate technical questions to TL and scope/acceptance questions to PM.
- `--must-not-edit state/architecture.md` — a hard deny list, overrides `--owns`. Use when a role has a broad `owns` grant but you want a few specific files out of bounds (e.g. `Backend --owns "src/" --must-not-edit "src/config/secrets.ts"`).

A worked example with all three flags:

```bash
agentctl role create PM       "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
agentctl role create TL       "Tech Lead"         --owns "state/architecture.md,docs/architecture/" --reports-to PM
agentctl role create Backend  "Backend Engineer"  --owns "src/" --reports-to TL,PM --must-not-edit "src/config/secrets.ts"
```

### Step 3 — Install the runtime for each agent tool you use

```bash
# Cursor: writes .cursor/rules/multi-agent-runtime.mdc
agentctl prompt --target cursor --write

# Claude Code: upserts a marker block in CLAUDE.md
agentctl prompt --target claude --write

# Codex CLI: writes ~/.codex/skills/multi-agent-runtime/
agentctl prompt --target codex --write

# Any other shell-capable agent (prints body; nothing installed)
agentctl prompt --target generic
```

**Run this before opening the agent window.** Cursor / Claude Code / Codex inject these rule files into the agent's system prompt only when the agent window first opens. If a window is already open when you run `prompt --write`, restart it before chatting — the new rule will not take effect in an already-running window. The CLI prints an IMPORTANT notice every time something was written.

Re-running `prompt --write` on the same project is idempotent. If the file is byte-identical you'll see `UNCHANGED (already up to date)` and nothing on disk changes. Pass `--force-rewrite` to overwrite from the current template anyway — useful after upgrading the CLI to confirm the install is fresh.

### Step 4 — Activate one role per agent window

Role binding is per-window. The `activate` command prints a chat-paste snippet — auto-copied to your clipboard when possible — and tells the agent how to claim the role, read its own contract, and skim `agentctl -h`.

```bash
agentctl activate PM      --target cursor   # paste into the Cursor window for PM
agentctl activate TL      --target claude   # paste into the Claude window for TL
agentctl activate Backend --target codex    # paste into the Codex window for Backend
agentctl activate QA      --target cursor   # another Cursor window, this time for QA
```

The snippet appears between `═══ BEGIN PASTE TO AGENT ═══` and `═══ END PASTE TO AGENT ═══` dividers. The dividers themselves are descriptive — do not paste them.

Two windows of the same tool can hold different roles independently because the role lives in that window's `MA_SESSION` shell variable, not in any project file.

From here, just chat with the agents normally.

---

## What you still need to write by hand

These files are project content. The CLI does not create them; you and your agents fill them as the project evolves.

- **`.multi-agent/state/project_state.md`** — vision, milestones, and per-task acceptance criteria. `agentctl init` seeds a TBD skeleton with these three sections; **your job is to fill the TBD placeholders**. The product-owner role (typically PM, whoever owns this file per `config.yaml`) keeps it up to date as the project evolves. The handbook tells agents to ask you to fill any section that is still marked TBD before they judge a task Done — so the longer this file stays empty, the more interrupting questions you'll get. Suggested minimum:

  ```markdown
  # Project state

  ## Vision
  One paragraph — what we're building, for whom, what's out of scope.

  ## Milestones
  - M1: ... due ...
  - M2: ...

  ## Acceptance criteria
  - T-0001 Build /login: returns 200, password bcrypt, lock after 5 failed attempts in 5 min
  - T-0002 ...
  ```

  The third section is where the value lives — concrete acceptance per task is what lets agents decide Done without you in the loop.

- **`.multi-agent/state/architecture.md`** — written by the role that `owns` it (typically TL). You read and review.

- **`.multi-agent/state/decisions.md`** — narrative complement to the RFC archive. Optional but useful.

- **`.multi-agent/roles/<id>.md`** — the description / responsibilities sections. You fill these once at role creation time.

---

## Driving it by hand (for debugging)

You can drive the whole flow from a terminal to understand it. None of these commands are part of a user's daily flow — they're what the agent runs automatically once activated.

**Window A — acting as PM:**

```bash
eval "$(agentctl claim PM --eval)"            # claims and exports MA_SESSION in one step

# Simple case
agentctl task new --title "Build /login endpoint" --owner Backend --priority P1

# With a parent epic, reference doc, and a hard deliverable:
agentctl task new --title "Build /login endpoint" --owner Backend --priority P1 \
  --parent T-0010 \
  --tag auth \
  --asset 'file:docs/specs/auth.md::Auth spec' \
  --asset 'url:https://figma.com/file/xxx::Login UI design' \
  --deliverable 'file:apps/api/auth/login.ts::Implementation' \
  --deliverable 'file:docs/api/login.md::API doc'

agentctl report --to TL --message "Auth scope confirmed. Backend is unblocked."
```

The deliverable lines mean: Backend cannot mark T-0011 Done until
both files exist on disk. If a reviewer waives a deliverable, Backend
runs `agentctl task status T-0011 Done --force-incomplete` and the
bypass lands in the event stream for audit.

**Window B — acting as Backend:**

```bash
eval "$(agentctl claim Backend --eval)"

agentctl plan                                  # what's waiting for you
agentctl task status T-0001 InProgress
# ...write the code...
agentctl task status T-0001 Review
agentctl worklog --message "T-0001 done, see commit abc123"
agentctl ack --token <token from plan>         # confirm processed
agentctl wait --in 10m                         # idle until attention or 10 min
# or, when you genuinely have no task:
agentctl wait --in 1h --for task-assigned      # also broadcasts "I'm idle"
```

When done with a role for the day:

```bash
agentctl release
unset MA_SESSION
```

### Brainstorm (RFC without `--options`)

When three or more roles need to weigh in on a question with no
concrete options yet, open an RFC without `--options`:

```bash
agentctl rfc new q3-priorities \
  --title "Q3 priorities — what should we be optimising for?" \
  --deciders TL --voters PM,Backend,Frontend,DevOps \
  --description "Performance, growth, or reliability? Drop ideas, risks, and follow-ups."

# Voters post freely — no option required
agentctl rfc comment RFC-0001 --rationale "Idea: focus on perf; we lost two churned accounts to latency."
agentctl rfc comment RFC-0001 --rationale "Risk: aborting feature X mid-flight upsets enterprise tier." --reply-to <prev-id>

# Once a concrete choice emerges, anyone can lift it into the option list
agentctl rfc add-option RFC-0001 --option perf:'Q3 = perf-only' --rationale "From discussion above."

# Either close without picking (takeaway-only):
agentctl rfc decide RFC-0001 --rationale "Discussion: revisit in Q4; no specific commitment now."
# Or, after add-option, close with a pick (normal RFC flow):
agentctl rfc decide RFC-0001 --option perf --rationale "Going with perf-only."
```

---

## Common situations

### Add a new role

```bash
agentctl role create Frontend "Frontend Engineer"
# fill in roles/Frontend.md
agentctl activate Frontend --target cursor
# open a new Cursor window and paste
```

The Cursor / Claude / Codex runtime rule is already installed; no need to re-run `prompt --write`.

### Remove a role

```bash
# In a shell with no MA_SESSION exported (role delete is project-governance):
unset MA_SESSION
agentctl role delete Frontend
```

Open task assignments owned by `Frontend` are left in place — recreating a role with the same id reinherits them. To reassign instead, use `agentctl task assign <task-id> --to <other-role>`. Any agent window that still has the deleted role's `MA_SESSION` exported will fail with USAGE on the next command; restart that window or claim a new role there.

### Upgrade the CLI

```bash
npm install -g multi-agent-coordination@latest
agentctl prompt --target cursor --write --force-rewrite   # repeat per host
# Restart every open agent window.
```

`--force-rewrite` skips the byte-equal short-circuit; useful when the runtime template was bumped and you want to confirm the install is fresh.

### "The agent says it doesn't know who it is"

Three usual causes:

1. **`MA_SESSION` is not exported in the agent's shell.** The activation snippet runs `eval "$(agentctl claim ... --eval)"` which sets it; if the agent skipped that step (some weaker models do), re-paste the snippet.
2. **The window was open before you ran `prompt --write`.** Hosts inject rules at window-open time. Restart the window.
3. **The role's markdown is still mostly TBD.** Run `agentctl role show <role>` to inspect; if it's empty, fill in `roles/<id>.md` and re-paste the activation snippet.

### "Two agents both want to claim the same role"

The second window will see "already claimed by a live session ...". The handbook tells the agent to stop and ask the user — do not pass `--force`. If the first window is genuinely dead (you killed the tab), wait for the lease to expire (~30 min default) or release explicitly: `agentctl release <role>` from a shell with that role's `MA_SESSION`.

### "I deleted my chat history but the role is stuck"

```bash
unset MA_SESSION              # in case you still have it
agentctl release <role>       # from a shell that holds the session, or
# wait ~30 min for the lease to expire automatically
```

---

## How decisions get made (RFCs)

When a decision touches multiple roles' `owns` or the architecture, an agent opens an RFC instead of acting unilaterally. RFCs support real multi-round discussion: threaded comments, options added mid-flight, a "send back for rewrite" path, and a structured pre-decide round where every required role must explicitly `ack` or `object` before the decider can finalise (silence is never consent). Full walkthrough in [docs/RFC.md](./docs/RFC.md); a quick tour:

```bash
# Any agent can open. --description is the context anyone-not-in-the-
# conversation needs; --task links the work this RFC is decided in
# the context of.
agentctl rfc new switch-to-postgres \
  --title       "Move primary store from SQLite to Postgres" \
  --description "Login latency root-caused to SQLite write contention; A is the migration, B is a tuning band-aid." \
  --options     "A:Migrate now (4 weeks),B:WAL tuning first" \
  --voters      "Backend,DevOps" \
  --deciders    "TL" \
  --task        T-0042

# Voters comment; replies thread under another comment by id.
agentctl rfc comment RFC-0001 --option A --rationale "Migration is straightforward."
agentctl rfc comment RFC-0001 --reply-to 01HZA...COMM1 --rationale "Can M2 slip 2 weeks?"

# Anyone with a session can add an option mid-discussion if the
# existing ones are inadequate.
agentctl rfc add-option RFC-0001 --option "C:Managed Postgres on RDS" --rationale "Captures the cost dimension."

# Pre-decide: decider posts a structured "I lean X" comment.
# Every voter + non-pre-decider decider MUST run rfc ack or rfc object
# before rfc decide will succeed. Silence is not consent.
agentctl rfc pre-decide RFC-0001 --option C --rationale "Lean C; please ack or object."
agentctl rfc ack    RFC-0001                                     # I agree
agentctl rfc object RFC-0001 --rationale "Cost concern" --option B  # I disagree

# Decider can also send a thin proposal back for rewrite without
# rejecting the topic.
agentctl rfc revise RFC-0001 --rationale "Add a paragraph on the operating cost."
agentctl rfc edit   RFC-0001 --rationale "Added cost paragraph." --description "<rewritten>"

# Only deciders can finally close (anyone else gets exit 9 FORBIDDEN).
agentctl rfc decide RFC-0001 --option C --rationale "Agreed. Proceed."
```

Open RFCs that need a role's attention appear in that role's next `agentctl plan` automatically, with `unreadComments` so the agent can prioritise. `agentctl rfc show <id>` advances the role's read marker for that RFC.

---

## What this doesn't do

- **Doesn't work across multiple machines.** Single-host only; multi-machine over HTTP is on the roadmap.
- **Doesn't call LLMs.** Coordination only; your existing tool (Cursor / Claude / Codex) is the AI.
- **Doesn't run a background server.** Every `agentctl` invocation starts and exits.
- **Doesn't prevent hand-editing files.** Agents through `agentctl` are scoped; anyone with a text editor still has full access.
- **Doesn't provide a `read-state` command.** Reading is unrestricted (the layer is a shared blackboard) and the agent host already has a file-read tool — wrapping it in `agentctl` would only add token cost. `agentctl` mediates **writes** (which need ownership, atomicity, audit) and **structured operations** (claim / plan / ack / task / rfc / report). Read the files directly.
- **Doesn't run on Windows yet.** macOS and Linux only.

---

## Roadmap

| What | Status |
| --- | --- |
| Storage, events, sessions, per-role ownership | Done |
| `claim`, `plan`, `ack`, `report`, `worklog`, `wait` | Done |
| `role` + `prompt` + `activate` (role-free runtime, per-window activation) | Done |
| Task board (`task new/assign/status/list/show`) | Done |
| RFCs v2.1: threaded comments, `add-option`, `pre-decide` + mandatory `ack`/`object` gate, `revise`/`edit`, `link-task` | Done |
| Collaboration handbook injected into runtime | Done |
| `role delete` with session and config cleanup | Done |
| `agentctl upgrade` and `reset` | Next |
| `doctor`, event history, archival | Planned |
| Multi-machine over HTTP | Future |

Full details: [docs/ROADMAP.md](./docs/ROADMAP.md)

---

## Documentation

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Wire-level contract — every command, manifest shape, ack semantics |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | Judgement rules: when to worklog vs report vs RFC; escalation; what NOT to bounce to the user |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | What every file under `.multi-agent/` contains and who creates it |
| [docs/RFC.md](./docs/RFC.md) | RFC mechanism end-to-end: model, state machine, on-disk layout, worked example |
| [docs/DESIGN.md](./docs/DESIGN.md) | Why things are designed the way they are |
| [docs/RELEASE.md](./docs/RELEASE.md) | How to cut a new version (maintainer) |
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

If you want the global `agentctl` to point at your working copy:

```bash
npm link                # registers ./bin/agentctl as the global one
npm run build           # rebuild after every source change, or:
npm run watch           # incremental tsc on every save
```

The linked binary loads `dist/cli/index.js`, so changes are only visible after a build. See [AGENTS.md](./AGENTS.md) for code layout and contribution conventions.

---

## License

MIT

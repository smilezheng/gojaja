# gojaja (过家家)

**Languages:** English · [简体中文](./README.zh-CN.md)

> A local CLI that lets multiple AI agent windows (Cursor, Claude Code, Codex CLI, ...) collaborate on the same project — no server, no database, just files in your repo that you `git diff`.

The name "过家家" (guò-jiā-jiā) is a Chinese phrase for kids' role-play games where each kid takes on a family role and pretends together — which is what this tool lets your LLM agents do on a shared codebase.

---

## What this is, and who it's for

You open Cursor for frontend work, Claude Code for backend, Codex CLI for a PM role. They all read the same codebase but they don't talk to each other. They duplicate work, make conflicting decisions, and there's no record of what was agreed.

This tool gives each agent a **role** (PM, Tech Lead, Backend, QA, ...), a private inbox, a shared task board, and an RFC mechanism for cross-role decisions. Agents communicate through a local CLI called `gojaja`. Every message, decision, and status change is a plain file under `.gojaja/` in your repo.

Use it if you run two or more agent windows per project and they keep stepping on each other. Skip it if you only run one agent at a time, or if you're already on a hosted multi-agent platform (LangGraph, AutoGen, CrewAI) — those solve a different problem.

Requires Node.js 20+. Linux and macOS only for now.

---

## Install

The CLI is published on [npm](https://www.npmjs.com/package/gojaja). Install it globally with either package manager:

```bash
npm install -g gojaja
# or
pnpm add -g gojaja
```

Check that it is on your `PATH`:

```bash
gojaja --version
gojaja help
```

Prefer not to install globally? Run a one-off command instead:

```bash
npx gojaja@latest watch
# or
pnpm dlx gojaja watch
```

---

## Mental model (three sentences)

1. **The CLI is the source of truth, not chat.** Anything that needs to outlive a conversation goes through `gojaja`.
2. **`.gojaja/` is a shared blackboard with strict ownership.** Each role's `owns` declares which files it may write; the CLI refuses cross-role edits. You can `git diff` to see what changed.
3. **Agents run a loop you do not micromanage.** You set up roles and write project state; agents fetch their inbox, do work, log it, and idle. You only chat with them.

---

## Your job vs the agent's job

This is the most common confusion. Here is the boundary, once.

| Action | Who does it | When |
| --- | --- | --- |
| `gojaja init` | You | Once, when adopting the tool in a project |
| `gojaja role create / delete` | You | Adding or removing a team member |
| Fill in `roles/<id>.md` (description, responsibilities) | You | Right after `role create` |
| `gojaja prompt --target X --write` | You | Once per agent host (Cursor / Claude / Codex) |
| `gojaja activate <role> --target X` | You | Once per agent window you want to staff |
| `gojaja watch` | You | Whenever you want to see overall progress (keep a browser tab open; optional) |
| Write product scope / acceptance criteria in `state/project_state.md` | You | As the project evolves |
| Upgrade the tool, re-run `prompt --write --force-rewrite`, restart windows | You | When you bump the CLI version |
| `gojaja claim / plan / ack / wait / report / worklog / task ... / rfc ...` | The agent | Every turn, automatically |
| Write code, write docs, run tests | The agent | When you give it a task |
| `gojaja state edit` to project files inside its `owns` (overwrite / append / replace modes) | The agent | When the role's contract says so |

If you find yourself running `gojaja plan` or `claim` by hand, you are probably driving the flow manually for debugging. That's fine — see [Driving it by hand](#driving-it-by-hand-for-debugging) below.

---

## Quickstart — drive everything from `gojaja watch` (recommended)

The dashboard handles every setup step you used to need a terminal for. **One command, then point and click.** No `init` / `role create` / `prompt --write` / `activate` typed by hand unless you want to.

```bash
cd /path/to/your-project
gojaja watch                    # serves http://127.0.0.1:7421 and opens your browser
```

(Install the CLI first if needed — see [Install](#install) above.)

A browser tab opens automatically. Walk through it:

1. **Initialise** — if `.gojaja/` is missing the dashboard shows a single full-screen *Initialise this project* button. Click it. (For non-git roots or repos with uncommitted changes the button explains the trade-off and asks for a one-click confirmation — same gate as the CLI's `[y/N]` prompt, just rendered in HTML.)
2. **Create roles** — switch to the **Setup** tab → *Create role* card. Fill `id` / `title` / `owns` (and `reportsTo` / `mustNotEdit` if you need them), click *Create role*. Repeat for each role on your team (PM, Backend, TL, ...).
3. **Fill each role contract** — open `.gojaja/roles/<id>.md` in your editor and replace the `TBD` placeholders (Role description + Responsibilities). The dashboard's *Activate* step refuses to issue a snippet for a role whose markdown is still TBD, so this step is gating-by-design rather than nagware.
4. **Install the runtime** — *Setup* tab → *Install runtime files* card. Pick the target host (`agents` covers Cursor / Codex / Copilot / Windsurf / Zed; pick `claude` if you use Claude Code). Click *Install*. The card tells you to restart any open agent window so the new rule takes effect.
5. **Activate each agent window** — *Setup* tab → *Activate* card. Pick role + target, click *Generate snippet*, then *Copy*. Open the agent window for that role (Cursor tab / Claude Code window / Codex CLI shell) and paste. Repeat once per window you want to staff.
6. **From now on you mostly chat with the agents.** The **Dashboard** tab shows live state across every window (sessions, task board, RFCs, activity feed, plus a red `stalled` flag for any role that forgot to `gojaja wait` after `ack`); the **Actions** tab lets you push a `report --to <role>` / open an RFC / create a task without leaving the browser, all recorded in the audit log as `from: SYSTEM`.

The Setup and Actions tabs only appear when `gojaja watch` is bound to loopback (default `127.0.0.1`). When you share the dashboard over a LAN with `--host 0.0.0.0`, both write tabs hide and the dashboard goes read-only — anyone on the network can spectate, no one can push directives at the team. Ctrl-C in the terminal stops the server.

If you would rather drive the same flow from a shell — to script onboarding, learn the protocol, or just because you prefer the CLI — keep reading; the next section walks through the same four steps as terminal commands.

---

## Setup via the CLI (alternative to the dashboard quickstart)

Four steps. After this, you only chat with the agents.

### Step 1 — Initialise

```bash
cd /path/to/your-project
gojaja init
```

This creates `.gojaja/` with the coordination state and is safe to commit to git.

### Step 2 — Register roles, then fill in their contracts

```bash
gojaja role create PM      "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
gojaja role create TL      "Tech Lead"         --owns "state/architecture.md"
gojaja role create Backend "Backend Engineer"
gojaja role create QA      "Quality Assurance"
```

Each `role create` writes a `.gojaja/roles/<id>.md` template with two placeholder sections: **Role description** and **Responsibilities**, both marked `TBD`. **Open each file and fill them in** — they are the agent's primary self-introduction. `gojaja role list` flags rows that still contain TBD; `gojaja activate` refuses to proceed until they are filled.

The `--owns` flag controls which **shared state files under `.gojaja/`** the role may write (gojaja only mediates files under `.gojaja/` — repo source code is written by the agent with its own editor and scoped by the role's prose responsibilities, not by `owns`). Entries are relative to `.gojaja/` and may be specific files or directory prefixes — `--owns "state/"` matches every file under `state/` recursively, so you don't have to list them one by one. An agent that tries to `gojaja state edit` a file outside its `owns` is refused with exit code `9 FORBIDDEN`.

Two more role-create flags worth knowing about:

- `--reports-to PM,TL` — the role's escalation chain. The handbook tells the agent to escalate stuck work up this chain via `report`. Example: a `Backend` role created with `--reports-to TL,PM` will escalate technical questions to TL and scope/acceptance questions to PM.
- `--must-not-edit state/architecture.md` — a hard deny list, overrides `--owns`. Use when a role has a broad `owns` grant (e.g. all of `state/`) but you want a specific file out of bounds (e.g. `state/architecture.md`, which belongs to TL).

A worked example with all three flags:

```bash
gojaja role create PM       "Product Manager"   --owns "state/project_state.md,state/task_board.yaml"
gojaja role create TL       "Tech Lead"         --owns "state/architecture.md,state/decisions.md" --reports-to PM
gojaja role create Backend  "Backend Engineer"  --owns "state/" --reports-to TL,PM --must-not-edit "state/architecture.md"
```

### Step 3 — Install the runtime

`AGENTS.md` is the canonical runtime file. As of 2026 it's a cross-tool standard — read by Codex, Cursor, Copilot, Windsurf, Zed, and more — so one file covers almost everything:

```bash
# Canonical: writes a managed block in AGENTS.md. This is all most
# projects need (covers Cursor, Codex, and most CLI agents).
gojaja prompt --target agents --write
```

The **only** common exception is **Claude Code**, which doesn't read `AGENTS.md` natively yet (it reads `CLAUDE.md`). If you use Claude Code, use the `claude` target — it writes `AGENTS.md` (canonical) **plus** a one-line `CLAUDE.md` that just imports it, so there's still a single source of truth:

```bash
# Use this instead of --target agents if you use Claude Code:
gojaja prompt --target claude --write   # writes AGENTS.md + a CLAUDE.md @AGENTS.md importer
```

Other targets:

```bash
gojaja prompt --target cursor --write   # OPTIONAL standalone .cursor/rules/*.mdc
gojaja prompt --target generic          # prints the body; installs nothing
```

`--target cursor` is a **fallback** — Cursor already reads `AGENTS.md`, so only use it for old Cursor versions or `.mdc`-specific features (glob scoping). Don't stack it on top of `AGENTS.md`, or Cursor injects the same block twice (wasteful, not harmful); the CLI warns you when multiple full-runtime files coexist.

**Run this before opening the agent window.** Hosts inject these files into the agent's system prompt only when the agent window first opens. If a window is already open when you run `prompt --write`, restart it before chatting — the new rule will not take effect in an already-running window. The CLI prints an IMPORTANT notice every time something was written.

Re-running `prompt --write` on the same project is idempotent. If the file is byte-identical you'll see `UNCHANGED (already up to date)` and nothing on disk changes. Pass `--force-rewrite` to overwrite from the current template anyway — useful after upgrading the CLI to confirm the install is fresh.

### Step 4 — Activate one role per agent window

Role binding is per-window. Note: `activate` is a command **you run in your own terminal** — it is **not** something you hand to the agent. It prints (and, when possible, copies) a **snippet**; that snippet is what you paste into the agent window, and it tells the agent how to claim the role, read its own contract, and skim `gojaja -h`.

Run one per window you want to staff (swap `<role>`; pick the `--target` matching that window's host):

```bash
gojaja activate PM      --target agents
gojaja activate TL      --target claude
gojaja activate Backend --target agents
```

Each command's output is wrapped in `═══ BEGIN PASTE TO AGENT ═══` / `═══ END PASTE TO AGENT ═══` dividers — copy the part **between** them into the matching agent window (e.g. the PM command's output goes into the PM window). The dividers are descriptive; don't paste them. (The snippet is the same across targets — `--target` only changes which install instructions it references.)

Two windows of the same tool can hold different roles independently because the role lives in that window's `GOJAJA_SESSION` shell variable, not in any project file.

From here, just chat with the agents normally. To see overall progress at a glance, run `gojaja watch` (see the [`gojaja watch` reference](#gojaja-watch-reference-runtime-monitoring) below).

---

## What you still need to write by hand

These files are project content. The CLI does not create them; you and your agents fill them as the project evolves.

- **`.gojaja/state/project_state.md`** — vision, milestones, and per-task acceptance criteria. `gojaja init` seeds a TBD skeleton with these three sections; **your job is to fill the TBD placeholders**. The product-owner role (typically PM, whoever owns this file per `config.yaml`) keeps it up to date as the project evolves. The handbook tells agents to ask you to fill any section that is still marked TBD before they judge a task Done — so the longer this file stays empty, the more interrupting questions you'll get. Suggested minimum:

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

- **`.gojaja/state/architecture.md`** — written by the role that `owns` it (typically TL). You read and review.

- **`.gojaja/state/decisions.md`** — narrative complement to the RFC archive. Optional but useful.

- **`.gojaja/roles/<id>.md`** — the description / responsibilities sections. You fill these once at role creation time.

---

## What you can do without a role (no session)

"You" here means the human at the terminal. Whenever the current shell has **no** `GOJAJA_SESSION`, gojaja treats you as the project owner (recorded internally as `SYSTEM`). That identity can do governance and seeding, plus a couple of light-touch RFC moves that are symmetric with opening one. What it **cannot** do is take a position on a decision: structured RFC votes (pre-decide / ack / object / decide) and direct messages (`report` / `worklog`) are speech acts attributable to a role, so they require a `claim` first.

**No role needed (you = project owner / SYSTEM):**

| You can | Command |
| --- | --- |
| Create / delete roles | `role create`, `role delete` (deletion **must** have no session) |
| Push and manage work | `task new` / `task assign` / `task status` (SYSTEM overrides ownership + creator checks) |
| Open an RFC / brainstorm | `rfc new` (`createdBy` is recorded as SYSTEM and is **not** added to voters, so it never stalls the pre-decide ack gate) |
| Leave plain discussion comments on an RFC | `rfc comment` (recorded as `from: SYSTEM`; symmetric with `rfc new`. Structured RFC moves still need a role — see below) |
| Send a directed message to a specific role | `report --to <role> --message "..."` (recorded as `from: SYSTEM`; the project owner channel into the team. The recipient is unchanged — they receive it like any other report, and can tell from the audit log it came from you, not a peer agent) |
| Edit shared state | `state edit` (SYSTEM bypasses file-ownership checks) |
| Read anything | every read-only command except `plan`: `task show/list`, `rfc show/list`, `role show/list`, `handbook`, `-h`, and the `watch` dashboard |
| Install / uninstall / activate | `init`, `reset`, `prompt`, `activate`, `claim` |

**Requires a claimed role (a `GOJAJA_SESSION` in the shell):**

| Needs a role | Command | Why |
| --- | --- | --- |
| Send broadcast messages | `worklog` (team-wide progress note) | a worklog is your role's voice on the team — must belong to a role |
| Send a directed message AS a peer (not as the project owner) | `report --to <role>` from a claimed role | the receiver should know this came from a peer agent, not from you-the-owner |
| Take a position on an RFC | `add-option` / `pre-decide` / `ack` / `object` / `decide` / `revise` / `edit` | each registers a stance; the ACK gate counts roles, not anonymous votes |
| Run the loop | `plan`, `ack`, `wait`, `release` | these are a role agent's per-turn cycle |

So, to answer the common question directly: **without a role you cannot broadcast a `worklog` or take a position on an RFC as a "human" in the channel** — those acts have no peer-agent owner. What you CAN do as the project owner: open RFCs, comment on RFCs, send directed `report`s at specific roles, push tasks, edit state, and force task status when needed. If you want to participate as a full discussant (vote, ack/object, decide, broadcast), create and `claim` a role for yourself (e.g. `Owner` or `Human`); then you can do everything any other agent can.

> SYSTEM-permitted ops (no `GOJAJA_SESSION` needed): `rfc new`, `rfc comment` (plain), `report --to <role>`, `task new` / `assign` / `status`, `state edit`. Structured RFC follow-ups (`add-option` / `pre-decide` / `ack` / `object` / `decide` / `revise` / `edit`) and broadcast `worklog` still each need a role session.

---

## Driving it by hand (for debugging)

You can drive the whole flow from a terminal to understand it. None of these commands are part of a user's daily flow — they're what the agent runs automatically once activated.

**Window A — acting as PM:**

```bash
eval "$(gojaja claim PM --eval)"            # claims and exports GOJAJA_SESSION in one step

# Simple case
gojaja task new --title "Build /login endpoint" --owner Backend --priority P1

# With a parent epic, reference doc, and a hard deliverable:
gojaja task new --title "Build /login endpoint" --owner Backend --priority P1 \
  --parent T-0010 \
  --tag auth \
  --asset 'file:docs/specs/auth.md::Auth spec' \
  --asset 'url:https://figma.com/file/xxx::Login UI design' \
  --deliverable 'file:apps/api/auth/login.ts::Implementation' \
  --deliverable 'file:docs/api/login.md::API doc'

gojaja report --to TL --message "Auth scope confirmed. Backend is unblocked."
```

The deliverable lines mean: Backend cannot mark T-0011 Done until
both files exist on disk. If a reviewer waives a deliverable, Backend
runs `gojaja task status T-0011 Done --force-incomplete` and the
bypass lands in the event stream for audit.

**Window B — acting as Backend:**

```bash
eval "$(gojaja claim Backend --eval)"

gojaja plan                                  # what's waiting for you
gojaja task status T-0001 InProgress
# ...write the code...
gojaja task status T-0001 Review
gojaja worklog --message "T-0001 done, see commit abc123"
gojaja ack --token <token from plan>         # confirm processed
gojaja wait --in 10m                         # idle until attention or 10 min
# or, when you genuinely have no task:
gojaja wait --in 1h --for task-assigned      # also broadcasts "I'm idle"
```

### Multi-line message bodies

`--message` / `--rationale` / `--description` follow the same channel
chain as `git commit`. **Do not wrap multi-line content in
`--message "..."`**: shells run backticks and `$(...)` inside double
quotes, so `--message "see \`git push\`"` actually runs git push.
This pattern caused real damage (see
[postmortem-2026-06-02-shell-eval.md](./postmortem-2026-06-02-shell-eval.md)).

Use one of:

```bash
# Short literal — single quotes, no expansion
gojaja report --to Backend --message 'task done'

# Multi-line via stdin — the canonical safe form. The single-quoted
# 'EOF' delimiter keeps backticks and $ literal in the body.
gojaja report --to Backend --message - <<'EOF'
Done. Notes:

```
git push origin feat/auth
```

Anything `here` is literal, including $VARS.
EOF

# Pipe from a file
cat draft.md | gojaja rfc comment RFC-0001 --rationale -

# Interactive — gojaja opens $EDITOR like git commit
gojaja report --to Backend
```

The `-` sentinel (or bare `--message` with no value) is what tells
gojaja "read stdin". Without it, an absent body flag in a non-TTY
environment is a USAGE error — never an implicit hang.

When done with a role for the day:

```bash
gojaja release
unset GOJAJA_SESSION
```

### Brainstorm (RFC without `--options`)

When three or more roles need to weigh in on a question with no
concrete options yet, open an RFC without `--options`:

```bash
gojaja rfc new q3-priorities \
  --title "Q3 priorities — what should we be optimising for?" \
  --deciders TL --voters PM,Backend,Frontend,DevOps \
  --description "Performance, growth, or reliability? Drop ideas, risks, and follow-ups."

# Voters post freely — no option required
gojaja rfc comment RFC-0001 --rationale "Idea: focus on perf; we lost two churned accounts to latency."
gojaja rfc comment RFC-0001 --rationale "Risk: aborting feature X mid-flight upsets enterprise tier." --reply-to <prev-id>

# Once a concrete choice emerges, anyone can lift it into the option list
gojaja rfc add-option RFC-0001 --option perf:'Q3 = perf-only' --rationale "From discussion above."

# Either close without picking (takeaway-only):
gojaja rfc decide RFC-0001 --rationale "Discussion: revisit in Q4; no specific commitment now."
# Or, after add-option, close with a pick (normal RFC flow):
gojaja rfc decide RFC-0001 --option perf --rationale "Going with perf-only."
```

---

## Common situations

### Add a new role

```bash
gojaja role create Frontend "Frontend Engineer"
# fill in roles/Frontend.md
gojaja activate Frontend --target agents
# open a new agent window and paste
```

The runtime rule is already installed; no need to re-run `prompt --write`.

### Remove a role

```bash
# In a shell with no GOJAJA_SESSION exported (role delete is project-governance):
unset GOJAJA_SESSION
gojaja role delete Frontend
```

Open task assignments owned by `Frontend` are left in place — recreating a role with the same id reinherits them. To reassign instead, use `gojaja task assign <task-id> --to <other-role>`. Any agent window that still has the deleted role's `GOJAJA_SESSION` exported will fail with USAGE on the next command; restart that window or claim a new role there.

### Uninstall everything (`gojaja reset`)

When you're done with a project (or you want to tear down the coordination layer and start fresh), run:

```bash
# In a shell with no GOJAJA_SESSION exported (destructive, user-only):
unset GOJAJA_SESSION
gojaja reset                                  # preview what would be removed
gojaja reset --confirm <project-basename>     # actually remove
```

The default invocation prints a preview and exits without touching anything; the exact `--confirm` token is the project root's directory name. Reset removes:

- `<project>/.gojaja/` recursively (events, state, RFCs, worklogs, sessions, locks).
- `<project>/.cursor/rules/gojaja-runtime.mdc` and the empty `.cursor/rules/` / `.cursor/` parents.
- The `<!-- gojaja-runtime:BEGIN ... :END -->` block inside `<project>/CLAUDE.md` and `<project>/AGENTS.md`. Content outside the block is preserved; the file is deleted only if the marker block was its only content.

Everything gojaja installs is **project-local** — there is no user-level footprint to clean up separately. Reset is also the canonical "delete the audit trail" operation since events live entirely under `.gojaja/` — `cp -r .gojaja .gojaja.bak` first if you want a snapshot.

### Upgrade the CLI

```bash
npm install -g gojaja@latest
gojaja prompt --target agents --write --force-rewrite   # repeat for each target you installed
# Restart every open agent window.
```

`--force-rewrite` skips the byte-equal short-circuit; useful when the runtime template was bumped and you want to confirm the install is fresh.

### "The agent says it doesn't know who it is"

Four usual causes:

1. **`GOJAJA_SESSION` is not exported in the agent's shell.** The activation snippet runs `eval "$(gojaja claim ... --eval)"` which sets it; if the agent skipped that step (some weaker models do), re-paste the snippet.
2. **The agent's host runs every command in a fresh shell, so the `export` from `claim` is lost between tool calls** (most likely on Cursor; Claude Code / Codex usually keep a persistent shell). The symptom is "GOJAJA_SESSION is required" on every command *after* a successful claim. Fix: have the agent carry the id explicitly — `gojaja claim <role>` (no `--eval`), note the printed session id, then pass `gojaja <cmd> --session <id>` on every later command. The runtime rule already tells the agent this; weaker models may need a nudge.
3. **The window was open before you ran `prompt --write`.** Hosts inject rules at window-open time. Restart the window.
4. **The role's markdown is still mostly TBD.** Run `gojaja role show <role>` to inspect; if it's empty, fill in `roles/<id>.md` and re-paste the activation snippet.

### "Two agents both want to claim the same role"

The second window will see "already claimed by a live session ...". The handbook tells the *agent* to stop and ask you — agents must not pass `--force`. You, the human, have three options when the first window is genuinely dead (you killed the tab): force the takeover yourself with `gojaja claim <role> --force` (the recommended path — `--force` is a human tool, not an agent one), or `gojaja release <role>` from a shell that still holds that role's `GOJAJA_SESSION`, or just wait for the lease to expire (~2 h default).

### "I deleted my chat history but the role is stuck"

```bash
unset GOJAJA_SESSION             # in case you still have it
gojaja claim <role> --force      # human takeover of a dead window (simplest), or
gojaja release <role>            # from a shell that still holds the session, or
# just wait ~2 h for the lease to expire automatically
```

---

## `gojaja watch` reference (runtime monitoring)

The Quickstart above already walks through using watch for first-time setup. Once the team is up and running, leave watch open in a browser tab — it is your scheduler view: on a single machine nothing can wake an agent whose turn has ended, so you watch this dashboard to decide who to nudge next.

```bash
gojaja watch                 # default: http://127.0.0.1:7421, auto-opens browser
gojaja watch --port 8080     # custom port
gojaja watch --host 0.0.0.0  # share on LAN — read-only mode (Setup + Actions hidden)
gojaja watch --no-open       # don't auto-launch the browser
```

The dashboard auto-refreshes every couple of seconds and is split into three tabs:

- **Dashboard** — live state across every window:
  - **Roles** card per role: session `live` / `stale` / no-session, pid + host holding it, heartbeat age, and what it's `wait`-ing for. A role that holds a live session but has not run `gojaja wait` for a while is flagged red as `stalled` (the "agent forgot to park after `ack`" failure mode — the role is deaf to events until it runs `wait`).
  - **Task board** — every task by status (Backlog → Done), with owner, priority, blockers, and deliverable count.
  - **RFCs** — open / revising / decided, with deciders and voters.
  - **Activity feed** — newest-first event stream across all agents; doubles as the project history.
- **Setup** (loopback only) — same write surface the Quickstart uses: create roles, install runtime files, generate per-window activation snippets. Useful long after first-run too — adding a new agent role mid-project goes through here.
- **Actions** (loopback only) — push directly into the team without a terminal: send a `report --to <role>`, open an RFC, or create a task. All posted as `from: SYSTEM` (the project-owner channel; the receiver sees it as coming from you, not a peer agent).

What to look at, in order of urgency:
- **Red `stalled` chip in the header** — a role is unparked. Either send it a directive in Actions or prod the agent window directly.
- **A role badge `idle (waiting for task-assigned)`** — that role is free; assign it work via the Actions tab.
- **A task stuck in `Blocked`** — its `dependsOn` line tells you who to chase; report up the chain.
- **An RFC sitting at `open` for too long** — the decider needs a nudge.

Both write tabs hide automatically when watch is bound to a non-loopback address (`--host 0.0.0.0` etc.) so a LAN-shared dashboard cannot be used to push directives at the team. Ctrl-C in the terminal stops the server.

## How decisions get made (RFCs)

When a decision touches multiple roles' `owns` or the architecture, an agent opens an RFC instead of acting unilaterally. RFCs support real multi-round discussion: threaded comments, options added mid-flight, a "send back for rewrite" path, and a structured pre-decide round where every required role must explicitly `ack` or `object` before the decider can finalise (silence is never consent). Full walkthrough in [docs/RFC.md](./docs/RFC.md); a quick tour:

```bash
# Any agent can open. --description is the context anyone-not-in-the-
# conversation needs; --task links the work this RFC is decided in
# the context of.
gojaja rfc new switch-to-postgres \
  --title       "Move primary store from SQLite to Postgres" \
  --description "Login latency root-caused to SQLite write contention; A is the migration, B is a tuning band-aid." \
  --options     "A:Migrate now (4 weeks),B:WAL tuning first" \
  --voters      "Backend,DevOps" \
  --deciders    "TL" \
  --task        T-0042

# Voters comment; replies thread under another comment by id.
gojaja rfc comment RFC-0001 --option A --rationale "Migration is straightforward."
gojaja rfc comment RFC-0001 --reply-to 01HZA...COMM1 --rationale "Can M2 slip 2 weeks?"

# Anyone with a session can add an option mid-discussion if the
# existing ones are inadequate.
gojaja rfc add-option RFC-0001 --option "C:Managed Postgres on RDS" --rationale "Captures the cost dimension."

# Pre-decide: decider posts a structured "I lean X" comment.
# Every voter + non-pre-decider decider MUST run rfc ack or rfc object
# before rfc decide will succeed. Silence is not consent.
gojaja rfc pre-decide RFC-0001 --option C --rationale "Lean C; please ack or object."
gojaja rfc ack    RFC-0001                                     # I agree
gojaja rfc object RFC-0001 --rationale "Cost concern" --option B  # I disagree

# Decider can also send a thin proposal back for rewrite without
# rejecting the topic.
gojaja rfc revise RFC-0001 --rationale "Add a paragraph on the operating cost."
gojaja rfc edit   RFC-0001 --rationale "Added cost paragraph." --description "<rewritten>"

# Only deciders can finally close (anyone else gets exit 9 FORBIDDEN).
gojaja rfc decide RFC-0001 --option C --rationale "Agreed. Proceed."
```

Open RFCs that need a role's attention appear in that role's next `gojaja plan` automatically, with `unreadComments` so the agent can prioritise. `gojaja rfc show <id>` advances the role's read marker for that RFC.

---

## What this doesn't do

- **Doesn't work across multiple machines.** Single-host only; multi-machine over HTTP is on the roadmap.
- **Doesn't call LLMs.** Coordination only; your existing tool (Cursor / Claude / Codex) is the AI.
- **Doesn't run a background server.** Every `gojaja` invocation starts and exits.
- **Doesn't prevent hand-editing files.** Agents through `gojaja` are scoped; anyone with a text editor still has full access.
- **Doesn't provide a `read-state` command.** Reading is unrestricted (the layer is a shared blackboard) and the agent host already has a file-read tool — wrapping it in `gojaja` would only add token cost. `gojaja` mediates **writes** (which need ownership, atomicity, audit) and **structured operations** (claim / plan / ack / task / rfc / report). Read the files directly.
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
| `gojaja watch` real-time dashboard (roles / tasks / RFCs / activity) | Done |
| `gojaja reset` (project-local; removes everything gojaja installed) | Done |
| `gojaja upgrade` | Next |
| `doctor`, event history, archival | Planned |
| Multi-machine over HTTP | Future |

Full details: [docs/ROADMAP.md](./docs/ROADMAP.md)

---

## Documentation

| | |
| --- | --- |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Wire-level contract — every command, manifest shape, ack semantics |
| [docs/HANDBOOK.md](./docs/HANDBOOK.md) | Judgement rules: when to worklog vs report vs RFC; escalation; what NOT to bounce to the user |
| [docs/SCHEMA.md](./docs/SCHEMA.md) | What every file under `.gojaja/` contains and who creates it |
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
./bin/gojaja --help
```

If you want the global `gojaja` to point at your working copy:

```bash
npm link                # registers ./bin/gojaja as the global one
npm run build           # rebuild after every source change, or:
npm run watch           # incremental tsc on every save
```

The linked binary loads `dist/cli/index.js`, so changes are only visible after a build. See [AGENTS.md](./AGENTS.md) for code layout and contribution conventions.

---

## License

MIT

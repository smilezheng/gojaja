import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `agentctl ${CLI_VERSION}
Multi-agent coordination layer. A filesystem-backed protocol that lets
multiple LLM agent windows (Cursor / Claude Code / Codex CLI / ...)
collaborate on the same project without stepping on each other:
durable messaging, a shared task board, ownership-gated state writes,
and an RFC mechanism for cross-role decisions.

Quickstart (one-time setup, you in your shell):

  cd /path/to/your-project
  agentctl init                                          # creates .multi-agent/
  agentctl role create PM "Product Manager"  --owns "state/project_state.md,state/task_board.yaml"
  agentctl role create TL "Tech Lead"        --owns "state/architecture.md"
  agentctl role create Backend "Backend Engineer"
  # ... then open roles/<id>.md and fill in TBD sections ...

  agentctl prompt --target cursor --write                # repeat per agent host
  # IMPORTANT: install before opening any agent window; hosts inject
  # rules into the system prompt only at window-open time.

  # For each agent window you want to staff:
  agentctl activate PM --target cursor                   # auto-copies snippet
  #   → paste into the Cursor window for PM (snippet tells the agent
  #     to claim the role, read its own contract, and skim agentctl -h)

Usage:
  agentctl <command> [options]

Setup (you, in your shell — runs once per project unless noted):
  init [--root <path>]
      Initialise a .multi-agent/ layer in the current project.
  role create <id> [<title>] [--description <text>] [--owns <a,b>]
                              [--reports-to <r1,r2>] [--must-not-edit <a,b>]
      Register a role. Writes roles/<id>.md (with TBD sections you must
      fill in) and adds the role to config.yaml. Re-run to add more.
  role list
      List configured roles. Rows with "(TBD: fill role markdown)" still
      have unfilled placeholder sections in their contract.
  role show <id>
      Print the role's config.yaml entry and the full roles/<id>.md.
      Agents should run this on activation to learn who they are.
  role delete <id>
      Project-governance op (SYSTEM only — no MA_SESSION in the shell).
      Removes the role from config.yaml, deletes roles/<id>.md, and
      invalidates any live session. Open task assignments are left in
      place; recreating the same id reinherits them.
  prompt --target codex|claude|cursor|generic [--write] [--force-rewrite]
                                              [--no-handbook] [--json]
      Print (and with --write, install) the host-specific runtime rule
      for this project. ROLE-FREE: same artifact for every role; the
      role is bound per-window by 'activate', not here.
      --force-rewrite overrides the byte-equal short-circuit (useful
      after an upgrade to confirm the install came from the current
      template).
  activate <role> --target codex|claude|cursor|generic
                                              [--no-handbook] [--no-copy] [--json]
      Print (and auto-copy to clipboard) the chat-paste snippet that
      binds <role> to one agent window. Never writes to disk; role
      binding stays at the window/shell layer. Refuses if the role's
      markdown still has TBD sections.

Session lifecycle (per agent window; agent or user runs this):
  claim <role> [--ttl <s>] [--eval] [--force] [--json]
      Acquire a session for <role> in this shell.
      Tip: 'eval "\$(agentctl claim <role> --eval)"' claims and exports
      MA_SESSION in a single step.
      --force is for humans only; agents seeing "already claimed by a
      live session" should STOP and ask the user, not retry with --force.
  release [<role>] [--json]
      Release the current session. After release, run 'unset MA_SESSION'
      in the same shell so subsequent commands don't try to authenticate
      with a now-invalid token.

Per-turn loop (agent, requires MA_SESSION):
  plan [<role>] [--json]
      Fetch a manifest of unread events, active tasks, open RFCs, plus
      an ackToken. Defaults to JSON when stdout is not a TTY.
  ack  [<role>] --token <t>
      Confirm the manifest you just processed. Cursor advances exactly
      to the snapshot the manifest captured — never further.

Messaging (agent, requires MA_SESSION):
  report --to <role> --message <text> [--ref <id>]
      Directed message to one role. Use for "I need you to act next".
      Refuses unregistered recipient roles.
  worklog --message <text>
      Broadcast progress note. Use for visible work that did not
      already emit a structured event (doc edited, migration ran).

Task board (any role that owns state/task_board.yaml):
  task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
           [--depends-on T-NNNN,...] [--acceptance <text>]
      Tasks created WITH an owner default to status Ready (the owner's
      next plan surfaces them). Without an owner, default is Backlog
      (PM-side product idea pending triage).
  task assign <task-id> --to <role>
      Reassign a task. Both creation and reassignment refuse owners
      that are not registered roles (catches typos before TASK_ASSIGNED
      goes to a nobody).
  task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>
      An owner can always change their own task's status. Anyone else
      must own state/task_board.yaml.
  task list [--owner <role>] [--status <s>] [--json]
  task show <task-id>

RFCs (cross-role decisions; any role can open, designated decider closes):
  rfc new <slug> --title <text> --deciders <r1,...>
                 --options <A:summary,B:summary>
                 [--voters <r1,...>] [--deadline <iso>]
  rfc comment <rfc-id> --rationale <text> [--option <opt>]
  rfc decide  <rfc-id> --option <opt> --rationale <text>
      Calling decide/reject from a role not in the deciders list fails
      with FORBIDDEN (exit 9), not USAGE — the handbook tells agents to
      escalate FORBIDDEN, not retry it.
  rfc reject  <rfc-id> --rationale <text>
  rfc list    [--status open|accepted|rejected|superseded]
  rfc show    <rfc-id>

Ownership-gated writes:
  write-state --file state/<path> [--content <text>]
      Atomic write into the layer, gated by the actor's config.yaml
      owns and mustNotEdit. Content from --content or stdin.

Keepalive (agent, requires MA_SESSION):
  wait [<role>] [--idle <minutes>] [--mode block|exit]
      block: sleep without burning tokens (default; ~10 minutes idle).
      exit:  drop a sentinel and return immediately; the host decides
             when to re-prompt the agent. Use exit on Cursor — its
             chat-mode shell kills long sleeps.

Global options:
  --root <path>                               Override discovered project root.
  --json                                      Force JSON output.

Information:
  version                                     CLI and schema version.
  help                                        Show this help.

Exit codes (relevant for scripted callers):
  0  OK
  2  USAGE       — your invocation is wrong; fix arguments and re-run.
  6  NOT_INIT    — .multi-agent/ not initialised in this project.
  9  FORBIDDEN   — permission denied (ownership / deciders gate).
                   Agents: escalate to your reportsTo, do not retry.
 10  STATE_CORRUPTION — on-disk state is malformed; stop and ask the user.

See:
  README.md           — first-time setup, mental model, troubleshooting
  docs/PROTOCOL.md    — wire-level contract (manifest shape, ack semantics)
  docs/HANDBOOK.md    — collaboration heuristics for agents
  docs/SCHEMA.md      — on-disk layout reference

Not yet implemented (see docs/ROADMAP.md): doctor, upgrade.
`;

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

      --owns entries are either specific files or directory prefixes;
        a trailing slash (or any path that exists as a directory)
        matches every file underneath, recursively. Example:
        --owns "docs/architecture/,state/project_state.md".
      --reports-to PM,TL    escalation chain; the handbook tells the
        agent to escalate via reports up this chain when stuck.
      --must-not-edit state/architecture.md    hard deny list; overrides
        --owns. Use to carve specific files out of a broad ownership
        grant.
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
           [--parent T-NNNN]
           [--tag <label> ...]
           [--asset 'kind:ref::desc' ...]
           [--deliverable 'kind:ref::desc' ...]
      Tasks created WITH an owner default to status Ready (the owner's
      next plan surfaces them). Without an owner, default is Backlog
      (PM-side product idea pending triage).
      --parent links to an existing task; the chain is depth-capped
        and cycle-checked. Children INHERIT NOTHING from the parent;
        ownership, priority, status are independent.
      --tag is a free-form label. Repeat for multiple tags.
      --asset is a pointer the owner needs to read:
        kind=file -> repo-relative path (must stay inside the repo
                      and outside .multi-agent/);
        kind=url  -> external link (Figma, Notion, ...).
      --deliverable is a HARD output that must exist on Done:
        kind=file   -> repo path, existence-checked on Done;
        kind=url    -> URL output (not auto-verified);
        kind=manual -> free-text requirement, not auto-verified.
        File-kind deliverables refuse the Done transition when the
        path is missing on disk. Pass --force-incomplete on
        'task status ... Done' to override (emits an audit event).
      Format is 'kind:ref' or 'kind:ref::description' (the '::' lets
      URLs survive intact). Repeat the flag for multiple entries.
  task assign <task-id> --to <role>
      Reassign a task. Both creation and reassignment refuse owners
      that are not registered roles (catches typos before TASK_ASSIGNED
      goes to a nobody). task.assignedBy records the ORIGINAL creator
      and is NOT updated on reassignment (audit log carries
      reassignment history).
  task status <task-id> <Backlog|Ready|InProgress|Blocked|Review|Done>
                       [--force-incomplete]
      An owner can always change their own task's status. Anyone else
      must own state/task_board.yaml.
      Moving to Done with missing file-kind deliverables refuses
      with USAGE. --force-incomplete bypasses the gate AND emits a
      TASK_DELIVERABLE_BYPASSED event with the missing refs so the
      bypass is permanently visible in the audit log.
  task list [--owner <role>] [--status <s>] [--tag <label> ...] [--json]
  task show <task-id>
      Renders parent, children, assets, deliverables (with on-disk
      [x] / [ ] / [?] markers for file / url / manual kinds).

RFCs (cross-role decisions; any role can open, designated decider closes):
  rfc new <slug> --title <text> --deciders <r1,...>
                 [--description <text>]
                 [--options <A:summary,B:summary>]
                 [--voters <r1,...>] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]
      --deciders is per-RFC; there is no role-level "default decider"
        flag. Pick roles whose owns overlap the decision, plus the
        role at the top of the relevant reportsTo chain.
      --options is OPTIONAL (PR8l). Omitting it opens a brainstorm-mode
        RFC: voters comment freely with no concrete choices on the
        table. Anyone can later run 'rfc add-option' to introduce a
        pickable choice, which upgrades the RFC into a decision flow.
      --description is the context anyone-not-in-the-conversation
        needs to weigh in. If empty the CLI prints a soft warning; in
        a future release this will be hard-required.
      --task links one or more existing task ids so voters/deciders
        can pull context with 'agentctl task show <id>'.

  rfc comment <rfc-id> --rationale <text> [--option <opt>]
                       [--reply-to <comment-id>]
      Append a comment to the threaded ledger. Multiple comments per
      role are preserved in order. --reply-to threads under another
      comment by id (printed by 'rfc show'). During pre-decide, a
      comment from anyone other than the pre-decider auto-reopens the
      RFC; silence is consent.

  rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>
      Add a new option mid-discussion. Allowed in open or revising.
      If there is an active pre-decision, add-option silently
      invalidates it (voters were ACKing an outdated option set).

  rfc pre-decide <rfc-id> --option <opt> --rationale <text>
      Decider posts a structured pre-decision comment ("I lean X").
      RFC status stays 'open'. Every role in (voters union deciders)
      except the pre-decider must run 'agentctl rfc ack' or 'rfc
      object' before 'rfc decide' will succeed. Silence does NOT
      count as consent — there is no override; the only escape from
      a stalled ACK round is 'rfc reject'.

  rfc ack <rfc-id> [--rationale <text>]
      Acknowledge the active pre-decision (agree with it). Required-
      ACK roles only; pre-decider cannot ack their own pre-decision.

  rfc object <rfc-id> --rationale <text> [--option <preferred-opt>]
      Object to the active pre-decision. Rationale required; optional
      --option names your preferred alternative.

  rfc decide  <rfc-id> [--option <opt>] --rationale <text>
      Final accept. Valid from open. Enforces the ACK gate: if there
      is an active pre-decision, every role in (voters union deciders)
      except the pre-decider must have ack'd or objected. Calling
      decide/reject from a role not in the deciders list fails with
      FORBIDDEN (exit 9), not USAGE.
      PR8l: --option is REQUIRED only when the RFC has at least one
      option. For brainstorm-mode RFCs (created without --options
      and never upgraded via add-option), --option must NOT be passed
      and the rationale carries the takeaway alone.

  rfc reject  <rfc-id> --rationale <text>
      Final reject. Valid from open or revising. Bypasses the ACK
      gate by design — it is the only escape from a stalled
      pre-decision (e.g. when a required-ACK role is unreachable).

  rfc revise  <rfc-id> --rationale <text>
      Send back to creator for rewrite (decider-only). Valid from
      open. Rationale tells the creator what to fix.

  rfc edit    <rfc-id> --rationale <text> [--title T] [--description D]
                       [--options A:summary,B:summary] [--deadline ISO]
      Apply a rewrite while in 'revising'; status flips back to 'open'.
      Allowed actors: original creator OR a decider. Comments are
      preserved across revise -> edit cycles.

  rfc link-task <rfc-id> --task T-NNNN
  rfc unlink-task <rfc-id> --task T-NNNN
      Attach / detach a task id post-creation. Idempotent.

  rfc list    [--status open|revising|accepted|rejected|superseded]
  rfc show    <rfc-id> [--no-mark-seen]
      'show' updates this role's read marker for the RFC, so 'plan'
      will report unreadComments=0 until new discussion arrives. Use
      --no-mark-seen for read-only inspection (e.g. from a script).

Shared-state editing (ownership-gated; --file must live under state/):
  state edit --file state/<path> [mode flags] [--json]
      Three mutually-exclusive modes; the default is overwrite.

      Overwrite the whole file (default):
        state edit --file state/foo.md --content '<text>'
        state edit --file state/foo.md              (content from stdin)
      Append to the end of the file:
        state edit --file state/foo.md --append '<text>'
      Literal find-and-replace:
        state edit --file state/foo.md --replace '<old>' --with '<new>'
        state edit --file state/foo.md --replace '<old>' --with '<new>' --batch

      Replace refuses 0 or N>1 matches by default — pass --batch to
      replace all occurrences. --with "" deletes the matched text.
      No regex anywhere; old/new are literal strings.
      All modes are atomic and respect config.yaml's owns / mustNotEdit.

Keepalive (agent, requires MA_SESSION):
  wait [<role>] [--until <ISO> | --in <duration>]
                [--for <condition>] [--poll-interval <duration>] [--json]
      Sleeps in chunks until either new attention arrives, the
      condition you named fires, or the deadline passes.

      Deadline (pick one; default is --in 10m):
        --until 2026-05-28T15:00:00Z
        --in 30s | 10m | 4h | 1d

      Conditions (pick one; default is attention):
        attention                 any event addressed to you or "*"
        rfc-decided:RFC-NNNN      that RFC closes (accepted or rejected)
        rfc-acked:RFC-NNNN        anyone posts an ack or object on that RFC
        task-assigned             a task lands with you as the new owner
                                  (also auto-emits an idle worklog so
                                  task-board owners can find you)
        report-from:<role>        that role sends you a directed report
        event-ref:<id>            any event with that ref

      Exit verdicts (each prints "Next: ..." with the command to run):
        ATTENTION       new events arrived; run plan.
        CONDITION_MET   your condition fired; run plan.
        RESUME          chunk timed out, deadline still in the future;
                        re-run the printed wait command.
        TIMEOUT         deadline reached; end the turn or take initiative.

      The chunked polling lets a long wait survive a short host shell
      timeout: each chunk is one process, the next process resumes from
      disk state. PR8i replaced the old --mode block | exit dichotomy
      and the .wait sentinel.

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

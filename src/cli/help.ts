import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `gojaja ${CLI_VERSION} (过家家)
Filesystem-backed coordination layer for multi-LLM-agent collaboration.
Let multiple agent windows (Cursor / Claude Code / Codex CLI / ...)
play house on the same project without stepping on each other:
durable messaging, a shared task board, ownership-gated state writes,
and an RFC mechanism for cross-role decisions.

Quickstart (one-time setup, you in your shell):

  cd /path/to/your-project
  gojaja init                                          # creates .gojaja/
  gojaja role create PM "Product Manager"  --owns "state/project_state.md,state/task_board.yaml"
  gojaja role create TL "Tech Lead"        --owns "state/architecture.md"
  gojaja role create Backend "Backend Engineer"
  # ... then open roles/<id>.md and fill in TBD sections ...

  gojaja prompt --target agents --write                # writes AGENTS.md
  #   AGENTS.md is the cross-tool standard (Codex, Cursor, Copilot, ...).
  #   Add --target claude too if you use Claude Code. IMPORTANT:
  #   install before opening any agent window; hosts inject rules into
  #   the system prompt only at window-open time.

  # For each agent window you want to staff:
  gojaja activate PM --target agents                   # auto-copies snippet
  #   → paste into the window for PM (snippet tells the agent to claim
  #     the role, read its own contract, and skim gojaja -h)

Usage:
  gojaja <command> [options]

Setup (you, in your shell — runs once per project unless noted):
  init [--root <path>]
      Initialise a .gojaja/ layer in the current project. PR9.2: v3
      layout. Mints a ULID, writes <project>/.gojaja/project.json
      (git-tracked marker), and creates a per-machine central tree
      at ~/.gojaja/projects/<ULID>/ for the task board, event stream,
      sessions, RFCs, worklog, and locks. See RFC-0001. The
      ~/.gojaja/ location is overridable via the GOJAJA_HOME env var.
  migrate [--execute] [--cleanup] [--force]
      PR9.3 v2 -> v3 walker. Default = dry-run preview. --execute
      copies central-classified files from <project>/.gojaja/ to
      ~/.gojaja/projects/<new-ULID>/, writes project.json, and bumps
      VERSION to 3.0.0. User-tree source files are KEPT as a safety
      net by default. --cleanup also removes them once the new
      layout is verified, but only paths gojaja exclusively owns
      (state/task_board.yaml + state/{architecture,decisions,risks}.*
      + comms/, rfcs/, worklog/, locks/ subtrees); user files
      placed under .gojaja/ for project-specific reasons are
      untouched. --cleanup additionally refuses on a dirty / non-git
      project unless --force (mirrors gojaja init / reset). Idempotent
      on a v3 layer (or a cleanup pass if --cleanup is set).
  role create <id> [<title>] [--description <text>] [--owns <a,b>]
                              [--reports-to <r1,r2>] [--must-not-edit <a,b>]
                              [--as-system]
      Register a role. Writes roles/<id>.md (with TBD sections you must
      fill in) and adds the role to config.yaml. Re-run to add more.
      PR9 SYSTEM-3: ownership-gated. Either run with --as-system
      (project-owner bootstrap path) or claim a role whose --owns
      list includes 'config.yaml' (the HR / Admin delegation
      pattern).

      --owns gates which shared state files UNDER .gojaja/ the role may
        write via gojaja (repo source is the agent's own job, not gated
        here). Entries are relative to .gojaja/ — specific files or a
        directory prefix (trailing slash matches the subtree). Example:
        --owns "state/project_state.md,state/task_board.yaml" or
        --owns "state/".
      --reports-to PM,TL    escalation chain; the handbook tells the
        agent to escalate via reports up this chain when stuck.
      --must-not-edit state/architecture.md    hard deny list; overrides
        --owns. Carves a specific file out of a broad grant (e.g. a role
        owns all of state/ but not state/architecture.md).
  role list
      List configured roles. Rows with "(TBD: fill role markdown)" still
      have unfilled placeholder sections in their contract.
  role show <id>
      Print the role's config.yaml entry and the full roles/<id>.md.
      Agents should run this on activation to learn who they are.
  role delete <id> [--as-system]
      Project-governance op. PR9 SYSTEM-3: ownership-gated symmetric
      with role create. Either --as-system OR a session for a role
      whose --owns includes 'config.yaml'. Replaces the prior
      "GOJAJA_SESSION must be unset" rule (the env-var presence was
      not a real trust boundary). Removes the role from config.yaml,
      deletes roles/<id>.md, and invalidates any live session. Open
      task assignments are left in
      place; recreating the same id reinherits them.
  prompt --target agents|claude|cursor|generic [--write]
                       [--force-rewrite] [--no-handbook] [--json]
      Print (and with --write, install) the project's runtime rule.
      ROLE-FREE: same artifact for every role; the role is bound
      per-window by 'activate', not here. All targets are project-local.
      AGENTS.md is the canonical runtime file (the cross-tool standard):
        agents  -> a managed block in AGENTS.md. Read by Codex, Cursor,
                   Copilot, Windsurf, Zed, ... — usually all you need.
        claude  -> AGENTS.md (canonical) PLUS a managed block in
                   CLAUDE.md that just imports it (@AGENTS.md), since
                   Claude Code doesn't read AGENTS.md natively yet. One
                   source of truth; CLAUDE.md is a one-line pointer.
        cursor  -> a standalone .cursor/rules/gojaja-runtime.mdc.
                   OPTIONAL fallback — Cursor already reads AGENTS.md;
                   use only for old Cursor or .mdc-specific features.
                   Don't stack it on top of AGENTS.md (double-inject).
        generic -> printed only, nothing installed.
      --no-handbook drops the compact judgement cheatsheet from the
      card (the full policy is always available via 'gojaja handbook').
      --force-rewrite overrides the byte-equal short-circuit (useful
      after an upgrade to confirm the install came from the current
      template).
  activate <role> --target agents|claude|cursor|generic
                                              [--no-handbook] [--no-copy] [--json]
      Print (and auto-copy to clipboard) the chat-paste snippet that
      binds <role> to one agent window. Never writes to disk; role
      binding stays at the window/shell layer. Refuses if the role's
      markdown still has TBD sections.

Session lifecycle (per agent window; agent or user runs this):
  claim <role> [--ttl <s>] [--session <id>] [--eval] [--force] [--json]
      Acquire a session for <role> in this shell.
      Tip: 'eval "\$(gojaja claim <role> --eval)"' claims and exports
      GOJAJA_SESSION in a single step.
      --session <id> is the recovery path: if you previously claimed
      this role and lost GOJAJA_SESSION (context-loss / fresh shell),
      pass the previous session id (visible in your earlier 'gojaja
      claim' output). If it matches the live session, claim is
      idempotent — same id is re-exported, no peer is taken over,
      no new event is emitted. Mismatch with a live session refuses.
      --force is for humans only; agents seeing "already claimed by a
      live session" should try --session <id> first, otherwise STOP
      and ask the user (do NOT retry with --force).
  release [<role>] [--json]
      Release the current session. After release, run 'unset GOJAJA_SESSION'
      in the same shell so subsequent commands don't try to authenticate
      with a now-invalid token.

Per-turn loop (agent, requires GOJAJA_SESSION):
  plan [<role>] [--json]
      Fetch a manifest of unread events, active tasks, open RFCs, plus
      an ackToken. Defaults to JSON when stdout is not a TTY.
  ack  [<role>] --token <t>
      Confirm the manifest you just processed. Cursor advances exactly
      to the snapshot the manifest captured — never further.
  handbook [--json]
      Print the full collaboration handbook — the judgement layer for
      when to use worklog vs report vs RFC, escalation, multi-round
      RFCs, deliverable gates, task lifecycle. The injected runtime
      prompt keeps only a compact cheatsheet + a pointer here, so this
      is where an agent reads the full policy when making a judgement
      call. Reference material; needs no session.

Messaging (agent, requires GOJAJA_SESSION):
  report --to <role> --message <text> [--ref <id>]
      Directed message to one role. Use for "I need you to act next".
      Refuses unregistered recipient roles.
  worklog --message <text>
      Broadcast progress note. Use for visible work that did not
      already emit a structured event (doc edited, migration ran).

  Multi-line bodies safely: any --message / --rationale /
  --description flag accepts inline OR an explicit stdin channel.
  Shells expand backticks and $(...) inside double quotes — so
  --message "see \`git push\`" actually runs git push. Use one of:
      --message 'short literal'       # single quotes; no expansion
      --message - <<'EOF' ... EOF     # stdin; quoted EOF keeps literal
      cat draft.md | gojaja ... --message -
      gojaja report --to X            # interactive: opens $EDITOR
  The '-' sentinel (or bare --message) tells gojaja to read stdin.

  --as-system flag (project owner only):
      A bare 'gojaja report' / 'task new' / 'rfc new' / 'rfc comment'
      / 'state edit' invocation with no GOJAJA_SESSION refuses by
      default (PR9 SYSTEM-1). The historic "no session -> SYSTEM"
      implicit bypass was an unintended escalation path: any agent
      could 'unset GOJAJA_SESSION' to gain SYSTEM authority. To act
      as SYSTEM (the project-owner channel into the team), pass
      --as-system explicitly. Audits will record actor=SYSTEM and
      pid / cwd / hostname (SYSTEM-2). Agents must claim a role
      first and inherit ownership from their role config; --as-system
      is reserved for the human user performing bootstrap or repair.

Task board (creators of new tasks need state/task_board.yaml write
access; status transitions follow per-task permissions below):
  task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
           [--depends-on T-NNNN,...] [--acceptance <text>]
           [--parent T-NNNN]
           [--tag <label> ...]
           [--reviewer <role> ...]
           [--asset 'kind:ref::desc' ...]
           [--deliverable 'kind:ref::desc' ...]
      Tasks created WITH an owner default to status Pending (the owner's
      next plan surfaces them). Without an owner, default is Backlog
      (PM-side product idea pending triage). The actor is recorded as
      task.creator and is immutable after create.
      --parent links to an existing task; the chain is depth-capped
        and cycle-checked. Children INHERIT NOTHING from the parent;
        ownership, priority, status are independent.
      --tag is a free-form label. Repeat for multiple tags.
      --reviewer names a role authorised to mark this task Done
        regardless of ownership. Reviewers also auto-receive
        TASK_STATUS_CHANGED events in their manifest, so pushing the
        task to Review notifies them without an explicit report.
        Repeat for multiple reviewers; each must be a registered role.
      --asset is a pointer the owner needs to read:
        kind=file -> repo-relative path (must stay inside the repo
                      and outside .gojaja/);
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
      goes to a nobody). task.creator records the ORIGINAL creator
      and is NOT updated on reassignment (audit log carries
      reassignment history).
  task status <task-id> <Backlog|Pending|InProgress|Blocked|Review|Done>
                       [--force-incomplete]
      Permission:
        - Done is allowed for: SYSTEM, a role in task.reviewers, the
          owner IF they are also the creator (self-managed task),
          or any role with state/task_board.yaml write access.
        - Other transitions: owner-exception, reviewer-exception, or
          state/task_board.yaml write access.
        - An owner who is not the creator gets FORBIDDEN (exit 9) on
          Done; the error message names the configured reviewers.
      Moving to Done with missing file-kind deliverables additionally
      refuses with USAGE. --force-incomplete bypasses the deliverable
      gate AND emits a TASK_DELIVERABLE_BYPASSED event with the
      missing refs so the bypass is permanently visible in the audit
      log. --force-incomplete does NOT bypass the permission gate.
  task list [--owner <role>] [--status <s>] [--tag <label> ...] [--json]
  task show <task-id>
      Renders parent, children, creator, reviewers, assets,
      deliverables (with on-disk [x] / [ ] / [?] markers for
      file / url / manual kinds).

RFCs (cross-role decisions; any role can open, designated decider closes):
  rfc new <slug> --title <text> --deciders <r1,...>
                 [--description <text>]
                 [--options <A:summary,B:summary>]
                 [--voters <r1,...>] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]
      --deciders is per-RFC; there is no role-level "default decider"
        flag. Pick roles whose owns overlap the decision, plus the
        role at the top of the relevant reportsTo chain.
      --options is OPTIONAL. Omitting it opens a brainstorm-mode RFC:
        voters comment freely with no concrete choices on the table.
        Anyone can later run 'rfc add-option' to introduce a pickable
        choice, which upgrades the RFC into a decision flow.
      --description is the context anyone-not-in-the-conversation
        needs to weigh in. If empty the CLI prints a soft warning; in
        a future release this will be hard-required.
      --task links one or more existing task ids so voters/deciders
        can pull context with 'gojaja task show <id>'.

  rfc comment <rfc-id> --rationale <text> [--option <opt>]
                       [--reply-to <comment-id>]
      Append a discussion comment to the threaded ledger. Multiple
      comments per role are preserved in order. --reply-to threads
      under another comment by id (printed by 'rfc show'). A plain
      comment does NOT advance an active pre-decision's ACK gate —
      silence is never consent; to register a position use 'rfc ack'
      or 'rfc object'.
      Allowed without GOJAJA_SESSION (a human running the CLI; the
      comment is recorded as from=SYSTEM), symmetric with 'rfc new'.
      Structured kinds (pre-decide / ack / object) still require a
      session.

  rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>
      Add a new option mid-discussion. Allowed in open or revising.
      If there is an active pre-decision, add-option silently
      invalidates it (voters were ACKing an outdated option set).

  rfc pre-decide <rfc-id> --option <opt> --rationale <text>
      Decider posts a structured pre-decision comment ("I lean X").
      RFC status stays 'open'. Every role in (voters union deciders)
      except the pre-decider must run 'gojaja rfc ack' or 'rfc
      object' before 'rfc decide' will succeed. Silence does NOT
      count as consent — there is no override; the only escape from
      a stalled ACK round is 'rfc reject'.
      Two structural gates on entry (PR8u):
        - Comment-coverage gate: every required commenter
          ((voters union deciders) minus the creator, except SYSTEM)
          must have posted a regular 'rfc comment' first. The
          framework auto-emits an RFC_READY_TO_DECIDE event the
          moment this gate flips green so deciders do not have to
          poll.
        - Active-pre-decision gate: refused if one is already
          active. Re-propose by either 'rfc withdraw-pre-decision'
          (if you authored it) or 'rfc add-option' (silently
          invalidates the active pre-decision; option set has
          changed).

  rfc withdraw-pre-decision <rfc-id> --rationale <text>
      Author-only self-revoke of the active pre-decision. Posts a
      kind=withdraw comment which clears the active state; existing
      ack/object posts predate any future pre-decision's ts and are
      naturally invalidated by the standard ts-gate. After withdraw
      any decider can pre-decide afresh.

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
      --option is REQUIRED only when the RFC has at least one option.
      For brainstorm-mode RFCs (created without --options and never
      upgraded via add-option), --option must NOT be passed and the
      rationale carries the takeaway alone.

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

Keepalive (agent, requires GOJAJA_SESSION):
  wait [<role>] [--until <ISO> | --in <duration>]
                [--for <condition>] [--poll-interval <duration>] [--json]
      Parks the agent in ONE blocking call (no token cost) until ANY
      event the role would see in its manifest arrives, or the deadline
      passes. It polls the event stream internally every --poll-interval
      (default 30s) — that is an in-process check cadence, NOT a
      re-invocation interval. Before blocking it prints a start line
      (WAITING role=<r> now=<iso> ...) so you can see the wall clock.

      Deadline (optional; omit BOTH to wait indefinitely until an event
      or a host kill — the agent then re-runs to resume):
        --until 2026-05-28T15:00:00Z
        --in 30s | 10m | 4h | 1d

      --for <condition> is NOT an event filter. wait always wakes on
      any visible event (same projection plan uses to build the
      manifest). --for is (a) a verdict tag — if a visible wake event
      satisfies the predicate the verdict upgrades from ATTENTION to
      CONDITION_MET; otherwise the verdict is still ATTENTION and the
      wait still ends — and (b) for '--for task-assigned', an idle
      worklog broadcast at session open. Picking the wrong --for
      cannot mute unrelated attention.

      Conditions (pick one; default is attention):
        attention                 verdict is always ATTENTION (no
                                  upgrade)
        rfc-decided:RFC-NNNN      that RFC closes (accepted or rejected)
        rfc-acked:RFC-NNNN        anyone posts an ack or object on that RFC
        task-assigned             a task lands with you as the new owner;
                                  also auto-emits a one-shot idle worklog
                                  at session open so task-board owners
                                  can find you
        report-from:<role>        that role sends you a directed report
        event-ref:<id>            any event with that ref

      Exit verdicts (each prints "Next: ..." with the command to run):
        ATTENTION       new events arrived; run plan.
        CONDITION_MET   your condition fired; run plan.
        TIMEOUT         finite deadline reached; end the turn or take
                        initiative. (Never fires for an indefinite wait.)

      If the host harness kills the blocking call before any verdict
      prints, just re-run 'gojaja wait' with NO deadline flags — it
      resumes the in-progress wait (same deadline + condition) from the
      on-disk session. Prefer one long block over many short re-runs
      (each re-run costs the agent a turn); a practical ceiling is ~5
      resumes before ending the turn.

Monitoring (you, the human scheduler):
  watch [--port <n>] [--host <addr>] [--no-open]
      Start a local web dashboard over this project's .gojaja/ state
      and open it in your browser. One screen shows every role's
      session (live / stale / idle-waiting / stalled-no-wait), the
      task board, open RFCs, and a live activity feed across all
      agent windows. Useful because on a single machine nothing can
      wake a turn-ended agent — you are the scheduler, and this is
      your view. On the default 127.0.0.1 bind, the dashboard also
      exposes Setup (init / role create / prompt --write / activate)
      and Actions (report / rfc / task) tabs — same writes the CLI
      does, posted as from=SYSTEM (project-owner channel). For an
      uninitialised project the dashboard serves a single
      "Initialise" landing page so first-time setup can run from the
      browser. Non-loopback binds hide both write tabs; the
      dashboard then stays purely read-only so it is safe to share
      over the LAN.
      Serves on 127.0.0.1:7421 by default (falls back to a free port if
      busy); --no-open skips launching the browser. Read-only: never
      mutates coordination state. Ctrl-C to stop.

Project lifecycle (user, NOT for agents):
  reset [--dry-run] [--confirm <basename>]
      Remove everything this tool installed into the project: the
      .gojaja/ layer (all events, state, RFCs, worklogs, sessions
      and locks), .cursor/rules/gojaja-runtime.mdc, and the managed
      BEGIN/END block inside CLAUDE.md and AGENTS.md (preserves the
      rest of each file; deletes a file only if nothing else was in
      it). Everything gojaja installs is project-local, so there is
      no user-level footprint to clean up separately.

      Default invocation prints a preview and refuses to delete. Pass
      --confirm <basename-of-project-root> to actually delete.

      Must be run from a shell with no GOJAJA_SESSION exported (mirrors
      role delete; destructive ops belong to the user, not an agent).

Global options:
  --root <path>                               Override discovered project root.
  --json                                      Force JSON output.
  --session <id>                              Authenticate as this session id
                                              instead of reading GOJAJA_SESSION
                                              from the environment. Use on agent
                                              hosts that run each command in a
                                              fresh shell and do not persist the
                                              exported GOJAJA_SESSION from claim.

Information:
  version                                     CLI and schema version.
  help                                        Show this help.

Exit codes (relevant for scripted callers):
  0  OK
  2  USAGE         — your invocation is wrong; fix arguments and re-run.
  3  NOT_INIT      — .gojaja/ not initialised in this project.
  4  ALREADY_INIT  — .gojaja/ already exists; use reset instead of init.
  5  UNKNOWN_ROLE  — the named role is not registered.
  6  LOCK_TIMEOUT  — could not acquire a resource lock in time; retry.
  7  PATH_INVALID  — a --file path escaped the allowed tree.
  8  STATE_CORRUPT — on-disk state is malformed; stop and ask the user.
  9  FORBIDDEN     — permission denied (ownership / deciders gate).
                     Agents: escalate to your reportsTo, do not retry.

See the gojaja source repo at https://github.com/smilezheng/gojaja
for the long-form docs (none of these files are shipped into your
project):
  README.md           — first-time setup, mental model, troubleshooting
  docs/PROTOCOL.md    — wire-level contract (manifest shape, ack semantics)
  docs/HANDBOOK.md    — collaboration heuristics for agents
  docs/SCHEMA.md      — on-disk layout reference
  docs/RFC.md         — full RFC lifecycle walkthrough

Not yet implemented (see docs/ROADMAP.md in the source repo):
doctor, upgrade.
`;

/**
 * Concise per-command help, shown for `gojaja <cmd> -h` / `--help`.
 * The full reference lives in HELP_TEXT (`gojaja -h`); these are quick
 * usage cards so a subcommand `-h` doesn't dump the whole manual.
 * Keyed by the top-level command (groups like role/task/rfc list their
 * subcommands).
 */
export const COMMAND_HELP: Record<string, string> = {
  init: `  gojaja init [--root <path>]
      Initialise a .gojaja/ layer in the current project. Refuses on a
      dirty git tree; on a non-git project, asks for y/n confirmation
      (or --force when stdin is not a TTY).`,

  role: `  gojaja role create <id> [<title>] [--owns a,b] [--reports-to r1,r2] [--must-not-edit a,b]
  gojaja role list
  gojaja role show <id>
  gojaja role delete <id> [--as-system]
      Manage roles. 'create' writes config.yaml + a roles/<id>.md
      contract (fill its TBD sections). 'delete' also invalidates any
      live session for the role. PR9 SYSTEM-3 gates both: either
      --as-system or a session for a role owning config.yaml.`,

  prompt: `  gojaja prompt --target agents|claude|cursor|generic [--write]
                [--force-rewrite] [--no-handbook] [--json]
      Install the project's role-free runtime rule.
        agents  -> AGENTS.md (canonical; covers Cursor, Codex, Copilot,
                   Windsurf, Zed, ... — usually all you need)
        claude  -> AGENTS.md PLUS a CLAUDE.md that imports it (@AGENTS.md)
        cursor  -> optional standalone .cursor/rules/*.mdc fallback
        generic -> printed only`,

  activate: `  gojaja activate <role> --target agents|claude|cursor|generic [--no-handbook] [--no-copy] [--json]
      Print (and auto-copy) the chat-paste snippet that binds <role> to
      one agent window. Never writes to disk.`,

  claim: `  gojaja claim <role> [--ttl <seconds>] [--session <id>] [--eval] [--force] [--json]
      Acquire a session for <role> in this shell (default lease 2h).
      'eval "$(gojaja claim <role> --eval)"' claims + exports in one step.
      --session <id>: idempotent recovery — pass your previous session
      id (from earlier chat output) to re-export the live session
      without taking over a peer.
      --force is humans-only.`,

  release: `  gojaja release [<role>] [--json]
      Release the current session; then run 'unset GOJAJA_SESSION'.`,

  plan: `  gojaja plan [<role>] [--json]
      Fetch the manifest: unread events, active tasks, open RFCs, and an
      ackToken. Defaults to JSON when stdout is not a TTY.`,

  ack: `  gojaja ack [<role>] --token <t>
      Confirm the manifest you just processed (advances your cursor).`,

  handbook: `  gojaja handbook [--json]
      Print the full collaboration handbook: when to worklog vs report
      vs RFC, escalation, multi-round RFCs, deliverable gates, task
      lifecycle. Reference material; needs no session.`,

  report: `  gojaja report --to <role> --message <text> [--ref <id>]
      Directed message to one role ("I need you to act next").
      Allowed without GOJAJA_SESSION (a human running the CLI as the
      project owner; recorded as from=SYSTEM), symmetric with
      'rfc new' / 'rfc comment'. The recipient is unchanged — they
      receive it like any other report. The 'to' role must be
      registered.`,

  worklog: `  gojaja worklog --message <text>
      Broadcast a progress note to the team.`,

  task: `  gojaja task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
                  [--depends-on T-NNNN,...] [--parent T-NNNN] [--acceptance <text>]
                  [--tag <l> ...] [--reviewer <role> ...]
                  [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]
  gojaja task assign <id> --to <role>
  gojaja task status <id> <Backlog|Pending|InProgress|Blocked|Review|Done> [--force-incomplete]
      (v3.0.x: "Ready" is silently accepted as a legacy alias for "Pending".)
  gojaja task list [--owner <role>] [--status <s>] [--tag <label> ...] [--json]
  gojaja task show <id>
      Manage the shared task board. file-kind deliverables are
      existence-checked on the Done transition.`,

  rfc: `  gojaja rfc new <slug> --title <t> --deciders <r1,...> [--options A:s,B:s]
                [--description <t>] [--voters <r1,...>] [--task T-NNNN] [--deadline <iso>]
  gojaja rfc comment|add-option|pre-decide|withdraw-pre-decision|ack|object|decide|reject|revise|edit <rfc-id> ...
  gojaja rfc link-task|unlink-task <rfc-id> --task T-NNNN
  gojaja rfc list [--status ...] | rfc show <rfc-id> [--no-mark-seen]
      Cross-role decisions with two structural gates on pre-decide:
      a comment-coverage gate (every required commenter must post a
      regular 'rfc comment' first; framework auto-emits
      RFC_READY_TO_DECIDE when this flips) and an active-pre-decision
      gate ('withdraw-pre-decision' or 'add-option' to unblock).
      Full walkthrough: docs/RFC.md.`,

  state: `  gojaja state edit --file state/<path> [mode] [--json]
      Ownership-gated edit of a file under state/. Modes (pick one):
      default overwrite (--content / stdin), --append <text>, or
      --replace <old> --with <new> [--batch].`,

  wait: `  gojaja wait [<role>] [--until <iso> | --in <duration>] [--for <condition>]
              [--poll-interval <duration>] [--json]
      Idle keepalive: ONE blocking call (no token cost) that polls
      internally until new attention, the named condition, or the
      deadline (TIMEOUT). Omit --in/--until to wait indefinitely. If the
      host kills it, re-run 'gojaja wait' (no deadline flags) to resume;
      cap at ~5 resumes, then end the turn.`,

  watch: `  gojaja watch [--port <n>] [--host <addr>] [--no-open]
      Start a local web dashboard (roles, task board, RFCs,
      live activity feed) and open it in the browser. Default
      127.0.0.1 bind also exposes an Actions panel — send report,
      open RFC, create task, all posted as from=SYSTEM (project-
      owner channel). Non-loopback binds (e.g. --host 0.0.0.0) hide
      the Actions panel so a LAN-shared dashboard stays read-only.
      Ctrl-C to stop.`,

  reset: `  gojaja reset [--dry-run] [--confirm <basename>] [--purge] [--force]
      Remove everything gojaja installed: .gojaja/, the Cursor rule, and
      the managed block in CLAUDE.md / AGENTS.md. PR9.6: v3 projects
      also archive the central tree (~/.gojaja/projects/<ULID>/) to
      ~/.gojaja/trash/<ULID>-<TS>/ (recoverable). --purge hard-deletes
      the central tree without trash — irrecoverable, explicit opt-in.
      Preview unless --confirm <project-basename>. No GOJAJA_SESSION
      in the shell. Refuses on a dirty or non-git project (same posture
      as 'gojaja init'); --force bypasses the git-state gate. Re-run
      with --force --confirm <basename> after reviewing the preview.`,

  version: `  gojaja version [--json]
      Print the CLI and on-disk schema version.`,
};

/**
 * Help to show for `gojaja <command> -h`. Returns the focused card when
 * we have one (plus a pointer to the full reference), otherwise the
 * whole manual.
 */
export function helpForCommand(command: string): string {
  const card = COMMAND_HELP[command];
  if (!card) return HELP_TEXT;
  return `${card}\n\nFull reference: gojaja -h\n`;
}

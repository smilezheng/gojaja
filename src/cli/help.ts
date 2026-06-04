import { CLI_VERSION } from "./runtime";

export const HELP_TEXT = `gojaja ${CLI_VERSION} (过家家)
Coordination layer for multi-LLM-agent collaboration on a shared codebase.
Durable messaging, shared task board, ownership-gated state writes, and
RFC-based cross-role decisions. No server, no database — just files.

Quickstart (human, one-time):

  cd /path/to/your-project
  gojaja init
  gojaja role create PM "Product Manager" --owns "state/project_state.md,state/task_board.yaml" --as-system
  gojaja role create Backend "Backend Engineer" --as-system
  # fill in roles/<id>.md TBD sections
  gojaja prompt --target agents --write          # installs AGENTS.md
  gojaja activate PM --target agents             # copies snippet -> paste into agent window

Usage:
  gojaja <command> [options]

Setup (human, once per project):
  init [--root <path>]
      Create .gojaja/ (git-tracked contracts) and ~/.gojaja/projects/<id>/
      (per-machine runtime: task board, events, sessions, RFCs, worklog,
      locks). Override location via GOJAJA_HOME env var.
  migrate [--execute] [--cleanup] [--force]
      v2 -> v3 one-shot walker. Default = dry-run preview. --execute moves
      runtime state to ~/.gojaja/projects/<id>/. --cleanup removes v2
      source files after verification (refuses on dirty git unless --force).
  role create <id> [<title>] [--owns <a,b>] [--reports-to <r1,r2>]
                              [--must-not-edit <a,b>] [--as-system]
      Register a role. Writes roles/<id>.md (fill TBD sections) and updates
      config.yaml. Requires --as-system (project-owner bootstrap) or a
      session whose owns includes 'config.yaml' (delegated HR pattern).
      --owns  state files under .gojaja/ the role may write. Entries:
        exact file or directory prefix (e.g. "state/" matches subtree).
      --reports-to  escalation chain for stuck work.
      --must-not-edit  hard deny, overrides --owns.
  role list
      List roles. Flags rows whose contract still has TBD.
  role show <id>
      Print config + full roles/<id>.md. Run on activation to learn
      who you are.
  role delete <id> [--as-system]
      Remove role from config + delete roles/<id>.md + invalidate session.
      Same permission gate as role create. Open task assignments kept;
      recreating the same id reinherits them.
  prompt --target agents|claude|cursor|generic [--write]
                       [--force-rewrite] [--no-handbook] [--json]
      Print or install the project's runtime rule (role-free; role binding
      is per-window via 'activate').
        agents  -> managed block in AGENTS.md (cross-tool standard:
                   Codex, Cursor, Copilot, Windsurf, Zed, ...).
        claude  -> AGENTS.md + CLAUDE.md importer (Claude Code doesn't
                   read AGENTS.md natively yet).
        cursor  -> standalone .cursor/rules/*.mdc. Fallback only; Cursor
                   already reads AGENTS.md.
        generic -> printed only.
      --force-rewrite overwrites even when content is byte-equal.
  activate <role> --target agents|claude|cursor|generic [--no-copy] [--json]
      Print (and auto-copy) the chat-paste snippet that binds <role> to one
      agent window. Never writes to disk. Refuses if role markdown has TBD.

Session lifecycle (per agent window):
  claim <role> [--ttl <s>] [--session <id>] [--eval] [--force] [--json]
      Acquire a session. Tip: eval "$(gojaja claim <role> --eval)" claims
      and exports GOJAJA_SESSION in one step.
      --session <id>  recovery path: pass your previous session id to
        re-export without taking over a peer. Mismatch refuses.
      --force  human-only takeover. Agents: try --session first, then
        STOP and ask the user.
  release [<role>] [--json]
      Release the session. Then run 'unset GOJAJA_SESSION'.

Per-turn loop (agent, requires GOJAJA_SESSION):
  plan [<role>] [--json]
      Fetch manifest: unread events, active tasks, open RFCs, ackToken.
      Defaults to JSON when stdout is not a TTY.
  ack [<role>] --token <t>
      Confirm the manifest. Cursor advances exactly to the snapshot.
  handbook [--json]
      Print the full collaboration handbook: when to worklog vs report vs
      RFC, escalation, task lifecycle, deliverable gates. The runtime
      prompt carries only a compact cheatsheet; read this for full policy.

Messaging (requires GOJAJA_SESSION, or --as-system for project owner):
  report --to <role> --message <text> [--ref <id>]
      Directed message. "I need you to act next." Refuses unknown recipients.
  worklog --message <text>
      Broadcast progress note to the team.

  Multi-line body safety: shells expand backticks and $() inside double
  quotes, so --message "see \`git push\`" actually runs git push. Use:
      --message 'short literal'         single quotes, no expansion
      --message - <<'EOF' ... EOF       stdin; quoted EOF keeps literal
      cat draft.md | gojaja ... --message -
      gojaja report --to X              interactive: opens $EDITOR
  The '-' sentinel tells gojaja to read stdin.

  --as-system: required when running report / task new / rfc new /
      rfc comment / state edit without GOJAJA_SESSION. Records
      actor=SYSTEM with pid/cwd/hostname for audit. Reserved for the
      human project owner — agents must claim a role instead.

Task board (task_board.yaml write access needed for new/assign;
per-task owner-exception for status):
  task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
           [--depends-on T-NNNN,...] [--acceptance <text>] [--parent T-NNNN]
           [--tag <label> ...] [--reviewer <role> ...]
           [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]
      With --owner: defaults to Pending. Without: Backlog. The actor is
      recorded as task.creator (immutable).
      --parent  link to existing task (depth <= 5, cycle-checked).
        Children inherit nothing; ownership/priority/status independent.
      --tag  free-form label; repeat for multiple.
      --reviewer  role authorised to mark Done; auto-receives status events.
      --asset  info pointer: kind=file (repo path) or kind=url.
      --deliverable  hard output gated on Done:
        kind=file (existence-checked), kind=url, kind=manual.
        Format: 'kind:ref' or 'kind:ref::description'.
  task assign <task-id> --to <role>
      Reassign. Does not change task.creator (audit via event stream).
  task status <task-id> <Backlog|Pending|InProgress|Blocked|Review|Done>
                       [--force-incomplete]
      Done permission: SYSTEM, task.reviewers, owner-if-creator, or
        task_board.yaml writer. Other transitions: owner, reviewers, or
        task_board.yaml writer.
      --force-incomplete bypasses the deliverable gate (not the permission
        gate) and emits TASK_DELIVERABLE_BYPASSED for audit.
  task list [--owner <role>] [--status <s>] [--tag <label> ...] [--json]
  task show <task-id>
      Shows parent, children, creator, reviewers, assets, deliverables
      with on-disk markers ([x] / [ ] / [?]).

RFCs (cross-role decisions; any role opens, designated decider closes):
  rfc new <slug> --title <text> --deciders <r1,...>
                 [--description <text>] [--options <A:summary,B:summary>]
                 [--voters <r1,...>] [--task T-NNNN[,T-NNNN]] [--deadline <iso>]
      --deciders per-RFC (no role-level default).
      --options optional: omit for brainstorm mode (free-form discussion;
        anyone can later add-option to upgrade into decision flow).
      --description context for non-participants (will be hard-required).
      --task links existing task ids for cross-reference.
  rfc comment <rfc-id> --rationale <text> [--option <opt>]
                       [--reply-to <comment-id>]
      Discussion comment. Multiple per role, threaded via --reply-to.
      Does NOT advance the ACK gate; use rfc ack/object for that.
      Allowed as SYSTEM (no session) for human comments.
  rfc add-option <rfc-id> --option <id>:<summary> --rationale <text>
      Add option mid-discussion. Invalidates any active pre-decision.
  rfc pre-decide <rfc-id> --option <opt> --rationale <text>
      Decider posts "I lean X". Every role in (voters + deciders) minus
      the pre-decider must ack or object before decide succeeds.
      Two entry gates:
        1) Comment-coverage: every required commenter must have posted
           a regular comment first (RFC_READY_TO_DECIDE auto-emitted
           when this gate flips green).
        2) No active pre-decision already (withdraw or add-option to
           unblock).
  rfc withdraw-pre-decision <rfc-id> --rationale <text>
      Author-only self-revoke of the active pre-decision.
  rfc ack <rfc-id> [--rationale <text>]
      Agree with the active pre-decision. Required-ACK roles only.
  rfc object <rfc-id> --rationale <text> [--option <preferred-opt>]
      Disagree. Rationale required; --option names your preferred alt.
  rfc decide <rfc-id> [--option <opt>] --rationale <text>
      Final accept. Enforces ACK gate. --option required when options
      exist; must NOT be passed for brainstorm-mode RFCs. Non-decider
      callers get FORBIDDEN (exit 9).
  rfc reject <rfc-id> --rationale <text>
      Final reject. Bypasses ACK gate (escape from stalled pre-decision).
  rfc revise <rfc-id> --rationale <text>
      Send back for rewrite (decider-only). Status -> revising.
  rfc edit <rfc-id> --rationale <text> [--title T] [--description D]
                     [--options A:s,B:s] [--deadline ISO]
      Apply rewrite in 'revising'; flips to 'open'. Creator or decider.
  rfc link-task|unlink-task <rfc-id> --task T-NNNN
      Attach / detach a task. Idempotent.
  rfc list [--status open|revising|accepted|rejected|superseded]
  rfc show <rfc-id> [--no-mark-seen]
      'show' advances your read marker; --no-mark-seen for read-only.

Shared-state editing (ownership-gated; --file under state/):
  state edit --file state/<path> [mode] [--json]
      Overwrite (default):  --content '<text>' or stdin
      Append:               --append '<text>'
      Find-and-replace:     --replace '<old>' --with '<new>' [--batch]
      Replace refuses 0 or N>1 matches; --batch allows all. Literal
      strings, no regex. All modes atomic, respect owns/mustNotEdit.

Keepalive (agent, requires GOJAJA_SESSION):
  wait [<role>] [--until <ISO> | --in <duration>]
                [--for <condition>] [--poll-interval <duration>] [--json]
      ONE blocking call (no token cost). Polls internally every
      --poll-interval (default from config.yaml, typically 10s). Omit
      deadline flags to wait indefinitely.

      --for is NOT a filter. wait wakes on ANY visible event (same
      projection as plan). --for upgrades the verdict from ATTENTION to
      CONDITION_MET when matched; the wait ends either way.

      Conditions (default: attention):
        attention                 always ATTENTION
        rfc-decided:RFC-NNNN     that RFC closes
        rfc-acked:RFC-NNNN       ack or object posted on that RFC
        task-assigned             task assigned to you; emits idle worklog
        report-from:<role>        directed report from that role
        event-ref:<id>            any event with that ref

      Verdicts (each prints "Next: ..."):
        ATTENTION       new events; run plan.
        CONDITION_MET   your condition fired; run plan.
        TIMEOUT         deadline reached; end turn or take initiative.

      Host kill recovery: re-run 'gojaja wait' with NO deadline flags to
      resume the in-progress wait. Cap at ~5 resumes, then end the turn.

Monitoring (human):
  watch [--port <n>] [--host <addr>] [--no-open]
      Web dashboard: role sessions, task board, RFCs, activity feed.
      127.0.0.1 bind exposes Setup + Actions tabs (write ops as SYSTEM).
      Non-loopback hides write tabs (read-only for LAN sharing). Ctrl-C
      to stop.

Project lifecycle (human only, no GOJAJA_SESSION):
  reset [--dry-run] [--confirm <basename>]
      Remove .gojaja/ (contracts), ~/.gojaja/projects/<id>/ (runtime
      state, soft-deleted to ~/.gojaja/trash/), .cursor/rules/
      gojaja-runtime.mdc, and the managed block in CLAUDE.md / AGENTS.md.
      Preview unless --confirm <project-basename>.

Global options:
  --root <path>       Override project root.
  --json              Force JSON output.
  --session <id>      Authenticate as this session instead of GOJAJA_SESSION.
                      Use on hosts that run each command in a fresh shell.

Information:
  version             CLI and schema version.
  help                This help.

Exit codes:
  0  OK
  2  USAGE         bad arguments; fix and re-run.
  3  NOT_INIT      .gojaja/ not found.
  4  ALREADY_INIT  .gojaja/ exists; use reset.
  5  UNKNOWN_ROLE  role not registered.
  6  LOCK_TIMEOUT  resource lock contention; retry.
  7  PATH_INVALID  path escaped the allowed tree.
  8  STATE_CORRUPT on-disk state malformed; stop and ask the user.
  9  FORBIDDEN     permission denied. Escalate to reportsTo, do not retry.

Run 'gojaja handbook' for the full collaboration policy. Not yet
implemented: doctor, upgrade.
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
      Create .gojaja/ (contracts) and ~/.gojaja/projects/<id>/ (runtime).
      Refuses on a dirty git tree; on a non-git project, asks for
      confirmation (or --force when stdin is not a TTY).`,

  role: `  gojaja role create <id> [<title>] [--owns a,b] [--reports-to r1,r2] [--must-not-edit a,b] [--as-system]
  gojaja role list
  gojaja role show <id>
  gojaja role delete <id> [--as-system]
      Manage roles. 'create' writes config.yaml + roles/<id>.md (fill TBD
      sections). 'delete' also invalidates any live session. Both require
      --as-system or a session for a role owning config.yaml.`,

  prompt: `  gojaja prompt --target agents|claude|cursor|generic [--write]
                [--force-rewrite] [--no-handbook] [--json]
      Install the project's role-free runtime rule.
        agents  -> AGENTS.md (cross-tool standard)
        claude  -> AGENTS.md + CLAUDE.md importer
        cursor  -> standalone .cursor/rules/*.mdc (fallback)
        generic -> printed only`,

  activate: `  gojaja activate <role> --target agents|claude|cursor|generic [--no-copy] [--json]
      Print (and auto-copy) the chat-paste snippet that binds <role> to
      one agent window. Never writes to disk.`,

  claim: `  gojaja claim <role> [--ttl <seconds>] [--session <id>] [--eval] [--force] [--json]
      Acquire a session (default lease 2h).
      eval "$(gojaja claim <role> --eval)" claims + exports in one step.
      --session <id>: idempotent recovery — re-export the live session
      without taking over a peer.
      --force: human-only takeover.`,

  release: `  gojaja release [<role>] [--json]
      Release the session; then run 'unset GOJAJA_SESSION'.`,

  plan: `  gojaja plan [<role>] [--json]
      Fetch manifest: unread events, active tasks, open RFCs, ackToken.
      Defaults to JSON when stdout is not a TTY.`,

  ack: `  gojaja ack [<role>] --token <t>
      Confirm the manifest (advances your cursor).`,

  handbook: `  gojaja handbook [--json]
      Print the full collaboration handbook: when to worklog vs report
      vs RFC, escalation, task lifecycle, deliverable gates.`,

  report: `  gojaja report --to <role> --message <text> [--ref <id>]
      Directed message ("I need you to act next").
      Allowed with --as-system (human, no session; recorded as SYSTEM).`,

  worklog: `  gojaja worklog --message <text>
      Broadcast a progress note to the team.`,

  task: `  gojaja task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]
                  [--depends-on T-NNNN,...] [--parent T-NNNN] [--acceptance <text>]
                  [--tag <l> ...] [--reviewer <role> ...]
                  [--asset 'kind:ref::desc' ...] [--deliverable 'kind:ref::desc' ...]
  gojaja task assign <id> --to <role>
  gojaja task status <id> <Backlog|Pending|InProgress|Blocked|Review|Done> [--force-incomplete]
  gojaja task list [--owner <role>] [--status <s>] [--tag <label> ...] [--json]
  gojaja task show <id>
      Manage the shared task board. file-kind deliverables are
      existence-checked on the Done transition.`,

  rfc: `  gojaja rfc new <slug> --title <t> --deciders <r1,...> [--options A:s,B:s]
                [--description <t>] [--voters <r1,...>] [--task T-NNNN] [--deadline <iso>]
  gojaja rfc comment|add-option|pre-decide|withdraw-pre-decision|ack|object|decide|reject|revise|edit <rfc-id> ...
  gojaja rfc link-task|unlink-task <rfc-id> --task T-NNNN
  gojaja rfc list [--status ...] | rfc show <rfc-id> [--no-mark-seen]
      Cross-role decisions. Two gates on pre-decide: comment-coverage
      (required commenters must post first; RFC_READY_TO_DECIDE auto-
      emitted when met) and active-pre-decision (withdraw or add-option
      to unblock). Run 'gojaja handbook' for the full RFC walkthrough.`,

  state: `  gojaja state edit --file state/<path> [mode] [--json]
      Ownership-gated edit under state/. Modes (pick one):
      default overwrite (--content / stdin), --append <text>, or
      --replace <old> --with <new> [--batch].`,

  wait: `  gojaja wait [<role>] [--until <iso> | --in <duration>] [--for <condition>]
              [--poll-interval <duration>] [--json]
      Idle keepalive: ONE blocking call (no token cost) that polls
      internally until new attention, the named condition, or the
      deadline. Omit --in/--until to wait indefinitely. Host kill
      recovery: re-run 'gojaja wait' (no deadline flags); cap ~5 resumes.`,

  watch: `  gojaja watch [--port <n>] [--host <addr>] [--no-open]
      Web dashboard: roles, task board, RFCs, activity feed.
      127.0.0.1 bind exposes Setup + Actions (write ops as SYSTEM).
      Non-loopback hides write tabs (read-only). Ctrl-C to stop.`,

  reset: `  gojaja reset [--dry-run] [--confirm <basename>] [--purge] [--force]
      Remove .gojaja/ (contracts) + ~/.gojaja/projects/<id>/ (runtime,
      soft-deleted to ~/.gojaja/trash/) + Cursor rule + managed block
      in CLAUDE.md / AGENTS.md. --purge hard-deletes without trash.
      Preview unless --confirm <project-basename>. No GOJAJA_SESSION.
      Refuses on dirty/non-git project; --force bypasses.`,

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

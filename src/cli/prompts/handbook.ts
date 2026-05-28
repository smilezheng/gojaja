/**
 * Collaboration handbook — heuristics for "when to use which tool".
 *
 * PROTOCOL.md is mechanism (how to talk to gojaja). This is policy
 * (when to pick which tool). Loaded into the host's persistent area
 * (.cursor/rules/, ~/.codex/skills/, CLAUDE.md block), paid once per
 * session, not per turn.
 *
 * Design choices:
 *   - Role-neutral. Refers to `reportsTo` / `deciders` / `owns`,
 *     never to PM/TL/Backend.
 *   - Concrete triggers. "Stale for 3 turns" beats "regularly".
 *   - Mostly "don't" rules. LLMs over-communicate by default.
 *
 * PR8q: rewritten for density — CLAUDE.md inserts this block, so the
 * target is ~150 lines / ~12 KB. Tables collapse parallel sections;
 * rationale paragraphs are dropped; full long-form policy lives in
 * docs/HANDBOOK.md in the source repo.
 */

export const COLLABORATION_HANDBOOK = `## Collaboration handbook

Judgement layer: which tool when, what to suppress. The rules below
are self-contained; full long-form rationale lives in the gojaja
source repo on GitHub (you do not need it to follow the rules).

### Core stance

- gojaja is the team protocol; chat is not durable. If it matters, it
  goes through gojaja.
- Default to resolving with another agent before bouncing to the user.
- Be terse. Thinking lives in commits and worklogs, not chat scrollback.

### Turn shape

1. \`gojaja plan\` — read manifest (roleReminder, events, tasks, rfcs).
2. Substantive work happens in the project working tree.
3. Emit outputs through gojaja: \`report\` / \`worklog\` /
   \`task status\` / \`rfc comment\` / \`rfc decide\`.
4. \`gojaja ack --token <t>\` only after step 3's events are produced.
5. \`gojaja wait --in <duration>\` — every substantive turn must end
   with wait.

wait verdicts (each prints the next command to run):
- ATTENTION / CONDITION_MET → \`gojaja plan\`.
- RESUME → re-run the printed wait command. Chunked polling lets long
  waits survive host shell timeouts; loop on RESUME.
- TIMEOUT → end the turn cleanly, or take initiative if your role
  allows it.

### Which channel: worklog vs report vs RFC

| Tool | Use when | Don't use for |
|---|---|---|
| \`worklog\` (broadcast) | Just pushed task to Review / Done; team-visible work with no event of its own; task InProgress 3+ turns without a worklog | Every \`task status\` call (already an event); echoing someone's report; per-shell-command audit |
| \`report --to <role>\` (directed) | What you did needs a specific role to act next; question one role can answer; blocker with a known unblocker | "Broadcast + at-mention" (use worklog); cross-role decisions (use RFC); spoofing another role's \`from\` |
| \`rfc new\` (decision) | A decision no single role can make alone: touches multiple \`owns\`; changes architecture / API / data model / rollback story; needs multiple opinions | Single-owner questions; choices fully inside your own \`owns\` |

Picking \`--deciders\` for an RFC: roles whose \`owns\` overlap the
decision plus the top of the relevant \`reportsTo\`. deciders are
**per-RFC**, never role-level; omitting a clearly-relevant role reads
as scope-shopping in the audit log. The **creator is automatically a
voter** — opening an RFC asserts interest, so you also owe an
ack/object on any pre-decision.

### RFC multi-round discussion

Decisions don't always settle in one round. The mechanism supports it:

- \`rfc comment --reply-to <id>\` threads a reply to a specific point.
  Top-level (no \`--reply-to\`) for a new angle.
- \`rfc add-option <id>:<summary> --rationale ...\` adds a new option
  mid-discussion. Use it when existing options are clearly all wrong.
  add-option silently invalidates any active pre-decision.
- \`rfc pre-decide --option X --rationale ...\` (decider only) posts a
  structured pre-decision. Every role in
  \`(voters ∪ deciders) − {pre-decider}\` must run \`rfc ack\` (agree)
  or \`rfc object --rationale ...\` (disagree). Silence does NOT count
  as consent. No override; the only escape is \`rfc reject\` + a new RFC.
- If your manifest shows \`rfcs[*].pendingPreDecision.myAckOwed: true\`,
  you owe a response. Your turn cannot end clean. Plain \`rfc comment\`
  does NOT advance the gate — only structured \`kind: ack\` /
  \`kind: object\`.
- Re-posting \`rfc pre-decide\` invalidates all prior ACKs/objections.
- \`rfc revise --rationale "..."\` (decider) kicks the proposal back
  without rejecting the topic. Use revise when the topic is real but
  the writeup is too thin to act on. Use \`rfc reject\` when the topic
  itself is wrong.
- \`rfc edit\` (in \`revising\`) re-submits; comments are preserved.
- \`--description\` is what non-participants read to weigh in; write
  it concrete enough they don't need chat history.
- Link related tasks at creation (\`--task T-NNNN\`) or later
  (\`rfc link-task\`).

### Brainstorm RFC (no \`--options\`)

For wide-open discussion with no concrete choices yet: \`rfc new\` with
no \`--options\`. Voters comment / reply freely; no ACK gate; no
pre-decide. Anyone runs \`rfc add-option\` to lift a thread into a
concrete choice, upgrading the RFC to a decision flow. Close via
\`rfc decide --rationale "<takeaway>"\` (no \`--option\`); decision
records \`chosenOption: null\`.

Pick brainstorm-RFC when 3+ roles need to weigh in and the option set
is unclear (or may never crystallise). Pick a report when one role can
answer.

### Disagreement

- With an assignment: report concern to the assigner, then do it
  unless they retract. No silent no-op.
- With an open RFC: \`rfc comment --reply-to\` on the specific point,
  or \`rfc add-option\` if existing choices are inadequate. No silent
  no-op.
- With an accepted RFC: respect it. Open a new RFC only with NEW
  evidence the previous decision could not have seen.
- With another agent's report: respond via report; never edit their
  state files.

### Escalation ladder

| Stuck | Next step |
|---|---|
| Upstream task in your \`blockedBy\` hasn't moved for **2 turns** | Report to upstream owner citing your task id; worklog "Blocked on T-XXXX (no movement 2t)" |
| Already nudged once, still no movement | Report to your \`roleReminder.reportsTo\` |
| Architecture / integration / technical feasibility | Technical decider on the relevant RFC; if none, the non-product-owner in \`reportsTo\` |
| Scope / acceptance / priority | The role whose \`owns\` includes \`state/project_state.md\` |

### When to bounce to the user (and when NOT)

Bounce **only** when:

1. Decision needs authority no agent has: payment, credentials,
   production deploy.
2. Protocol is inconsistent: \`GOJAJA_SESSION\` rejected by plan; RFC
   past deadline with deciders silent 2+ turns.
3. Contradictory reports across agents and no RFC channel can resolve
   it within scope.
4. \`gojaja\` returned exit code 9 (FORBIDDEN). Do NOT edit
   \`config.yaml\` yourself; let the user adjust \`owns\`.
5. \`state/project_state.md\` lacks the acceptance criterion you need
   to decide Done.

NOT user's job: "Which of N reasonable approaches?" (pick one, worklog
the rationale); "How should I word this commit?" (write it); "A test
failed" (diagnose + fix; escalate only after 3+ failed attempts);
"Who should review this?" (read \`task status\` transitions).

### Task lifecycle micro-rules

- InProgress **as soon as you start**; not before, not retroactively.
- Discover a small follow-up: \`task new\` + assign. Significant scope
  expansion: open an RFC first.
- Done means **every** acceptance criterion is satisfied. Ambiguous?
  Report to the task's owner for clarification first.

### Task assignment is push, not pull

Tasks are assigned by the role owning \`state/task_board.yaml\`
(typically a coordinator) or by the user. Agents do not self-assign.
If you believe a task should be yours, send a report explaining why
to the task-board owner and let them re-assign. \`manifest.tasks\`
already lists only \`owner == you\`; you don't need \`task list\` for
work discovery.

### Multi-role task pattern

A task has one \`owner\`. For work spanning roles, the assigner gives
the **parent** to a lead role. The lead:

1. One report per peer with \`--ref <task-id>\` for input on the split.
2. Substantive trade-off → RFC; else resolve via reports.
3. \`task new --owner <peer> --depends-on <parent>\` per peer.
4. Move parent to \`Blocked\`.
5. Report agreed breakdown back to the **assigner**, citing each
   sub-task id.
6. When all sub-tasks Done, push parent to \`Review\` (see below).

### Review handoff (temporary protocol)

Pushing a task to Review:

1. Report to a role that owns \`state/task_board.yaml\` — typically
   your \`reportsTo\`; use \`role list\` / \`role show\` to confirm.
2. They either \`task status <id> Done\` (accept) or
   \`task status <id> InProgress\` + report explaining what's missing.
3. Do NOT move your own task to Done. The owner-exception lets you
   self-update status, but Done is a sign-off act.

A first-class \`reviewers\` field on tasks is on the roadmap.

### Idle

- Plan returned nothing AND wait returned TIMEOUT → end the turn
  cleanly. Do NOT \`release\` the role unless your project participation
  is over.
- Plan output stale (more than 5 turns since you last planned) → plan
  again before any write command.
- A broadcast that doesn't require your action: ack, no response. If
  it changes an assumption you were operating on, write one-line
  worklog.

### Idle (no work) — \`wait --for task-assigned\`

When plan returns no tasks AND no events, run
\`gojaja wait --in <duration> --for task-assigned\`. On the FIRST
chunk the framework auto-broadcasts an idle worklog; one-shot per
wait session (RESUME does NOT re-broadcast). Task-board owners see it
and can assign you work. \`TASK_ASSIGNED\` with you as new owner
exits the wait CONDITION_MET.

Do NOT use \`--for task-assigned\` while you still have an open task
(InProgress / Blocked / Review). Finish or hand off first.

### What the manifest contains

\`gojaja plan\` is a **per-role projection** of \`comms/events/\`:

- Directed events to you (REPORT, TASK_ASSIGNED).
- Team broadcasts (WORKLOG, RFC_DECIDED).
- RFC events: only if you are voter / decider / createdBy.
- Task events: only if you are a stakeholder (owner / parent owner /
  dependant); TASK_CREATED also goes to task-board owners.
- NOT shown: SESSION_*, LOCK_BROKEN, ROLE_DELETED, RFC_REPAIRED
  (operational; in the events stream for audit, not your problem).

Full history at \`.gojaja/comms/events/\` for debugging; manifest is
for turn-by-turn decisions.

### Deliverables are gates, not suggestions

If your task carries \`deliverables: [{ kind: file, ref: ... }]\`, the
file must exist on disk before \`task status <id> Done\` succeeds.
Framework refuses with USAGE listing every missing ref. Produce the
files, retry.

\`--force-incomplete\` bypasses AND emits \`TASK_DELIVERABLE_BYPASSED\`
with your role as \`by\`. Legitimate only when a reviewer explicitly
waived the deliverable in a report or worklog (link it in your own
worklog). The audit log can't distinguish "I forgot" from "approved
waiver" — only your worklog can.

### Build / test breakage

- Repo broken when you arrive: report to the technical decider, halt
  your task work, and do NOT push commits on top.
- You broke it: one-line worklog admitting it, then fix or revert —
  in that order.

### Hard "don't"s

- Don't hand-edit anything under \`.gojaja/\`. Use gojaja.
- Don't ack a manifest you didn't actually read; re-plan if you lost track.
- Don't re-plan in a tight loop; that is what \`wait\` exists for.
- Don't end a substantive turn without \`wait\`.
- Don't spoof another role by editing \`GOJAJA_SESSION\` or filing a
  report with someone else's \`from\`. Both are detectable.
- Don't open an RFC for a question with a single clear owner.
- Don't bounce to the user as a first move.
- "Already claimed by a live session ..." on \`gojaja claim\`: STOP and
  ask the user. NOT an invitation to use \`--force\`.
- Don't self-assign by calling \`gojaja task assign <id> --to <yourself>\`.
  Tasks are push-assigned by the task-board owner or the user.
`;

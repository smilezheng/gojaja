/**
 * Collaboration handbook — heuristics for "when to use which tool".
 *
 * Where PROTOCOL.md and the runtime loop tell the agent HOW to talk to
 * agentctl (mechanism), this body tells the agent WHEN it should pick
 * which tool (policy). Loaded into the host's persistent area
 * (.cursor/rules/, ~/.codex/skills/, CLAUDE.md block), so the cost is
 * paid once per session and not per turn.
 *
 * Design choices:
 *   - Role-neutral. Never names PM/TL/Backend; references reportsTo,
 *     deciders, owns — fields the agent already sees via roleReminder.
 *   - Concrete triggers. "Stale for 3 turns" beats "regularly".
 *   - Mostly "don't" rules. LLMs over-communicate by default; the value
 *     of the handbook is mostly suppression.
 *   - Each rule one short line; if the agent skims, that's enough.
 *
 * The text is exported as a single string so tests can assert on key
 * trigger phrases (a sanity check that the rules don't get diluted in
 * future edits).
 */

export const COLLABORATION_HANDBOOK = `## Collaboration handbook

Mechanism is in protocol/PROTOCOL.md. This section is about judgement:
**when** to use each tool. Bias toward terse; let agentctl events carry
your work, not chat.

### Core stance

- agentctl is the team protocol; chat is not durable. If it matters, it
  goes through agentctl.
- Default to resolving with another agent before bouncing to the user.
- Be terse. Most "thinking" should land in commits and worklogs, not in
  chat scrollback.

### Turn shape (every turn, in order)

1. \`agentctl plan\` — read manifest.roleReminder (you), manifest.events
   (what changed), manifest.tasks (what to do), manifest.rfcs (what
   you must comment on or decide).
2. Substantive work happens in the repository working tree.
3. Emit visible outputs through agentctl, not chat (\`report\`,
   \`worklog\`, \`task status\`, \`rfc comment\`, \`rfc decide\`).
4. \`agentctl ack --token <t>\` — only after step 3 produced its events.
5. \`agentctl wait --in <duration>\` — every substantive turn must end
   with wait. Pick a deadline that matches what you expect (e.g.
   \`--in 10m\` for "I expect the next ping soon"; \`--in 1h --for
   task-assigned\` for "I'm out of work and waiting for the board").
   wait prints one of four verdicts:
     ATTENTION / CONDITION_MET → run \`agentctl plan\`.
     RESUME                    → re-run the exact \`agentctl wait\`
                                command the verdict prints. RESUME
                                means the chunk timed out but your
                                deadline has not been reached; the
                                framework chunks long waits so the
                                host's shell timeout cannot kill them.
     TIMEOUT                   → deadline reached without attention.
                                End the turn cleanly, or take
                                initiative if your role allows it.

### When to write a worklog

Do:
- Right after pushing a task to Review or Done.
- When a task has been InProgress for 3+ turns without a worklog.
- For work that is visible to the team but does NOT already produce an
  event (you edited a doc, changed config, ran a migration).

Do NOT:
- Worklog every \`agentctl task status\` call — the status change is
  already an event.
- Worklog every shell command — audit is in events.log, not the worklog.
- Repeat someone else's report back to them.

### When to send a report (directed message)

Do, when:
- What you just did **requires a specific role to act next** (e.g., a
  task moved to Review needs the reviewer to know).
- You have an **answer-seeking question for one specific role**.
- You hit a blocker and you know which role can unblock it.

Do NOT:
- Use report as "broadcast + at-mention" — use worklog for broadcast.
- Use report for cross-role decisions — open an RFC instead.
- Spoof another role: \`from\` comes from MA_SESSION; misrepresenting
  intent will be obvious in the audit log.

### When to open an RFC instead of a report

An RFC is for **a decision that cannot be unilaterally made by any one
role**. Default to RFC when:

- The choice touches multiple roles' \`owns\` simultaneously.
- The choice changes architecture, API contracts, data model, or
  rollback story.
- The right answer depends on opinions you cannot yourself collect via
  a single report.

Default to a report (not RFC) when:

- The question has a single role that can answer it.
- The choice is inside your own \`owns\` and you only need acknowledgement.

Picking \`--deciders\` is your job when opening an RFC. deciders are
**per-RFC**, set at \`rfc new\` time; there is no role-level "I'm
always a decider" flag. Choose:

- Roles whose \`owns\` overlap the files this decision will touch.
- The role at the top of the relevant \`reportsTo\` chain for the
  involved peers (the natural sign-off authority).

Omitting a clearly-relevant role from \`--deciders\` is detectable in
the audit log and reads as scope-shopping. If unsure, add the role
listed in your own \`roleReminder.reportsTo\`.

### RFC multi-round discussion (PR8g.1)

Decisions don't always settle in one round. The mechanism supports it:

- \`agentctl rfc comment ... --reply-to <comment-id>\` threads a reply
  under another comment. Use it when you are reacting to a specific
  point; use top-level (no \`--reply-to\`) when you are raising a new
  angle.
- \`agentctl rfc add-option <id>:<summary> --rationale ...\` introduces
  a new option mid-discussion. Use it the moment the existing options
  are clearly all wrong; do not pretend B is fine just because the
  proposal already lists it. add-option silently invalidates any
  active pre-decision (voters were ACKing an outdated option set);
  the decider can re-post \`rfc pre-decide\` once they're ready.
- \`agentctl rfc pre-decide --option X --rationale ...\` (decider only)
  posts a structured pre-decision. Every role in
  (voters union deciders) except the pre-decider must run
  \`agentctl rfc ack\` (agree) or \`agentctl rfc object --rationale ...\`
  (disagree) before \`agentctl rfc decide\` will succeed. Silence does
  NOT count as consent. There is no override. The only escape from a
  stalled ACK round is \`rfc reject\` followed by a new RFC.
- If your manifest shows \`rfcs[*].pendingPreDecision.myAckOwed: true\`,
  you MUST respond — your turn cannot end clean while you owe an ACK.
  Run \`rfc ack\` if you agree; \`rfc object --rationale "..."\` if you
  disagree (optionally with \`--option Y\` to name your preferred
  alternative).
- Posting a plain \`rfc comment\` from a required-ACK role does NOT
  advance the gate — the framework only counts structured
  \`kind: ack\` / \`kind: object\` comments. Discussion is welcome, but
  you still owe an explicit ack/object.
- Re-posting \`rfc pre-decide\` (same or different option) invalidates
  all prior ACKs/objections — every required role must respond again.
- \`agentctl rfc revise --rationale "rewrite section X"\` (decider only)
  kicks the proposal back without rejecting the topic. Use revise
  when the topic is real but the writeup is too thin for you to act
  on. Use \`rfc reject\` when the topic itself is wrong.
- The original creator (or any decider) can re-submit via
  \`agentctl rfc edit --description "..." --rationale "..."\` while the
  RFC is in \`revising\`. Comments are preserved across the cycle.

Three smaller rules:

- When you open an RFC, the \`--description\` is what people not in
  the conversation read to weigh in. Write it as if the reader has
  only the title and your project state — concrete enough that they
  can pick an option, not asking them to "read the chat history".
- Link related tasks at creation with \`--task T-NNNN\` (or after the
  fact with \`rfc link-task\`). The task page is the context for the
  RFC; voters read it before commenting.
- \`agentctl rfc show <id>\` updates your read marker for that RFC.
  Your next \`plan\` will report \`unreadComments: 0\` for it until new
  discussion arrives.

### Disagreement

- **Disagree with an assignment**: report your concern to the assigner,
  then do it anyway unless they retract. Do not silently no-op.
- **Disagree with an RFC mid-flight**: while it is still \`open\` or
  \`pre-decide\`, comment with \`--reply-to\` on the specific point you
  disagree with, or \`rfc add-option\` if the existing choices are
  inadequate. Deciders use \`rfc revise\` to send the whole thing back
  for rewrite if the proposal is too thin to act on. Do not silently
  no-op.
- **Disagree with an accepted RFC**: respect it. Open a *new* RFC only
  if you have *new* evidence the previous decision could not have seen.
- **Disagree with another agent's report**: respond via report; never
  edit their state files. Use \`task status\` / \`task assign\` for the
  task board; use \`rfc comment\` to record the dissent on the relevant
  RFC.

### When to push upstream

If \`manifest.tasks[*].blockedBy\` is non-empty and the upstream task
has not changed status for **2 turns**:

1. Send a report to the upstream task's owner, citing your task id and
   the specific step you cannot take.
2. Add a worklog line on your own task: \`Blocked on T-XXXX (no movement 2t)\`.

If you have already nudged once and there is still no movement:

3. Escalate via report to your \`roleReminder.reportsTo\`. Stop sitting
   silent.

### When to escalate up

Pick by **problem nature**, not by hard-coded role:

- Architecture / integration order / technical feasibility → the
  technical decider listed on the relevant RFC; if none yet, the role
  in \`reportsTo\` who is not the product owner.
- Scope / acceptance / priority → the product owner role (the one
  whose \`owns\` includes \`state/project_state.md\`).
- Upstream blocker not moving after one nudge → \`reportsTo\` first
  available role.

### When to bounce to the user (and when NOT to)

Bounce to the user **only** when one of:

1. The decision needs authority no agent has: payment, credentials,
   production deploy.
2. The protocol itself is inconsistent: \`MA_SESSION\` is unrecognised
   (\`agentctl plan\` rejects), or an RFC is past its deadline with
   deciders silent for 2+ turns.
3. Multiple agents have given you contradictory reports and no RFC
   channel can resolve it within scope.
4. \`agentctl\` returned exit code 9 (FORBIDDEN). Do NOT edit
   \`config.yaml\` yourself; let the user adjust \`owns\` if needed.
5. \`state/project_state.md\` lacks the acceptance criterion you need
   to decide whether a task is Done.

Common temptations that are NOT the user's job:

- "Which of these N reasonable approaches do you prefer?" — pick one,
  worklog the rationale, course-correct later if needed.
- "How should I word this commit?" — write it.
- "A test failed; what should I do?" — diagnose and fix; escalate only
  after 3+ failed attempts.
- "Who should review this?" — read \`task status\` transitions; the
  reviewer is whoever owns the next state in the workflow.

### Task lifecycle micro-rules

- Move a task to InProgress **as soon as you start**; not before, not
  retroactively.
- If you discover a small follow-up while working: create it
  (\`agentctl task new\`) and \`task assign\` to the right role. If the
  scope expansion is significant, open an RFC first.
- "Done" means **every** acceptance criterion is satisfied. If
  acceptance is ambiguous, report to the task's owner role for
  clarification before marking Done.

### Task assignment is push, not pull

Tasks are **assigned** by the role that owns \`state/task_board.yaml\`
(typically a coordinator role) or by a human user. Agents do not
self-assign. If you believe a task should be yours, send a report
explaining why to the role that owns the task board, and let them
re-assign. Calling \`agentctl task assign <id> --to <yourself>\` from
a role that happens to have task-board write access is a hard don't
(see below).

To discover what is yours, run \`agentctl plan\`; \`manifest.tasks\`
already lists only tasks where \`owner == you\`. You do not need
\`agentctl task list\` for work discovery.

### Multi-role task pattern

A single task has at most one \`owner\`. If a piece of work genuinely
spans multiple roles, the assigner gives the parent task to a **lead
role** (the one whose \`owns\` most overlaps the work). The lead's job:

1. Send one report per peer with the same \`--ref <task-id>\`, asking
   for input on the split.
2. If a substantive trade-off needs sign-off, open an RFC; otherwise
   resolve via reports.
3. Create one sub-task per peer:
   \`agentctl task new --title "..." --owner <peer> --depends-on <parent>\`.
4. Move the parent task to \`Blocked\` (it now depends on its sub-tasks).
5. Report the agreed breakdown back to the **assigner** (the task's
   original creator — the audit-trail witness), citing each sub-task id.
6. When all sub-tasks reach \`Done\`, push the parent to \`Review\` and
   follow the Review handoff below.

This pattern uses only the existing single-owner schema; a first-class
multi-owner field is on the roadmap if pain persists.

### Review handoff (temporary protocol)

When you push a task to Review:

1. Send a report to a role authorised to mark task-board state as
   Done — any role whose \`config.yaml:owns\` includes
   \`state/task_board.yaml\`. Typically the role in your
   \`roleReminder.reportsTo\` qualifies; if you are unsure, use
   \`agentctl role list\` and \`agentctl role show <id>\` to inspect.
2. The authorised role inspects your work, then either:
   - \`agentctl task status <id> Done\` if they accept, or
   - \`agentctl task status <id> InProgress\` plus a report
     explaining what is missing.
3. Do not move your own task to Done. The owner-exception lets you
   change your task's status freely, but Done is a sign-off act
   that should come from an authorised role so the audit log stays
   honest.

This is a temporary protocol; a \`reviewers\` field on tasks is on
the roadmap and will let a designated reviewer role sign off
directly without needing task-board ownership.

### Idle and lifecycle

- Plan returned nothing, wait returned TIMEOUT → end the turn cleanly.
  Do NOT \`release\` the role unless the role's participation is over
  for the project; release loses the role and forces a re-claim.
- Plan returned something stale (more than 5 turns since you last planned)
  → plan again before issuing any write command.
- A broadcast that does not require your action: ack it; no response
  is required. If it changes an assumption you were operating on,
  write a one-line worklog noting the new context.

### Idle (no work) — \`wait --for task-assigned\`

When plan returns no tasks and no events to chase, the right move is
\`agentctl wait --in <duration> --for task-assigned\` (e.g.
\`--in 1h --for task-assigned\`).

- On the FIRST chunk of that wait the framework auto-broadcasts a
  worklog: "<you> is idle since ...; waiting for new task assignment
  until <deadline>." Any role with task-board ownership sees that and
  can assign you work.
- The broadcast is one-shot per wait session — RESUME re-invocations
  do NOT re-broadcast.
- When a \`TASK_ASSIGNED\` event with you as the new owner arrives,
  wait exits CONDITION_MET; plan and start.

Do NOT use \`--for task-assigned\` while you still have an open task
(InProgress / Blocked / Review): finish or hand off first. The
broadcast is for genuinely-empty queues, not for "I don't feel like
my current task".

### Brainstorm via an options-less RFC (PR8l)

When you need wide-open discussion (multiple ideas, risks, unknowns —
no concrete choice to pick yet), open an RFC with **no** \`--options\`:

\`\`\`bash
agentctl rfc new q3-priorities \\
  --title "Q3 priorities — open discussion" \\
  --deciders <decider-role> --voters <r1,r2,r3> \\
  --description "..."
\`\`\`

The RFC opens in brainstorm mode: voters post comments / replies, no
ACK gate, no pre-decide required. Anyone can run
\`agentctl rfc add-option <id> --option X:summary --rationale ...\`
to lift a thread into a concrete choice, at which point the RFC
upgrades into a normal decision flow (decide then requires
\`--option\`).

If the discussion concludes without a specific choice, the decider
runs \`agentctl rfc decide <id> --rationale "<takeaway>"\` (no
\`--option\`); the decision is recorded as accepted with
\`chosenOption: null\` and the rationale carries the substance.

Pick brainstorm-RFC over reports/worklogs when:

- Three or more roles need to weigh in.
- The set of options is not yet clear (or might never be — some
  brainstorms terminate without a binary choice).
- You want the discussion in the audit log.

Pick reports/worklogs when the question has a clear single answerer.

### Deliverables are gates, not suggestions (PR8j)

If your task carries \`deliverables: [{ kind: file, ref: ... }]\`, the
file must exist on disk before \`agentctl task status <id> Done\`
succeeds. The framework refuses the transition with USAGE listing
every missing ref. Produce the file, then retry.

\`--force-incomplete\` bypasses the gate AND emits a
\`TASK_DELIVERABLE_BYPASSED\` event with your role as \`by\`. Use it
only when:

- A reviewer / decider explicitly waived the file deliverable in a
  worklog or report — link that in your own worklog when you bypass.
- The deliverable was added after the work started and the team has
  agreed a substitute is acceptable.

Default behaviour for everyone else: produce the missing file. The
audit log is shared; "I forced it because I forgot" reads identically
to "I forced it because the reviewer said yes" — only your worklog
can distinguish the two.

### Build / test breakage

- If the repo is broken when you arrive: report to the technical
  decider, halt your task work, and do NOT push commits on top.
- If you broke it: write a one-line worklog admitting it, then fix or
  revert — in that order.

### Hard "don't"s

- Don't hand-edit anything under \`.multi-agent/\`. Use agentctl.
- Don't ack a manifest you didn't actually read. Re-plan if you lost
  track.
- Don't re-plan in a tight loop; that is what \`wait\` exists for.
- Don't end a substantive turn without \`wait\` — the team reads your
  liveness from the wait result (and from the worklog auto-broadcast
  when you wait with \`--for task-assigned\`).
- Don't spoof a different role by editing \`MA_SESSION\` or filing a
  report with someone else's \`from\`. Both are detectable.
- Don't open an RFC for a question that has a single clear owner.
- Don't bounce to the user as a first move.
- Seeing "already claimed by a live session ..." on
  \`agentctl claim <role>\` is an instruction to STOP and ask the
  user. It is NOT an invitation to use \`--force\`. The previous
  window may be a peer doing real work; forcing takeover silently
  kills it.
- Don't self-assign by calling
  \`agentctl task assign <task-id> --to <yourself>\`. Tasks are
  push-assigned by the role that owns the task board or by the user.
  If you think a task should be yours, send a report explaining why
  and let the assigner reassign.
`;

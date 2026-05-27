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
5. \`agentctl wait\` — every substantive turn must end with wait, so
   the rest of the team can read your status as IDLE or ATTENTION.

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

### Disagreement

- **Disagree with an assignment**: report your concern to the assigner,
  then do it anyway unless they retract. Do not silently no-op.
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

- Plan returned nothing, wait returned IDLE → end the turn cleanly.
  Do NOT \`release\` the role unless the role's participation is over
  for the project; release loses the role and forces a re-claim.
- Plan returned something stale (more than 5 turns since you last planned)
  → plan again before issuing any write command.
- A broadcast that does not require your action: ack it; no response
  is required. If it changes an assumption you were operating on,
  write a one-line worklog noting the new context.

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
  liveness from the wait result.
- Don't spoof a different role by editing \`MA_SESSION\` or filing a
  report with someone else's \`from\`. Both are detectable.
- Don't open an RFC for a question that has a single clear owner.
- Don't bounce to the user as a first move.
- Seeing "already claimed by a live session ..." on
  \`agentctl claim <role>\` is an instruction to STOP and ask the
  user. It is NOT an invitation to use \`--force\`. The previous
  window may be a peer doing real work; forcing takeover silently
  kills it.
`;

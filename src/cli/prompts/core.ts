import type { Target } from "./types";

export interface RuntimeBodyOptions {
  /**
   * Include the compact "when to use which" cheatsheet in the injected
   * card. Default true. The full judgement layer is NOT embedded — it is
   * served on demand by `gojaja handbook`, so the always-injected card
   * stays inside CLAUDE.md's ~200-line budget.
   */
  withHandbook?: boolean;
  /**
   * Host target. Currently does not change the runtime body (the `wait`
   * recommendation is uniform across hosts now that a single call blocks
   * internally). Kept for per-host tweaks we may add later.
   */
  target?: Target;
}

/**
 * The shared "agent runtime loop" content. Every host target wraps this
 * with host-specific frontmatter / activation glue.
 *
 * Two important invariants of this text:
 *
 *   1. It is ROLE-AGNOSTIC. It tells the agent how to find its identity
 *      (via GOJAJA_SESSION and `gojaja plan`), not what role it is. The
 *      role is bound at activation time, not when the prompt is written.
 *
 *   2. It restates the protocol on every turn implicitly: an agent that
 *      has been context-compressed only needs to read this block (which
 *      lives in the host's persistent area) and run `gojaja plan` to
 *      reconstitute its identity and unread work.
 */
export function runtimeLoopBody(
  _projectRoot: string,
  opts: RuntimeBodyOptions = { withHandbook: true },
): string {
  const cheatsheet = opts.withHandbook === false ? "" : `\n${WHEN_TO_USE_WHICH}`;
  const waitCmd = waitRecommendation(opts.target);
  // projectRoot is intentionally NOT baked into the runtime body. The
  // body is written into committed files (cursor rule, CLAUDE.md
  // marker block) and copied across machines; an absolute path makes
  // the artifact host-specific (wrong root on another checkout).
  // `gojaja` discovers the project root from the shell's cwd at
  // runtime — the rendered text says exactly that. The parameter
  // remains so callers can pass cwd-discovery vs. a chat activation
  // snippet symmetrically (activationSnippet does still include the
  // path because it is pasted per-window and never committed).
  const projectLine = `for whichever project this window is currently
working in (\`gojaja\` discovers the project root from the shell's
cwd).`;
  return `You participate in a multi-agent coordination layer
${projectLine}
Shared state lives under \`.gojaja/\` at that project root, mediated
by the \`gojaja\` CLI. Treat the CLI — not chat — as the source of
truth.

## When this section applies

ONLY when this window is bound to a role: \`GOJAJA_SESSION\` is
exported in the shell (via \`gojaja claim\`), OR the user explicitly
told you in chat which role you are. Otherwise ignore the loop;
respond normally and do NOT speculatively run \`gojaja plan\` /
\`claim\` / any other gojaja command.

## Identity

One role per window. Bound by \`gojaja claim <role>\` + exporting the
printed \`GOJAJA_SESSION\`. Lose track? Run \`gojaja plan\` — the
manifest names your role and your unread work.

If your shell does NOT keep environment variables between commands
(each tool call starts a fresh shell, so the \`export\` from claim is
lost and every command errors with "GOJAJA_SESSION is required"), pass
the id explicitly instead: \`gojaja <cmd> --session <id>\` (the id is
printed by \`gojaja claim\`). Either run the loop in one persistent
shell, or carry \`--session <id>\` on every command.

## Every turn

1. \`gojaja plan\` → JSON Manifest (role, ackToken, events, tasks, rfcs).
2. Do the work (a conversational message from the user counts as work).
3. Emit through gojaja: \`report\` / \`worklog\` / \`task status\` /
   \`rfc comment\` / \`rfc decide\`.
4. \`gojaja ack --token <ackToken>\`.

**End-of-turn ritual: \`${waitCmd}\`.** wait is the ONLY way to end a
turn — without it your role goes deaf. ONE call BLOCKS (no token
cost) until an event wakes you, or TIMEOUT if you pass \`--in\`/\`--until\`.
Bare \`wait\` blocks indefinitely. Host killed it? Re-run \`gojaja wait\`
(no args) to resume; cap ~5 resumes. See \`gojaja handbook\`.
**\`wait\` is a parked state, not active work.** Once it starts:
no progress narration, no polling, no check-ins with the user. The
block IS the work — some hosts (e.g. Codex) prompt you to "update"
every 30 s while a tool is running; ignore that prompt for \`wait\`,
or you'll burn tokens narrating an idle block.

## Rules

- **NEVER end a turn without \`gojaja wait\` as the final tool call.**
  Even for a conversational message: answer the user, then \`wait\`.
  "I'm online, ready for instructions" is NOT a turn end.
- **Tasks pull.** If \`plan\` shows a task you own (Pending / InProgress
  / Blocked), start it — accepting the task in plan IS the start.
  Don't ask "shall I begin?" or "ready when you are". For a blocking
  ambiguity use \`gojaja report\` (\`reportsTo\` / reviewer / parent
  owner) or \`gojaja rfc\`. Never silent waiting.
- Never hand-edit files under \`.gojaja/\`. Use \`gojaja\`.
- Never claim to have done something without producing an event for it.
- Lost context or unsure of your identity? \`gojaja plan\` first.
- Blocked by a cross-role decision? Open an RFC; don't guess.
- Don't spoof another role (editing GOJAJA_SESSION, faking a report's
  \`from\`). Don't \`--force\` a claim — that is a human action.
${cheatsheet}
## Where to look things up

- **This turn's work**: \`gojaja plan\` output is authoritative (your
  role, unread events, active tasks, RFCs you owe a response on).
- **Judgement policy** (picking a tool, disagreement, escalation,
  multi-round RFCs, deliverables): \`gojaja handbook\`.
- **Command + flag reference**: \`gojaja -h\`.
`;
}

/**
 * Compact "which channel when" cheatsheet embedded in the injected card.
 * The full policy lives in \`gojaja handbook\`; this is just enough to
 * stop the most damaging mistakes even if the agent never fetches it.
 */
const WHEN_TO_USE_WHICH = `## When to use which (full policy: \`gojaja handbook\`)

- \`worklog\` (broadcast): team-visible progress that has no event of its
  own. Don't echo an event you already emitted.
- \`report --to <role>\` (directed): you need ONE named role to act next,
  or a question only one role can answer.
- \`rfc new\` (decision): a choice no single role owns — spans multiple
  \`owns\`, or changes architecture / API / data model / rollback. Not
  for single-owner questions.
- Stuck on a dependency? \`report\` up your \`reportsTo\` chain.
- Idle (no task AND no events)? \`gojaja wait --for task-assigned\`
  (broadcasts that you're free). Don't use \`--for task-assigned\` while
  you still hold an open task — finish or hand it off first.
- "Done" means every acceptance criterion is met; if the task has file
  deliverables they must exist on disk before \`task status ... Done\`.
`;

/**
 * The recommended `wait` invocation. Bare `gojaja wait` blocks
 * indefinitely, polling the event stream internally, until an event /
 * condition fires or the host kills the call — uniform across hosts (no
 * per-host `--poll-interval` chunking). The agent may add `--in` /
 * `--until` to bound it, or re-run after a host kill to resume.
 */
function waitRecommendation(_target: Target | undefined): string {
  return "gojaja wait";
}

/**
 * The short activation line the user pastes into the agent chat to
 * bind a specific role to the current window. Per-window and per-role —
 * never persisted to disk, so the role identifier does NOT leak into
 * any project-shared file.
 */
export function activationSnippet(role: string, projectRoot: string): string {
  // Compute the recommended worktree path at activation time. The
  // role agent cd's here so `git checkout` / branch switches in
  // this window don't fight any other agent windows that may be
  // sharing the same project root.
  const projectBasename = projectRoot.split("/").filter(Boolean).pop() ?? "";
  const worktreeDir = `${projectRoot}/../${projectBasename}-${role}`;
  return `You are the ${role} agent for the multi-agent project at ${projectRoot}.

## Step 0 — your own git worktree (recommended for multi-role)

v3 gojaja shares coordination state across worktrees (same
project.json → same central tree), so isolating this window's
git checkout costs nothing. Skip if user already gave you a
checkout, single-role project, or not a git repo.

  cd "${projectRoot}"
  WT="${worktreeDir}"
  git worktree add -b "${role}/work" "$WT" 2>/dev/null \\
    || git worktree add "$WT" 2>/dev/null || true
  cd "$WT" 2>/dev/null || cd "${projectRoot}"

## Step 1 — claim, learn, loop

Before doing anything else, run these commands in this same shell,
in order:

  1. eval "$(gojaja claim ${role} --eval)"
     # Claims the role and exports GOJAJA_SESSION in one step.
     # Subsequent gojaja commands in this shell authenticate as ${role}.
     # If your shell does NOT persist env vars between commands, run
     # \`gojaja claim ${role}\` (no --eval), note the printed session id,
     # and pass \`--session <id>\` on every later gojaja command.

  2. gojaja role show ${role}
     # Read your own role contract: title, owns, reportsTo,
     # mustNotEdit, description, responsibilities. This is your
     # self-introduction — every "who am I / what can I do" question
     # is answered here.

  3. gojaja -h
     # Skim what the gojaja CLI can do. You will come back to it
     # often (task, rfc, report, worklog, plan, ack, wait, ...).

Then start your first turn: run \`gojaja plan\` to pull your manifest
(unread events, plus tasks and RFCs that need you). Every turn follows
the same loop: plan → do the work → emit through gojaja (report /
worklog / task status / rfc) → ack → wait. The full protocol is
installed in this project's AGENTS.md and read (or imported) by your
host — re-read that block if you ever lose the thread.
`;
}

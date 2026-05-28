import { COLLABORATION_HANDBOOK } from "./handbook";
import type { Target } from "./types";

export interface RuntimeBodyOptions {
  /** Append the collaboration handbook (heuristics for "when to use what"). */
  withHandbook?: boolean;
  /**
   * Host target. The runtime body uses this only to tweak the
   * recommended `wait` invocation: Cursor's chat-mode shell kills any
   * shell command at its host-side timeout (seconds), so Cursor builds
   * pin a short `--poll-interval`. Codex / Claude / generic hosts can
   * comfortably sleep through the default poll interval, so we leave it
   * unset there.
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
  const handbook = opts.withHandbook === false ? "" : `\n\n${COLLABORATION_HANDBOOK}`;
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

## Every turn

1. \`gojaja plan\` → JSON Manifest (role, ackToken, events, tasks, rfcs).
2. Do the work in the project working tree.
3. Emit through gojaja, not chat: \`report\` / \`worklog\` /
   \`task status\` / \`rfc comment\` / \`rfc decide\`.
4. \`gojaja ack --token <ackToken>\`.
5. \`${waitCmd}\` — wait prints ATTENTION / CONDITION_MET / RESUME /
   TIMEOUT and the exact next command. RESUME means re-run the printed
   wait command (chunked polling lets long waits survive host shell
   timeouts); ATTENTION / CONDITION_MET → \`gojaja plan\`; TIMEOUT →
   end the turn or take initiative.

## Rules

- Never hand-edit files under \`.gojaja/\`. Use \`gojaja\`.
- Never claim to have done something without producing an event for it.
- Lost context or unsure of your identity? \`gojaja plan\` first.
- Blocked by a cross-role decision? Open an RFC; don't guess.
${handbook}`;
}

/**
 * Per-target recommendation for the `wait` invocation.
 *
 * Cursor's chat-mode shell wraps each tool call with a host-side
 * timeout in the seconds range. A single long sleep is killed by the
 * host and the agent sees a broken exit code. The `wait` design
 * answers this with chunked, resumable polling: Cursor pins a short
 * `--poll-interval` so each chunk fits inside the host budget; on
 * RESUME the agent re-invokes the same command. Codex / Claude /
 * generic shells can sleep through the default chunk, so we omit the
 * flag there.
 */
function waitRecommendation(target: Target | undefined): string {
  if (target === "cursor") {
    return "gojaja wait --in 10m --poll-interval 30s";
  }
  return "gojaja wait --in 10m";
}

/**
 * The short activation line the user pastes into the agent chat to
 * bind a specific role to the current window. Per-window and per-role —
 * never persisted to disk, so the role identifier does NOT leak into
 * any project-shared file.
 */
export function activationSnippet(role: string, projectRoot: string): string {
  return `You are the ${role} agent for the multi-agent project at ${projectRoot}.

Before doing anything else, run these commands in this same shell,
in order:

  1. eval "$(gojaja claim ${role} --eval)"
     # Claims the role and exports GOJAJA_SESSION in one step.
     # Subsequent gojaja commands in this shell will authenticate
     # as ${role}.

  2. gojaja role show ${role}
     # Read your own role contract: title, owns, reportsTo,
     # mustNotEdit, description, responsibilities. This is your
     # self-introduction — every "who am I / what can I do" question
     # is answered here.

  3. gojaja -h
     # Skim what the gojaja CLI can do. You will come back to it
     # often (task, rfc, report, worklog, plan, ack, wait, ...).

Then enter the runtime loop documented in the gojaja-runtime
instructions installed in this host (Cursor rule / CLAUDE.md / Codex
skill — whichever applies to you).
`;
}

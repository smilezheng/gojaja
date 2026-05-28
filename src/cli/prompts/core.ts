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
 *      (via MA_SESSION and `agentctl plan`), not what role it is. The
 *      role is bound at activation time, not when the prompt is written.
 *
 *   2. It restates the protocol on every turn implicitly: an agent that
 *      has been context-compressed only needs to read this block (which
 *      lives in the host's persistent area) and run `agentctl plan` to
 *      reconstitute its identity and unread work.
 */
export function runtimeLoopBody(
  projectRoot: string,
  opts: RuntimeBodyOptions = { withHandbook: true },
): string {
  const handbook = opts.withHandbook === false ? "" : `\n\n${COLLABORATION_HANDBOOK}`;
  const waitCmd = waitRecommendation(opts.target);
  // Empty projectRoot is intentional for user-level installs (Codex
  // skill at ~/.codex/skills/...) — that install services every project
  // the user works on, so it cannot bake any specific path. Agent
  // resolves the project from cwd when it runs `agentctl plan`.
  const projectLine = projectRoot
    ? `rooted at:\n\n  ${projectRoot}\n`
    : `for whichever project this window is currently working in
(\`agentctl\` discovers the project root from the shell's cwd).\n`;
  return `You are participating in a multi-agent coordination layer ${projectLine}
The shared coordination state lives in \`.multi-agent/\` under that path,
mediated by a CLI named \`agentctl\`. Treat the CLI — not chat — as the
source of truth for who you are and what you should do.

## When this section applies

The protocol in this section governs your behaviour **only when this
window has been bound to a role**, which is true if and only if at
least one of the following holds:

- The shell has \`MA_SESSION\` exported (you were claimed via
  \`agentctl claim\` or \`eval "$(agentctl claim <role> --eval)"\`).
- The user has explicitly told you in chat that you are playing the
  \`<role>\` for this project (e.g. via an activation snippet from
  \`agentctl activate\`).

If neither holds, ignore the rest of this section and respond to the
user normally. Do **not** speculatively run \`agentctl plan\`,
\`agentctl claim\`, or any other \`agentctl\` command — the user may
be using this window for unrelated work.

## Identity

You play one role per window. The role is bound by the user when they
run \`agentctl claim <role>\` in this shell and export the printed
session id:

  agentctl claim <role>
  export MA_SESSION=<the printed session id>

All subsequent \`agentctl\` invocations in this shell will authenticate
as that role automatically. You can recover your role at any time by
running \`agentctl plan\`; its JSON output names your role and your
unread work.

## Every turn

1. Run \`agentctl plan\`. It returns a JSON Manifest with:
     - role            (who you are)
     - ackToken        (use this in step 4)
     - events          (unread items you must process; oldest first)
2. Process every event. If an event implies code or document work, do it
   in the project working tree (committed by the user via git).
3. Emit your outputs through \`agentctl\`, not chat:
     agentctl report  --to <role> --message "<text>"
     agentctl worklog --message "<text>"
   These produce durable events other agents can see.
4. Confirm what you saw:
     agentctl ack --token <ackToken from step 1>
5. Stay alive without burning tokens:
     ${waitCmd}
   wait prints one of four verdicts and the exact next command to run:
     ATTENTION       new work arrived; the verdict line says
                     \`Next: agentctl plan\` — do that.
     CONDITION_MET   the specific thing you were waiting for
                     happened; same \`Next: agentctl plan\`.
     RESUME          chunk over but the deadline has not been
                     reached; the verdict echoes the exact
                     \`agentctl wait --until ... [--for ...]\`
                     command to re-run. Copy/paste that and loop.
     TIMEOUT         deadline reached without attention; end the
                     turn cleanly or take initiative.
   On long waits, RESUME may fire many times before any of the other
   three. That is the design — every chunk is one shell call, so the
   host can kill the shell at any point without losing the wait.

## Rules

- Never edit files under \`.multi-agent/\` by hand. Always go through
  \`agentctl\`.
- Never claim to have done something without producing an event for it.
- If you lose context or are unsure of your identity, run
  \`agentctl plan\` first. Its output re-anchors you.
- If you are blocked by a cross-role decision, do not guess. Open an
  RFC (\`agentctl rfc new\`) and let the designated decider close it.
${handbook}`;
}

/**
 * Per-target recommendation for the `wait` invocation.
 *
 * Cursor's chat-mode shell wraps each tool call with a host-side
 * timeout in the seconds range. A single long sleep is killed by the
 * host and the agent sees a broken exit code. The PR8i `wait` design
 * answers this with chunked, resumable polling: Cursor pins a short
 * `--poll-interval` so each chunk fits inside the host budget; on
 * RESUME the agent re-invokes the same command. Codex / Claude /
 * generic shells can sleep through the default chunk, so we omit the
 * flag there.
 */
function waitRecommendation(target: Target | undefined): string {
  if (target === "cursor") {
    return "agentctl wait --in 10m --poll-interval 30s";
  }
  return "agentctl wait --in 10m";
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

  1. eval "$(agentctl claim ${role} --eval)"
     # Claims the role and exports MA_SESSION in one step.
     # Subsequent agentctl commands in this shell will authenticate
     # as ${role}.

  2. agentctl role show ${role}
     # Read your own role contract: title, owns, reportsTo,
     # mustNotEdit, description, responsibilities. This is your
     # self-introduction — every "who am I / what can I do" question
     # is answered here.

  3. agentctl -h
     # Skim what the agentctl CLI can do. You will come back to it
     # often (task, rfc, report, worklog, plan, ack, wait, ...).

Then enter the runtime loop documented in the multi-agent-runtime
instructions installed in this host (Cursor rule / CLAUDE.md / Codex
skill — whichever applies to you).
`;
}

import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { RuntimeArtifact } from "./types";

/**
 * The "generic" target has no persistent location (no skill/rule/CLAUDE.md
 * to install). The runtime body is just printed for inspection; nothing is
 * written. The activation snippet for generic therefore has to bundle the
 * runtime body with the per-role chat line, because the agent has nowhere
 * else to read the protocol from.
 */
export function buildGenericRuntime(
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const body = [
    "# Generic agent prompt body",
    "",
    "There is no persistent install location for a generic agent; the",
    "runtime body and per-role activation are bundled at activate time.",
    "Use `agentctl activate <role> --target generic` to get the full",
    "paste-ready prompt for each agent window.",
    "",
    "----- BEGIN runtime body (for inspection only) -----",
    "",
    runtimeLoopBody(projectRoot, opts),
    "----- END -----",
    "",
  ].join("\n");
  return { body, files: [] };
}

export function buildGenericActivation(
  role: string,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): string {
  return [
    "Paste the BEGIN..END block below into the agent window assigned to",
    `role '${role}'. The agent will follow the runtime loop on every turn.`,
    "",
    "----- BEGIN -----",
    "",
    runtimeLoopBody(projectRoot, opts),
    "",
    activationSnippet(role, projectRoot),
    "----- END -----",
    "",
  ].join("\n");
}

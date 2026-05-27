import { activationSnippet, runtimeLoopBody } from "./core";
import type { PromptArtifact } from "./types";

export function buildGenericArtifact(role: string, projectRoot: string): PromptArtifact {
  const body = [
    "# Generic agent prompt",
    "",
    "Paste the BEGIN..END block below into the agent window assigned to",
    `role '${role}'. The agent will follow the runtime loop on every turn.`,
    "",
    "----- BEGIN -----",
    "",
    runtimeLoopBody(projectRoot),
    "",
    activationSnippet(role, projectRoot),
    "----- END -----",
    "",
  ].join("\n");
  return { body, files: [], activation: activationSnippet(role, projectRoot) };
}

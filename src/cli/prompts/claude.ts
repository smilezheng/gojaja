import * as path from "node:path";
import { activationSnippet, runtimeLoopBody } from "./core";
import type { PromptArtifact } from "./types";

export const CLAUDE_MARKER_BEGIN = "<!-- multi-agent-runtime:BEGIN -->";
export const CLAUDE_MARKER_END = "<!-- multi-agent-runtime:END -->";

function blockBody(projectRoot: string): string {
  return [
    CLAUDE_MARKER_BEGIN,
    "<!-- managed by multi-agent-coordination; edit the surrounding file freely, but do not edit the contents of this block -->",
    "",
    "## Multi-Agent Coordination",
    "",
    runtimeLoopBody(projectRoot),
    CLAUDE_MARKER_END,
  ].join("\n");
}

export function buildClaudeArtifact(role: string, projectRoot: string): PromptArtifact {
  const target = path.join(projectRoot, "CLAUDE.md");
  const body = [
    `# Claude project instructions: ${target}`,
    "",
    "Run with `--write` to insert (or refresh) a managed block in",
    "`CLAUDE.md`. Existing content outside the block is preserved.",
    "",
    "---",
    "",
    blockBody(projectRoot),
  ].join("\n");
  return {
    body,
    files: [
      {
        path: target,
        content: blockBody(projectRoot),
        mode: "marker-block",
        markerBegin: CLAUDE_MARKER_BEGIN,
        markerEnd: CLAUDE_MARKER_END,
      },
    ],
    activation: activationSnippet(role, projectRoot),
  };
}

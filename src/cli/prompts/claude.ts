import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { PromptArtifact } from "./types";

export const CLAUDE_MARKER_BEGIN = "<!-- multi-agent-runtime:BEGIN -->";
export const CLAUDE_MARKER_END = "<!-- multi-agent-runtime:END -->";

function blockBody(projectRoot: string, opts: RuntimeBodyOptions): string {
  return [
    CLAUDE_MARKER_BEGIN,
    "<!-- managed by multi-agent-coordination; edit the surrounding file freely, but do not edit the contents of this block -->",
    "",
    "## Multi-Agent Coordination",
    "",
    runtimeLoopBody(projectRoot, opts),
    CLAUDE_MARKER_END,
  ].join("\n");
}

export function buildClaudeArtifact(
  role: string,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): PromptArtifact {
  const target = path.join(projectRoot, "CLAUDE.md");
  const block = blockBody(projectRoot, opts);
  const body = [
    `# Claude project instructions: ${target}`,
    "",
    "Run with `--write` to insert (or refresh) a managed block in",
    "`CLAUDE.md`. Existing content outside the block is preserved.",
    "",
    "---",
    "",
    block,
  ].join("\n");
  return {
    body,
    files: [
      {
        path: target,
        content: block,
        mode: "marker-block",
        markerBegin: CLAUDE_MARKER_BEGIN,
        markerEnd: CLAUDE_MARKER_END,
      },
    ],
    activation: activationSnippet(role, projectRoot),
  };
}

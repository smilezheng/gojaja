import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import { CLAUDE_MARKER_BEGIN, CLAUDE_MARKER_END } from "./claude";
import type { RuntimeArtifact } from "./types";

// Codex injects each project's AGENTS.md into the model instructions at
// session start (walking from the git root to the cwd). That is exactly
// the "always-on, survives compaction" channel we need — and unlike the
// old user-level skill it is PROJECT-LOCAL, so there is no cross-project
// sharing to reference-count and no user-level footprint. We upsert a
// managed marker block, identical in spirit to the CLAUDE.md handling,
// preserving any content the user already has in AGENTS.md.

function blockBody(projectRoot: string, opts: RuntimeBodyOptions): string {
  const effectiveOpts: RuntimeBodyOptions = { ...opts, target: "codex" };
  return [
    CLAUDE_MARKER_BEGIN,
    "<!-- managed by gojaja; edit the surrounding file freely, but do not edit the contents of this block -->",
    "",
    "## Multi-Agent Coordination",
    "",
    runtimeLoopBody(projectRoot, effectiveOpts),
    CLAUDE_MARKER_END,
  ].join("\n");
}

export function buildCodexRuntime(
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const target = path.join(projectRoot, "AGENTS.md");
  const block = blockBody(projectRoot, opts);
  const body = [
    `# Codex project instructions: ${target}`,
    "",
    "Run with `--write` to insert (or refresh) a managed block in this",
    "project's `AGENTS.md`. Codex reads AGENTS.md into its model",
    "instructions at session start, so the runtime loop is always in",
    "context. Existing content outside the block is preserved.",
    "",
    "After install, use `gojaja activate <role> --target codex` to get",
    "the chat-paste line for each role.",
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
  };
}

export function buildCodexActivation(role: string, projectRoot: string): string {
  return activationSnippet(role, projectRoot);
}

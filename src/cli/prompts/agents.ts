import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import { RUNTIME_MARKER_BEGIN, RUNTIME_MARKER_END } from "./markers";
import type { RuntimeArtifact } from "./types";

// AGENTS.md is the canonical runtime file: the cross-tool project
// system-prompt standard, injected at session start and surviving
// compaction. It is PROJECT-LOCAL (no user-level footprint). We upsert a
// managed marker block, preserving any content the user already has in
// AGENTS.md. The `claude` target reuses `agentsFile()` so AGENTS.md
// stays the single source of truth.

/** The managed marker-block content for AGENTS.md. */
export function agentsBlock(projectRoot: string, opts: RuntimeBodyOptions): string {
  const effectiveOpts: RuntimeBodyOptions = { ...opts, target: "agents" };
  return [
    RUNTIME_MARKER_BEGIN,
    "<!-- managed by gojaja; edit the surrounding file freely, but do not edit the contents of this block -->",
    "",
    "## Multi-Agent Coordination",
    "",
    runtimeLoopBody(projectRoot, effectiveOpts),
    RUNTIME_MARKER_END,
  ].join("\n");
}

/** The AGENTS.md file descriptor (marker-block upsert at <root>/AGENTS.md). */
export function agentsFile(
  projectRoot: string,
  opts: RuntimeBodyOptions,
): RuntimeArtifact["files"][number] {
  return {
    path: path.join(projectRoot, "AGENTS.md"),
    content: agentsBlock(projectRoot, opts),
    mode: "marker-block",
    markerBegin: RUNTIME_MARKER_BEGIN,
    markerEnd: RUNTIME_MARKER_END,
  };
}

export function buildAgentsRuntime(
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const file = agentsFile(projectRoot, opts);
  const body = [
    `# Project runtime: ${file.path}`,
    "",
    "Run with `--write` to insert (or refresh) a managed block in this",
    "project's `AGENTS.md` — the cross-tool standard read by Codex,",
    "Cursor, Copilot, Windsurf, Zed and more, injected into the model",
    "instructions at session start. Existing content outside the block",
    "is preserved.",
    "",
    "After install, use `gojaja activate <role> --target agents` to get",
    "the chat-paste line for each role.",
    "",
    "---",
    "",
    file.content,
  ].join("\n");
  return { body, files: [file] };
}

export function buildAgentsActivation(role: string, projectRoot: string): string {
  return activationSnippet(role, projectRoot);
}

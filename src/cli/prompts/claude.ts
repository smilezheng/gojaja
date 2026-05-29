import * as path from "node:path";
import { activationSnippet, type RuntimeBodyOptions } from "./core";
import { agentsFile } from "./agents";
import { RUNTIME_MARKER_BEGIN, RUNTIME_MARKER_END } from "./markers";
import type { RuntimeArtifact } from "./types";

// Claude Code does not read AGENTS.md natively yet (it reads CLAUDE.md
// + nested imports). To keep AGENTS.md the single source of truth, the
// `claude` target writes the canonical AGENTS.md block AND a thin
// CLAUDE.md whose managed block just imports it via Claude's `@path`
// syntax. So there is no duplicated runtime content: CLAUDE.md is a
// one-line pointer, AGENTS.md holds the real instructions.
function claudeImporterBlock(): string {
  return [
    RUNTIME_MARKER_BEGIN,
    "<!-- managed by gojaja; do not edit the contents of this block -->",
    "",
    "The gojaja multi-agent runtime instructions live in AGENTS.md.",
    "Claude Code does not read AGENTS.md natively yet, so import it here:",
    "",
    "@AGENTS.md",
    RUNTIME_MARKER_END,
  ].join("\n");
}

export function buildClaudeRuntime(
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const agents = agentsFile(projectRoot, opts);
  const claudePath = path.join(projectRoot, "CLAUDE.md");
  const importer = claudeImporterBlock();
  const body = [
    `# Claude Code runtime: ${agents.path} + ${claudePath}`,
    "",
    "Run with `--write` to install the runtime for Claude Code. Because",
    "Claude Code does not read AGENTS.md natively yet, this writes TWO",
    "files, keeping AGENTS.md as the single source of truth:",
    `  - ${agents.path} — the canonical runtime block (shared with every`,
    "    AGENTS.md-reading tool); its content is shown below.",
    `  - ${claudePath} — a managed block that just imports it:`,
    "",
    importer,
    "",
    "Existing content outside each managed block is preserved.",
    "",
    "After install, use `gojaja activate <role> --target claude` to get",
    "the chat-paste line for each role.",
    "",
    "--- AGENTS.md block ---",
    "",
    agents.content,
  ].join("\n");
  return {
    body,
    files: [
      agents,
      {
        path: claudePath,
        content: importer,
        mode: "marker-block",
        markerBegin: RUNTIME_MARKER_BEGIN,
        markerEnd: RUNTIME_MARKER_END,
      },
    ],
  };
}

export function buildClaudeActivation(role: string, projectRoot: string): string {
  return activationSnippet(role, projectRoot);
}

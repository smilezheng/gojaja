import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { PromptArtifact } from "./types";

function ruleFile(projectRoot: string): string {
  return path.join(projectRoot, ".cursor", "rules", "multi-agent-runtime.mdc");
}

function ruleContent(projectRoot: string, opts: RuntimeBodyOptions): string {
  return [
    "---",
    'description: "Runtime loop for an agent window assigned to a role in this project\'s .multi-agent layer."',
    "alwaysApply: true",
    "---",
    "",
    "# Multi-Agent Runtime",
    "",
    "This rule is active whenever you work in this project. If the shell",
    "has `MA_SESSION` exported, you are the agent for the role bound to",
    "that session; follow the runtime loop below for every turn.",
    "",
    runtimeLoopBody(projectRoot, opts),
  ].join("\n");
}

export function buildCursorArtifact(
  role: string,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): PromptArtifact {
  const target = ruleFile(projectRoot);
  const content = ruleContent(projectRoot, opts);
  const body = [
    `# Cursor project rule: ${target}`,
    "",
    "Run with `--write` to create (or refresh) the rule. The rule is",
    "project-scoped, role-agnostic, and applies to every Cursor session",
    "opened in this project. Each window picks its role at activation",
    "time via the chat snippet below.",
    "",
    "---",
    "",
    content,
  ].join("\n");
  return {
    body,
    files: [{ path: target, content, mode: "replace" }],
    activation: activationSnippet(role, projectRoot),
  };
}

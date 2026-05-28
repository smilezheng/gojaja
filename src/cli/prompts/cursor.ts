import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { RuntimeArtifact } from "./types";

function ruleFile(projectRoot: string): string {
  return path.join(projectRoot, ".cursor", "rules", "gojaja-runtime.mdc");
}

function ruleContent(projectRoot: string, opts: RuntimeBodyOptions): string {
  const effectiveOpts: RuntimeBodyOptions = { ...opts, target: "cursor" };
  return [
    "---",
    'description: "Runtime loop for an agent window assigned to a role in this project\'s .gojaja layer."',
    "alwaysApply: true",
    "---",
    "",
    "# Multi-Agent Runtime",
    "",
    "This rule is active whenever you work in this project. If the shell",
    "has `GOJAJA_SESSION` exported, you are the agent for the role bound to",
    "that session; follow the runtime loop below for every turn.",
    "",
    runtimeLoopBody(projectRoot, effectiveOpts),
  ].join("\n");
}

export function buildCursorRuntime(
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const target = ruleFile(projectRoot);
  const content = ruleContent(projectRoot, opts);
  const body = [
    `# Cursor project rule: ${target}`,
    "",
    "Run with `--write` to create (or refresh) the rule. The rule is",
    "project-scoped, role-agnostic, and applies to every Cursor session",
    "opened in this project.",
    "",
    "After install, use `gojaja activate <role> --target cursor` to get",
    "the chat-paste line for each window.",
    "",
    "---",
    "",
    content,
  ].join("\n");
  return {
    body,
    files: [{ path: target, content, mode: "replace" }],
  };
}

export function buildCursorActivation(role: string, projectRoot: string): string {
  return activationSnippet(role, projectRoot);
}

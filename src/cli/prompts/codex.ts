import * as os from "node:os";
import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { RuntimeArtifact } from "./types";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function skillDir(): string {
  return path.join(codexHome(), "skills", "multi-agent-runtime");
}

function skillMarkdown(opts: RuntimeBodyOptions): string {
  // M1: This skill ships to a USER-LEVEL location
  // (~/.codex/skills/multi-agent-runtime/), so it MUST be reusable
  // across every project the user works on. Hard-coding any specific
  // project root would mean each `prompt --write` from a different
  // project silently overwrites the previous install's projectRoot.
  // Pass empty string; runtimeLoopBody will say "discover via cwd".
  const effectiveOpts: RuntimeBodyOptions = { ...opts, target: "codex" };
  return [
    "---",
    "name: multi-agent-runtime",
    'description: Runtime loop for a Codex window assigned to a role in a project-local .multi-agent coordination layer. Activate when the user says they are playing a role in the multi-agent project.',
    "---",
    "",
    "# Multi-Agent Runtime",
    "",
    "Activate this skill when the user says they are playing a role in a",
    "project-local `.multi-agent` coordination layer. Use it for the full",
    "runtime loop until the user ends the conversation.",
    "",
    runtimeLoopBody("", effectiveOpts),
  ].join("\n");
}

function openaiYaml(): string {
  return [
    "interface:",
    '  display_name: "Multi-Agent Runtime"',
    '  short_description: "Runtime loop for an assigned multi-agent role"',
    '  default_prompt: "Use $multi-agent-runtime. Tell me which role I am playing and the project root, then enter the runtime loop."',
    "",
    "policy:",
    "  allow_implicit_invocation: true",
    "",
  ].join("\n");
}

export function buildCodexRuntime(
  _projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  const dir = skillDir();
  // Note: projectRoot is intentionally ignored. The Codex skill ships
  // to ~/.codex/skills/multi-agent-runtime/ which is user-level — one
  // install must service every project the user works on. The skill
  // body discovers the active project at runtime via cwd.
  const skill = skillMarkdown(opts);
  const body = [
    "# Codex skill: multi-agent-runtime",
    "",
    "Run with `--write` to install (or refresh) the skill at:",
    "",
    `  ${dir}`,
    "",
    "After install, use `agentctl activate <role> --target codex` to get",
    "the chat-paste line for each role. The skill is project-agnostic —",
    "the activation snippet carries the project context per window.",
    "",
    "---",
    "",
    skill,
  ].join("\n");
  return {
    body,
    files: [
      { path: path.join(dir, "SKILL.md"),              content: skill,       mode: "replace" },
      { path: path.join(dir, "agents", "openai.yaml"), content: openaiYaml(), mode: "replace" },
    ],
  };
}

export function buildCodexActivation(role: string, projectRoot: string): string {
  return `Use $multi-agent-runtime.\n${activationSnippet(role, projectRoot)}`;
}

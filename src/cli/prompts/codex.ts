import * as os from "node:os";
import * as path from "node:path";
import { activationSnippet, runtimeLoopBody, type RuntimeBodyOptions } from "./core";
import type { PromptArtifact } from "./types";

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function skillDir(): string {
  return path.join(codexHome(), "skills", "multi-agent-runtime");
}

function skillMarkdown(projectRoot: string, opts: RuntimeBodyOptions): string {
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
    runtimeLoopBody(projectRoot, opts),
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

export function buildCodexArtifact(
  role: string,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): PromptArtifact {
  const dir = skillDir();
  const skill = skillMarkdown(projectRoot, opts);
  const body = [
    "# Codex skill: multi-agent-runtime",
    "",
    "Run with `--write` to install (or refresh) the skill at:",
    "",
    `  ${dir}`,
    "",
    "After install, paste the activation line below into your Codex chat",
    "for this window. Codex will look up the skill and follow its runtime",
    "loop until the conversation ends.",
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
    activation:
      `Use $multi-agent-runtime.\n` +
      activationSnippet(role, projectRoot),
  };
}

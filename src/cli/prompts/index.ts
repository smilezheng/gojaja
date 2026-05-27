import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, exists } from "../../core/atomic";
import { UsageError } from "../../core/errors";
import { buildClaudeActivation, buildClaudeRuntime } from "./claude";
import { buildCodexActivation, buildCodexRuntime } from "./codex";
import type { RuntimeBodyOptions } from "./core";
import { buildCursorActivation, buildCursorRuntime } from "./cursor";
import { buildGenericActivation, buildGenericRuntime } from "./generic";
import type { RuntimeArtifact, Target } from "./types";

export type { RuntimeArtifact, Target };
export type { RuntimeBodyOptions } from "./core";

/**
 * Build the role-free runtime artifact for a host.
 *
 * Critical invariant: the returned `body` and any `files[].content` MUST
 * NOT contain any role identifier. Two agent windows playing different
 * roles in the same project read the same artifact; baking a role into
 * it would lock the project to a single role per host. Enforced by
 * `tests/prompt.test.ts`'s "no role intrusion" regression scan.
 */
export function buildRuntime(
  target: Target,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): RuntimeArtifact {
  switch (target) {
    case "codex":   return buildCodexRuntime(projectRoot, opts);
    case "claude":  return buildClaudeRuntime(projectRoot, opts);
    case "cursor":  return buildCursorRuntime(projectRoot, opts);
    case "generic": return buildGenericRuntime(projectRoot, opts);
  }
}

/**
 * Build the per-window activation snippet for a role. The snippet is
 * never persisted to disk; it lives entirely in the chat history of the
 * specific agent window that pastes it. This keeps role binding strictly
 * at the window layer (and `MA_SESSION` in the window's shell), never
 * at the project layer.
 *
 * For the generic target, the snippet has to bundle the runtime body
 * because there is no persistent install location.
 */
export function buildActivation(
  target: Target,
  role: string,
  projectRoot: string,
  opts: RuntimeBodyOptions = {},
): string {
  switch (target) {
    case "codex":   return buildCodexActivation(role, projectRoot);
    case "claude":  return buildClaudeActivation(role, projectRoot);
    case "cursor":  return buildCursorActivation(role, projectRoot);
    case "generic": return buildGenericActivation(role, projectRoot, opts);
  }
}

/** Expand a leading `~/` in a path. */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const RUNTIME_MARKER = "agentctl plan";

export async function writeArtifactFile(
  file: RuntimeArtifact["files"][number],
  opts: { force?: boolean } = {},
): Promise<"wrote" | "unchanged"> {
  const target = expandHome(file.path);
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (file.mode === "marker-block") {
    if (!file.markerBegin || !file.markerEnd) {
      throw new UsageError("marker-block artifact missing markers");
    }
    let existing = "";
    if (await exists(target)) {
      existing = await fsp.readFile(target, "utf8");
    }
    const replaced = upsertMarkerBlock(
      existing,
      file.content,
      file.markerBegin,
      file.markerEnd,
    );
    if (!opts.force && replaced === existing) return "unchanged";
    await atomicWriteFile(target, replaced);
    return "wrote";
  }

  if (await exists(target)) {
    const prior = await fsp.readFile(target, "utf8");
    if (!prior.includes(RUNTIME_MARKER)) {
      throw new UsageError(
        `Refusing to overwrite ${target}: file exists and does not look like a multi-agent-coordination artifact. ` +
          `Move or rename it, then re-run.`,
      );
    }
    // Byte-equality short-circuit. `opts.force` bypasses it for the
    // operator who wants to confirm the file is freshly written from
    // the current template (e.g. while debugging drift).
    if (!opts.force && prior === file.content) return "unchanged";
  }
  await atomicWriteFile(target, file.content);
  return "wrote";
}

function upsertMarkerBlock(
  existing: string,
  block: string,
  begin: string,
  end: string,
): string {
  const startIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + end.length);
    return `${before}${block}${after}`;
  }
  if (existing.length === 0) return `${block}\n`;
  const sep = existing.endsWith("\n") ? "" : "\n";
  return `${existing}${sep}\n${block}\n`;
}

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile, exists } from "../../core/atomic";
import { UsageError } from "../../core/errors";
import { buildClaudeArtifact } from "./claude";
import { buildCodexArtifact } from "./codex";
import { buildCursorArtifact } from "./cursor";
import { buildGenericArtifact } from "./generic";
import type { PromptArtifact, Target } from "./types";

export type { PromptArtifact, Target };

export function buildArtifact(
  target: Target,
  role: string,
  projectRoot: string,
): PromptArtifact {
  switch (target) {
    case "codex":   return buildCodexArtifact(role, projectRoot);
    case "claude":  return buildClaudeArtifact(role, projectRoot);
    case "cursor":  return buildCursorArtifact(role, projectRoot);
    case "generic": return buildGenericArtifact(role, projectRoot);
  }
}

/** Expand a leading `~/` in a path. */
function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Write one artifact file to disk.
 *
 * - `replace` mode: atomic write. Refuses to overwrite an existing file
 *   UNLESS we recognise the file's prior content as one of our own
 *   `buildArtifact` outputs (heuristic: starts with a frontmatter line or
 *   contains the runtime-loop marker phrase). This is intentionally
 *   conservative — users with hand-edited rules / skills are protected.
 *
 * - `marker-block` mode: read the file, replace the content between
 *   `markerBegin` and `markerEnd` (or append the block if absent),
 *   atomic-write back. Idempotent across re-runs.
 *
 * Returns "wrote" if the file was changed, "skipped" if nothing changed,
 * or throws UsageError on a refused clobber.
 */
const RUNTIME_MARKER = "agentctl plan";

export async function writeArtifactFile(file: PromptArtifact["files"][number]): Promise<
  "wrote" | "skipped"
> {
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
    if (replaced === existing) return "skipped";
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
    if (prior === file.content) return "skipped";
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

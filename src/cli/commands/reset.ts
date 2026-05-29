import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, LAYER_DIRNAME } from "../runtime";
import {
  RUNTIME_MARKER_BEGIN as CLAUDE_MARKER_BEGIN,
  RUNTIME_MARKER_END as CLAUDE_MARKER_END,
} from "../prompts/markers";

const CURSOR_RULE_REL = path.join(".cursor", "rules", "gojaja-runtime.mdc");
// Files that may carry a managed `gojaja-runtime` marker block. CLAUDE.md
// is Claude Code's project memory; AGENTS.md is Codex's project system
// prompt. Both are the user's own files — we only strip our block and
// preserve the rest (deleting the file only if our block was all it held).
const MARKER_BLOCK_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

interface MarkerFilePlan {
  path: string;
  /** True iff stripping our block leaves the file empty (we delete it). */
  willDelete: boolean;
}

interface ResetPlan {
  layerDir: string | null;
  cursorRule: string | null;
  markerFiles: MarkerFilePlan[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip the `gojaja-runtime` marker block from a host file (CLAUDE.md /
 * AGENTS.md), preserving everything outside. Forgiving:
 *   - removes the block from its BEGIN marker through its END marker
 *   - eats trailing whitespace immediately after the END marker
 *   - collapses runs of 3+ blank lines to a single blank line so the
 *     stripped file does not gain artificial empty regions
 *
 * Returns the input unchanged if either marker is missing (defensive).
 */
function stripRuntimeBlock(text: string): string {
  const beginIdx = text.indexOf(CLAUDE_MARKER_BEGIN);
  const endIdx = text.indexOf(CLAUDE_MARKER_END, beginIdx + 1);
  if (beginIdx < 0 || endIdx < 0) return text;
  let endStop = endIdx + CLAUDE_MARKER_END.length;
  while (endStop < text.length && (text[endStop] === "\n" || text[endStop] === "\r")) {
    endStop++;
  }
  let beginStart = beginIdx;
  while (beginStart > 0 && (text[beginStart - 1] === "\n" || text[beginStart - 1] === "\r")) {
    beginStart--;
  }
  const before = text.slice(0, beginStart);
  const after = text.slice(endStop);
  const joined = before + (before && after ? "\n\n" : "") + after;
  return joined.replace(/\n{3,}/g, "\n\n");
}

async function buildPlan(projectRoot: string): Promise<ResetPlan> {
  const layer = path.join(projectRoot, LAYER_DIRNAME);
  const cursor = path.join(projectRoot, CURSOR_RULE_REL);

  const markerFiles: MarkerFilePlan[] = [];
  for (const name of MARKER_BLOCK_FILES) {
    const file = path.join(projectRoot, name);
    if (!(await pathExists(file))) continue;
    const text = await fsp.readFile(file, "utf8");
    if (text.includes(CLAUDE_MARKER_BEGIN) && text.includes(CLAUDE_MARKER_END)) {
      markerFiles.push({
        path: file,
        willDelete: stripRuntimeBlock(text).trim().length === 0,
      });
    }
  }

  return {
    layerDir: (await pathExists(layer)) ? layer : null,
    cursorRule: (await pathExists(cursor)) ? cursor : null,
    markerFiles,
  };
}

async function rmDirIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir);
    if (entries.length === 0) await fsp.rmdir(dir);
  } catch {
    // ignore — not our problem if it's gone or non-empty
  }
}

interface RemovedItem {
  path: string;
  kind: "layer-dir" | "cursor-rule" | "marker-block" | "marker-file-delete";
}

function planToRemovedList(plan: ResetPlan): RemovedItem[] {
  const out: RemovedItem[] = [];
  if (plan.layerDir) out.push({ path: plan.layerDir, kind: "layer-dir" });
  if (plan.cursorRule) out.push({ path: plan.cursorRule, kind: "cursor-rule" });
  for (const mf of plan.markerFiles) {
    out.push({
      path: mf.path,
      kind: mf.willDelete ? "marker-file-delete" : "marker-block",
    });
  }
  return out;
}

export async function runReset(args: ParsedArgs): Promise<number> {
  // Destructive op: refuse when an agent session is exported. The
  // user must be in their own shell, not impersonating a role. Same
  // rationale as `role delete`.
  if (typeof process.env.GOJAJA_SESSION === "string" && process.env.GOJAJA_SESSION.length > 0) {
    throw new UsageError(
      "`reset` must be run from a shell with no GOJAJA_SESSION exported. " +
        "Run `unset GOJAJA_SESSION` (or open a fresh shell) and try again.",
    );
  }

  const projectRoot = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const expectedToken = path.basename(projectRoot);
  const confirm = optionalString(args.flags, "confirm");
  const dryRun = boolFlag(args.flags, "dry-run");
  const json = boolFlag(args.flags, "json");

  const plan = await buildPlan(projectRoot);
  const items = planToRemovedList(plan);

  if (items.length === 0) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "nothing-to-remove", projectRoot }) + "\n",
      );
    } else {
      process.stdout.write(
        `Nothing to remove at ${projectRoot}.\n` +
          `  - No .gojaja/ layer\n` +
          `  - No .cursor/rules/gojaja-runtime.mdc\n` +
          `  - No managed block in CLAUDE.md / AGENTS.md\n`,
      );
    }
    return 0;
  }

  // Preview when no --confirm OR when --dry-run.
  if (!confirm || dryRun) {
    if (json) {
      process.stdout.write(
        JSON.stringify({
          status: dryRun ? "dry-run" : "preview",
          projectRoot,
          confirmToken: expectedToken,
          willRemove: items,
        }) + "\n",
      );
      return 0;
    }
    process.stdout.write(`Reset preview for ${projectRoot}\n\n`);
    process.stdout.write(`Will remove:\n`);
    for (const it of items) {
      process.stdout.write(`  - ${it.path}  [${it.kind}]\n`);
    }
    process.stdout.write("\n");
    if (dryRun) {
      process.stdout.write(`Dry-run: nothing was removed.\n`);
      return 0;
    }
    process.stdout.write(
      `To confirm, run:\n  gojaja reset --confirm ${expectedToken}\n`,
    );
    return 0;
  }

  if (confirm !== expectedToken) {
    throw new UsageError(
      `--confirm token mismatch. Expected '${expectedToken}' ` +
        `(the basename of the project root). Got '${confirm}'.`,
    );
  }

  // Execute the plan.
  const removed: RemovedItem[] = [];
  if (plan.layerDir) {
    await fsp.rm(plan.layerDir, { recursive: true, force: true });
    removed.push({ path: plan.layerDir, kind: "layer-dir" });
  }
  if (plan.cursorRule) {
    await fsp.unlink(plan.cursorRule);
    removed.push({ path: plan.cursorRule, kind: "cursor-rule" });
    // Clean up the parent directories if they now hold only our footprint.
    await rmDirIfEmpty(path.dirname(plan.cursorRule));               // .cursor/rules/
    await rmDirIfEmpty(path.dirname(path.dirname(plan.cursorRule))); // .cursor/
  }
  for (const mf of plan.markerFiles) {
    const text = await fsp.readFile(mf.path, "utf8");
    const stripped = stripRuntimeBlock(text);
    if (stripped.trim().length === 0) {
      await fsp.unlink(mf.path);
      removed.push({ path: mf.path, kind: "marker-file-delete" });
    } else {
      const out = stripped.endsWith("\n") ? stripped : stripped + "\n";
      await fsp.writeFile(mf.path, out);
      removed.push({ path: mf.path, kind: "marker-block" });
    }
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({ status: "reset", projectRoot, removed }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`Reset complete at ${projectRoot}.\n\n`);
  process.stdout.write(`Removed:\n`);
  for (const it of removed) {
    process.stdout.write(`  - ${it.path}  [${it.kind}]\n`);
  }
  return 0;
}

// Exported for tests. (Kept the historical name so existing tests that
// destructure `stripClaudeMarkerBlock` keep working; the function now
// strips the block from any host file, not just CLAUDE.md.)
export const __test__ = { stripClaudeMarkerBlock: stripRuntimeBlock };

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, LAYER_DIRNAME } from "../runtime";
import { CLAUDE_MARKER_BEGIN, CLAUDE_MARKER_END } from "../prompts/claude";
import {
  codexSkillDir,
  otherCodexProjects,
  unregisterCodexProject,
} from "../prompts/codex-registry";

const CURSOR_RULE_REL = path.join(".cursor", "rules", "gojaja-runtime.mdc");
const CLAUDE_FILE = "CLAUDE.md";

interface ResetPlan {
  layerDir: string | null;
  cursorRule: string | null;
  /** CLAUDE.md path when a managed marker block is present. */
  claudeFile: string | null;
  /** True iff stripping the marker block leaves CLAUDE.md empty (we delete it). */
  claudeFileWillDelete: boolean;
  /**
   * Set only when --purge-codex-skill was passed, the dir exists, AND
   * removing this project leaves no other project using the skill (or
   * --force was passed). Null means "not deleting the skill".
   */
  codexSkillDir: string | null;
  /**
   * When --purge-codex-skill was passed but the skill is still used by
   * other projects (and --force was NOT passed), the roots that keep it
   * alive. Null otherwise. Drives the "kept, still used by N" message.
   */
  codexSkillKeptFor: string[] | null;
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
 * Strip the `gojaja-runtime` marker block from a CLAUDE.md
 * payload, preserving everything outside. The strip is forgiving:
 *   - removes the block from its BEGIN marker through its END marker
 *   - eats trailing whitespace immediately after the END marker
 *   - collapses runs of 3+ blank lines to a single blank line so the
 *     stripped file does not gain artificial empty regions
 *
 * Returns the input unchanged if either marker is missing (defensive).
 */
function stripClaudeMarkerBlock(text: string): string {
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

async function buildPlan(
  projectRoot: string,
  purgeCodexSkill: boolean,
  force: boolean,
): Promise<ResetPlan> {
  const layer = path.join(projectRoot, LAYER_DIRNAME);
  const cursor = path.join(projectRoot, CURSOR_RULE_REL);
  const claude = path.join(projectRoot, CLAUDE_FILE);

  let claudeFile: string | null = null;
  let claudeFileWillDelete = false;
  if (await pathExists(claude)) {
    const text = await fsp.readFile(claude, "utf8");
    if (text.includes(CLAUDE_MARKER_BEGIN) && text.includes(CLAUDE_MARKER_END)) {
      claudeFile = claude;
      claudeFileWillDelete = stripClaudeMarkerBlock(text).trim().length === 0;
    }
  }

  // Codex skill is ref-counted. Deleting it is safe only when no OTHER
  // project still has it registered (or the user passed --force). This
  // read does NOT mutate the registry; the execute path unregisters.
  let codexDir: string | null = null;
  let codexSkillKeptFor: string[] | null = null;
  if (purgeCodexSkill) {
    const dir = codexSkillDir();
    if (await pathExists(dir)) {
      const others = await otherCodexProjects(projectRoot);
      if (others.length === 0 || force) {
        codexDir = dir;
      } else {
        codexSkillKeptFor = others;
      }
    }
  }

  return {
    layerDir: (await pathExists(layer)) ? layer : null,
    cursorRule: (await pathExists(cursor)) ? cursor : null,
    claudeFile,
    claudeFileWillDelete,
    codexSkillDir: codexDir,
    codexSkillKeptFor,
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
  kind:
    | "layer-dir"
    | "cursor-rule"
    | "claude-marker-block"
    | "claude-file-delete"
    | "codex-skill";
}

function planToRemovedList(plan: ResetPlan): RemovedItem[] {
  const out: RemovedItem[] = [];
  if (plan.layerDir) out.push({ path: plan.layerDir, kind: "layer-dir" });
  if (plan.cursorRule) out.push({ path: plan.cursorRule, kind: "cursor-rule" });
  if (plan.claudeFile) {
    out.push({
      path: plan.claudeFile,
      kind: plan.claudeFileWillDelete ? "claude-file-delete" : "claude-marker-block",
    });
  }
  if (plan.codexSkillDir) out.push({ path: plan.codexSkillDir, kind: "codex-skill" });
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
  const purgeCodexSkill = boolFlag(args.flags, "purge-codex-skill");
  const force = boolFlag(args.flags, "force");
  const dryRun = boolFlag(args.flags, "dry-run");
  const json = boolFlag(args.flags, "json");

  const plan = await buildPlan(projectRoot, purgeCodexSkill, force);
  const items = planToRemovedList(plan);

  if (items.length === 0) {
    if (json) {
      process.stdout.write(
        JSON.stringify({
          status: "nothing-to-remove",
          projectRoot,
          purgeCodexSkill,
        }) + "\n",
      );
    } else {
      process.stdout.write(
        `Nothing to remove at ${projectRoot}.\n` +
          `  - No .gojaja/ layer\n` +
          `  - No .cursor/rules/gojaja-runtime.mdc\n` +
          `  - No managed block in CLAUDE.md\n` +
          (purgeCodexSkill
            ? `  - No ~/.codex/skills/gojaja-runtime/\n`
            : `(Pass --purge-codex-skill to also check the user-level Codex skill.)\n`),
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
          purgeCodexSkill,
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
    if (!purgeCodexSkill) {
      process.stdout.write(
        `The Codex skill at ~/.codex/skills/gojaja-runtime/ is\n` +
          `user-level and shared across every project that activated a\n` +
          `Codex agent. It is NOT touched by default; pass\n` +
          `--purge-codex-skill to also delete it.\n\n`,
      );
    } else if (plan.codexSkillKeptFor) {
      process.stdout.write(
        `The Codex skill at ~/.codex/skills/gojaja-runtime/ will be KEPT:\n` +
          `${plan.codexSkillKeptFor.length} other project(s) still use it:\n` +
          plan.codexSkillKeptFor.map((p) => `    - ${p}`).join("\n") +
          `\nThis project will be de-registered from it. Pass --force to\n` +
          `delete the skill anyway (breaks those projects' Codex windows).\n\n`,
      );
    }
    if (dryRun) {
      process.stdout.write(`Dry-run: nothing was removed.\n`);
      return 0;
    }
    process.stdout.write(
      `To confirm, run:\n  gojaja reset --confirm ${expectedToken}` +
        (purgeCodexSkill ? " --purge-codex-skill\n" : "\n"),
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
  if (plan.claudeFile) {
    const text = await fsp.readFile(plan.claudeFile, "utf8");
    const stripped = stripClaudeMarkerBlock(text);
    if (stripped.trim().length === 0) {
      await fsp.unlink(plan.claudeFile);
      removed.push({ path: plan.claudeFile, kind: "claude-file-delete" });
    } else {
      const out = stripped.endsWith("\n") ? stripped : stripped + "\n";
      await fsp.writeFile(plan.claudeFile, out);
      removed.push({ path: plan.claudeFile, kind: "claude-marker-block" });
    }
  }
  // De-register this project from the Codex skill registry regardless of
  // --purge (the project is gone, so it no longer uses the skill). When
  // we're deleting the whole skill dir, unregister is a harmless no-op
  // (the registry file goes with the dir).
  await unregisterCodexProject(projectRoot);
  if (plan.codexSkillDir) {
    await fsp.rm(plan.codexSkillDir, { recursive: true, force: true });
    removed.push({ path: plan.codexSkillDir, kind: "codex-skill" });
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "reset",
        projectRoot,
        removed,
        codexSkillKeptFor: plan.codexSkillKeptFor ?? undefined,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`Reset complete at ${projectRoot}.\n\n`);
  process.stdout.write(`Removed:\n`);
  for (const it of removed) {
    process.stdout.write(`  - ${it.path}  [${it.kind}]\n`);
  }
  if (plan.codexSkillKeptFor) {
    process.stdout.write(
      `\nThe Codex skill at ~/.codex/skills/gojaja-runtime/ was KEPT and\n` +
        `this project de-registered from it; ${plan.codexSkillKeptFor.length} other ` +
        `project(s) still use it.\n`,
    );
  } else if (!purgeCodexSkill) {
    process.stdout.write(
      `\nThe Codex skill at ~/.codex/skills/gojaja-runtime/ was NOT\n` +
        `touched (user-level, shared across projects). Pass --purge-codex-skill\n` +
        `next time if you want it removed too.\n`,
    );
  }
  return 0;
}

// Exported for tests.
export const __test__ = { stripClaudeMarkerBlock };

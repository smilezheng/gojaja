import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LAYER_DIRNAME, SCHEMA_VERSION } from "./runtime";
import { freshId } from "../core/ids";
import { Paths } from "../core/paths";
import { classifyPath } from "../core/path-routing";
import { exists, atomicWriteFile } from "../core/atomic";
import {
  centralRootForProject,
  readProjectJson,
  writeProjectJson,
} from "./central-root";
import type { ProjectJson } from "../core/types";

/**
 * PR9.3 — `gojaja migrate` walker for v2 → v3.
 *
 * Pure logic: this module knows nothing about argv parsing or output
 * formatting. The CLI surface lives in `commands/migrate.ts`.
 *
 * Migration model:
 *   1. Read `<project>/.gojaja/VERSION` to confirm a v2 layer.
 *   2. If `project.json` is already present, treat as idempotent
 *      no-op (the project was previously migrated; we don't touch
 *      it again).
 *   3. Otherwise mint a fresh ULID, compute the central root via
 *      `centralRootForProject(ulid)`, and copy every file under the
 *      user tree whose `classifyPath` returns `"central"` into the
 *      central tree at the same relative path.
 *   4. Write `<project>/.gojaja/project.json` and bump `VERSION` to
 *      the v3 schema.
 *
 * Safety net (`opts.cleanup === false`, the default):
 *   - Source files in the user tree are NOT deleted; they remain
 *     as a fallback in case the new central tree turns out to be
 *     wrong. The user tree just gains extra files that the v3 store
 *     ignores. `gojaja migrate --cleanup` re-runs the file walk in
 *     "remove central-classified files from the user tree" mode
 *     once the user has confirmed the new layout is working.
 *
 * Idempotency:
 *   - Re-running `migrate` on a v3 layer is a no-op (the
 *     `project.json` check short-circuits).
 *   - Re-running with `--cleanup` on an already-cleaned layer is
 *     also a no-op (nothing left to delete).
 */

export interface MigrateInspection {
  layerDir: string;
  /** True when `.gojaja/VERSION` exists. */
  hasLayer: boolean;
  /** Raw VERSION file contents (trimmed), or null if missing. */
  version: string | null;
  /** Existing project.json if present (v3 marker). */
  project: ProjectJson | null;
  /** What action the planner would take given the current state. */
  action: MigrateAction;
}

export type MigrateAction =
  | { kind: "no-layer"; reason: string }
  | { kind: "already-v3"; reason: string }
  | { kind: "ready"; fromVersion: string; centralRoot: string; projectId: string };

export interface MigratePlan {
  inspection: MigrateInspection;
  /** Concrete file-by-file copy plan (only populated for "ready" action). */
  copies: Array<{ relPath: string; bytes: number }>;
  /** Files that `--cleanup` would remove from the user tree. */
  cleanup: string[];
}

export interface MigrateResult {
  layerDir: string;
  projectId: string;
  centralRoot: string;
  copied: number;
  cleanedUp: number;
  fromVersion: string;
  toVersion: string;
}

export class MigrateNoLayerError extends Error {
  readonly code = "MIGRATE_NO_LAYER";
  constructor(public readonly layerDir: string) {
    super(`No .gojaja layer at ${layerDir}; nothing to migrate.`);
  }
}

export class MigrateAlreadyV3Error extends Error {
  readonly code = "MIGRATE_ALREADY_V3";
  constructor(
    public readonly layerDir: string,
    public readonly projectId: string,
  ) {
    super(
      `${layerDir} is already on the v3 layout (project.json present, id=${projectId}). ` +
        `Nothing to do.`,
    );
  }
}

/**
 * Pre-flight inspection. Reads VERSION + project.json, walks the
 * user tree to enumerate files. Never writes.
 */
export async function inspectMigrate(
  projectRoot: string,
): Promise<MigrateInspection> {
  const layerDir = path.join(projectRoot, LAYER_DIRNAME);
  const versionPath = path.join(layerDir, Paths.versionFile);
  const hasLayer = await exists(versionPath);
  if (!hasLayer) {
    return {
      layerDir,
      hasLayer: false,
      version: null,
      project: null,
      action: {
        kind: "no-layer",
        reason: `No ${Paths.versionFile} found under ${layerDir}.`,
      },
    };
  }
  const version = (await fsp.readFile(versionPath, "utf8")).trim();
  const project = await readProjectJson(layerDir);
  if (project) {
    return {
      layerDir,
      hasLayer: true,
      version,
      project,
      action: {
        kind: "already-v3",
        reason: `project.json found (id=${project.id}, schema=${project.schema}).`,
      },
    };
  }
  const projectId = freshId();
  const centralRoot = centralRootForProject(projectId);
  return {
    layerDir,
    hasLayer: true,
    version,
    project: null,
    action: { kind: "ready", fromVersion: version, centralRoot, projectId },
  };
}

/**
 * Build a concrete copy/cleanup plan. Pure read; safe to print to
 * the user as a dry-run preview before any `performMigrate` call.
 *
 * The plan only includes files the classifier routes to `"central"`.
 * The user tree's contracts (VERSION, config.yaml, roles/, etc.)
 * stay where they are.
 */
export async function planMigrate(
  inspection: MigrateInspection,
): Promise<MigratePlan> {
  if (inspection.action.kind !== "ready") {
    return { inspection, copies: [], cleanup: [] };
  }
  const copies: Array<{ relPath: string; bytes: number }> = [];
  const cleanup: string[] = [];
  for await (const rel of walkRelativeFiles(inspection.layerDir, "")) {
    // Skip project.json (we'll write a fresh one) and the VERSION
    // file (we'll bump it in place; don't try to copy a stale value
    // into central by mistake).
    if (rel === "project.json" || rel === Paths.versionFile) continue;
    if (classifyPath(rel) !== "central") continue;
    const abs = path.join(inspection.layerDir, rel);
    const st = await fsp.stat(abs);
    copies.push({ relPath: rel, bytes: st.size });
    cleanup.push(rel);
  }
  return { inspection, copies, cleanup };
}

/**
 * Execute a migration plan. Idempotent at the file level: an
 * already-present destination file is overwritten (atomic rename),
 * never duplicated.
 *
 * `opts.cleanup === true` also removes the central-classified files
 * from the user tree AFTER all copies have succeeded. The default is
 * false so the user has a fallback for a few sprints; a second run
 * with `--cleanup` deletes them.
 */
export async function performMigrate(
  projectRoot: string,
  opts: { cleanup?: boolean } = {},
): Promise<MigrateResult> {
  const inspection = await inspectMigrate(projectRoot);
  if (inspection.action.kind === "no-layer") {
    throw new MigrateNoLayerError(inspection.layerDir);
  }
  if (inspection.action.kind === "already-v3") {
    // Idempotent: re-running on a v3 layer is just a cleanup pass
    // if requested, else a no-op.
    if (!opts.cleanup) {
      throw new MigrateAlreadyV3Error(
        inspection.layerDir,
        inspection.project!.id,
      );
    }
    const cleaned = await cleanupUserTreeCentralFiles(inspection.layerDir);
    return {
      layerDir: inspection.layerDir,
      projectId: inspection.project!.id,
      centralRoot: centralRootForProject(inspection.project!.id),
      copied: 0,
      cleanedUp: cleaned,
      fromVersion: inspection.version ?? "?",
      toVersion: inspection.project!.schema,
    };
  }
  // action.kind === "ready"
  const ready = inspection.action;

  const plan = await planMigrate(inspection);

  // Phase 1: stage all central-classified files into the central
  // tree. Each file is written atomically; failures part-way
  // through leave a half-migrated central tree but the user tree
  // is still intact, so the migration is restartable.
  for (const { relPath } of plan.copies) {
    const src = path.join(inspection.layerDir, relPath);
    const dst = path.join(ready.centralRoot, relPath);
    const buf = await fsp.readFile(src);
    await atomicWriteFile(dst, buf);
  }

  // Phase 2: stamp the v3 marker + bump VERSION in the user tree.
  // Both writes are themselves atomic; the project.json write goes
  // first so a crash between them leaves a recoverable state ("has
  // project.json but VERSION still v2" is detectable and retryable).
  const project: ProjectJson = {
    id: ready.projectId,
    name: path.basename(projectRoot),
    schema: SCHEMA_VERSION,
  };
  await writeProjectJson(inspection.layerDir, project);
  await atomicWriteFile(
    path.join(inspection.layerDir, Paths.versionFile),
    `${SCHEMA_VERSION}\n`,
  );

  // Phase 3 (optional): cleanup. Done last so the user tree
  // retains a fallback through phases 1+2.
  let cleanedUp = 0;
  if (opts.cleanup) {
    cleanedUp = await cleanupUserTreeCentralFiles(inspection.layerDir);
  }

  return {
    layerDir: inspection.layerDir,
    projectId: ready.projectId,
    centralRoot: ready.centralRoot,
    copied: plan.copies.length,
    cleanedUp,
    fromVersion: ready.fromVersion,
    toVersion: SCHEMA_VERSION,
  };
}

/**
 * Recursively yield every file under `root/<sub>` as a POSIX
 * relative path against `root`. Skips empty directories
 * (directories themselves are not yielded). Yields nothing if the
 * directory does not exist.
 */
async function* walkRelativeFiles(
  root: string,
  sub: string,
): AsyncGenerator<string> {
  const dir = path.join(root, sub);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const ent of entries) {
    const childRel = sub.length === 0 ? ent.name : `${sub}/${ent.name}`;
    if (ent.isDirectory()) {
      yield* walkRelativeFiles(root, childRel);
    } else if (ent.isFile()) {
      yield childRel;
    }
    // Symlinks / sockets / etc are intentionally skipped — gojaja
    // never writes them and an attacker-planted symlink should not
    // be silently copied into the central tree.
  }
}

/**
 * Delete every file under the user tree whose `classifyPath` says
 * it belongs in central. Used by `--cleanup`. Returns the count of
 * files actually removed. Empty parent directories are pruned
 * post-walk.
 */
async function cleanupUserTreeCentralFiles(layerDir: string): Promise<number> {
  let removed = 0;
  const candidateDirs = new Set<string>();
  for await (const rel of walkRelativeFiles(layerDir, "")) {
    if (rel === "project.json" || rel === Paths.versionFile) continue;
    if (classifyPath(rel) !== "central") continue;
    const abs = path.join(layerDir, rel);
    await fsp.unlink(abs);
    removed += 1;
    candidateDirs.add(path.dirname(abs));
  }
  // Best-effort prune of now-empty directories that were carrying
  // central content. We walk from longest path to shortest so
  // nested dirs collapse correctly.
  const sortedDirs = [...candidateDirs].sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    if (dir === layerDir) continue;
    try {
      await fsp.rmdir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "ENOENT") throw err;
    }
  }
  return removed;
}

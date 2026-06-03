import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson, readJsonFileOrNull } from "../core/atomic";
import type { ProjectJson } from "../core/types";

/**
 * v3 central-root resolution (RFC-0001, PR9.2).
 *
 * In v3, mutable runtime state lives outside the project tree at
 * `~/.gojaja/projects/<project-id>/`. This module:
 *
 *   1. Computes that path from the ULID stored in
 *      `<project>/.gojaja/project.json`.
 *   2. Reads / writes the marker file itself.
 *
 * The marker file is the only piece of v3 layout that travels with
 * git (the rest is per-user / per-machine). Every git worktree of
 * the same repository inherits the same project.json and therefore
 * the same central root, which is the entire reason this exists —
 * see postmortem-2026-06-02-shell-eval.md §8.3 / §8.10b for the
 * v2 incidents that motivated the split.
 */

/**
 * Root of all per-user, per-machine gojaja state. Currently fixed at
 * `~/.gojaja/` but reads `GOJAJA_HOME` first as an override so tests
 * (and unusual deployments where `$HOME` isn't writable) can redirect
 * it. Always returns an absolute path.
 */
export function gojajaHome(): string {
  const override = process.env.GOJAJA_HOME;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".gojaja");
}

/**
 * Path to a project's central tree, given its ULID.
 *
 * No I/O — pure path arithmetic. The directory may or may not exist
 * (it doesn't on a fresh clone of a v3 project on a new machine
 * until `gojaja project link` / a future `gojaja init --resume`
 * creates it).
 */
export function centralRootForProject(projectId: string): string {
  return path.join(gojajaHome(), "projects", projectId);
}

/**
 * Path to the project.json marker file for a given user-tree root
 * (i.e. `<project>/.gojaja/`).
 */
export function projectJsonPath(userRoot: string): string {
  return path.join(userRoot, "project.json");
}

/**
 * Read `<userRoot>/project.json` if it exists; return null otherwise.
 *
 * v2 projects don't have this file. Callers distinguish v2 vs v3 by
 * a null return value here.
 */
export async function readProjectJson(
  userRoot: string,
): Promise<ProjectJson | null> {
  return readJsonFileOrNull<ProjectJson>(projectJsonPath(userRoot));
}

/**
 * Write `<userRoot>/project.json` atomically.
 *
 * Refuses to overwrite by default — the only legitimate way to
 * change an existing project.json is via `gojaja project rename`
 * (PR9.4) or `gojaja project link`, both of which pass
 * `allowOverwrite: true` explicitly. Initial creation comes
 * through `gojaja init` and `gojaja migrate`; in both paths the
 * caller has already verified the file is absent.
 */
export async function writeProjectJson(
  userRoot: string,
  data: ProjectJson,
  opts: { allowOverwrite?: boolean } = {},
): Promise<void> {
  const target = projectJsonPath(userRoot);
  if (!opts.allowOverwrite) {
    const existing = await fsp.stat(target).catch(() => null);
    if (existing) {
      throw new Error(
        `Refusing to overwrite existing ${target}. ` +
          `Pass { allowOverwrite: true } to deliberately replace it.`,
      );
    }
  }
  await atomicWriteJson(target, data);
}

/**
 * Convenience: given a userRoot, return its central root if the
 * project.json marker is present, or null for v2 / uninitialised
 * projects. The returned path may not yet exist on disk (fresh clone
 * on a new machine); callers responsible for the "does central tree
 * exist?" check.
 */
export async function resolveCentralRoot(
  userRoot: string,
): Promise<string | null> {
  const project = await readProjectJson(userRoot);
  if (!project) return null;
  return centralRootForProject(project.id);
}

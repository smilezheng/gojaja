import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LocalFsStore } from "../core/local-fs-store";
import { NotInitializedError } from "../core/errors";
import {
  centralRootForProject,
  readProjectJson,
} from "./central-root";

const PACKAGE_VERSION = require("../../package.json").version as string;
export const CLI_VERSION: string = PACKAGE_VERSION;

/**
 * The on-disk schema version stamped into `.gojaja/VERSION` by
 * `gojaja init`.
 *
 * v3.0.0 splits the layer into a small git-tracked
 * `<project>/.gojaja/` tree (carrying VERSION + project.json +
 * config.yaml + roles/<id>.md + state/project_state.md) and a
 * per-user / per-machine central tree at
 * `~/.gojaja/projects/<project-id>/` carrying everything else (the
 * task board, event stream, sessions, RFCs, worklog, locks). See
 * RFC-0001 for the design and `gojaja migrate` for the v2 → v3
 * walker.
 */
export const SCHEMA_VERSION = "3.0.0";

export const LAYER_DIRNAME = ".gojaja";

/**
 * Discover the project root.
 *
 * Resolution order:
 *   1. The `GOJAJA_PROJECT_ROOT` env var, if set, is used verbatim.
 *   2. Otherwise walk upwards from CWD looking for an existing
 *      `.gojaja/VERSION` file. The directory containing it wins.
 *   3. If nothing is found, fall back to CWD. Callers wanting initialisation
 *      should use `cwd` directly via `--root`.
 */
export async function discoverProjectRoot(cwd: string = process.cwd()): Promise<string> {
  const envRoot = process.env.GOJAJA_PROJECT_ROOT;
  if (envRoot) return path.resolve(envRoot);

  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, LAYER_DIRNAME, "VERSION");
    try {
      await fsp.access(candidate);
      return dir;
    } catch {
      // not here, walk up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

export function layerRoot(projectRoot: string): string {
  return path.join(projectRoot, LAYER_DIRNAME);
}

export async function openStoreOrThrow(projectRoot: string): Promise<LocalFsStore> {
  const userRoot = layerRoot(projectRoot);
  // v3 detection: `<project>/.gojaja/project.json` marks a project
  // that uses the central-root split (RFC-0001). v2 projects don't
  // carry this file; they fall through to single-root mode below.
  const project = await readProjectJson(userRoot);
  const opts = project
    ? { centralRoot: centralRootForProject(project.id) }
    : undefined;
  const store = new LocalFsStore(userRoot, opts);
  if (!(await store.isInitialised())) {
    throw new NotInitializedError(userRoot);
  }
  return store;
}

export function openStoreUnchecked(projectRoot: string): LocalFsStore {
  // Synchronous form is best-effort; callers using this path are
  // pre-init helpers (e.g. `gojaja reset`'s preview). They get a
  // single-root store here; if the project turns out to be v3 the
  // caller can re-resolve via `openStoreOrThrow` once it's safe
  // to do async I/O.
  return new LocalFsStore(layerRoot(projectRoot));
}

/**
 * Async, init-tolerant store resolver — like `openStoreOrThrow` but
 * does NOT throw on an uninitialised layer. Used by `gojaja watch`,
 * which serves an init landing page when the layer is missing and
 * therefore must construct a usable store reference even pre-init.
 *
 * If `<project>/.gojaja/project.json` exists, returns a v3
 * split-mode store with the right `centralRoot`. Otherwise returns
 * a single-root store (v2 layout, or pre-init).
 *
 * v3.0.x bug fix: the previous `new LocalFsStore(layer)` shortcut
 * inside watch ignored project.json entirely, so after `gojaja
 * migrate --execute --cleanup` (which moves runtime state to
 * `~/.gojaja/projects/<id>/`) the dashboard saw an empty user
 * tree even though `gojaja task list` (which goes through
 * `openStoreOrThrow`) read the central tree correctly. Funnelling
 * watch through this helper closes the gap.
 */
export async function openStoreUncheckedAsync(
  projectRoot: string,
): Promise<LocalFsStore> {
  const userRoot = layerRoot(projectRoot);
  const project = await readProjectJson(userRoot).catch(() => null);
  const opts = project
    ? { centralRoot: centralRootForProject(project.id) }
    : undefined;
  return new LocalFsStore(userRoot, opts);
}

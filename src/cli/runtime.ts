import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LocalFsStore } from "../core/local-fs-store";
import { NotInitializedError } from "../core/errors";

const PACKAGE_VERSION = require("../../package.json").version as string;
export const CLI_VERSION: string = PACKAGE_VERSION;

/** The on-disk schema version embedded in the .multi-agent/VERSION file. */
export const SCHEMA_VERSION = "2.0.0";

export const LAYER_DIRNAME = ".multi-agent";

/**
 * Discover the project root.
 *
 * Resolution order:
 *   1. The `MA_PROJECT_ROOT` env var, if set, is used verbatim.
 *   2. Otherwise walk upwards from CWD looking for an existing
 *      `.multi-agent/VERSION` file. The directory containing it wins.
 *   3. If nothing is found, fall back to CWD. Callers wanting initialisation
 *      should use `cwd` directly via `--root`.
 */
export async function discoverProjectRoot(cwd: string = process.cwd()): Promise<string> {
  const envRoot = process.env.MA_PROJECT_ROOT;
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
  const store = new LocalFsStore(layerRoot(projectRoot));
  if (!(await store.isInitialised())) {
    throw new NotInitializedError(layerRoot(projectRoot));
  }
  return store;
}

export function openStoreUnchecked(projectRoot: string): LocalFsStore {
  return new LocalFsStore(layerRoot(projectRoot));
}

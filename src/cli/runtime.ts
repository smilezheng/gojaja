import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LocalFsStore } from "../core/local-fs-store";
import { NotInitializedError } from "../core/errors";

const PACKAGE_VERSION = require("../../package.json").version as string;
export const CLI_VERSION: string = PACKAGE_VERSION;

/** The on-disk schema version embedded in the .multi-agent/VERSION file. */
// Bumped in PR8g (RFC v2 — comments shape moved from per-role JSONs
// to a single threaded comments.yaml ledger; proposal.yaml gained
// description / relatedTasks / preDecision; new RFC_* event types).
// Bumped again in PR8g.1: pre-decide collapsed back to a comment kind
// with a hard ACK gate. proposal.yaml `status: pre-decide` and
// `preDecision` field are removed; comments carry a structured `kind`
// (pre-decision / ack / object). Old shapes are detected on read and
// refused with a migration hint.
// Bumped again in PR8i: the `.wait` sentinel is gone; `wait` writes a
// session record at `comms/pending/<role>/wait.json` and survives host
// shell timeouts via chunked polling with explicit deadlines.
// Bumped again in PR8j: Task records gained `parent` (hierarchy),
// `assignedBy` (audit), `assets` / `deliverables` (reference materials
// + gated hard outputs), `tags` (filter labels). `setTaskStatus(Done)`
// refuses when file-kind deliverables are missing on disk; bypass via
// `--force-incomplete` emits `TASK_DELIVERABLE_BYPASSED`.
// Bumped in PR8n: manifest `events` is now a per-role projection of
// the global event stream. Broadcast events (`to: "*"`) only land in
// the manifests of roles that are stakeholders for that event type
// (RFC participants, task stakeholders, task-board owners, ...).
// Operational events (SESSION_*, LOCK_BROKEN, RFC_REPAIRED,
// ROLE_DELETED) never appear in any manifest — they stay in
// `comms/events/` for audit + future `agentctl doctor`.
export const SCHEMA_VERSION = "2.0.0-manifest-filter";

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

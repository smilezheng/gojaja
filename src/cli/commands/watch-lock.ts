/**
 * Single-instance gate for `gojaja watch` within a project.
 *
 * Running two watch dashboards against the same `.gojaja/` is rarely
 * what the user wants:
 *   - both processes would run the same 30-minute auto-archive sweep
 *     against the same task board, doubling the IO for nothing.
 *   - the "open the browser to the dashboard" affordance becomes
 *     ambiguous — which window is the canonical one?
 *
 * We persist a lock record at `.gojaja/watch.lock` containing the
 * process identity + URL of the live instance. A second `watch`
 * invocation reads the lock; if the recorded PID is still alive on
 * this host, the second invocation aborts early and opens the user's
 * browser at the existing instance's URL (the friendliest possible
 * "you already have one of these running" UX). Stale locks (dead
 * PID, or written by another host) are silently overwritten.
 *
 * The lock is purely advisory inside the gojaja CLI — nothing else
 * looks at it. It deliberately does NOT live under `Paths.locksDir`,
 * which is the short-lived per-resource lock used by the store layer
 * for serialised writes; this is a long-lived process registration
 * with very different semantics.
 */

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";

/** Relative location of the lock file within the layer root. */
export const WATCH_LOCK_RELATIVE = "watch.lock";

export interface WatchLockInfo {
  /** Process id of the running watch. */
  pid: number;
  /** os.hostname() at acquire time — disambiguates a shared filesystem. */
  host: string;
  /** Bind host of the dashboard server (e.g. `127.0.0.1`). */
  bindHost: string;
  /** Listening port. */
  port: number;
  /** ISO-8601 UTC timestamp of acquire. */
  startedAt: string;
  /** URL to open in a browser for the running instance. */
  url: string;
}

function lockPath(layerRoot: string): string {
  return path.join(layerRoot, WATCH_LOCK_RELATIVE);
}

/**
 * Read the lock file at the given layer root. Returns null if the
 * file does not exist or is unparseable (treat malformed lock as
 * stale rather than blowing up the start path).
 */
export async function readWatchLock(
  layerRoot: string,
): Promise<WatchLockInfo | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(lockPath(layerRoot), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WatchLockInfo>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.host !== "string" ||
      typeof parsed.port !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      host: parsed.host,
      bindHost: parsed.bindHost ?? "127.0.0.1",
      port: parsed.port,
      startedAt: parsed.startedAt,
      url: parsed.url ?? `http://${parsed.bindHost ?? "127.0.0.1"}:${parsed.port}/`,
    };
  } catch {
    return null;
  }
}

/**
 * Is the lock record currently live (= same host AND `process.kill(pid, 0)`
 * succeeds)? Cross-host locks are always treated as not-live because
 * we cannot probe a remote PID — the cost of a false negative
 * (stomping someone else's lock) is symmetric with the cost of a
 * false positive (refusing to start on a freshly-cloned checkout),
 * and freshly-cloned checkouts are vastly more common.
 */
export function isLockLive(info: WatchLockInfo, hostname: string): boolean {
  if (info.host !== hostname) return false;
  try {
    // Signal 0 = "check the process exists and we can signal it".
    // Throws ESRCH if no such pid, EPERM if it exists but is owned by
    // a different user (treat as live — we are not authorised to
    // assume it crashed).
    process.kill(info.pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Write the lock file with the supplied info. Overwrites any
 * existing file at the path — callers should have already decided
 * the existing lock is stale or absent.
 */
export async function writeWatchLock(
  layerRoot: string,
  info: WatchLockInfo,
): Promise<void> {
  // Best-effort directory creation. The layer root already exists by
  // the time we get here (watch only acquires after `isInitialised`),
  // but the layer might be the .gojaja root with no `watch.lock`
  // ancestors to create, so this is essentially a noop. Kept for
  // symmetry with the test path where `layerRoot` is a tempdir.
  await fsp.mkdir(layerRoot, { recursive: true });
  await fsp.writeFile(
    lockPath(layerRoot),
    JSON.stringify(info, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Synchronous lock removal. The async variants would be cleaner but
 * `process.on("exit", ...)` only runs synchronous handlers, and we
 * need the lock gone even when the process is exiting normally.
 * Errors are silently swallowed — by exit time there is no useful
 * recovery (and a leftover lock will simply be detected as stale on
 * the next start).
 */
export function removeWatchLockSync(layerRoot: string): void {
  try {
    fs.unlinkSync(lockPath(layerRoot));
  } catch {
    /* ignore */
  }
}

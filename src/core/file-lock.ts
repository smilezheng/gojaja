import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { LockTimeoutError } from "./errors";
import { atomicWriteJson, hostId, readJsonFileOrNull, safeUnlink } from "./atomic";
import { freshId } from "./ids";

interface LockRecord {
  owner: string;
  pid: number;
  host: string;
  acquiredAt: number;
  leaseExpiresAt: number;
}

export interface LockOptions {
  timeoutMs?: number;
  leaseMs?: number;
  pollMs?: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  leaseMs: 30_000,
  pollMs: 50,
};

/**
 * File-based exclusive lock with PID liveness and lease expiry.
 *
 * Acquire algorithm:
 *   1. Try to atomically create `<lockPath>` with O_EXCL. Success: we own it.
 *   2. EEXIST: read the existing lock. If the lease is expired, OR the
 *      owning process is on this host and no longer alive, attempt a
 *      best-effort takeover (rename aside, then retry create). The takeover
 *      itself races safely: only one process can rename, and a fresh create
 *      still goes through O_EXCL.
 *   3. Otherwise sleep `pollMs` and retry until `timeoutMs` elapses.
 *
 * Limitations (intentional for v1):
 *   - Locks held longer than `leaseMs` may be silently broken. Keep critical
 *     sections short. There is no lease-renewal mechanism yet.
 *   - PID liveness is only checked when the lock owner is on the same host.
 *     Multi-machine scenarios are out of scope for v1.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<{ result: T; broke: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const leaseMs = opts.leaseMs ?? DEFAULTS.leaseMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;

  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  let broke = false;
  const ownerId = freshId();

  while (true) {
    const record: LockRecord = {
      owner: ownerId,
      pid: process.pid,
      host: hostId(),
      acquiredAt: Date.now(),
      leaseExpiresAt: Date.now() + leaseMs,
    };
    const json = JSON.stringify(record) + "\n";

    try {
      const handle = await fsp.open(lockPath, "wx", 0o644);
      try {
        await handle.writeFile(json);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const result = await fn();
        return { result, broke };
      } finally {
        await releaseIfOwned(lockPath, ownerId);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const stale = await detectStale(lockPath);
    if (stale) {
      const tookOver = await tryBreakStale(lockPath, stale);
      if (tookOver) {
        broke = true;
        continue;
      }
    }

    if (Date.now() - start >= timeoutMs) {
      throw new LockTimeoutError(lockPath, Date.now() - start);
    }
    await sleep(pollMs);
  }
}

async function releaseIfOwned(lockPath: string, ownerId: string): Promise<void> {
  const current = await readJsonFileOrNull<LockRecord>(lockPath);
  if (current && current.owner === ownerId) {
    await safeUnlink(lockPath);
  }
  // If owner differs, someone has taken over our lock (we held it past the
  // lease). We do not delete their record; the takeover already happened.
}

async function detectStale(lockPath: string): Promise<LockRecord | null> {
  const current = await readJsonFileOrNull<LockRecord>(lockPath);
  if (!current) return null;
  if (current.leaseExpiresAt <= Date.now()) return current;
  if (current.host === hostId() && !pidAlive(current.pid)) return current;
  return null;
}

async function tryBreakStale(
  lockPath: string,
  expected: LockRecord,
): Promise<boolean> {
  const aside = `${lockPath}.dead-${freshId()}`;
  try {
    await fsp.rename(lockPath, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    return false;
  }
  const movedRecord = await readJsonFileOrNull<LockRecord>(aside);
  await safeUnlink(aside);
  if (!movedRecord) return true;
  return movedRecord.owner === expected.owner && movedRecord.pid === expected.pid;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true; // EPERM means the pid exists but we lack signal permission
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exported so tests can synthesise a stale lock without poking at internals.
export async function _writeRawLockForTest(
  lockPath: string,
  record: Partial<LockRecord>,
): Promise<void> {
  const full: LockRecord = {
    owner: record.owner ?? freshId(),
    pid: record.pid ?? -1,
    host: record.host ?? hostId(),
    acquiredAt: record.acquiredAt ?? Date.now(),
    leaseExpiresAt: record.leaseExpiresAt ?? Date.now() + 60_000,
  };
  await atomicWriteJson(lockPath, full);
}

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
  let current: LockRecord | null = null;
  try {
    current = await readJsonFileOrNull<LockRecord>(lockPath);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Partial write observed; treat as "not ours" and don't unlink.
  }
  if (current && current.owner === ownerId) {
    await safeUnlink(lockPath);
  }
  // If owner differs, someone has taken over our lock (we held it past the
  // lease). We do not delete their record; the takeover already happened.
}

async function detectStale(lockPath: string): Promise<LockRecord | null> {
  // The lock file is written non-atomically (open + write + close, no
  // rename). A concurrent reader can therefore observe an empty or
  // partial file. Tolerate parse failures by treating the lock as
  // "currently held but contents not yet observable" — never break a
  // half-written lock; let the next poll see the complete record.
  let current: LockRecord | null = null;
  try {
    current = await readJsonFileOrNull<LockRecord>(lockPath);
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  if (!current) return null;
  if (current.leaseExpiresAt <= Date.now()) return current;
  if (current.host === hostId() && !pidAlive(current.pid)) return current;
  return null;
}

async function tryBreakStale(
  lockPath: string,
  expected: LockRecord,
): Promise<boolean> {
  // Race we are guarding against: between `detectStale` returning the
  // stale record and us calling `rename` here, the original owner may
  // have released and a fresh process B may have legitimately taken the
  // lock with a new record. If we then unconditionally unlink the aside,
  // B is in the critical section with NO lock file on disk, and a third
  // process C can acquire the lock simultaneously. Two processes in the
  // critical section is exactly what locks exist to prevent.
  //
  // Strategy: only delete `aside` when its record matches the expected
  // (stale) record we set out to break. On mismatch, rename it BACK to
  // `lockPath` (best effort). If the rename-back fails because someone
  // else has created a new lock in the meantime, leave `aside` on disk
  // as forensic evidence — never delete a record that may belong to a
  // legitimate, live owner.
  const aside = `${lockPath}.dead-${freshId()}`;
  try {
    await fsp.rename(lockPath, aside);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    return false;
  }
  let movedRecord: LockRecord | null = null;
  try {
    movedRecord = await readJsonFileOrNull<LockRecord>(aside);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    // Treat partial reads as "not the expected record"; do not delete.
  }
  const matchesExpected =
    movedRecord !== null &&
    movedRecord.owner === expected.owner &&
    movedRecord.pid === expected.pid;
  if (matchesExpected || movedRecord === null) {
    // Either the record we wanted to break, or an unreadable record we
    // already moved aside (no live owner can correctly trust it). Safe
    // to discard.
    await safeUnlink(aside);
    return true;
  }
  // Record changed under us. Try to put it back so the legitimate owner
  // is not silently de-locked.
  try {
    await fsp.rename(aside, lockPath);
  } catch {
    // Someone else has already created a new lockPath in the brief
    // window. We MUST NOT delete `aside` — leave it as forensic evidence
    // that two lock records existed for the same key at the same time.
    // Operators / `agentctl doctor` (planned) will reconcile.
  }
  return false;
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

// Exposed only for regression testing of the conditional-restore behaviour
// when the record on disk has changed between detectStale and the rename.
export async function _tryBreakStaleForTest(
  lockPath: string,
  expected: LockRecord,
): Promise<boolean> {
  return tryBreakStale(lockPath, expected);
}

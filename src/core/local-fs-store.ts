import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  AlreadyInitializedError,
  NotInitializedError,
  StateCorruptionError,
  UsageError,
} from "./errors";
import {
  atomicWriteFile,
  atomicWriteJson,
  exists,
  hostId,
  readJsonFile,
  readJsonFileOrNull,
  safeUnlink,
} from "./atomic";
import { withFileLock } from "./file-lock";
import { freshId, isUlid, newId } from "./ids";
import { Paths, resolveInside, rolePaths } from "./paths";
import { validateRoleId } from "./role-id";
import type { Store } from "./store";
import type { CursorState, Event, SessionInfo } from "./types";

/**
 * Filesystem-backed Store. Operates against a `.multi-agent` directory rooted
 * at `root`. All path construction is forced through `resolveInside`, so no
 * user input can reach `fs.*` without validation.
 */
export class LocalFsStore implements Store {
  readonly rootDescription: string;

  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
    this.rootDescription = this.root;
  }

  // ---- bootstrap ----------------------------------------------------------

  async isInitialised(): Promise<boolean> {
    return exists(this.abs(Paths.versionFile));
  }

  async initialise(version: string): Promise<void> {
    if (await this.isInitialised()) {
      throw new AlreadyInitializedError(this.root);
    }
    await fsp.mkdir(this.root, { recursive: true });
    const dirs = [
      Paths.protocolDir,
      Paths.rolesDir,
      Paths.stateDir,
      Paths.eventsDir,
      Paths.inboxDir,
      Paths.cursorsDir,
      Paths.pendingDir,
      Paths.sessionsDir,
      Paths.heartbeatsDir,
      Paths.rfcsDir,
      Paths.worklogDir,
      Paths.locksDir,
    ];
    await Promise.all(dirs.map((d) => fsp.mkdir(this.abs(d), { recursive: true })));
    await atomicWriteFile(this.abs(Paths.versionFile), `${version}\n`);
  }

  async readVersion(): Promise<string> {
    if (!(await this.isInitialised())) {
      throw new NotInitializedError(this.root);
    }
    const raw = await fsp.readFile(this.abs(Paths.versionFile), "utf8");
    return raw.trim();
  }

  // ---- locking ------------------------------------------------------------

  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(key)) {
      throw new UsageError(`Invalid lock key '${key}'.`);
    }
    const lockPath = this.abs(path.posix.join(Paths.locksDir, `${key}.lock`));
    const { result, broke } = await withFileLock(lockPath, fn, opts);
    if (broke) {
      await this.recordEventInternal({
        type: "LOCK_BROKEN",
        from: "SYSTEM",
        to: "*",
        ref: key,
        payload: { lockKey: key, host: hostId(), pid: process.pid },
      });
    }
    return result;
  }

  // ---- events -------------------------------------------------------------

  async appendEvent(input: Omit<Event, "id" | "ts">): Promise<Event> {
    return this.recordEventInternal(input);
  }

  private async recordEventInternal(
    input: Omit<Event, "id" | "ts">,
  ): Promise<Event> {
    const id = newId();
    const ts = new Date().toISOString();
    const event: Event = { id, ts, ...input };
    const dest = this.abs(path.posix.join(Paths.eventsDir, `${id}.json`));
    await atomicWriteJson(dest, event);
    return event;
  }

  async listEventsAfter(afterId: string, limit?: number): Promise<Event[]> {
    if (afterId && !isUlid(afterId)) {
      throw new UsageError(`Invalid cursor '${afterId}', expected ULID.`);
    }
    const dir = this.abs(Paths.eventsDir);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const ids = names
      .filter((n) => n.endsWith(".json") && !n.startsWith("."))
      .map((n) => n.slice(0, -".json".length))
      .filter((id) => isUlid(id) && id > afterId)
      .sort();
    const capped = limit !== undefined ? ids.slice(0, limit) : ids;
    const events: Event[] = [];
    for (const id of capped) {
      const file = path.join(dir, `${id}.json`);
      const evt = await readJsonFileOrNull<Event>(file);
      if (!evt) continue; // raced with a concurrent reader/cleanup
      if (evt.id !== id) {
        throw new StateCorruptionError(
          `Event file ${id}.json has mismatched id '${evt.id}'.`,
        );
      }
      events.push(evt);
    }
    return events;
  }

  // ---- cursors ------------------------------------------------------------

  async readCursor(role: string): Promise<CursorState> {
    validateRoleId(role);
    const file = this.abs(rolePaths(role).cursorFile);
    const existing = await readJsonFileOrNull<CursorState>(file);
    if (existing) return existing;
    return {
      role,
      ackedThrough: "",
      pendingManifest: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async updateCursor(
    role: string,
    mutator: (current: CursorState) => CursorState,
  ): Promise<CursorState> {
    validateRoleId(role);
    return this.withLock(`cursor-${role}`, async () => {
      const current = await this.readCursor(role);
      const next = mutator(current);
      if (next.role !== role) {
        throw new StateCorruptionError(
          `Cursor mutator returned wrong role '${next.role}', expected '${role}'.`,
        );
      }
      if (next.ackedThrough && !isUlid(next.ackedThrough)) {
        throw new UsageError(`Cursor ackedThrough must be a ULID, got '${next.ackedThrough}'.`);
      }
      if (next.ackedThrough && next.ackedThrough < current.ackedThrough) {
        throw new UsageError(
          `Cursor for '${role}' cannot move backwards (${current.ackedThrough} -> ${next.ackedThrough}).`,
        );
      }
      const written: CursorState = { ...next, updatedAt: new Date().toISOString() };
      await atomicWriteJson(this.abs(rolePaths(role).cursorFile), written);
      return written;
    });
  }

  // ---- sessions -----------------------------------------------------------

  async claimSession(
    role: string,
    ttlSeconds: number,
    force = false,
  ): Promise<SessionInfo> {
    validateRoleId(role);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new UsageError(`Invalid TTL: ${ttlSeconds}`);
    }
    return this.withLock(`session-${role}`, async () => {
      const file = this.abs(rolePaths(role).sessionFile);
      const existing = await readJsonFileOrNull<SessionInfo>(file);
      const now = Date.now();
      if (existing && !force) {
        const heartbeatAge = now - Date.parse(existing.heartbeatAt);
        const stillAlive = heartbeatAge < existing.leaseTtlSeconds * 1000;
        if (stillAlive) {
          throw new UsageError(
            `Role '${role}' is already claimed by session ${existing.sessionId} ` +
              `(heartbeat ${Math.floor(heartbeatAge / 1000)}s ago). Pass --force to take over.`,
          );
        }
      }
      const session: SessionInfo = {
        role,
        sessionId: freshId(),
        pid: process.pid,
        host: hostId(),
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        leaseTtlSeconds: ttlSeconds,
      };
      await atomicWriteJson(file, session);
      await this.recordEventInternal({
        type: existing ? "SESSION_TAKEOVER" : "SESSION_CLAIMED",
        from: "SYSTEM",
        to: "*",
        ref: role,
        payload: {
          role,
          sessionId: session.sessionId,
          previous: existing?.sessionId ?? null,
        },
      });
      return session;
    });
  }

  async releaseSession(role: string, sessionId: string): Promise<void> {
    validateRoleId(role);
    await this.withLock(`session-${role}`, async () => {
      const file = this.abs(rolePaths(role).sessionFile);
      const existing = await readJsonFileOrNull<SessionInfo>(file);
      if (!existing) return;
      if (existing.sessionId !== sessionId) {
        throw new UsageError(
          `Session id mismatch for role '${role}': have '${existing.sessionId}', ` +
            `release attempted by '${sessionId}'.`,
        );
      }
      await safeUnlink(file);
      await this.recordEventInternal({
        type: "SESSION_RELEASED",
        from: "SYSTEM",
        to: "*",
        ref: role,
        payload: { role, sessionId },
      });
    });
  }

  async readSession(role: string): Promise<SessionInfo | null> {
    validateRoleId(role);
    return readJsonFileOrNull<SessionInfo>(this.abs(rolePaths(role).sessionFile));
  }

  async touchHeartbeat(role: string, sessionId: string): Promise<void> {
    validateRoleId(role);
    await this.withLock(`session-${role}`, async () => {
      const file = this.abs(rolePaths(role).sessionFile);
      const existing = await readJsonFile<SessionInfo>(file);
      if (existing.sessionId !== sessionId) {
        throw new UsageError(
          `Heartbeat session mismatch for '${role}': stored '${existing.sessionId}', ` +
            `caller '${sessionId}'.`,
        );
      }
      const updated: SessionInfo = {
        ...existing,
        heartbeatAt: new Date().toISOString(),
      };
      await atomicWriteJson(file, updated);
    });
  }

  // ---- helpers ------------------------------------------------------------

  private abs(rel: string): string {
    return resolveInside(this.root, rel);
  }
}

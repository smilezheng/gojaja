import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  AlreadyInitializedError,
  NotInitializedError,
  StateCorruptionError,
  UnknownRoleError,
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
import {
  Paths,
  manifestPath,
  resolveInside,
  rolePaths,
  waitSentinelPath,
  worklogEntryPath,
} from "./paths";
import { validateRoleId } from "./role-id";
import { renderRoleMarkdown } from "./role-template";
import type { Store } from "./store";
import type {
  CursorState,
  Event,
  Manifest,
  ProjectConfig,
  RoleConfig,
  RoleId,
  SessionInfo,
} from "./types";

function freshConfig(schemaVersion: string): ProjectConfig {
  return { schemaVersion, roles: {} };
}

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
    await atomicWriteFile(
      this.abs(Paths.configFile),
      yaml.dump(freshConfig(version), { lineWidth: 100, noRefs: true }),
    );
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

  async findSessionById(sessionId: string): Promise<SessionInfo | null> {
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const dir = this.abs(Paths.sessionsDir);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const session = await readJsonFileOrNull<SessionInfo>(
        path.join(dir, name),
      );
      if (session && session.sessionId === sessionId) return session;
    }
    return null;
  }

  // ---- composite operations -----------------------------------------------

  async publishReport(input: {
    from: RoleId;
    to: RoleId;
    ref?: string;
    message: string;
  }): Promise<Event> {
    validateRoleId(input.from);
    validateRoleId(input.to);
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new UsageError("Report message must be a non-empty string.");
    }
    return this.recordEventInternal({
      type: "REPORT",
      from: input.from,
      to: input.to,
      ref: input.ref,
      payload: { message: input.message },
    });
  }

  async publishWorklog(input: { from: RoleId; message: string }): Promise<Event> {
    validateRoleId(input.from);
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new UsageError("Worklog message must be a non-empty string.");
    }
    const event = await this.recordEventInternal({
      type: "WORKLOG",
      from: input.from,
      to: "*",
      payload: { message: input.message },
    });
    // Best-effort markdown copy for git-friendly browsing. If this fails the
    // canonical record (the event file) is already durable.
    const mdPath = this.abs(worklogEntryPath(input.from, event.id));
    const body =
      `# Worklog entry ${event.id}\n\n` +
      `- Role: ${event.from}\n` +
      `- Time: ${event.ts}\n\n` +
      `${input.message}\n`;
    await atomicWriteFile(mdPath, body);
    return event;
  }

  async openOrCreatePlan(role: RoleId): Promise<Manifest> {
    validateRoleId(role);
    return this.withLock(`cursor-${role}`, async () => {
      const cursor = await this.readCursor(role);
      if (cursor.pendingManifest) {
        const existing = await readJsonFileOrNull<Manifest>(
          this.abs(manifestPath(role, cursor.pendingManifest)),
        );
        if (existing && existing.role === role && existing.ackToken === cursor.pendingManifest) {
          return existing;
        }
        // Pending pointer is stale; fall through and regenerate.
      }
      const events = await this.listEventsAfter(cursor.ackedThrough);
      const filtered = events.filter(
        (e) => e.from !== role && (e.to === role || e.to === "*"),
      );
      const advanceCursorTo =
        events.length > 0 ? events[events.length - 1].id : cursor.ackedThrough;
      const ackToken = newId();
      const manifest: Manifest = {
        ackToken,
        role,
        generatedAt: new Date().toISOString(),
        advanceCursorTo,
        fromCursor: cursor.ackedThrough,
        events: filtered,
      };
      await atomicWriteJson(this.abs(manifestPath(role, ackToken)), manifest);
      const updated: CursorState = {
        ...cursor,
        pendingManifest: ackToken,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.abs(rolePaths(role).cursorFile), updated);
      return manifest;
    });
  }

  async ackManifest(
    role: RoleId,
    token: string,
  ): Promise<{
    role: RoleId;
    previousCursor: string;
    ackedThrough: string;
    eventsAcked: number;
  }> {
    validateRoleId(role);
    if (!isUlid(token)) {
      throw new UsageError(`Ack token must be a ULID, got '${token}'.`);
    }
    return this.withLock(`cursor-${role}`, async () => {
      const cursor = await this.readCursor(role);
      if (!cursor.pendingManifest) {
        throw new UsageError(
          `Role '${role}' has no outstanding manifest to ack. Run 'agentctl plan' first.`,
        );
      }
      if (cursor.pendingManifest !== token) {
        throw new UsageError(
          `Ack token mismatch for '${role}': pending '${cursor.pendingManifest}', ` +
            `provided '${token}'. Re-run 'agentctl plan' to get the current token.`,
        );
      }
      const manifestFile = this.abs(manifestPath(role, token));
      const manifest = await readJsonFileOrNull<Manifest>(manifestFile);
      if (!manifest) {
        throw new StateCorruptionError(
          `Pending manifest for '${role}' is missing on disk: ${manifestFile}`,
        );
      }
      const previousCursor = cursor.ackedThrough;
      const advanceTo = manifest.advanceCursorTo;
      if (advanceTo && advanceTo < previousCursor) {
        throw new StateCorruptionError(
          `Manifest advanceCursorTo '${advanceTo}' is older than current cursor '${previousCursor}'.`,
        );
      }
      const updated: CursorState = {
        ...cursor,
        ackedThrough: advanceTo || previousCursor,
        pendingManifest: null,
        updatedAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.abs(rolePaths(role).cursorFile), updated);
      await safeUnlink(manifestFile);
      return {
        role,
        previousCursor,
        ackedThrough: updated.ackedThrough,
        eventsAcked: manifest.events.length,
      };
    });
  }

  // ---- config & roles -----------------------------------------------------

  async readConfig(): Promise<ProjectConfig> {
    const file = this.abs(Paths.configFile);
    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // initialise() should have created this; treat absence as a layer
        // that has never been initialised with a config schema.
        throw new StateCorruptionError(
          `${Paths.configFile} is missing. Run 'agentctl init' to create it.`,
        );
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new StateCorruptionError(
        `${Paths.configFile} is not valid YAML: ${(err as Error).message}`,
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { schemaVersion?: unknown }).schemaVersion !== "string"
    ) {
      throw new StateCorruptionError(
        `${Paths.configFile} is missing required top-level fields.`,
      );
    }
    const obj = parsed as ProjectConfig;
    if (!obj.roles || typeof obj.roles !== "object") {
      obj.roles = {};
    }
    return obj;
  }

  async writeConfig(config: ProjectConfig): Promise<void> {
    await atomicWriteFile(
      this.abs(Paths.configFile),
      yaml.dump(config, { lineWidth: 100, noRefs: true }),
    );
  }

  async createRole(input: {
    id: RoleId;
    title?: string;
    description?: string;
    owns?: string[];
    reportsTo?: RoleId[];
    mustNotEdit?: string[];
  }): Promise<RoleConfig> {
    validateRoleId(input.id);
    const title = input.title ?? `${input.id} Agent`;
    const description = input.description ?? "";
    const owns = input.owns ?? [];
    const reportsTo = (input.reportsTo ?? []).map((r) => validateRoleId(r));
    const mustNotEdit = input.mustNotEdit ?? [];

    return this.withLock("roles-create", async () => {
      const config = await this.readConfig();
      if (config.roles[input.id]) {
        throw new UsageError(
          `Role '${input.id}' already exists in config.yaml.`,
        );
      }
      const roleMdPath = this.abs(rolePaths(input.id).roleFile);
      if (await exists(roleMdPath)) {
        throw new UsageError(
          `Role markdown already exists: ${roleMdPath}.`,
        );
      }
      const roleConfig: RoleConfig = { title, description, owns, reportsTo, mustNotEdit };
      const nextConfig: ProjectConfig = {
        ...config,
        roles: { ...config.roles, [input.id]: roleConfig },
      };
      await atomicWriteFile(
        roleMdPath,
        renderRoleMarkdown({ id: input.id, ...roleConfig }),
      );
      await this.writeConfig(nextConfig);
      return roleConfig;
    });
  }

  async readRoleFile(role: RoleId): Promise<string> {
    validateRoleId(role);
    const file = this.abs(rolePaths(role).roleFile);
    try {
      return await fsp.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new UnknownRoleError(role);
      }
      throw err;
    }
  }

  // ---- wait sentinel ------------------------------------------------------

  async writeWaitSentinel(role: RoleId): Promise<{ path: string; writtenAt: string }> {
    validateRoleId(role);
    const writtenAt = new Date().toISOString();
    const target = this.abs(waitSentinelPath(role));
    await atomicWriteJson(target, { role, mode: "exit", writtenAt });
    return { path: target, writtenAt };
  }

  // ---- helpers ------------------------------------------------------------

  private abs(rel: string): string {
    return resolveInside(this.root, rel);
  }
}

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
  rfcCommentPath,
  rfcDecisionPath,
  rfcDir,
  rfcProposalPath,
  rolePaths,
  waitSentinelPath,
  worklogEntryPath,
} from "./paths";
import { validateRoleId, validateSlug } from "./role-id";
import { renderRoleMarkdown } from "./role-template";
import type { Store } from "./store";
import {
  ACTIVE_TASK_STATUSES,
  PROTOCOL_ONE_LINER,
  TASK_STATUSES,
  type CursorState,
  type Event,
  type Manifest,
  type ProjectConfig,
  type RfcComment,
  type RfcDecision,
  type RfcOption,
  type RfcProposal,
  type RfcStatus,
  type RfcSummary,
  type RoleConfig,
  type RoleId,
  type RoleReminder,
  type SessionInfo,
  type Task,
  type TaskBoard,
  type TaskStatus,
  type TaskSummary,
} from "./types";

function freshConfig(schemaVersion: string): ProjectConfig {
  return { schemaVersion, roles: {} };
}

function freshTaskBoard(schemaVersion: string): TaskBoard {
  return { schemaVersion, nextId: 0, tasks: {} };
}

function formatTaskId(n: number): string {
  return `T-${String(n).padStart(4, "0")}`;
}

function formatRfcId(n: number): string {
  return `RFC-${String(n).padStart(4, "0")}`;
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
    await atomicWriteFile(
      this.abs(Paths.taskBoardFile),
      yaml.dump(freshTaskBoard(version), { lineWidth: 100, noRefs: true }),
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
      const board = await this.readTaskBoard();
      const tasks = this.taskSummariesForRole(board, role);
      const rfcs = await this.rfcSummariesForRole(role);
      const manifest: Manifest = {
        ackToken,
        role,
        generatedAt: new Date().toISOString(),
        advanceCursorTo,
        fromCursor: cursor.ackedThrough,
        events: filtered,
        roleReminder: await this.buildRoleReminder(role),
        tasks,
        rfcs,
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

  /**
   * Build the compact RoleReminder. Empty fields are omitted from the
   * serialised JSON to keep agent prompts small. If the role is not yet
   * registered in `config.yaml` (e.g. unit-test paths that exercise the
   * Store directly without going through `agentctl role create`), we
   * synthesise a minimal reminder rather than failing — `plan` is
   * read-only and should never crash an otherwise-valid window.
   */
  private async buildRoleReminder(role: RoleId): Promise<RoleReminder> {
    let cfg: RoleConfig | undefined;
    try {
      const config = await this.readConfig();
      cfg = config.roles[role];
    } catch {
      cfg = undefined;
    }
    const reminder: RoleReminder = {
      id: role,
      title: cfg?.title ?? `${role} Agent`,
      protocol: PROTOCOL_ONE_LINER,
    };
    if (cfg) {
      if (cfg.owns.length > 0) reminder.owns = cfg.owns;
      if (cfg.mustNotEdit.length > 0) reminder.mustNotEdit = cfg.mustNotEdit;
      if (cfg.reportsTo.length > 0) reminder.reportsTo = cfg.reportsTo;
    }
    return reminder;
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

  // ---- task board ---------------------------------------------------------

  async readTaskBoard(): Promise<TaskBoard> {
    const file = this.abs(Paths.taskBoardFile);
    let raw: string;
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // initialise() should have written one; treat absence as empty.
        return freshTaskBoard("2.0.0");
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new StateCorruptionError(
        `${Paths.taskBoardFile} is not valid YAML: ${(err as Error).message}`,
      );
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { schemaVersion?: unknown }).schemaVersion !== "string"
    ) {
      throw new StateCorruptionError(
        `${Paths.taskBoardFile} is missing required top-level fields.`,
      );
    }
    const board = parsed as TaskBoard;
    if (!board.tasks || typeof board.tasks !== "object") board.tasks = {};
    if (typeof board.nextId !== "number" || !Number.isFinite(board.nextId)) board.nextId = 0;
    return board;
  }

  private async writeTaskBoardUnlocked(board: TaskBoard): Promise<void> {
    await atomicWriteFile(
      this.abs(Paths.taskBoardFile),
      yaml.dump(board, { lineWidth: 100, noRefs: true }),
    );
  }

  async createTask(input: {
    title: string;
    owner?: RoleId | null;
    priority?: string;
    dependsOn?: string[];
    acceptance?: string;
    actor: RoleId | "SYSTEM";
  }): Promise<Task> {
    const title = String(input.title ?? "").trim();
    if (title.length === 0) {
      throw new UsageError("Task title must be non-empty.");
    }
    const priority = (input.priority ?? "P2").trim();
    const owner = input.owner === undefined ? null : input.owner;
    if (owner !== null) validateRoleId(owner);
    const dependsOn = (input.dependsOn ?? []).map((d) => String(d));
    const acceptance = input.acceptance ?? "";

    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const idNumber = board.nextId + 1;
      const id = formatTaskId(idNumber);
      const now = new Date().toISOString();
      const task: Task = {
        id,
        title,
        status: "Backlog",
        owner,
        priority,
        dependsOn,
        acceptance,
        createdAt: now,
        updatedAt: now,
      };
      board.nextId = idNumber;
      board.tasks[id] = task;
      await this.writeTaskBoardUnlocked(board);
      await this.recordEventInternal({
        type: "TASK_CREATED",
        from: input.actor,
        to: "*",
        ref: id,
        payload: { taskId: id, title, owner, priority },
      });
      if (owner) {
        await this.recordEventInternal({
          type: "TASK_ASSIGNED",
          from: input.actor,
          to: owner,
          ref: id,
          payload: { taskId: id, previousOwner: null, newOwner: owner },
        });
      }
      return task;
    });
  }

  async assignTask(input: {
    taskId: string;
    newOwner: RoleId;
    actor: RoleId | "SYSTEM";
  }): Promise<Task> {
    validateRoleId(input.newOwner);
    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const task = board.tasks[input.taskId];
      if (!task) {
        throw new UsageError(`Unknown task '${input.taskId}'.`);
      }
      const previousOwner = task.owner;
      if (previousOwner === input.newOwner) return task;
      task.owner = input.newOwner;
      task.updatedAt = new Date().toISOString();
      await this.writeTaskBoardUnlocked(board);
      await this.recordEventInternal({
        type: "TASK_ASSIGNED",
        from: input.actor,
        to: input.newOwner,
        ref: input.taskId,
        payload: { taskId: input.taskId, previousOwner, newOwner: input.newOwner },
      });
      return task;
    });
  }

  async setTaskStatus(input: {
    taskId: string;
    newStatus: TaskStatus;
    actor: RoleId | "SYSTEM";
  }): Promise<Task> {
    if (!TASK_STATUSES.includes(input.newStatus)) {
      throw new UsageError(
        `Invalid status '${input.newStatus}'. Use one of: ${TASK_STATUSES.join(", ")}.`,
      );
    }
    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const task = board.tasks[input.taskId];
      if (!task) {
        throw new UsageError(`Unknown task '${input.taskId}'.`);
      }
      const previousStatus = task.status;
      if (previousStatus === input.newStatus) return task;
      task.status = input.newStatus;
      task.updatedAt = new Date().toISOString();
      await this.writeTaskBoardUnlocked(board);
      await this.recordEventInternal({
        type: "TASK_STATUS_CHANGED",
        from: input.actor,
        to: "*",
        ref: input.taskId,
        payload: {
          taskId: input.taskId,
          previousStatus,
          newStatus: input.newStatus,
        },
      });
      return task;
    });
  }

  async readTask(taskId: string): Promise<Task> {
    const board = await this.readTaskBoard();
    const t = board.tasks[taskId];
    if (!t) throw new UsageError(`Unknown task '${taskId}'.`);
    return t;
  }

  private taskSummariesForRole(board: TaskBoard, role: RoleId): TaskSummary[] {
    const matching: Task[] = [];
    for (const t of Object.values(board.tasks)) {
      if (t.owner !== role) continue;
      if (!ACTIVE_TASK_STATUSES.has(t.status)) continue;
      matching.push(t);
    }
    return matching.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      blockedBy: t.dependsOn.filter((dep) => {
        const d = board.tasks[dep];
        return !d || d.status !== "Done";
      }),
    }));
  }

  // ---- RFCs ---------------------------------------------------------------

  async createRfc(input: {
    slug: string;
    title: string;
    voters: RoleId[];
    deciders: RoleId[];
    options: RfcOption[];
    deadline?: string | null;
    createdBy: RoleId | "SYSTEM";
  }): Promise<RfcProposal> {
    validateSlug(input.slug);
    const title = String(input.title ?? "").trim();
    if (title.length === 0) throw new UsageError("RFC title must be non-empty.");
    if (!Array.isArray(input.options) || input.options.length < 1) {
      throw new UsageError("RFC must have at least one option.");
    }
    const optionIds = new Set<string>();
    for (const o of input.options) {
      if (!o.id || typeof o.id !== "string") {
        throw new UsageError("Each RFC option needs a non-empty id.");
      }
      if (optionIds.has(o.id)) {
        throw new UsageError(`Duplicate RFC option id '${o.id}'.`);
      }
      optionIds.add(o.id);
    }
    const voters = input.voters.map((r) => validateRoleId(r));
    const deciders = input.deciders.map((r) => validateRoleId(r));
    if (deciders.length === 0) {
      throw new UsageError("RFC must have at least one decider.");
    }

    return this.withLock("rfcs", async () => {
      const config = await this.readConfig();
      const idNumber = (config.rfcCounter ?? 0) + 1;
      const id = formatRfcId(idNumber);

      // Refuse if any directory already exists for this id or this slug.
      // We do not allow slug reuse across RFCs to keep `rfc show <slug>`
      // unambiguous if we add it later.
      const dirsBeforeAlloc = await this.listRfcDirNames();
      for (const d of dirsBeforeAlloc) {
        if (d.startsWith(`${id}-`)) {
          throw new StateCorruptionError(
            `RFC dir ${d} already exists for id ${id}.`,
          );
        }
        if (d.endsWith(`-${input.slug}`)) {
          throw new UsageError(`Slug '${input.slug}' is already used by ${d}.`);
        }
      }

      const proposal: RfcProposal = {
        id,
        slug: input.slug,
        title,
        status: "open",
        voters,
        deciders,
        options: input.options.map((o) => ({ id: o.id, summary: o.summary ?? "" })),
        deadline: input.deadline ?? null,
        createdAt: new Date().toISOString(),
        createdBy: input.createdBy,
      };
      const dir = this.abs(rfcDir(id, input.slug));
      await fsp.mkdir(path.join(dir, "comments"), { recursive: true });
      await atomicWriteFile(
        this.abs(rfcProposalPath(id, input.slug)),
        yaml.dump(proposal, { lineWidth: 100, noRefs: true }),
      );
      await this.writeConfig({ ...config, rfcCounter: idNumber });
      await this.recordEventInternal({
        type: "RFC_CREATED",
        from: input.createdBy,
        to: "*",
        ref: id,
        payload: { rfcId: id, title, voters, deciders },
      });
      return proposal;
    });
  }

  async commentRfc(input: {
    rfcId: string;
    role: RoleId;
    preferred: string;
    rationale: string;
  }): Promise<RfcComment> {
    validateRoleId(input.role);
    const preferred = String(input.preferred ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError("RFC comment rationale must be non-empty.");
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (proposal.status !== "open") {
        throw new UsageError(
          `RFC ${input.rfcId} is ${proposal.status}; cannot comment on a closed RFC.`,
        );
      }
      if (preferred.length > 0 && !proposal.options.find((o) => o.id === preferred)) {
        throw new UsageError(
          `RFC ${input.rfcId} has no option '${preferred}'. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
        );
      }
      const comment: RfcComment = {
        rfcId: proposal.id,
        role: input.role,
        ts: new Date().toISOString(),
        preferred,
        rationale,
      };
      await atomicWriteJson(
        this.abs(rfcCommentPath(proposal.id, proposal.slug, input.role)),
        comment,
      );
      await this.recordEventInternal({
        type: "RFC_COMMENT",
        from: input.role,
        to: "*",
        ref: proposal.id,
        payload: { rfcId: proposal.id, role: input.role, preferred, rationale },
      });
      return comment;
    });
  }

  async decideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string;
    rationale: string;
  }): Promise<RfcDecision> {
    return this.finaliseRfc({
      rfcId: input.rfcId,
      decidedBy: input.decidedBy,
      outcome: "accepted",
      chosenOption: input.chosenOption,
      rationale: input.rationale,
    });
  }

  async rejectRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    rationale: string;
  }): Promise<RfcDecision> {
    return this.finaliseRfc({
      rfcId: input.rfcId,
      decidedBy: input.decidedBy,
      outcome: "rejected",
      chosenOption: null,
      rationale: input.rationale,
    });
  }

  private async finaliseRfc(args: {
    rfcId: string;
    decidedBy: RoleId;
    outcome: "accepted" | "rejected";
    chosenOption: string | null;
    rationale: string;
  }): Promise<RfcDecision> {
    validateRoleId(args.decidedBy);
    const rationale = String(args.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError("Decision rationale must be non-empty.");
    }

    return this.withLock(`rfc-${args.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(args.rfcId);
      if (proposal.status !== "open") {
        throw new UsageError(
          `RFC ${args.rfcId} is already ${proposal.status}; cannot finalise again.`,
        );
      }
      if (!proposal.deciders.includes(args.decidedBy)) {
        throw new UsageError(
          `Role '${args.decidedBy}' is not in deciders for ${args.rfcId} (deciders: ${proposal.deciders.join(", ") || "(none)"}).`,
        );
      }
      if (args.outcome === "accepted") {
        if (!args.chosenOption) {
          throw new UsageError("`accept` requires a non-empty option id.");
        }
        if (!proposal.options.find((o) => o.id === args.chosenOption)) {
          throw new UsageError(
            `Option '${args.chosenOption}' is not in RFC ${args.rfcId}. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
          );
        }
      }
      const decision: RfcDecision = {
        rfcId: proposal.id,
        decidedBy: args.decidedBy,
        ts: new Date().toISOString(),
        outcome: args.outcome,
        chosenOption: args.outcome === "accepted" ? args.chosenOption : null,
        rationale,
      };
      await atomicWriteJson(
        this.abs(rfcDecisionPath(proposal.id, proposal.slug)),
        decision,
      );
      const updatedProposal: RfcProposal = {
        ...proposal,
        status: args.outcome === "accepted" ? "accepted" : "rejected",
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updatedProposal, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_DECIDED",
        from: args.decidedBy,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          decidedBy: args.decidedBy,
          outcome: args.outcome,
          chosenOption: decision.chosenOption,
          rationale,
        },
      });
      return decision;
    });
  }

  async readRfc(rfcId: string): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }> {
    return this.readRfcUnchecked(rfcId);
  }

  private async readRfcUnchecked(rfcId: string): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }> {
    if (!/^RFC-\d{4,}$/.test(rfcId)) {
      throw new UsageError(`Invalid RFC id '${rfcId}'. Expected RFC-NNNN.`);
    }
    const dirName = (await this.listRfcDirNames()).find((d) =>
      d.startsWith(`${rfcId}-`),
    );
    if (!dirName) {
      throw new UsageError(`Unknown RFC '${rfcId}'.`);
    }
    const slug = dirName.slice(rfcId.length + 1);
    const proposalRaw = await fsp.readFile(
      this.abs(rfcProposalPath(rfcId, slug)),
      "utf8",
    );
    let proposal: RfcProposal;
    try {
      proposal = yaml.load(proposalRaw) as RfcProposal;
    } catch (err) {
      throw new StateCorruptionError(
        `proposal.yaml for ${rfcId} is not valid YAML: ${(err as Error).message}`,
      );
    }
    const commentsDir = this.abs(path.posix.join(rfcDir(rfcId, slug), "comments"));
    const comments: RfcComment[] = [];
    try {
      const names = await fsp.readdir(commentsDir);
      for (const n of names) {
        if (!n.endsWith(".json") || n.startsWith(".")) continue;
        const c = await readJsonFileOrNull<RfcComment>(path.join(commentsDir, n));
        if (c) comments.push(c);
      }
      comments.sort((a, b) => a.ts.localeCompare(b.ts));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const decision = await readJsonFileOrNull<RfcDecision>(
      this.abs(rfcDecisionPath(rfcId, slug)),
    );
    return { proposal, comments, decision };
  }

  async listRfcs(filter?: { status?: RfcStatus }): Promise<RfcProposal[]> {
    const dirs = await this.listRfcDirNames();
    const out: RfcProposal[] = [];
    for (const d of dirs) {
      const m = d.match(/^(RFC-\d{4,})-(.+)$/);
      if (!m) continue;
      const id = m[1];
      const slug = m[2];
      const raw = await fsp.readFile(
        this.abs(rfcProposalPath(id, slug)),
        "utf8",
      );
      let proposal: RfcProposal;
      try {
        proposal = yaml.load(raw) as RfcProposal;
      } catch {
        continue; // skip malformed
      }
      if (filter?.status && proposal.status !== filter.status) continue;
      out.push(proposal);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  private async listRfcDirNames(): Promise<string[]> {
    try {
      const entries = await fsp.readdir(this.abs(Paths.rfcsDir), {
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isDirectory() && /^RFC-\d{4,}-/.test(e.name))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async rfcSummariesForRole(role: RoleId): Promise<RfcSummary[]> {
    const open = await this.listRfcs({ status: "open" });
    const out: RfcSummary[] = [];
    for (const p of open) {
      const isDecider = p.deciders.includes(role);
      const isVoter = p.voters.includes(role);
      if (!isDecider && !isVoter) continue;
      let commented = false;
      const commentFile = this.abs(rfcCommentPath(p.id, p.slug, role));
      if (await exists(commentFile)) commented = true;
      // Voters whose comment is already on file fall out of the action list.
      if (isVoter && !isDecider && commented) continue;
      out.push({
        id: p.id,
        title: p.title,
        status: p.status,
        role: isDecider ? "decider" : "voter",
        commented,
      });
    }
    return out;
  }

  // ---- helpers ------------------------------------------------------------

  private abs(rel: string): string {
    return resolveInside(this.root, rel);
  }
}

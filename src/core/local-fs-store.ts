import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  AlreadyInitializedError,
  ForbiddenError,
  NotInitializedError,
  PathValidationError,
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
import { decodeUlidTimestamp, freshId, isUlid, newId } from "./ids";
import {
  Paths,
  manifestPath,
  resolveInside,
  rfcCommentsFile,
  rfcDecisionPath,
  rfcDir,
  rfcLegacyCommentsDir,
  rfcProposalPath,
  rfcReadCursorPath,
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

/**
 * Read a file, returning the empty string if it does not exist. Used
 * by the append / replace paths of writeStateFile so writing to a
 * not-yet-existing file just becomes "write from scratch" rather than
 * an awkward ENOENT.
 */
async function readFileOrEmpty(absolutePath: string): Promise<string> {
  try {
    return await fsp.readFile(absolutePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Count literal occurrences of `needle` in `haystack`. Non-overlapping;
 * matches the behaviour of `String.prototype.split` and of a literal
 * search-and-replace. Returns 0 for empty needle (guarded upstream
 * anyway by the UsageError on empty oldText).
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Replace every literal occurrence of `oldText` with `newText`. We do
 * it via split/join to avoid the regex-escape pitfalls of
 * `String.prototype.replaceAll`-via-regex.
 */
function splitJoin(haystack: string, oldText: string, newText: string): string {
  return haystack.split(oldText).join(newText);
}

/**
 * A skeleton `state/project_state.md` so agents and users always have
 * a concrete file to read and edit, rather than the previous "file
 * does not exist yet" mode that left users guessing and agents
 * repeatedly asking the user to create it. The three sections (Vision,
 * Milestones, Acceptance criteria) are intentionally TBD; the handbook
 * tells agents to nag the user to fill them.
 *
 * Plain string (not a function of schemaVersion) — this file's shape
 * is human-edit space, not part of the machine schema.
 */
const PROJECT_STATE_SKELETON = `# Project state

> Maintained by the role whose \`config.yaml:owns\` includes
> \`state/project_state.md\` (typically the product-owner role).
> Agents consult this file whenever they need to decide whether a task
> is "Done" — see docs/HANDBOOK.md.

## Vision

TBD — one paragraph. What are we building? For whom? What is
explicitly out of scope?

## Milestones

- TBD — M1: ... due ...
- TBD — M2: ...

## Acceptance criteria

> One entry per task that has explicit acceptance criteria. Without
> entries here, agents will keep bouncing acceptance questions back to
> the user every time a task reaches Review.

- TBD — T-NNNN <title>: ...
`;

function formatTaskId(n: number): string {
  return `T-${String(n).padStart(4, "0")}`;
}

function formatRfcId(n: number): string {
  return `RFC-${String(n).padStart(4, "0")}`;
}

/**
 * Match an `owns` / `mustNotEdit` entry against a target relative path.
 *
 * - Exact equality matches a single file.
 * - An entry ending in `/` matches any path that is a strict child of
 *   that directory.
 * - Trailing slashes are normalised so `state/` and `state` both work as
 *   directory entries.
 */
function pathMatches(entry: string, target: string): boolean {
  const e = entry.replace(/\/+$/, "");
  if (e === target) return true;
  return target.startsWith(`${e}/`);
}

export interface LocalFsStoreOptions {
  /**
   * Cross-process watermark used by `openOrCreatePlan`. Events whose ULID
   * timestamp is newer than `now - safetyMarginMs` are deferred to the
   * next plan rather than being included in the current manifest.
   *
   * This is the only practical defence against the cross-process
   * ULID-monotonicity gap: `monotonicFactory()` only guarantees order
   * within one process, so two processes generating events in the same
   * millisecond can produce IDs whose lexicographic order is reversed
   * relative to actual write order. A watermark wide enough to cover a
   * write+rename round-trip eliminates the race; 200ms is generous on
   * local filesystems while imperceptible at agent timescales.
   *
   * Tests pass 0 to keep deterministic assertions about immediate
   * visibility.
   */
  safetyMarginMs?: number;
}

const DEFAULT_SAFETY_MARGIN_MS = 200;

/**
 * Filesystem-backed Store. Operates against a `.multi-agent` directory rooted
 * at `root`. All path construction is forced through `resolveInside`, so no
 * user input can reach `fs.*` without validation.
 */
export class LocalFsStore implements Store {
  readonly rootDescription: string;

  private readonly root: string;
  private readonly safetyMarginMs: number;

  constructor(rootDir: string, opts: LocalFsStoreOptions = {}) {
    this.root = path.resolve(rootDir);
    this.rootDescription = this.root;
    this.safetyMarginMs = opts.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
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
    // PR8f-B: seed a TBD skeleton for project_state.md so it always
    // exists on disk. The product-owner role is expected to fill the
    // sections; activate / handbook nudge that along.
    await atomicWriteFile(
      this.abs(Paths.projectStateFile),
      PROJECT_STATE_SKELETON,
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
          // Step 4b: deliberately do NOT advertise `--force` here. LLM
          // agents that see "pass --force to take over" will reflexively
          // do so, and a live peer in another window is silently killed.
          // The `--force` flag still works for humans who pass it
          // explicitly (see `agentctl claim --help`).
          throw new UsageError(
            `Role '${role}' is already claimed by a live session ` +
              `(heartbeat ${Math.floor(heartbeatAge / 1000)}s ago). ` +
              `If you believe the previous window is genuinely dead, ` +
              `see \`agentctl claim --help\`. Otherwise stop and ask the ` +
              `user — do NOT silently take over a peer.`,
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
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const session = await readJsonFileOrNull<SessionInfo>(
        path.join(dir, name),
      );
      if (!session || session.sessionId !== sessionId) continue;
      // Lease check: a session whose heartbeat is older than its TTL is
      // no longer "live" and must not authenticate further commands. The
      // session file may still exist on disk because no one has called
      // claim again to take it over; that does NOT make it valid.
      // M3: fail CLOSED on a corrupt heartbeatAt. Previously this
      // check was `if (isFinite && expired) return null` — meaning a
      // NaN heartbeat (empty string, malformed, missing key) caused
      // the whole expiry check to be skipped and the session to be
      // treated as perpetually live. Reject any session whose
      // heartbeat we cannot interpret.
      const heartbeatMs = Date.parse(session.heartbeatAt);
      if (!Number.isFinite(heartbeatMs)) return null;
      if (heartbeatMs + session.leaseTtlSeconds * 1000 < now) {
        return null;
      }
      return session;
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
    // PROTOCOL.md promises that reports to unknown recipients are
    // refused. Without this the typo `--to Forntend` silently emits an
    // event no one will ever read.
    const config = await this.readConfig();
    if (!config.roles[input.to]) {
      throw new UsageError(
        `Unknown recipient role '${input.to}'. ` +
          `Known roles: ${Object.keys(config.roles).sort().join(", ") || "(none)"}.`,
      );
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
      // Watermark: only events whose ULID timestamp is older than the
      // safety margin go into the manifest. Anything newer is deferred
      // to the next plan so cross-process same-ms ULIDs cannot produce
      // a cursor advance past an event that has not been seen.
      const watermarkMs = Date.now() - this.safetyMarginMs;
      const safeEvents =
        this.safetyMarginMs > 0
          ? events.filter((e) => decodeUlidTimestamp(e.id) <= watermarkMs)
          : events;
      const filtered = safeEvents.filter(
        (e) => e.from !== role && (e.to === role || e.to === "*"),
      );
      const advanceCursorTo =
        safeEvents.length > 0
          ? safeEvents[safeEvents.length - 1].id
          : cursor.ackedThrough;
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

  async updateConfig(
    mutator: (current: ProjectConfig) => ProjectConfig,
  ): Promise<ProjectConfig> {
    return this.withLock("config-yaml", async () => {
      const current = await this.readConfig();
      const next = mutator(current);
      if (!next || typeof next !== "object") {
        throw new StateCorruptionError(
          "updateConfig mutator returned a non-config value.",
        );
      }
      if (typeof next.schemaVersion !== "string") {
        throw new StateCorruptionError(
          "updateConfig mutator dropped schemaVersion.",
        );
      }
      if (!next.roles || typeof next.roles !== "object") {
        throw new StateCorruptionError(
          "updateConfig mutator dropped or corrupted roles map.",
        );
      }
      await this.writeConfig(next);
      return next;
    });
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
      const roleMdPath = this.abs(rolePaths(input.id).roleFile);
      const newRoleConfig: RoleConfig = { title, description, owns, reportsTo, mustNotEdit };

      // Step 1: register in config.yaml under the config-yaml lock. The
      // mutator handles all three pre-existing shapes: fresh create,
      // recovery (already in config, md missing), and duplicate
      // (already in config AND md exists). The thrown errors propagate
      // out of the lock cleanly.
      let committedConfig: RoleConfig | null = null;
      let recoveryNoOp = false;
      // The mutator runs under config-yaml lock. We CANNOT do file I/O
      // inside it (it must be a pure function of the current config),
      // so the duplicate / recovery split is decided post-lock by
      // re-checking the markdown file. The mutator just decides whether
      // to add a new entry or no-op.
      await this.updateConfig((cur) => {
        if (cur.roles[input.id]) {
          committedConfig = cur.roles[input.id];
          recoveryNoOp = true;
          return cur;
        }
        return {
          ...cur,
          roles: { ...cur.roles, [input.id]: newRoleConfig },
        };
      });
      const mdExists = await exists(roleMdPath);

      if (recoveryNoOp) {
        // Two sub-cases now:
        //   (a) duplicate     — both config + md present
        //   (b) recovery      — config present, md missing
        if (mdExists) {
          throw new UsageError(`Role '${input.id}' already exists in config.yaml.`);
        }
        // (b) Complete the missing markdown using the EXISTING config
        // entry so any hand edits (owns, reportsTo) are preserved.
        const existing = committedConfig as unknown as RoleConfig;
        await atomicWriteFile(
          roleMdPath,
          renderRoleMarkdown({ id: input.id, ...existing }),
        );
        return existing;
      }

      // Fresh create path. Config write committed; if the markdown
      // write fails, the next retry observes "config has, md missing"
      // and takes the recovery branch above — never the "md present,
      // config missing" wedge the prior write-order produced.
      if (mdExists) {
        // Legacy / hand-edit shape that pre-existed our config write
        // (e.g. someone manually put a markdown file with no config
        // entry, and now we just wrote a config entry). Refuse to
        // clobber the hand-edited file; revert the config write to
        // keep the invariant.
        await this.updateConfig((cur) => {
          const { [input.id]: _removed, ...rest } = cur.roles;
          return { ...cur, roles: rest };
        });
        throw new UsageError(
          `Role markdown ${roleMdPath} pre-existed but '${input.id}' was not in config.yaml. ` +
            `Move that file aside before re-running create.`,
        );
      }
      await atomicWriteFile(
        roleMdPath,
        renderRoleMarkdown({ id: input.id, ...newRoleConfig }),
      );
      return newRoleConfig;
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

  async deleteRole(input: {
    id: RoleId;
    actor: RoleId | "SYSTEM";
  }): Promise<{ role: RoleId; removedSessions: number }> {
    validateRoleId(input.id);
    // Role deletion is a project-governance act, not a per-role
    // operation. Restrict to SYSTEM (no MA_SESSION) so an agent that
    // somehow acquired a session for any role cannot wipe another
    // role out from under it. The user runs this from their shell.
    if (input.actor !== "SYSTEM") {
      throw new ForbiddenError(
        `Role deletion is restricted to project owners (SYSTEM). ` +
          `Run \`agentctl role delete ${input.id}\` from a shell without MA_SESSION set.`,
      );
    }
    return this.withLock("roles-create", async () => {
      // Step 1: remove from config.yaml under the shared config lock.
      // The mutator must refuse to no-op silently — caller passed a
      // role id and expects it to have existed.
      let existed = false;
      await this.updateConfig((cur) => {
        if (!cur.roles[input.id]) return cur;
        existed = true;
        const { [input.id]: _removed, ...rest } = cur.roles;
        return { ...cur, roles: rest };
      });
      if (!existed) {
        throw new UsageError(
          `Role '${input.id}' is not registered. Nothing to delete.`,
        );
      }
      // Step 2: best-effort delete the markdown contract. If it was
      // hand-removed already we still consider the operation a success
      // (config-level deletion is the source of truth).
      const mdPath = this.abs(rolePaths(input.id).roleFile);
      try {
        await fsp.unlink(mdPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Step 3: invalidate any live session. Without this, an agent
      // window with the old MA_SESSION still exported would happily
      // authenticate via findSessionById until the lease ran out —
      // and could still call `agentctl plan` against a role that no
      // longer exists in config.
      let removedSessions = 0;
      const sessionFile = this.abs(rolePaths(input.id).sessionFile);
      try {
        await fsp.unlink(sessionFile);
        removedSessions = 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // Step 4: audit. Broadcast so any agent reading its next plan
      // (including reassigned task owners after recreate) sees the
      // event in events.log.
      await this.recordEventInternal({
        type: "ROLE_DELETED",
        from: "SYSTEM",
        to: "*",
        ref: input.id,
        payload: { roleId: input.id, removedSessions },
      });
      return { role: input.id, removedSessions };
    });
  }

  // ---- wait sentinel ------------------------------------------------------

  async writeWaitSentinel(role: RoleId): Promise<{ path: string; writtenAt: string }> {
    validateRoleId(role);
    const writtenAt = new Date().toISOString();
    const target = this.abs(waitSentinelPath(role));
    await atomicWriteJson(target, { role, mode: "exit", writtenAt });
    return { path: target, writtenAt };
  }

  // ---- ownership ----------------------------------------------------------

  /**
   * Verify the `actor` has permission to write to `relPath`. `"SYSTEM"`
   * bypasses the check by design (humans running the CLI manually).
   *
   * Rules:
   *   - relPath must be a valid path inside the layer (no .. escapes).
   *   - if relPath is in `mustNotEdit` for the actor, refuse (defence in
   *     depth even if owns also contained it).
   *   - else relPath must appear in `config.yaml:roles[actor].owns`. An
   *     entry matches when it equals relPath OR is a directory prefix
   *     of relPath (entries ending with `/` are explicit directories).
   */
  private async requireOwnership(
    actor: RoleId | "SYSTEM",
    relPath: string,
  ): Promise<void> {
    if (actor === "SYSTEM") return;
    validateRoleId(actor);
    // Force a path-traversal check on relPath even though it's a
    // framework-internal constant in most call sites — defence in depth.
    this.abs(relPath);
    // Reject any input that does not match its own POSIX normalisation.
    // Without this, `state//architecture.md` slips past pathMatches
    // (string compare against `state/architecture.md` fails) yet
    // resolves to the protected path on disk via path.resolve — a
    // mustNotEdit bypass. `state/./foo` and trailing-slash variants
    // hit the same hole.
    //
    // path.posix.normalize keeps a trailing slash (POSIX directory
    // semantics), so we add an explicit rule: a write target must not
    // end in '/'. Files are not directories; ambiguous input is
    // rejected outright rather than silently coerced.
    if (relPath.endsWith("/")) {
      throw new PathValidationError(
        `Path '${relPath}' must not end with '/' for a file write target.`,
      );
    }
    const normalized = path.posix.normalize(relPath);
    if (normalized !== relPath) {
      throw new PathValidationError(
        `Path '${relPath}' is not in canonical form (would normalise to '${normalized}'). ` +
          `Pass the canonical path so ownership checks cannot be bypassed.`,
      );
    }

    const config = await this.readConfig();
    const cfg = config.roles[actor];
    if (!cfg) {
      throw new ForbiddenError(
        `Role '${actor}' is not registered in config.yaml; ` +
          `cannot write '${relPath}'.`,
      );
    }
    if (cfg.mustNotEdit.some((p) => pathMatches(p, relPath))) {
      throw new ForbiddenError(
        `Role '${actor}' is forbidden by mustNotEdit from writing '${relPath}'.`,
      );
    }
    if (!cfg.owns.some((p) => pathMatches(p, relPath))) {
      throw new ForbiddenError(
        `Role '${actor}' does not own '${relPath}'. ` +
          `Add it to config.yaml:roles.${actor}.owns, or get an authorised role to do this write.`,
      );
    }
  }

  async writeStateFile(
    input:
      | { actor: RoleId | "SYSTEM"; relPath: string; content: string; mode?: "overwrite" }
      | { actor: RoleId | "SYSTEM"; relPath: string; mode: "append"; appendText: string }
      | {
          actor: RoleId | "SYSTEM";
          relPath: string;
          mode: "replace";
          oldText: string;
          newText: string;
          batch?: boolean;
        },
  ): Promise<{
    relPath: string;
    absolutePath: string;
    bytesWritten: number;
    replacedOccurrences?: number;
  }> {
    if (typeof input.relPath !== "string" || input.relPath.length === 0) {
      throw new UsageError("--file must be a non-empty relative path.");
    }
    // writeStateFile can only target paths under the `state/` subtree,
    // by convention. Other writes have dedicated commands.
    if (!input.relPath.startsWith(`${Paths.stateDir}/`)) {
      throw new UsageError(
        `state edit can only write under ${Paths.stateDir}/. Got '${input.relPath}'.`,
      );
    }
    await this.requireOwnership(input.actor, input.relPath);
    const absolutePath = this.abs(input.relPath);
    const mode = input.mode ?? "overwrite";

    if (mode === "overwrite") {
      const content = (input as { content: string }).content;
      await atomicWriteFile(absolutePath, content);
      return {
        relPath: input.relPath,
        absolutePath,
        bytesWritten: Buffer.byteLength(content, "utf8"),
      };
    }

    if (mode === "append") {
      const appendText = (input as { appendText: string }).appendText;
      const existing = await readFileOrEmpty(absolutePath);
      const next = existing + appendText;
      await atomicWriteFile(absolutePath, next);
      return {
        relPath: input.relPath,
        absolutePath,
        bytesWritten: Buffer.byteLength(appendText, "utf8"),
      };
    }

    // mode === "replace"
    const { oldText, newText, batch } = input as {
      oldText: string;
      newText: string;
      batch?: boolean;
    };
    if (typeof oldText !== "string" || oldText.length === 0) {
      throw new UsageError("--replace requires a non-empty old text.");
    }
    if (typeof newText !== "string") {
      throw new UsageError("--with must be a string (may be empty).");
    }
    const existing = await readFileOrEmpty(absolutePath);
    const count = countOccurrences(existing, oldText);
    if (count === 0) {
      throw new UsageError(
        `Old text not found in ${input.relPath}. ` +
          `Read the current file and pass an exact-match snippet.`,
      );
    }
    if (count > 1 && !batch) {
      throw new UsageError(
        `Old text appears ${count} times in ${input.relPath}; ` +
          `pass --batch to replace all occurrences, or expand the snippet ` +
          `so it appears exactly once.`,
      );
    }
    // count === 1 OR (count > 1 && batch). Replace all matches; for
    // count === 1 this is equivalent to a single replacement.
    const next = splitJoin(existing, oldText, newText);
    await atomicWriteFile(absolutePath, next);
    return {
      relPath: input.relPath,
      absolutePath,
      bytesWritten: Buffer.byteLength(next, "utf8") - Buffer.byteLength(existing, "utf8"),
      replacedOccurrences: count,
    };
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
    if (owner !== null) {
      validateRoleId(owner);
      // Step 12: owner must be a registered role. Otherwise the
      // TASK_ASSIGNED event we emit goes to a nobody and the typo
      // (e.g. `--owner Forntend`) is silently accepted.
      const config = await this.readConfig();
      if (!config.roles[owner]) {
        throw new UsageError(
          `Owner role '${owner}' is not registered. Run \`agentctl role list\` ` +
            `to see registered roles or \`agentctl role create ${owner} ...\` ` +
            `to add it first.`,
        );
      }
    }
    const dependsOn = (input.dependsOn ?? []).map((d) => String(d));
    const acceptance = input.acceptance ?? "";

    await this.requireOwnership(input.actor, Paths.taskBoardFile);

    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const idNumber = board.nextId + 1;
      const id = formatTaskId(idNumber);
      const now = new Date().toISOString();
      // When an owner is given at creation time, "assigning" implies
      // "go work on this" — default to Ready so the owner's next plan
      // surfaces the task (Backlog is filtered out of manifest.tasks
      // by design). Without an owner, the task is a product/PM backlog
      // item that needs triage before anyone should pick it up.
      const initialStatus: TaskStatus = owner !== null ? "Ready" : "Backlog";
      const task: Task = {
        id,
        title,
        status: initialStatus,
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
    // Step 12: owner must be registered. Same reasoning as createTask.
    const config = await this.readConfig();
    if (!config.roles[input.newOwner]) {
      throw new UsageError(
        `Owner role '${input.newOwner}' is not registered. Run ` +
          `\`agentctl role list\` to see registered roles or ` +
          `\`agentctl role create ${input.newOwner} ...\` to add it first.`,
      );
    }
    await this.requireOwnership(input.actor, Paths.taskBoardFile);
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
      // Either the actor owns the task board, or the actor IS this task's
      // owner. The owner-exception lets agents update their own status
      // without requiring blanket task_board write access.
      const isTaskOwner = input.actor !== "SYSTEM" && task.owner === input.actor;
      if (!isTaskOwner) {
        await this.requireOwnership(input.actor, Paths.taskBoardFile);
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
    description?: string;
    relatedTasks?: string[];
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
    const description = String(input.description ?? "").trim();
    const relatedTasks = (input.relatedTasks ?? []).map((t) => String(t).trim()).filter((t) => t.length > 0);
    // Validate every related task id against the live task board so we
    // never store a pointer to a non-existent task (catches typos at
    // creation time).
    if (relatedTasks.length > 0) {
      const board = await this.readTaskBoard();
      for (const tid of relatedTasks) {
        if (!board.tasks[tid]) {
          throw new UsageError(
            `Related task '${tid}' is not on the board. Existing task ids: ${
              Object.keys(board.tasks).sort().join(", ") || "(none)"
            }.`,
          );
        }
      }
    }

    return this.withLock("rfcs", async () => {
      // Refuse if the slug is already used. (Slug uniqueness is checked
      // pre-allocation so we don't burn an id on a doomed create.)
      const dirsBefore = await this.listRfcDirNames();
      for (const d of dirsBefore) {
        if (d.endsWith(`-${input.slug}`)) {
          throw new UsageError(`Slug '${input.slug}' is already used by ${d}.`);
        }
      }

      // Atomically allocate the next id under config-yaml lock. This is
      // the only place `rfcCounter` is mutated, but it shares the file
      // with `createRole` — without coordinated lock, a concurrent
      // role-create would read the same config, write its own version,
      // and clobber our +1.
      let idNumber = 0;
      await this.updateConfig((cur) => {
        idNumber = (cur.rfcCounter ?? 0) + 1;
        return { ...cur, rfcCounter: idNumber };
      });
      const id = formatRfcId(idNumber);

      // Race protection: after id allocation, double-check no directory
      // for this id already exists on disk (could only happen if a
      // previous create crashed after allocating but before writing).
      const dirsAfter = await this.listRfcDirNames();
      for (const d of dirsAfter) {
        if (d.startsWith(`${id}-`)) {
          throw new StateCorruptionError(
            `RFC dir ${d} already exists for freshly-allocated id ${id}. ` +
              `A prior create likely crashed between id allocation and dir write.`,
          );
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
        description,
        relatedTasks,
      };
      const dir = this.abs(rfcDir(id, input.slug));
      await fsp.mkdir(dir, { recursive: true });
      // PR8g: comments live in a single threaded ledger now, not per-role
      // JSONs. Seed an empty ledger so readers don't have to special-case
      // a missing file.
      await atomicWriteFile(
        this.abs(rfcCommentsFile(id, input.slug)),
        yaml.dump([], { lineWidth: 100, noRefs: true }),
      );
      await atomicWriteFile(
        this.abs(rfcProposalPath(id, input.slug)),
        yaml.dump(proposal, { lineWidth: 100, noRefs: true }),
      );
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
    replyTo?: string | null;
  }): Promise<RfcComment> {
    validateRoleId(input.role);
    const preferred = String(input.preferred ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError("RFC comment rationale must be non-empty.");
    }
    const replyTo =
      input.replyTo === undefined || input.replyTo === null
        ? null
        : String(input.replyTo).trim();

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal, comments } = await this.readRfcUnchecked(input.rfcId);
      // PR8g: comments are allowed in `open` AND `pre-decide`. In
      // `pre-decide`, a comment from anyone other than the
      // pre-decider auto-reopens the RFC (see end of this method).
      if (proposal.status !== "open" && proposal.status !== "pre-decide") {
        throw new UsageError(
          `RFC ${input.rfcId} is ${proposal.status}; cannot comment on a closed RFC.`,
        );
      }
      if (preferred.length > 0 && !proposal.options.find((o) => o.id === preferred)) {
        throw new UsageError(
          `RFC ${input.rfcId} has no option '${preferred}'. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
        );
      }
      if (replyTo !== null) {
        if (!comments.find((c) => c.id === replyTo)) {
          throw new UsageError(
            `replyTo target '${replyTo}' is not a comment on ${input.rfcId}.`,
          );
        }
      }
      const comment: RfcComment = {
        id: newId(),
        rfcId: proposal.id,
        role: input.role,
        ts: new Date().toISOString(),
        preferred,
        replyTo,
        rationale,
      };
      const nextLedger = [...comments, comment];
      await atomicWriteFile(
        this.abs(rfcCommentsFile(proposal.id, proposal.slug)),
        yaml.dump(nextLedger, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_COMMENT",
        from: input.role,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          role: input.role,
          preferred,
          rationale,
          commentId: comment.id,
          replyTo,
        },
      });
      // PR8g: the commenter has by definition seen everything up to
      // and including their own comment. Advance their read cursor so
      // they don't appear in their own manifest as having "unread
      // discussion" right after they spoke.
      const cursorTarget = this.abs(rfcReadCursorPath(input.role, proposal.id));
      await fsp.mkdir(path.dirname(cursorTarget), { recursive: true });
      await atomicWriteJson(cursorTarget, { lastSeenCommentId: comment.id });
      // PR8g auto-reopen rule: any comment during pre-decide from a
      // role OTHER than the pre-decider flips status back to open.
      // The pre-decider themselves can keep adding reasoning to their
      // own pending round without aborting it. Silent acknowledgement
      // is the "consent" path.
      if (
        proposal.status === "pre-decide" &&
        proposal.preDecision !== undefined &&
        input.role !== proposal.preDecision.decidedBy
      ) {
        const reopened: RfcProposal = {
          ...proposal,
          status: "open",
          preDecision: undefined,
        };
        await atomicWriteFile(
          this.abs(rfcProposalPath(proposal.id, proposal.slug)),
          yaml.dump(reopened, { lineWidth: 100, noRefs: true }),
        );
        await this.recordEventInternal({
          type: "RFC_PRE_DECISION_OBJECTED",
          from: input.role,
          to: "*",
          ref: proposal.id,
          payload: {
            rfcId: proposal.id,
            triggeringCommentId: comment.id,
            by: input.role,
          },
        });
      }
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
      // PR8g: decide/reject are valid from open OR pre-decide.
      // reject is additionally valid from revising (you can give up on
      // the topic entirely instead of waiting for a rewrite). decide
      // from revising is refused — the proposal text is in flux.
      const okStarts: RfcStatus[] =
        args.outcome === "accepted"
          ? ["open", "pre-decide"]
          : ["open", "pre-decide", "revising"];
      if (!okStarts.includes(proposal.status)) {
        throw new UsageError(
          `RFC ${args.rfcId} is ${proposal.status}; cannot ${args.outcome === "accepted" ? "decide" : "reject"} from this state.`,
        );
      }
      if (!proposal.deciders.includes(args.decidedBy)) {
        // M2: This is a permission denial (caller lacks authority to
        // sign off this RFC), not a usage mistake. ForbiddenError exits
        // with code 9 which the handbook teaches agents to escalate
        // rather than retry.
        throw new ForbiddenError(
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
        // Clear pending pre-decision (if any) since terminal status
        // overrides it.
        preDecision: undefined,
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

  // ---- PR8g: RFC v2 state transitions ------------------------------------

  async addRfcOption(input: {
    rfcId: string;
    actor: RoleId;
    optionId: string;
    summary: string;
    rationale: string;
  }): Promise<RfcOption> {
    validateRoleId(input.actor);
    const optionId = String(input.optionId ?? "").trim();
    if (optionId.length === 0) {
      throw new UsageError("Option id must be non-empty.");
    }
    const summary = String(input.summary ?? "").trim();
    if (summary.length === 0) {
      throw new UsageError("Option summary must be non-empty.");
    }
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError(
        "add-option rationale must be non-empty (tells voters why this option is being introduced now).",
      );
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      // PR8g: options may only be added while the proposal is mutable.
      // Adding mid pre-decide would invalidate the round (silently
      // changing what voters were asked to ACK); the path is "comment to
      // reopen, then add". Adding after terminal is meaningless.
      if (proposal.status !== "open" && proposal.status !== "revising") {
        throw new UsageError(
          `Cannot add an option to ${input.rfcId} in state ${proposal.status}. ` +
            `Options may be added only in 'open' or 'revising'.`,
        );
      }
      if (proposal.options.find((o) => o.id === optionId)) {
        throw new UsageError(
          `Option id '${optionId}' already exists in ${input.rfcId}.`,
        );
      }
      const newOption: RfcOption = { id: optionId, summary };
      const updatedProposal: RfcProposal = {
        ...proposal,
        options: [...proposal.options, newOption],
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updatedProposal, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_OPTION_ADDED",
        from: input.actor,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          optionId,
          summary,
          addedBy: input.actor,
          rationale,
        },
      });
      return newOption;
    });
  }

  async preDecideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string;
    rationale: string;
  }): Promise<RfcProposal> {
    validateRoleId(input.decidedBy);
    const chosenOption = String(input.chosenOption ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    if (chosenOption.length === 0) {
      throw new UsageError("pre-decide requires a non-empty --option.");
    }
    if (rationale.length === 0) {
      throw new UsageError("pre-decide rationale must be non-empty.");
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (proposal.status !== "open") {
        throw new UsageError(
          `Cannot pre-decide ${input.rfcId} in state ${proposal.status}; ` +
            `pre-decide is only valid from 'open'.`,
        );
      }
      if (!proposal.deciders.includes(input.decidedBy)) {
        throw new ForbiddenError(
          `Role '${input.decidedBy}' is not in deciders for ${input.rfcId} (deciders: ${proposal.deciders.join(", ") || "(none)"}).`,
        );
      }
      if (!proposal.options.find((o) => o.id === chosenOption)) {
        throw new UsageError(
          `Option '${chosenOption}' is not in RFC ${input.rfcId}. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
        );
      }
      const now = new Date().toISOString();
      const updated: RfcProposal = {
        ...proposal,
        status: "pre-decide",
        preDecision: {
          decidedBy: input.decidedBy,
          chosenOption,
          ts: now,
          rationale,
        },
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updated, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_PRE_DECISION",
        from: input.decidedBy,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          decidedBy: input.decidedBy,
          chosenOption,
          rationale,
        },
      });
      return updated;
    });
  }

  async reviseRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    rationale: string;
  }): Promise<RfcProposal> {
    validateRoleId(input.decidedBy);
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError(
        "revise rationale must be non-empty (tells the creator what to fix).",
      );
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (proposal.status !== "open" && proposal.status !== "pre-decide") {
        throw new UsageError(
          `Cannot revise ${input.rfcId} in state ${proposal.status}; ` +
            `revise is only valid from 'open' or 'pre-decide'.`,
        );
      }
      if (!proposal.deciders.includes(input.decidedBy)) {
        throw new ForbiddenError(
          `Role '${input.decidedBy}' is not in deciders for ${input.rfcId} (deciders: ${proposal.deciders.join(", ") || "(none)"}).`,
        );
      }
      const updated: RfcProposal = {
        ...proposal,
        status: "revising",
        preDecision: undefined,
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updated, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_REVISION_REQUESTED",
        from: input.decidedBy,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          requestedBy: input.decidedBy,
          rationale,
        },
      });
      return updated;
    });
  }

  async editRfc(input: {
    rfcId: string;
    actor: RoleId;
    rationale: string;
    title?: string;
    description?: string;
    options?: RfcOption[];
    deadline?: string | null;
  }): Promise<RfcProposal> {
    validateRoleId(input.actor);
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError(
        "edit rationale must be non-empty (summarise what changed).",
      );
    }
    const hasAny =
      input.title !== undefined ||
      input.description !== undefined ||
      input.options !== undefined ||
      input.deadline !== undefined;
    if (!hasAny) {
      throw new UsageError(
        "edit needs at least one of --title / --description / --options / --deadline.",
      );
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (proposal.status !== "revising") {
        throw new UsageError(
          `Cannot edit ${input.rfcId} in state ${proposal.status}; ` +
            `edit is only valid from 'revising' (use 'rfc revise' first).`,
        );
      }
      // Creator OR decider can rewrite. Voters provide opinions, not
      // rewrite specs.
      const isCreator = proposal.createdBy === input.actor;
      const isDecider = proposal.deciders.includes(input.actor);
      if (!isCreator && !isDecider) {
        throw new ForbiddenError(
          `Role '${input.actor}' may not edit ${input.rfcId}. Allowed: createdBy '${proposal.createdBy}' or deciders ${proposal.deciders.join(", ") || "(none)"}.`,
        );
      }

      const changed: Array<"title" | "description" | "options" | "deadline"> = [];
      const next: RfcProposal = { ...proposal };

      if (input.title !== undefined) {
        const t = String(input.title).trim();
        if (t.length === 0) {
          throw new UsageError("edit --title must be non-empty.");
        }
        next.title = t;
        changed.push("title");
      }
      if (input.description !== undefined) {
        next.description = String(input.description).trim();
        changed.push("description");
      }
      if (input.options !== undefined) {
        if (!Array.isArray(input.options) || input.options.length < 1) {
          throw new UsageError("edit --options must have at least one option.");
        }
        const ids = new Set<string>();
        for (const o of input.options) {
          if (!o.id || typeof o.id !== "string") {
            throw new UsageError("Each edited option needs a non-empty id.");
          }
          if (ids.has(o.id)) {
            throw new UsageError(`Duplicate option id '${o.id}' in edit.`);
          }
          ids.add(o.id);
        }
        next.options = input.options.map((o) => ({
          id: o.id,
          summary: o.summary ?? "",
        }));
        changed.push("options");
      }
      if (input.deadline !== undefined) {
        next.deadline = input.deadline;
        changed.push("deadline");
      }

      // Status flips back to open; comments preserved untouched.
      next.status = "open";
      next.preDecision = undefined;

      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(next, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_REVISED",
        from: input.actor,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          revisedBy: input.actor,
          rationale,
          changed,
        },
      });
      return next;
    });
  }

  async linkTaskToRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal> {
    validateRoleId(input.actor);
    const taskId = String(input.taskId ?? "").trim();
    if (taskId.length === 0) {
      throw new UsageError("link-task requires a non-empty --task.");
    }
    // Validate the task exists; better to fail at link time than at
    // read time. PR8g.
    const board = await this.readTaskBoard();
    if (!board.tasks[taskId]) {
      throw new UsageError(
        `Task '${taskId}' is not on the board. Existing ids: ${
          Object.keys(board.tasks).sort().join(", ") || "(none)"
        }.`,
      );
    }
    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (
        proposal.status === "accepted" ||
        proposal.status === "rejected" ||
        proposal.status === "superseded"
      ) {
        throw new UsageError(
          `Cannot edit task links on ${input.rfcId} in terminal state ${proposal.status}.`,
        );
      }
      // Idempotent: linking an already-linked task returns unchanged.
      if (proposal.relatedTasks.includes(taskId)) return proposal;
      const updated: RfcProposal = {
        ...proposal,
        relatedTasks: [...proposal.relatedTasks, taskId],
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updated, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_TASK_LINKED",
        from: input.actor,
        to: "*",
        ref: proposal.id,
        payload: { rfcId: proposal.id, taskId, by: input.actor },
      });
      return updated;
    });
  }

  async unlinkTaskFromRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal> {
    validateRoleId(input.actor);
    const taskId = String(input.taskId ?? "").trim();
    if (taskId.length === 0) {
      throw new UsageError("unlink-task requires a non-empty --task.");
    }
    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId);
      if (
        proposal.status === "accepted" ||
        proposal.status === "rejected" ||
        proposal.status === "superseded"
      ) {
        throw new UsageError(
          `Cannot edit task links on ${input.rfcId} in terminal state ${proposal.status}.`,
        );
      }
      if (!proposal.relatedTasks.includes(taskId)) return proposal;
      const updated: RfcProposal = {
        ...proposal,
        relatedTasks: proposal.relatedTasks.filter((t) => t !== taskId),
      };
      await atomicWriteFile(
        this.abs(rfcProposalPath(proposal.id, proposal.slug)),
        yaml.dump(updated, { lineWidth: 100, noRefs: true }),
      );
      await this.recordEventInternal({
        type: "RFC_TASK_UNLINKED",
        from: input.actor,
        to: "*",
        ref: proposal.id,
        payload: { rfcId: proposal.id, taskId, by: input.actor },
      });
      return updated;
    });
  }

  async markRfcSeen(input: {
    role: RoleId;
    rfcId: string;
  }): Promise<{ lastSeenCommentId: string | null }> {
    validateRoleId(input.role);
    if (!/^RFC-\d{4,}$/.test(input.rfcId)) {
      throw new UsageError(`Invalid RFC id '${input.rfcId}'.`);
    }
    // Pure metadata write per role; no rfc-<id> lock needed (the
    // cursor file is per-role, no contention with other roles).
    const { comments } = await this.readRfcUnchecked(input.rfcId);
    const lastSeenCommentId =
      comments.length > 0 ? comments[comments.length - 1].id : null;
    const target = this.abs(rfcReadCursorPath(input.role, input.rfcId));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await atomicWriteJson(target, { lastSeenCommentId });
    return { lastSeenCommentId };
  }

  private async readRfcSeenCursor(
    role: RoleId,
    rfcId: string,
  ): Promise<string | null> {
    const target = this.abs(rfcReadCursorPath(role, rfcId));
    const parsed = await readJsonFileOrNull<{ lastSeenCommentId: string | null }>(target);
    return parsed?.lastSeenCommentId ?? null;
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
    const snapshot = await this.readRfcFiles(rfcId, slug);

    // Crash-recovery: `finaliseRfc` writes decision.json BEFORE updating
    // proposal.yaml's status. If the process died between those two
    // writes, an external observer would now see a `decision.json` but a
    // still-`open` proposal — and the next `decideRfc` call would happily
    // pass the `status === "open"` guard and overwrite the prior
    // decision, silently corrupting the audit record.
    //
    // Self-heal: when we observe that inconsistent shape, take the
    // RFC's lock and repair under it. This guarantees that N concurrent
    // readers all observe the inconsistency but only ONE writes the
    // proposal.yaml fix and only ONE emits RFC_REPAIRED — re-verifying
    // inside the lock means the second reader sees the already-repaired
    // shape and just returns it.
    if (snapshot.decision !== null && snapshot.proposal.status === "open") {
      return this.withLock(`rfc-${rfcId}`, async () => {
        const fresh = await this.readRfcFiles(rfcId, slug);
        if (fresh.decision === null || fresh.proposal.status !== "open") {
          // Another reader/writer beat us to the repair under the lock.
          return fresh;
        }
        const repaired: RfcProposal = {
          ...fresh.proposal,
          status: fresh.decision.outcome === "accepted" ? "accepted" : "rejected",
        };
        await atomicWriteFile(
          this.abs(rfcProposalPath(rfcId, slug)),
          yaml.dump(repaired, { lineWidth: 100, noRefs: true }),
        );
        await this.recordEventInternal({
          type: "RFC_REPAIRED",
          from: "SYSTEM",
          to: "*",
          ref: rfcId,
          payload: {
            rfcId,
            repairedStatus: repaired.status,
            decidedBy: fresh.decision.decidedBy,
          },
        });
        return {
          proposal: repaired,
          comments: fresh.comments,
          decision: fresh.decision,
        };
      });
    }
    return snapshot;
  }

  /**
   * Pure read of the on-disk state for an RFC. No mutations, no events.
   * Pulled out of readRfcUnchecked so the self-heal path can re-verify
   * the shape under the rfc-${id} lock without recursing.
   */
  private async readRfcFiles(
    rfcId: string,
    slug: string,
  ): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }> {
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
    // PR8g back-compat: detect the old per-role comments directory and
    // refuse to proceed silently. Alpha-stage hard cut; the user must
    // migrate by hand or `agentctl init` a fresh project. We deliberately
    // do NOT auto-migrate: comment timestamps + threading would need to
    // be synthesised and that risks silently destroying audit detail.
    const legacyDir = this.abs(rfcLegacyCommentsDir(rfcId, slug));
    if (await exists(legacyDir)) {
      // Only error if the legacy dir contains role JSONs; an empty
      // `comments/` directory left over from `mkdir -p` is harmless.
      try {
        const legacyNames = await fsp.readdir(legacyDir);
        const legacyJsons = legacyNames.filter(
          (n) => n.endsWith(".json") && !n.startsWith("."),
        );
        if (legacyJsons.length > 0) {
          throw new UsageError(
            `RFC ${rfcId} has a pre-PR8g comments layout at ` +
              `${rfcLegacyCommentsDir(rfcId, slug)}/ (per-role JSON files). ` +
              `PR8g uses a single threaded ledger at ${rfcCommentsFile(rfcId, slug)}. ` +
              `Migrate by hand (no auto-migrator) or open a fresh project with ` +
              `\`agentctl init\`. See CHANGELOG 2.0.0-alpha.15 for the new shape.`,
          );
        }
      } catch (err) {
        // Re-throw the UsageError we just raised; swallow other errors
        // (e.g. directory disappeared between exists and readdir).
        if (err instanceof UsageError) throw err;
      }
    }
    // PR8g comments ledger.
    let comments: RfcComment[] = [];
    const commentsFile = this.abs(rfcCommentsFile(rfcId, slug));
    if (await exists(commentsFile)) {
      const ledgerRaw = await fsp.readFile(commentsFile, "utf8");
      try {
        const parsed = yaml.load(ledgerRaw);
        if (parsed === null || parsed === undefined) {
          comments = [];
        } else if (!Array.isArray(parsed)) {
          throw new StateCorruptionError(
            `comments.yaml for ${rfcId} is not a YAML list.`,
          );
        } else {
          comments = parsed as RfcComment[];
        }
      } catch (err) {
        if (err instanceof StateCorruptionError) throw err;
        throw new StateCorruptionError(
          `comments.yaml for ${rfcId} is not valid YAML: ${(err as Error).message}`,
        );
      }
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
    // PR8g visibility rules. Active = open / pre-decide / revising
    // (was just "open" pre-PR8g). The per-state rules below reflect
    // the docs/RFC.md "Manifest filter" section.
    const active: RfcProposal[] = [
      ...(await this.listRfcs({ status: "open" })),
      ...(await this.listRfcs({ status: "pre-decide" })),
      ...(await this.listRfcs({ status: "revising" })),
    ];
    const out: RfcSummary[] = [];
    for (const p of active) {
      const isDecider = p.deciders.includes(role);
      const isVoter = p.voters.includes(role);
      const isCreator = p.createdBy === role;
      if (!isDecider && !isVoter && !isCreator) continue;
      // Read the comments ledger once per RFC; both `commented` and
      // `unreadComments` derive from it.
      const { comments } = await this.readRfcUnchecked(p.id);
      const myComments = comments.filter((c) => c.role === role);
      const commented = myComments.length > 0;
      const lastSeen = await this.readRfcSeenCursor(role, p.id);
      const unreadComments = lastSeen
        ? comments.findIndex((c) => c.id === lastSeen) === -1
          ? comments.length
          : comments.length - (comments.findIndex((c) => c.id === lastSeen) + 1)
        : comments.length;

      // PR8g per-status filtering rules.
      switch (p.status) {
        case "open": {
          // Voter who has already commented and is NOT a decider falls
          // out of the action list — they have spoken. Voter who has
          // new (unread) comments by others stays — there's new
          // discussion to react to. Decider always stays.
          if (isVoter && !isDecider && commented && unreadComments === 0) continue;
          break;
        }
        case "pre-decide": {
          // Decider always stays (waiting for objections / can finalise).
          // Voter stays unless they have already commented AFTER the
          // pre-decision was posted (silent consent path: commenting
          // would have auto-reopened).
          if (isVoter && !isDecider) {
            const preDecisionTs = p.preDecision?.ts ?? "";
            const commentedAfterPreDecide = myComments.some((c) => c.ts > preDecisionTs);
            if (commentedAfterPreDecide) continue;
          }
          break;
        }
        case "revising": {
          // Only the creator (rewriter) and deciders need this on their
          // dashboard. Other voters can wait until it re-opens.
          if (!isCreator && !isDecider) continue;
          break;
        }
        default:
          continue;
      }

      const summary: RfcSummary = {
        id: p.id,
        title: p.title,
        status: p.status,
        // Prefer decider role label when both apply (decider work
        // outranks voter work).
        role: isDecider ? "decider" : "voter",
        commented,
        unreadComments,
        relatedTasks: p.relatedTasks,
      };
      if (p.status === "pre-decide" && p.preDecision !== undefined) {
        summary.pendingPreDecision = {
          decidedBy: p.preDecision.decidedBy,
          chosenOption: p.preDecision.chosenOption,
          ts: p.preDecision.ts,
        };
      }
      out.push(summary);
    }
    return out;
  }

  // ---- helpers ------------------------------------------------------------

  private abs(rel: string): string {
    return resolveInside(this.root, rel);
  }
}

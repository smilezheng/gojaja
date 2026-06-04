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
  rfcProposalPath,
  rfcReadCursorPath,
  rolePaths,
  waitStatePath,
  worklogEntryPath,
} from "./paths";
import { classifyPath } from "./path-routing";
import { validateRoleId, validateSlug } from "./role-id";
import { renderRoleMarkdown } from "./role-template";
import type { Store } from "./store";
import {
  ACTIVE_TASK_STATUSES,
  MAX_TASK_DEPTH,
  PROTOCOL_ONE_LINER,
  TASK_STATUSES,
  type CursorState,
  type Deliverable,
  type Event,
  type Manifest,
  type ProjectConfig,
  type RfcComment,
  type RfcCommentKind,
  type RfcDecision,
  type RfcOption,
  type RfcProposal,
  type RfcStatus,
  type RfcSummary,
  type RoleConfig,
  type RoleId,
  type RoleReminder,
  type SessionInfo,
  type SystemActorMeta,
  type Task,
  type TaskAsset,
  type TaskBoard,
  type TaskStatus,
  type TaskSummary,
  type WaitState,
} from "./types";

/**
 * Build the `actorMeta` slice of an `Event` payload.
 *
 * Returns `{ actorMeta: meta }` ONLY when the actor is `"SYSTEM"`
 * AND metadata was provided. Role-bearing events always get
 * `{}` (no `actorMeta` field on the resulting event) — their trace
 * lives in the session record, not on the event itself.
 *
 * This is a one-line spread helper so every `recordEventInternal`
 * call site can stay terse:
 *
 *   return this.recordEventInternal({
 *     type: "REPORT",
 *     from: input.from,
 *     ...
 *     ...attachActorMeta(input.from, input.actorMeta),
 *   });
 */
function attachActorMeta(
  actor: RoleId | "SYSTEM",
  meta: SystemActorMeta | undefined,
): { actorMeta?: SystemActorMeta } {
  if (actor === "SYSTEM" && meta) return { actorMeta: meta };
  return {};
}

function freshConfig(schemaVersion: string): ProjectConfig {
  return { schemaVersion, roles: {} };
}

function freshTaskBoard(schemaVersion: string): TaskBoard {
  return { schemaVersion, nextId: 0, tasks: {} };
}

/**
 * Defensive defaults for Task fields. Mutates in place. Used when
 * reading YAML the framework wrote — these fields are always emitted
 * by the writer, so the only way they can be missing is a hand-edit.
 */
function backfillTaskFields(t: Task): void {
  if (!Array.isArray(t.dependsOn)) t.dependsOn = [];
  if (typeof t.acceptance !== "string") t.acceptance = "";
  if (t.parent === undefined) t.parent = null;
  if (t.creator === undefined) t.creator = "SYSTEM";
  if (!Array.isArray(t.assets)) t.assets = [];
  if (!Array.isArray(t.deliverables)) t.deliverables = [];
  if (!Array.isArray(t.tags)) t.tags = [];
  if (!Array.isArray(t.reviewers)) t.reviewers = [];
  // v3.0.x rename: "Ready" → "Pending". Apply at the read boundary
  // so every downstream consumer (dashboard, manifest, handbook
  // rendering) only ever sees the new name. The legacy literal
  // stays accepted on the input side (see TaskStatus union) so
  // hand-edited boards / external callers never crash. The next
  // setTaskStatus / createTask call writes "Pending" back to YAML,
  // so the migration is naturally completed by ordinary use.
  if ((t.status as string) === "Ready") {
    t.status = "Pending";
  }
  // `archived` stays optional — undefined === false for filters. We
  // intentionally do NOT default-set it to false, to keep the on-disk
  // YAML tight for the (overwhelmingly common) un-archived case.
  if (t.archived !== true) delete (t as Task).archived;
}

/**
 * walk the parent graph of every task and refuse anything that
 * forms a cycle or exceeds the depth limit. Runs once on read so a
 * hand edit that introduces a cycle stops the world early instead of
 * silently looping anywhere that walks the chain (manifest summaries,
 * task show, etc).
 */
function detectParentCycles(board: TaskBoard): void {
  for (const taskId of Object.keys(board.tasks)) {
    const seen: string[] = [];
    let cur: string | null = taskId;
    while (cur) {
      if (seen.includes(cur)) {
        throw new StateCorruptionError(
          `Parent cycle in task board: ${seen.concat(cur).join(" -> ")}. ` +
            `Manually edit state/task_board.yaml to break the cycle.`,
        );
      }
      seen.push(cur);
      if (seen.length > MAX_TASK_DEPTH + 1) {
        // +1 because seen[0] is the task itself; chain depth is the
        // count of ancestors plus self.
        throw new StateCorruptionError(
          `Parent chain exceeds ${MAX_TASK_DEPTH}: ${seen.join(" -> ")}. ` +
            `Manually edit state/task_board.yaml to flatten the tree.`,
        );
      }
      const next: Task | undefined = board.tasks[cur];
      cur = next?.parent ?? null;
    }
  }
}

/**
 * validate a `kind: "file"` ref is a repo-relative path that
 * stays inside the project tree AND outside the `.gojaja/` layer.
 * Refs are kept as POSIX-style strings on disk; we normalise here only
 * to detect escape attempts (`..`), not to mutate the stored value.
 */
function validateFileRef(ref: string, fieldName: string, projectRoot: string, layerRoot: string): void {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new UsageError(`${fieldName} ref must be a non-empty string.`);
  }
  if (path.isAbsolute(ref)) {
    throw new UsageError(`${fieldName} ref '${ref}' must be repo-relative, not absolute.`);
  }
  const normalised = path.posix.normalize(ref);
  if (normalised.startsWith("..") || normalised.split("/").includes("..")) {
    throw new UsageError(`${fieldName} ref '${ref}' escapes the project tree.`);
  }
  // Confirm by resolving (mostly redundant with the textual check, but
  // catches edge cases like `./foo/../../bar`).
  const abs = path.resolve(projectRoot, ref);
  const relFromProject = path.relative(projectRoot, abs);
  if (relFromProject.startsWith("..") || path.isAbsolute(relFromProject)) {
    throw new UsageError(`${fieldName} ref '${ref}' escapes the project tree.`);
  }
  const relFromLayer = path.relative(layerRoot, abs);
  if (!relFromLayer.startsWith("..") && relFromLayer !== "..") {
    throw new UsageError(
      `${fieldName} ref '${ref}' points inside .gojaja/. Deliverables and ` +
        `assets are project-tree artifacts; do not target framework state.`,
    );
  }
}

/**
 * is `role` a "stakeholder" of `taskId`? Used by the manifest
 * visibility filter to decide whether `TASK_STATUS_CHANGED` and
 * friends should land in this role's manifest.
 *
 * Stakeholders are:
 *   - the task's current owner,
 *   - the parent task's current owner (epic owner),
 *   - any other task's owner where this task appears in `dependsOn`
 *     (i.e. someone is blocked on this).
 *
 * Returns false for unknown task ids (defensive — the caller surfaces
 * defensively when board context is missing).
 */
function isTaskStakeholder(role: RoleId, taskId: string, board: TaskBoard): boolean {
  const task = board.tasks[taskId];
  if (!task) return false;
  if (task.owner === role) return true;
  if (task.parent) {
    const parent = board.tasks[task.parent];
    if (parent && parent.owner === role) return true;
  }
  for (const other of Object.values(board.tasks)) {
    if (other.owner === role && other.dependsOn.includes(taskId)) return true;
  }
  // reviewers are also stakeholders. TASK_STATUS_CHANGED on a
  // task they review (most importantly: the transition to Review)
  // surfaces in their manifest without the owner needing to send an
  // explicit report.
  if (task.reviewers.includes(role)) return true;
  return false;
}

function validateAsset(asset: TaskAsset, projectRoot: string, layerRoot: string): void {
  if (!asset || typeof asset !== "object") {
    throw new UsageError("Asset must be an object.");
  }
  if (asset.kind !== "file" && asset.kind !== "url") {
    throw new UsageError(`Asset kind must be 'file' or 'url' (got '${asset.kind}').`);
  }
  if (asset.kind === "file") {
    validateFileRef(asset.ref, "asset", projectRoot, layerRoot);
  } else if (typeof asset.ref !== "string" || asset.ref.length === 0) {
    throw new UsageError("Asset ref must be a non-empty string.");
  }
  if (typeof asset.description !== "string") {
    throw new UsageError("Asset description must be a string (use '' if none).");
  }
}

function validateDeliverable(d: Deliverable, projectRoot: string, layerRoot: string): void {
  if (!d || typeof d !== "object") {
    throw new UsageError("Deliverable must be an object.");
  }
  if (d.kind !== "file" && d.kind !== "url" && d.kind !== "manual") {
    throw new UsageError(`Deliverable kind must be 'file', 'url', or 'manual' (got '${d.kind}').`);
  }
  if (d.kind === "file") {
    validateFileRef(d.ref, "deliverable", projectRoot, layerRoot);
  } else if (typeof d.ref !== "string") {
    // url + manual: allow empty ref (e.g. "manual:Design link in worklog"
    // where the description carries the requirement). But still must be string.
    throw new UsageError("Deliverable ref must be a string.");
  }
  if (typeof d.description !== "string") {
    throw new UsageError("Deliverable description must be a string.");
  }
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
 * helper: given a comments ledger (already sorted by ts) and
 * the timestamps of all RFC_OPTION_ADDED events for the same RFC,
 * compute whether there is currently an "active pre-decision".
 *
 * Rules: the latest `kind === "pre-decision"` comment in the ledger
 * is active UNLESS one of the following invalidates it:
 *
 *   1. **add-option after the pre-decision**: any RFC_OPTION_ADDED
 *      with `ts > pre-decision.ts` invalidates — voters were ACKing
 *      an outdated option set; the decider must issue a fresh
 *      pre-decision if they want a new ACK round.
 *   2. **withdraw by the original pre-decider**: any later
 *      `kind === "withdraw"` comment from `pre-decision.role` is an
 *      explicit self-revoke. The pre-decide lock is released and the
 *      RFC is back to open discussion.
 *
 * Returns null if no pre-decision exists yet, or if the latest one
 * has been invalidated by either rule above.
 */
function computeActivePreDecisionInLedger(
  comments: RfcComment[],
  _rfcId: string,
  addOptionAddedTimestamps: string[],
): {
  decidedBy: RoleId;
  chosenOption: string;
  ts: string;
  rationale: string;
} | null {
  let latest: RfcComment | null = null;
  for (const c of comments) {
    if (c.kind === "pre-decision") {
      // Comments are appended in ts order (ULIDs are monotonic per
      // process + serialised by rfc-<id> lock), so later iterations
      // overwrite earlier `latest`. The newest pre-decision wins —
      // earlier ACKs would have been computed against an older
      // proposal anyway.
      latest = c;
    }
  }
  if (latest === null) return null;
  if (addOptionAddedTimestamps.some((ts) => ts > latest!.ts)) return null;
  const withdrawnByAuthor = comments.some(
    (c) =>
      c.kind === "withdraw" &&
      c.role === latest!.role &&
      c.ts > latest!.ts,
  );
  if (withdrawnByAuthor) return null;
  return {
    decidedBy: latest.role,
    chosenOption: latest.preferred,
    ts: latest.ts,
    rationale: latest.rationale,
  };
}

/**
 * Compute the "required commenter set" for an RFC: the roles whose
 * plain `rfc comment` participation must be present before any
 * `pre-decide` is allowed.
 *
 * The set is `(voters ∪ deciders) − {createdBy if not SYSTEM}`. The
 * creator is excluded by design — they already framed the question
 * (the proposal's `description`); requiring them to also post a
 * regular comment would either be ceremony (duplicating the
 * description) or create a self-anchoring effect that biases the
 * discussion toward whatever the creator's first comment says.
 * SYSTEM-created RFCs (`createdBy === "SYSTEM"`) have no creator to
 * exclude, and SYSTEM is never in voters/deciders anyway.
 */
function requiredCommenterSet(proposal: RfcProposal): Set<RoleId> {
  const set = new Set<RoleId>([...proposal.voters, ...proposal.deciders]);
  if (proposal.createdBy !== "SYSTEM") set.delete(proposal.createdBy);
  return set;
}

/**
 * Has every role in the required-commenter set posted at least one
 * regular discussion comment (`kind === undefined`) on this RFC?
 *
 * Structured kinds (`pre-decision` / `ack` / `object` / `withdraw`)
 * deliberately do NOT count: they are flow-control posts, not
 * substantive engagement. Otherwise an ack would silently satisfy
 * the comment gate and the gate would lose its point.
 */
function isRfcPreDecideAble(
  proposal: RfcProposal,
  comments: RfcComment[],
): boolean {
  const required = requiredCommenterSet(proposal);
  if (required.size === 0) return true; // edge case: nothing to wait on.
  const commented = new Set<RoleId>();
  for (const c of comments) {
    if (c.kind !== undefined) continue;
    if (c.role === "SYSTEM") continue; // SYSTEM is never in required.
    if (required.has(c.role)) commented.add(c.role);
  }
  for (const r of required) {
    if (!commented.has(r)) return false;
  }
  return true;
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
> Agents consult this file whenever they need to decide whether a
> task is "Done": the acceptance criteria below are authoritative.

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

// Written to `.gojaja/.gitignore` at init. Keeps machine-specific
// runtime state out of version control while leaving the audit trail
// (events, worklog, rfcs, state, roles, config) committable.
const GOJAJA_GITIGNORE = `# Managed by gojaja. Runtime state below is machine-specific and must
# NOT be committed: a checked-in session/lock looks "live" on another
# machine (or after a window died) and blocks 'gojaja claim' until the
# lease expires; checked-in read cursors make a fresh checkout think it
# has already read events.
#
# Everything else under .gojaja/ (events, worklog, rfcs, state, roles,
# config.yaml, VERSION) is the shared audit trail and SHOULD be committed.
locks/
comms/sessions/
comms/pending/
comms/heartbeats/
comms/cursors/
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

  /**
   * v3 split-mode opt-in (RFC-0001). When provided, `LocalFsStore`
   * routes file I/O through `classifyPath` to either the user tree
   * (`rootDir` — git tracked) or the central tree (`centralRoot` —
   * `~/.gojaja/projects/<id>/`, per-machine).
   *
   * When omitted, both logical scopes resolve to `rootDir`. This is
   * the v2 single-root layout and remains the behaviour for every
   * existing on-disk project until PR9.2 / PR9.3 migrate it.
   */
  centralRoot?: string;
}

const DEFAULT_SAFETY_MARGIN_MS = 200;

/**
 * Filesystem-backed Store. Operates against the on-disk layer.
 *
 * In v2 single-root mode (the default), all file I/O resolves against
 * `<project>/.gojaja/` (`this.userRoot === this.centralRoot`). In v3
 * split mode (RFC-0001), `centralRoot` is passed to the constructor and
 * each path is classified at the call site by `classifyPath`: contracts
 * (config.yaml, role briefs, project_state.md) land in the user tree
 * (git-tracked); runtime state (task board, comms/, rfcs/, worklog/,
 * locks/) lands in the central tree (per-machine, never in git).
 *
 * Either way, every concrete path is forced through `resolveInside` so
 * user / agent input can never reach `fs.*` without validation.
 */
export class LocalFsStore implements Store {
  readonly rootDescription: string;

  private readonly userRoot: string;
  private readonly centralRoot: string;
  private readonly safetyMarginMs: number;

  constructor(rootDir: string, opts: LocalFsStoreOptions = {}) {
    this.userRoot = path.resolve(rootDir);
    this.centralRoot = opts.centralRoot
      ? path.resolve(opts.centralRoot)
      : this.userRoot;
    // Single-root mode keeps the historical one-path description so
    // error messages and `gojaja --version` stay readable. Split mode
    // surfaces both roots so audit / doctor output stays diagnosable.
    this.rootDescription =
      this.userRoot === this.centralRoot
        ? this.userRoot
        : `user=${this.userRoot} central=${this.centralRoot}`;
    this.safetyMarginMs = opts.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS;
  }

  /**
   * Backwards-compatible accessor used by code paths that still think
   * of "the root" as a single directory (deliverable file gate
   * resolution; lock-key namespacing). In v3 split mode, the user
   * tree is the right answer here — it's the one that sits next to
   * the project source code on disk.
   */
  private get root(): string {
    return this.userRoot;
  }

  /**
   * the project tree (the directory CONTAINING `.gojaja/`).
   * Used to resolve `kind: "file"` deliverable refs for the existence
   * gate on `setTaskStatus(... Done)`. We rely on the convention that
   * the layer directory lives at the project root; if that ever
   * changes we will need to thread project root through the
   * constructor instead. In v3 split mode the user tree is the project
   * tree, so this is still correct.
   */
  private projectRoot(): string {
    return path.dirname(this.userRoot);
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
    // -B: seed a TBD skeleton for project_state.md so it always
    // exists on disk. The product-owner role is expected to fill the
    // sections; activate / handbook nudge that along.
    await atomicWriteFile(
      this.abs(Paths.projectStateFile),
      PROJECT_STATE_SKELETON,
    );
    // Drop a .gitignore so a committed `.gojaja/` does not carry
    // machine-specific runtime state. Sessions/locks/pending/heartbeats
    // and per-role read cursors are ephemeral: committing them means a
    // checkout on another machine (or after a window died) resurrects a
    // "live"-looking session that blocks `claim` until the lease
    // expires, or a stale lock / read cursor. The audit trail
    // (events, worklog, rfcs, state, roles, config) stays committable.
    await atomicWriteFile(this.abs(Paths.gitignoreFile), GOJAJA_GITIGNORE);
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

  /**
   * project the global event stream onto the slice that should
   * land in `<role>`'s next manifest. The events file under
   * `comms/events/` always carries the full stream (audit, git
   * history, future `gojaja doctor`); per-role projection happens
   * here based on event type + business context.
   *
   * Default rules (broadcast events `to: "*"`):
   *   - `REPORT`, `TASK_ASSIGNED` — already directed; filter passes
   *     them through via `e.to === role` check.
   *   - `WORKLOG`, `RFC_DECIDED` — true broadcast. Every role sees.
   *   - `RFC_CREATED`, `RFC_COMMENT`, `RFC_OPTION_ADDED`,
   *     `RFC_REVISION_REQUESTED`, `RFC_REVISED` — only RFC
   *     participants (`voters ∪ deciders ∪ {createdBy}`).
   *   - `RFC_TASK_LINKED`, `RFC_TASK_UNLINKED` — RFC participants OR
   *     the linked task's stakeholders.
   *   - `TASK_CREATED` — only roles owning `state/task_board.yaml`
   *     (the natural triage set; the new owner already gets a
   *     directed `TASK_ASSIGNED`).
   *   - `TASK_STATUS_CHANGED`, `TASK_DELIVERABLE_BYPASSED` — task
   *     stakeholders (owner, parent owner, anyone with this task in
   *     their `dependsOn`).
   *   - `SESSION_CLAIMED`, `SESSION_RELEASED`, `SESSION_TAKEOVER`,
   *     `LOCK_BROKEN`, `ROLE_DELETED`, `RFC_REPAIRED` — operational
   *     events; NEVER in a per-role manifest. They live in the event
   *     stream for `gojaja doctor` and audit.
   *   - Unknown types — surfaced (forward-compatible default).
   *
   * The function is async because RFC participant sets are read
   * lazily from disk; a Map cache keeps per-call cost ≈ O(unique
   * RFCs touched).
   */
  async filterVisibleEventsForRole(
    events: Event[],
    role: RoleId,
  ): Promise<Event[]> {
    if (events.length === 0) return [];

    // Pre-pass: identify which contexts we need before paying the I/O.
    let needsBoard = false;
    let needsConfig = false;
    const rfcIdsTouched = new Set<string>();
    for (const e of events) {
      switch (e.type) {
        case "TASK_CREATED":
          needsConfig = true;
          break;
        case "WORKLOG":
          // `kind: "idle"` worklogs are narrowed to task-board owners
          // (see isBroadcastVisible). Pre-load `config.yaml` so we can
          // resolve that ownership set without one I/O per event.
          if ((e.payload as { kind?: unknown }).kind === "idle") {
            needsConfig = true;
          }
          break;
        case "TASK_STATUS_CHANGED":
        case "TASK_DELIVERABLE_BYPASSED":
          needsBoard = true;
          break;
        case "RFC_CREATED":
        case "RFC_COMMENT":
        case "RFC_OPTION_ADDED":
        case "RFC_REVISION_REQUESTED":
        case "RFC_REVISED":
        case "RFC_READY_TO_DECIDE":
          if (e.ref) rfcIdsTouched.add(e.ref);
          break;
        case "RFC_TASK_LINKED":
        case "RFC_TASK_UNLINKED":
          if (e.ref) rfcIdsTouched.add(e.ref);
          needsBoard = true;
          break;
      }
    }

    const board = needsBoard ? await this.readTaskBoard() : null;
    const taskBoardOwners = needsConfig ? await this.computeTaskBoardOwners() : new Set<RoleId>();
    const rfcParticipants = new Map<string, Set<RoleId>>();
    for (const rfcId of rfcIdsTouched) {
      try {
        const { proposal } = await this.readRfcUnchecked(rfcId);
        const set = new Set<RoleId>();
        for (const v of proposal.voters) set.add(v);
        for (const d of proposal.deciders) set.add(d);
        if (proposal.createdBy !== "SYSTEM") set.add(proposal.createdBy);
        rfcParticipants.set(rfcId, set);
      } catch {
        // RFC unreadable (deleted, corrupted, ...). Surface defensively
        // so a buggy state cannot silently swallow events.
        rfcParticipants.set(rfcId, new Set<RoleId>([role]));
      }
    }

    const out: Event[] = [];
    for (const e of events) {
      // Self-events are never in the manifest.
      if (e.from === role) continue;
      // Directed events: only the named recipient sees them.
      if (e.to !== "*") {
        if (e.to === role) out.push(e);
        continue;
      }
      // Broadcast events: apply per-type rules.
      if (this.isBroadcastVisible(e, role, board, taskBoardOwners, rfcParticipants)) {
        out.push(e);
      }
    }
    return out;
  }

  /**
   * Owners of `state/task_board.yaml`. Lazy helper for
   * `filterVisibleEventsForRole`. A role's `owns` list can name the
   * file directly or via a directory prefix (`state/`); we treat any
   * entry that would let `requireOwnership` succeed as ownership.
   */
  private async computeTaskBoardOwners(): Promise<Set<RoleId>> {
    const config = await this.readConfig();
    const target = Paths.taskBoardFile;
    const owners = new Set<RoleId>();
    for (const [roleId, cfg] of Object.entries(config.roles)) {
      for (const entry of cfg.owns) {
        const normalised = entry.endsWith("/") ? entry : entry;
        if (target === normalised) {
          owners.add(roleId);
          break;
        }
        if (target.startsWith(normalised.endsWith("/") ? normalised : `${normalised}/`)) {
          owners.add(roleId);
          break;
        }
      }
    }
    return owners;
  }

  /**
   * Per-type broadcast visibility. `event.to === "*"` and
   * `event.from !== role` have already been verified by the caller.
   */
  private isBroadcastVisible(
    e: Event,
    role: RoleId,
    board: TaskBoard | null,
    taskBoardOwners: Set<RoleId>,
    rfcParticipants: Map<string, Set<RoleId>>,
  ): boolean {
    switch (e.type) {
      case "WORKLOG": {
        // `kind: "idle"` is the auto-broadcast that `wait --for
        // task-assigned` emits at session open. Its informational
        // value is "give me work", which only matters to roles that
        // own the task board. Broadcasting it to everyone caused
        // mutual-wakeup loops between idle agents (each one's wait
        // ATTENTION-fired on the other's idle worklog, ack'd, parked,
        // re-broadcast, ad infinitum). Narrow it here.
        if ((e.payload as { kind?: unknown }).kind === "idle") {
          return taskBoardOwners.has(role);
        }
        return true;
      }
      case "RFC_DECIDED":
      case "REPORT":
        return true;

      case "RFC_CREATED":
      case "RFC_COMMENT":
      case "RFC_OPTION_ADDED":
      case "RFC_REVISION_REQUESTED":
      case "RFC_REVISED":
      case "RFC_READY_TO_DECIDE": {
        if (!e.ref) return true; // malformed; surface defensively
        const set = rfcParticipants.get(e.ref);
        return set ? set.has(role) : true;
      }

      case "RFC_TASK_LINKED":
      case "RFC_TASK_UNLINKED": {
        const rfcSet = e.ref ? rfcParticipants.get(e.ref) : undefined;
        if (rfcSet?.has(role)) return true;
        const taskId = (e.payload as { taskId?: string }).taskId;
        if (taskId && board && isTaskStakeholder(role, taskId, board)) return true;
        return false;
      }

      case "TASK_CREATED":
        return taskBoardOwners.has(role);

      case "TASK_STATUS_CHANGED":
      case "TASK_DELIVERABLE_BYPASSED": {
        const taskId = e.ref ?? (e.payload as { taskId?: string }).taskId;
        if (!taskId || !board) return true; // defensive
        return isTaskStakeholder(role, taskId, board);
      }

      case "SESSION_CLAIMED":
      case "SESSION_RELEASED":
      case "SESSION_TAKEOVER":
      case "LOCK_BROKEN":
      case "ROLE_DELETED":
      case "RFC_REPAIRED":
        // Operational. Stays in the event stream for audit / doctor;
        // never lands in a per-role manifest.
        return false;

      case "TASK_ASSIGNED":
        // Always directed; if we got here with to: "*" something is
        // wrong upstream — surface defensively.
        return true;

      case "SYSTEM":
        // Unknown / generic SYSTEM event — surface.
        return true;

      default:
        // Forward-compat: future event types we do not yet classify
        // are surfaced rather than silently dropped.
        return true;
    }
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
    options?: { force?: boolean; recoverSessionId?: string },
  ): Promise<SessionInfo> {
    validateRoleId(role);
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new UsageError(`Invalid TTL: ${ttlSeconds}`);
    }
    const force = options?.force ?? false;
    const recoverSessionId = options?.recoverSessionId;
    if (force && recoverSessionId !== undefined) {
      // `force` is "I am taking over a stranger's session"; recovery
      // is "this is MY session, I just lost the env var". They are
      // mutually exclusive — passing both is a caller bug, not a
      // policy choice we silently resolve.
      throw new UsageError(
        "claimSession: `force` and `recoverSessionId` are mutually exclusive.",
      );
    }
    return this.withLock(`session-${role}`, async () => {
      const file = this.abs(rolePaths(role).sessionFile);
      const existing = await readJsonFileOrNull<SessionInfo>(file);
      const now = Date.now();
      if (existing && !force) {
        const heartbeatAge = now - Date.parse(existing.heartbeatAt);
        const stillAlive = heartbeatAge < existing.leaseTtlSeconds * 1000;
        if (stillAlive) {
          // Idempotent recovery path: caller knows the live
          // session's id (recovered from chat history after a
          // context-loss), and just wants to re-export it without
          // taking over a peer. We refresh the heartbeat (as any
          // authenticated call would) and return the existing
          // record unchanged. NO new session is minted; no
          // SESSION_CLAIMED / SESSION_TAKEOVER event is emitted —
          // nothing actually changed.
          if (recoverSessionId !== undefined) {
            if (recoverSessionId === existing.sessionId) {
              const refreshed: SessionInfo = {
                ...existing,
                heartbeatAt: new Date().toISOString(),
              };
              await atomicWriteJson(file, refreshed);
              return refreshed;
            }
            throw new UsageError(
              `Role '${role}' is held by a different live session ` +
                `(yours: ${recoverSessionId}; live: ${existing.sessionId}, ` +
                `heartbeat ${Math.floor(heartbeatAge / 1000)}s ago). ` +
                `The id you supplied does NOT match — that session was ` +
                `taken over or released. Stop and ask the user before ` +
                `forcing anything.`,
            );
          }
          // No recovery hint and no force. Empirically agents that
          // hit this error often DID hold the session before a
          // context-loss; spell out the recovery path so they can
          // try `--session <id>` first instead of escalating to
          // --force. We still do not advertise --force itself —
          // that escalation is a human action, gated on the user
          // confirming the previous window is dead.
          throw new UsageError(
            `Role '${role}' is already claimed by a live session ` +
              `(sessionId ${existing.sessionId}, heartbeat ` +
              `${Math.floor(heartbeatAge / 1000)}s ago).\n` +
              `\n` +
              `If you previously held THIS session and just lost ` +
              `\`GOJAJA_SESSION\` (context-loss / fresh shell), recover ` +
              `it without re-claiming:\n` +
              `  1. Find \`GOJAJA_SESSION=<ulid>\` in your earlier ` +
              `\`gojaja claim\` output (chat history).\n` +
              `  2. Run \`gojaja claim ${role} --session <that-ulid> --eval\`. ` +
              `If the id matches the live session, this just re-exports it.\n` +
              `\n` +
              `If the previous window is genuinely dead AND the user has ` +
              `confirmed it, see \`gojaja claim --help\` for the ` +
              `human-only takeover path.\n` +
              `\n` +
              `Otherwise stop and ask the user — do NOT silently take ` +
              `over a peer.`,
          );
        }
      }
      // No live session, or stale + force: mint a fresh one.
      // recoverSessionId is silently ignored here — there is nothing
      // alive to recover, so falling through to a new session is the
      // friendlier outcome (matches what an agent retrying after a
      // long absence would expect).
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
    from: RoleId | "SYSTEM";
    to: RoleId;
    ref?: string;
    message: string;
    actorMeta?: SystemActorMeta;
  }): Promise<Event> {
    // `"SYSTEM"` is allowed for a human running the CLI without
    // `GOJAJA_SESSION` — the project owner directing a question or
    // request at a specific role. Symmetric with `rfc new` / `rfc
    // comment` / `task new` / `state edit`'s SYSTEM paths.
    if (input.from !== "SYSTEM") validateRoleId(input.from);
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
      ...attachActorMeta(input.from, input.actorMeta),
    });
  }

  async publishWorklog(input: {
    from: RoleId;
    message: string;
    kind?: "idle";
  }): Promise<Event> {
    validateRoleId(input.from);
    if (typeof input.message !== "string" || input.message.length === 0) {
      throw new UsageError("Worklog message must be a non-empty string.");
    }
    // The event payload omits `kind` entirely for regular worklogs so
    // existing event files stay byte-identical to the pre-PR shape and
    // any external consumer that does not know about `kind` keeps
    // working unchanged. `kind: "idle"` is added only when the caller
    // asks for it; `filterVisibleEventsForRole` reads it back to
    // narrow visibility for the wait-idle broadcast.
    const payload: { message: string; kind?: "idle" } = {
      message: input.message,
    };
    if (input.kind !== undefined) payload.kind = input.kind;
    const event = await this.recordEventInternal({
      type: "WORKLOG",
      from: input.from,
      to: "*",
      payload,
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
      // filter by what THIS role actually cares about. The events
      // stream stays full (audit / git / gojaja doctor); the manifest
      // projects only the slice that needs the role's attention. This
      // keeps the LLM turn from being noisy when the project produces
      // many broadcast events.
      const filtered = await this.filterVisibleEventsForRole(safeEvents, role);
      // IMPORTANT: advanceCursorTo uses the LAST safeEvent (not the last
      // filtered event), so events excluded by the visibility filter do
      // NOT re-appear on next plan. They are durably visible in the
      // events stream itself; the cursor advance is about manifest
      // accountability, not about which events count as "seen".
      const advanceCursorTo =
        safeEvents.length > 0
          ? safeEvents[safeEvents.length - 1].id
          : cursor.ackedThrough;
      const ackToken = newId();
      const board = await this.readTaskBoard();
      const tasks = await this.taskSummariesForRole(board, role);
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
   * Store directly without going through `gojaja role create`), we
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
          `Role '${role}' has no outstanding manifest to ack. Run 'gojaja plan' first.`,
        );
      }
      if (cursor.pendingManifest !== token) {
        throw new UsageError(
          `Ack token mismatch for '${role}': pending '${cursor.pendingManifest}', ` +
            `provided '${token}'. Re-run 'gojaja plan' to get the current token.`,
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
          `${Paths.configFile} is missing. Run 'gojaja init' to create it.`,
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
    actor?: RoleId | "SYSTEM";
    actorMeta?: SystemActorMeta;
  }): Promise<RoleConfig> {
    validateRoleId(input.id);
    const title = input.title ?? `${input.id} Agent`;
    const description = input.description ?? "";
    const owns = input.owns ?? [];
    const reportsTo = (input.reportsTo ?? []).map((r) => validateRoleId(r));
    const mustNotEdit = input.mustNotEdit ?? [];

    // PR9 SYSTEM-3: ownership-gate role creation. Defaults to
    // "SYSTEM" so the ~75 pre-PR9 test fixtures that call
    // store.createRole({...}) without an `actor` keep working —
    // they are by construction bootstrap-style fixtures. The CLI
    // layer always provides an actor (resolved via the SYSTEM-1
    // `--as-system` gate), so the missing-actor default is reachable
    // only from internal callers.
    const actor: RoleId | "SYSTEM" = input.actor ?? "SYSTEM";
    if (actor !== "SYSTEM") {
      await this.requireOwnership(actor, Paths.configFile);
    }

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
    actorMeta?: SystemActorMeta;
  }): Promise<{ role: RoleId; removedSessions: number }> {
    validateRoleId(input.id);
    // PR9 SYSTEM-3: role deletion is now ownership-gated symmetric
    // with `createRole`. Allowed actors:
    //   - SYSTEM (project-owner bypass via `--as-system`); OR
    //   - a role whose `owns` list contains `config.yaml` (the
    //     delegated HR / Admin pattern — same gate as create).
    // Any other actor raises ForbiddenError. This replaces the
    // previous "GOJAJA_SESSION must be unset" rule, which leaked
    // the trust boundary to an env var that agents could
    // trivially unset.
    if (input.actor !== "SYSTEM") {
      await this.requireOwnership(input.actor, Paths.configFile);
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
      // window with the old GOJAJA_SESSION still exported would happily
      // authenticate via findSessionById until the lease ran out —
      // and could still call `gojaja plan` against a role that no
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
        from: input.actor,
        to: "*",
        ref: input.id,
        payload: { roleId: input.id, removedSessions },
        ...attachActorMeta(input.actor, input.actorMeta),
      });
      return { role: input.id, removedSessions };
    });
  }

  // ---- wait state --------------------------------------------------

  async readWaitState(role: RoleId): Promise<WaitState | null> {
    validateRoleId(role);
    const target = this.abs(waitStatePath(role));
    const data = await readJsonFileOrNull<WaitState>(target);
    return data;
  }

  async writeWaitState(state: WaitState): Promise<void> {
    validateRoleId(state.role);
    const target = this.abs(waitStatePath(state.role));
    await atomicWriteJson(target, state);
  }

  async clearWaitState(role: RoleId): Promise<void> {
    validateRoleId(role);
    const target = this.abs(waitStatePath(role));
    await safeUnlink(target);
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

    // Serialise the whole write under a per-file lock. append / replace
    // are read-modify-write, so two concurrent edits to the same file
    // would otherwise lose each other's bytes (classic lost update);
    // overwrite is single-write but still serialised so it cannot land
    // between another edit's read and write. The lock key is derived
    // from the file path (capped to the 80-char lock-key limit), so
    // edits to unrelated state files still run in parallel.
    const lockKey = `state-${input.relPath.replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(
      0,
      80,
    );
    return this.withLock(lockKey, async () => {
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
    });
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
    // Backfill defensive defaults, then run a cycle check across the
    // parent graph — hand-edited boards could otherwise poison every
    // subsequent operation that walks the chain.
    for (const t of Object.values(board.tasks)) {
      backfillTaskFields(t as Task);
    }
    detectParentCycles(board);
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
    parent?: string | null;
    assets?: TaskAsset[];
    deliverables?: Deliverable[];
    tags?: string[];
    reviewers?: RoleId[];
    actorMeta?: SystemActorMeta;
  }): Promise<Task> {
    const title = String(input.title ?? "").trim();
    if (title.length === 0) {
      throw new UsageError("Task title must be non-empty.");
    }
    const priority = (input.priority ?? "P2").trim();
    const owner = input.owner === undefined ? null : input.owner;
    const config = await this.readConfig();
    if (owner !== null) {
      validateRoleId(owner);
      // Step 12: owner must be a registered role. Otherwise the
      // TASK_ASSIGNED event we emit goes to a nobody and the typo
      // (e.g. `--owner Forntend`) is silently accepted.
      if (!config.roles[owner]) {
        throw new UsageError(
          `Owner role '${owner}' is not registered. Run \`gojaja role list\` ` +
            `to see registered roles or \`gojaja role create ${owner} ...\` ` +
            `to add it first.`,
        );
      }
    }
    const dependsOn = (input.dependsOn ?? []).map((d) => String(d));
    const acceptance = input.acceptance ?? "";
    const parent = input.parent === undefined ? null : input.parent;
    const assets = input.assets ?? [];
    const deliverables = input.deliverables ?? [];
    const tags = (input.tags ?? []).map((t) => String(t));
    // Reviewers validated like owner — each must be a registered
    // role. We dedup to keep the audit log tidy; duplicate listings
    // would otherwise show up in `task show` and confuse readers.
    const rawReviewers = (input.reviewers ?? []).map((r) => validateRoleId(r));
    const reviewerSet = new Set<RoleId>();
    for (const r of rawReviewers) {
      if (!config.roles[r]) {
        throw new UsageError(
          `Reviewer role '${r}' is not registered. Run \`gojaja role list\` ` +
            `to see registered roles or \`gojaja role create ${r} ...\` to add it first.`,
        );
      }
      reviewerSet.add(r);
    }
    const reviewers: RoleId[] = [...reviewerSet];

    // Validate asset / deliverable refs up front so the user gets a
    // single error per invocation rather than discovering problems
    // at status Done time.
    const projectRoot = this.projectRoot();
    for (const a of assets) validateAsset(a, projectRoot, this.root);
    for (const d of deliverables) validateDeliverable(d, projectRoot, this.root);

    await this.requireOwnership(input.actor, Paths.taskBoardFile);

    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();

      // Parent must exist, must not create a cycle (impossible for a
      // brand-new task since it has no children yet, but we still
      // check depth + existence), and must not exceed the depth limit.
      if (parent !== null) {
        if (!board.tasks[parent]) {
          throw new UsageError(
            `Parent task '${parent}' does not exist. Create it first or ` +
              `omit --parent.`,
          );
        }
        // Walk the parent chain; we're inserting AT depth = chain + 1.
        let depth = 1; // the new task counts as depth 1
        let cur: string | null = parent;
        const visited: string[] = [];
        while (cur) {
          if (visited.includes(cur)) {
            // Should not be reachable thanks to detectParentCycles in
            // readTaskBoard, but defence in depth.
            throw new StateCorruptionError(
              `Cycle detected walking parent chain at '${cur}'.`,
            );
          }
          visited.push(cur);
          depth++;
          const node: Task | undefined = board.tasks[cur];
          cur = node?.parent ?? null;
        }
        if (depth > MAX_TASK_DEPTH) {
          throw new UsageError(
            `Parent chain would exceed maximum depth of ${MAX_TASK_DEPTH}: ` +
              `${visited.join(" -> ")} -> <new>. ` +
              `Tasks this deep usually mean you should split into siblings.`,
          );
        }
      }

      const idNumber = board.nextId + 1;
      const id = formatTaskId(idNumber);
      const now = new Date().toISOString();
      // When an owner is given at creation time, "assigning" implies
      // "go work on this" — default to Ready so the owner's next plan
      // surfaces the task (Backlog is filtered out of manifest.tasks
      // by design). Without an owner, the task is a product/PM backlog
      // item that needs triage before anyone should pick it up.
      // v3.0.x: new tasks land in "Pending" (renamed from "Ready").
      // The reader normalises legacy boards on the way in, so this
      // is the only writer of the canonical name.
      const initialStatus: TaskStatus = owner !== null ? "Pending" : "Backlog";
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
        parent,
        creator: input.actor,
        assets,
        deliverables,
        tags,
        reviewers,
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
        ...attachActorMeta(input.actor, input.actorMeta),
      });
      if (owner) {
        await this.recordEventInternal({
          type: "TASK_ASSIGNED",
          from: input.actor,
          to: owner,
          ref: id,
          payload: { taskId: id, previousOwner: null, newOwner: owner },
          ...attachActorMeta(input.actor, input.actorMeta),
        });
      }
      return task;
    });
  }

  async assignTask(input: {
    taskId: string;
    newOwner: RoleId;
    actor: RoleId | "SYSTEM";
    actorMeta?: SystemActorMeta;
  }): Promise<Task> {
    validateRoleId(input.newOwner);
    // Step 12: owner must be registered. Same reasoning as createTask.
    const config = await this.readConfig();
    if (!config.roles[input.newOwner]) {
      throw new UsageError(
        `Owner role '${input.newOwner}' is not registered. Run ` +
          `\`gojaja role list\` to see registered roles or ` +
          `\`gojaja role create ${input.newOwner} ...\` to add it first.`,
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
        ...attachActorMeta(input.actor, input.actorMeta),
      });
      return task;
    });
  }

  async setTaskStatus(input: {
    taskId: string;
    newStatus: TaskStatus;
    actor: RoleId | "SYSTEM";
    forceIncomplete?: boolean;
    actorMeta?: SystemActorMeta;
  }): Promise<Task> {
    if (!TASK_STATUSES.includes(input.newStatus)) {
      throw new UsageError(
        `Invalid status '${input.newStatus}'. Use one of: ${TASK_STATUSES.join(", ")}.`,
      );
    }
    // v3.0.x: silently normalise the legacy "Ready" literal at the
    // input boundary so the persisted event + task carry only the
    // canonical "Pending" name. Mirrors the reader-side fold in
    // `backfillTaskFields`.
    const newStatus: TaskStatus =
      input.newStatus === "Ready" ? "Pending" : input.newStatus;
    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const task = board.tasks[input.taskId];
      if (!task) {
        throw new UsageError(`Unknown task '${input.taskId}'.`);
      }
      // Permission model:
      //
      //   For Done transitions (sign-off act):
      //     - SYSTEM: allowed (CLI run by the human user directly).
      //     - actor in task.reviewers: allowed (explicit review hop).
      //     - actor === task.owner AND actor === task.creator: allowed
      //       (self-managed — you created and own this task).
      //     - else: fall through to requireOwnership(task_board.yaml).
      //
      //   For non-Done transitions (normal work):
      //     - SYSTEM: allowed.
      //     - actor === task.owner: allowed (owner-exception).
      //     - actor in task.reviewers: allowed (reviewer can push the
      //       task back to InProgress when they reject).
      //     - else: fall through to requireOwnership.
      const isTaskOwner = input.actor !== "SYSTEM" && task.owner === input.actor;
      const isCreator = input.actor !== "SYSTEM" && task.creator === input.actor;
      const isReviewer =
        input.actor !== "SYSTEM" && task.reviewers.includes(input.actor);
      const isSystem = input.actor === "SYSTEM";
      let permitted = false;
      if (newStatus === "Done") {
        if (isSystem) permitted = true;
        else if (isReviewer) permitted = true;
        else if (isTaskOwner && isCreator) permitted = true;
      } else {
        if (isSystem) permitted = true;
        else if (isTaskOwner) permitted = true;
        else if (isReviewer) permitted = true;
      }
      if (!permitted) {
        if (newStatus === "Done" && isTaskOwner && !isCreator) {
          // Special-case the most common failure mode so the error is
          // informative: owner trying to Done a task they did not
          // create AND with no reviewers configured.
          throw new ForbiddenError(
            `Role '${input.actor}' is the owner of ${task.id} but not its creator. ` +
              `Done is a sign-off act; ask a reviewer or task-board owner to accept. ` +
              (task.reviewers.length > 0
                ? `Reviewers configured: ${task.reviewers.join(", ")}.`
                : `No reviewers configured for this task; escalate to the role ` +
                  `that owns state/task_board.yaml.`),
          );
        }
        // Last resort: task-board-owner can do anything. requireOwnership
        // throws ForbiddenError (exit 9) if the actor is not on the
        // owns list either.
        await this.requireOwnership(input.actor, Paths.taskBoardFile);
      }
      const previousStatus = task.status;
      if (previousStatus === newStatus) return task;

      // Deliverable gate on Done. Every `kind: "file"` deliverable
      // must point at an existing file in the project tree, otherwise
      // we refuse the transition with a clear list. `forceIncomplete`
      // bypasses with an audit event so the trail explains "this was
      // a knowing approval, not silent loss".
      let bypassMissing: string[] = [];
      if (newStatus === "Done") {
        const missing = await this.findMissingFileDeliverables(task);
        if (missing.length > 0) {
          if (!input.forceIncomplete) {
            const list = missing.map((m) => `  - ${m}`).join("\n");
            throw new UsageError(
              `Cannot mark ${task.id} Done: deliverable files missing on disk:\n` +
                `${list}\n` +
                `Either produce these files or pass --force-incomplete ` +
                `(emits an audit event).`,
            );
          }
          bypassMissing = missing;
        }
      }

      task.status = newStatus;
      task.updatedAt = new Date().toISOString();
      await this.writeTaskBoardUnlocked(board);

      // Emit the bypass event BEFORE the status change so the audit
      // ordering is "approval given -> status moved", in that order.
      if (bypassMissing.length > 0) {
        await this.recordEventInternal({
          type: "TASK_DELIVERABLE_BYPASSED",
          from: input.actor,
          to: "*",
          ref: input.taskId,
          payload: {
            taskId: input.taskId,
            missing: bypassMissing,
            by: input.actor,
          },
          ...attachActorMeta(input.actor, input.actorMeta),
        });
      }
      await this.recordEventInternal({
        type: "TASK_STATUS_CHANGED",
        from: input.actor,
        to: "*",
        ref: input.taskId,
        payload: {
          taskId: input.taskId,
          previousStatus,
          newStatus,
        },
        ...attachActorMeta(input.actor, input.actorMeta),
      });
      return task;
    });
  }

  /**
   * list `kind: "file"` deliverables on `task` whose `ref` does
   * not exist in the project tree. Honours the same path-escape rules
   * as `validateFileRef`; an asset that should have been rejected at
   * create time is logged as "missing" here (defence in depth).
   */
  private async findMissingFileDeliverables(task: Task): Promise<string[]> {
    const projectRoot = this.projectRoot();
    const missing: string[] = [];
    for (const d of task.deliverables) {
      if (d.kind !== "file") continue;
      const abs = path.resolve(projectRoot, d.ref);
      const rel = path.relative(projectRoot, abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        missing.push(d.ref);
        continue;
      }
      try {
        await fsp.access(abs);
      } catch {
        missing.push(d.ref);
      }
    }
    return missing;
  }

  async readTask(taskId: string): Promise<Task> {
    const board = await this.readTaskBoard();
    const t = board.tasks[taskId];
    if (!t) throw new UsageError(`Unknown task '${taskId}'.`);
    return t;
  }

  async archiveTask(input: { taskId: string }): Promise<Task> {
    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const task = board.tasks[input.taskId];
      if (!task) {
        throw new UsageError(`Unknown task '${input.taskId}'.`);
      }
      if (task.archived) return task; // idempotent
      task.archived = true;
      // Deliberately NOT bumping updatedAt: the Archived tab groups
      // by updatedAt and the user wants that to reflect "moved to
      // Done at <date>", not "moved to archived at <date>".
      await this.writeTaskBoardUnlocked(board);
      // Silent — no event. Archiving is a watch-dashboard housekeeping
      // op, not a governance change that other agents should react to.
      return task;
    });
  }

  async autoArchiveDoneTasks(input: {
    thresholdMs: number;
  }): Promise<{ archived: string[] }> {
    const cutoff = Date.now() - Math.max(0, input.thresholdMs);
    return this.withLock("task-board", async () => {
      const board = await this.readTaskBoard();
      const archived: string[] = [];
      for (const t of Object.values(board.tasks)) {
        if (t.archived) continue;
        if (t.status !== "Done") continue;
        const ts = Date.parse(t.updatedAt);
        if (!Number.isFinite(ts)) continue;
        if (ts > cutoff) continue;
        t.archived = true;
        archived.push(t.id);
      }
      if (archived.length > 0) {
        await this.writeTaskBoardUnlocked(board);
      }
      return { archived };
    });
  }

  private async taskSummariesForRole(
    board: TaskBoard,
    role: RoleId,
  ): Promise<TaskSummary[]> {
    const matching: Task[] = [];
    for (const t of Object.values(board.tasks)) {
      if (t.owner !== role) continue;
      if (!ACTIVE_TASK_STATUSES.has(t.status)) continue;
      // Archived tasks are intentionally hidden from manifests too.
      // They never reach an ACTIVE status today (only `Done` is
      // auto-archived, and `Done` is not active), but check defensively
      // so a hand-edit that pairs `archived: true` with an active
      // status still drops the task from the agent's plan.
      if (t.archived) continue;
      matching.push(t);
    }

    // compute children grouped by parent id once so we can attach
    // childCounts to every matching task that has children, without
    // re-scanning per task.
    const childrenByParent = new Map<string, Task[]>();
    for (const t of Object.values(board.tasks)) {
      if (t.parent === null) continue;
      const arr = childrenByParent.get(t.parent) ?? [];
      arr.push(t);
      childrenByParent.set(t.parent, arr);
    }

    // cache fs.access results for the duration of this manifest
    // generation. A long-tail epic with shared deliverable paths across
    // children would otherwise re-stat the same file repeatedly.
    const existenceCache = new Map<string, boolean>();
    const projectRoot = this.projectRoot();
    const fileExists = async (ref: string): Promise<boolean> => {
      const cached = existenceCache.get(ref);
      if (cached !== undefined) return cached;
      const abs = path.resolve(projectRoot, ref);
      const rel = path.relative(projectRoot, abs);
      let exists = false;
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        try {
          await fsp.access(abs);
          exists = true;
        } catch {
          exists = false;
        }
      }
      existenceCache.set(ref, exists);
      return exists;
    };

    const summaries: TaskSummary[] = [];
    for (const t of matching) {
      const summary: TaskSummary = {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        blockedBy: t.dependsOn.filter((dep) => {
          const d = board.tasks[dep];
          return !d || d.status !== "Done";
        }),
      };
      if (t.parent) summary.parent = t.parent;
      if (t.tags.length > 0) summary.tags = t.tags.slice();
      if (t.reviewers.length > 0) summary.reviewers = t.reviewers.slice();

      const children = childrenByParent.get(t.id);
      if (children && children.length > 0) {
        const counts = { ready: 0, inProgress: 0, blocked: 0, review: 0, done: 0 };
        for (const c of children) {
          switch (c.status) {
            case "Pending":
            case "Ready":
              // Dual-read: count legacy "Ready" alongside "Pending".
              // The reader normalises on the way in so this case is
              // only triggered by in-flight code that hasn't been
              // re-read yet, but keep both for safety.
              counts.ready++;
              break;
            case "InProgress":
              counts.inProgress++;
              break;
            case "Blocked":
              counts.blocked++;
              break;
            case "Review":
              counts.review++;
              break;
            case "Done":
              counts.done++;
              break;
            // Backlog children intentionally do not contribute — they
            // are PM-triage items, not yet "in flight".
          }
        }
        summary.childCounts = counts;
      }

      let unmet = 0;
      for (const d of t.deliverables) {
        if (d.kind !== "file") continue;
        if (!(await fileExists(d.ref))) unmet++;
      }
      if (unmet > 0) summary.unmetDeliverables = unmet;

      summaries.push(summary);
    }
    return summaries;
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
    actorMeta?: SystemActorMeta;
    description?: string;
    relatedTasks?: string[];
  }): Promise<RfcProposal> {
    validateSlug(input.slug);
    const title = String(input.title ?? "").trim();
    if (title.length === 0) throw new UsageError("RFC title must be non-empty.");
    // empty options are now allowed. An RFC created without any
    // option starts in brainstorm mode — voters post comments freely
    // until someone calls `rfc add-option` to introduce concrete
    // choices, at which point the RFC effectively upgrades into a
    // decision flow. `finaliseRfc` enforces the matching invariant
    // (decide may omit --option iff the proposal has none).
    if (!Array.isArray(input.options)) {
      throw new UsageError("RFC options must be an array (may be empty).");
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
    const rawVoters = input.voters.map((r) => validateRoleId(r));
    // the RFC creator is always a participant. Semantically, the
    // act of opening an RFC asserts interest in its outcome — the
    // creator should both see manifest events for it (already true via
    // 's `createdBy` in the visibility set) AND be required to
    // ack/object on a pre-decision. Dedup so passing `--voters` that
    // explicitly contains the creator does not double-list. SYSTEM-
    // created RFCs (no MA_SESSION; CLI driven by the user directly)
    // do NOT auto-include SYSTEM as a voter, because SYSTEM is not a
    // role and cannot ack/object.
    const voters: RoleId[] = [...rawVoters];
    if (input.createdBy !== "SYSTEM" && !voters.includes(input.createdBy)) {
      voters.push(input.createdBy);
    }
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
      // comments live in a single threaded ledger now, not per-role
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
        ...attachActorMeta(input.createdBy, input.actorMeta),
      });
      return proposal;
    });
  }

  async commentRfc(input: {
    rfcId: string;
    role: RoleId | "SYSTEM";
    actorMeta?: SystemActorMeta;
    preferred: string;
    rationale: string;
    replyTo?: string | null;
    kind?: RfcCommentKind;
  }): Promise<RfcComment> {
    // `"SYSTEM"` is allowed for plain discussion comments only — a
    // human running the CLI without `GOJAJA_SESSION` can leave
    // guidance on an RFC. Structured kinds (pre-decision / ack /
    // object) carry a position and must be borne by a role; reject
    // SYSTEM up front for those so the error message is clear
    // instead of the downstream "deciders.includes / required.has"
    // gates rejecting it for an unrelated-looking reason.
    const isSystem = input.role === "SYSTEM";
    if (isSystem && input.kind !== undefined) {
      throw new UsageError(
        `Cannot post a ${input.kind} comment as SYSTEM; ` +
          `pre-decision / ack / object require a registered role. ` +
          `Run 'gojaja claim <role>' first.`,
      );
    }
    if (!isSystem) validateRoleId(input.role);
    let preferred = String(input.preferred ?? "").trim();
    const rationale = String(input.rationale ?? "").trim();
    const kind = input.kind;
    // For regular discussion comments, rationale is required (as in
    // ). For ack, rationale is optional ("yes" is meaningful on
    // its own). For object / pre-decision, rationale is required
    // (you must say why you object / propose).
    if (kind !== "ack" && rationale.length === 0) {
      throw new UsageError("RFC comment rationale must be non-empty.");
    }
    const replyTo =
      input.replyTo === undefined || input.replyTo === null
        ? null
        : String(input.replyTo).trim();

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal, comments } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
      // pre-decide is no longer a status. Only `open` and
      // `revising` allow comments. Regular discussion is allowed in
      // both; structured kinds (ack / object) are only meaningful when
      // there is an active pre-decision, which can only exist in
      // `open` (a pre-decide comment in `revising` is refused below).
      if (proposal.status !== "open" && proposal.status !== "revising") {
        throw new UsageError(
          `RFC ${input.rfcId} is ${proposal.status}; cannot comment on a closed RFC.`,
        );
      }
      if (preferred.length > 0 && !proposal.options.find((o) => o.id === preferred)) {
        // a brainstorm-mode RFC (options empty) gets a friendlier
        // hint pointing at `rfc add-option`. The general "unknown
        // option" error survives for the case where the RFC has
        // options but the caller named a non-existent one.
        if (proposal.options.length === 0) {
          throw new UsageError(
            `RFC ${input.rfcId} is in brainstorm mode (no options yet); ` +
              `cannot reference option '${preferred}'. ` +
              `Run \`gojaja rfc add-option ${input.rfcId} <id>:<summary> --rationale ...\` first.`,
          );
        }
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

      // kind-specific validation.
      if (kind === "pre-decision") {
        // Order matters: structural gates (authority, RFC state,
        // option-set sanity) come before discussion gates (active
        // pre-decision, comment-coverage). The structural gates
        // produce the most actionable error messages — "you're not
        // a decider" / "this is brainstorm-mode" — and gating them
        // behind "wait for X to comment" would feel wrong.
        if (!proposal.deciders.includes(input.role)) {
          throw new ForbiddenError(
            `Role '${input.role}' is not in deciders for ${input.rfcId} (deciders: ${proposal.deciders.join(", ") || "(none)"}). ` +
              `Only deciders can post a pre-decision.`,
          );
        }
        if (proposal.status !== "open") {
          throw new UsageError(
            `Cannot post a pre-decision on RFC ${input.rfcId} in state ${proposal.status}; ` +
              `pre-decisions are only valid in 'open'.`,
          );
        }
        if (preferred.length === 0) {
          throw new UsageError(
            "pre-decision requires a non-empty option id (--option).",
          );
        }
        // explicit, friendlier error when the RFC is in brainstorm
        // mode (no options yet) — pre-decision has nothing concrete to
        // lock in until at least one option exists.
        if (proposal.options.length === 0) {
          throw new UsageError(
            `RFC ${input.rfcId} has no options yet; cannot pre-decide. ` +
              `Run \`gojaja rfc add-option ${input.rfcId} <id>:<summary>\` first.`,
          );
        }
        if (!proposal.options.find((o) => o.id === preferred)) {
          throw new UsageError(
            `Option '${preferred}' is not in RFC ${input.rfcId}. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
          );
        }
        // Refuse a second pre-decide while one is already active.
        // Without this gate two deciders could rapidly post competing
        // pre-decisions and silently overwrite one another (the old
        // "latest wins" behaviour); the resulting ACK round would be
        // a coin flip on whoever wrote last. To re-propose, the
        // original pre-decider runs `rfc withdraw-pre-decision`
        // first, OR add-option silently invalidates the existing
        // pre-decision (option set has changed; ACK round was
        // against an outdated set).
        const activeAlready = computeActivePreDecisionInLedger(
          comments,
          proposal.id,
          await this.rfcOptionAddedEventTimestamps(proposal.id),
        );
        if (activeAlready !== null) {
          throw new UsageError(
            `RFC ${input.rfcId} already has an active pre-decision (option ` +
              `'${activeAlready.chosenOption}' by ${activeAlready.decidedBy}). ` +
              `To re-propose, ${activeAlready.decidedBy} must run ` +
              `\`gojaja rfc withdraw-pre-decision ${input.rfcId} --rationale ...\` first; ` +
              `or any voter/decider can run \`gojaja rfc add-option ${input.rfcId} ...\` ` +
              `(which silently invalidates the active pre-decision).`,
          );
        }
        // Comment-coverage gate. Every required commenter — `(voters
        // ∪ deciders) − {createdBy if not SYSTEM}` — must have posted
        // at least one regular discussion comment before any decider
        // is allowed to pre-decide. Without this, a decider could
        // rush a pre-decision before the rest of the team had
        // weighed in. The framework auto-emits
        // `RFC_READY_TO_DECIDE` exactly when this gate flips green
        // (see commentRfc), so deciders do not have to poll.
        if (!isRfcPreDecideAble(proposal, comments)) {
          const required = requiredCommenterSet(proposal);
          const commented = new Set<RoleId>();
          for (const c of comments) {
            if (c.kind === undefined && c.role !== "SYSTEM" && required.has(c.role)) {
              commented.add(c.role);
            }
          }
          const missing = [...required].filter((r) => !commented.has(r));
          throw new UsageError(
            `Cannot pre-decide ${input.rfcId} yet: still waiting on a regular ` +
              `\`rfc comment\` from ${missing.join(", ")}. ` +
              `Every required commenter (voters + deciders, excluding the creator) ` +
              `must weigh in at least once before a pre-decision is allowed. ` +
              `If a role is unreachable, run \`gojaja rfc reject ${input.rfcId} ` +
              `--rationale ...\` and open a new RFC without that role.`,
          );
        }
      } else if (kind === "ack" || kind === "object") {
        const active = computeActivePreDecisionInLedger(comments, proposal.id, await this.rfcOptionAddedEventTimestamps(proposal.id));
        if (active === null) {
          throw new UsageError(
            `RFC ${input.rfcId} has no active pre-decision; ` +
              `nothing to ${kind === "ack" ? "acknowledge" : "object to"}.`,
          );
        }
        if (input.role === active.decidedBy) {
          throw new UsageError(
            `Role '${input.role}' posted the active pre-decision on ${input.rfcId}; ` +
              `cannot ${kind === "ack" ? "ack" : "object to"} your own pre-decision. ` +
              `Use 'rfc decide' to finalise, 'rfc revise' to send back for rewrite, or post a new 'rfc pre-decide' to change your proposal.`,
          );
        }
        const required = new Set<RoleId>([
          ...proposal.voters,
          ...proposal.deciders,
        ]);
        required.delete(active.decidedBy);
        if (!required.has(input.role)) {
          throw new ForbiddenError(
            `Role '${input.role}' is not in the required-ACK set for ${input.rfcId} ` +
              `(voters: ${proposal.voters.join(", ") || "(none)"}; deciders: ${proposal.deciders.join(", ")}). ` +
              `Only required roles can ack / object.`,
          );
        }
        if (kind === "ack") {
          // ACK comment locks preferred to the pre-decision's option
          // (you cannot say "yes, but with a different option" — that
          // is what `object --option Y` is for).
          preferred = active.chosenOption;
        } else {
          // object: rationale already enforced non-empty above.
          // preferred is optional ("just not C") or any existing option.
          // (Already validated against proposal.options above.)
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
        kind,
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
          kind,
        },
        ...attachActorMeta(input.role, input.actorMeta),
      });
      // the commenter has by definition seen everything up to
      // and including their own comment. Advance their read cursor so
      // they don't appear in their own manifest as having "unread
      // discussion" right after they spoke.
      // SYSTEM never has a manifest / read cursor — skip to avoid
      // creating a stray `cursors/SYSTEM/` directory that no role
      // would ever consult.
      if (!isSystem) {
        const cursorTarget = this.abs(rfcReadCursorPath(input.role, proposal.id));
        await fsp.mkdir(path.dirname(cursorTarget), { recursive: true });
        await atomicWriteJson(cursorTarget, { lastSeenCommentId: comment.id });
      }

      // Pre-decide-able autoprompt: if this comment was a regular
      // discussion comment (not a structured kind), the RFC is `open`,
      // and there is currently no active pre-decision, check whether
      // the just-updated ledger now satisfies the comment-coverage
      // gate. If so, emit `RFC_READY_TO_DECIDE` to nudge the deciders.
      //
      // We deliberately re-emit if a fresh comment lands after a
      // previous READY (a late voter still gets to be heard before
      // pre-decide); the alternative — gating on "no prior READY
      // event for this RFC" — would silently lose the late voter's
      // signal. Over the lifetime of a single RFC the worst case is
      // one READY per qualifying late comment, which is fine.
      // Suppressed once a pre-decision is active (the flow has moved
      // on to ACK; READY is no longer the right prompt).
      if (kind === undefined && proposal.status === "open") {
        const optionAddedTs = await this.rfcOptionAddedEventTimestamps(proposal.id);
        const activeAfter = computeActivePreDecisionInLedger(
          nextLedger,
          proposal.id,
          optionAddedTs,
        );
        if (activeAfter === null && isRfcPreDecideAble(proposal, nextLedger)) {
          const required = [...requiredCommenterSet(proposal)];
          await this.recordEventInternal({
            type: "RFC_READY_TO_DECIDE",
            from: "SYSTEM",
            to: "*",
            ref: proposal.id,
            payload: {
              rfcId: proposal.id,
              requiredCommenters: required,
            },
          });
        }
      }

      return comment;
    });
  }

  /**
   * helper: list timestamps of RFC_OPTION_ADDED events for a
   * specific RFC. Used by computeActivePreDecisionInLedger to detect
   * "add-option after a pre-decision invalidates that pre-decision".
   * Kept private; reaches into the event stream once per call (RFCs
   * are low-traffic so this is fine).
   */
  private async rfcOptionAddedEventTimestamps(rfcId: string): Promise<string[]> {
    const all = await this.listEventsAfter("");
    return all
      .filter((e) => e.type === "RFC_OPTION_ADDED" && e.ref === rfcId)
      .map((e) => e.ts);
  }

  async decideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string | null;
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
      const { proposal, comments } = await this.readRfcUnchecked(args.rfcId, {
        lockHeld: true,
      });
      // decide is valid from `open`. reject is additionally
      // valid from `revising` (decider may give up on the topic
      // instead of waiting for a rewrite). reject is also the only
      // escape from an ACK-stalled pre-decision.
      const okStarts: RfcStatus[] =
        args.outcome === "accepted" ? ["open"] : ["open", "revising"];
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
        // brainstorm-mode RFCs (proposal.options is empty) accept
        // without a chosen option — the rationale carries the takeaway.
        // RFCs that DO have options still require a pick, exactly as
        // before. The two modes are mutually exclusive: you cannot pass
        // a chosenOption when the proposal carries no options, and you
        // cannot omit it when it does.
        if (proposal.options.length === 0) {
          if (args.chosenOption) {
            throw new UsageError(
              `RFC ${args.rfcId} has no options; decide must not be given an --option. ` +
                `If you want to lock in a concrete choice, run \`gojaja rfc add-option ${args.rfcId} ...\` first.`,
            );
          }
        } else {
          if (!args.chosenOption) {
            throw new UsageError(
              `RFC ${args.rfcId} has options (${proposal.options.map((o) => o.id).join(", ")}); ` +
                `decide requires --option <id>.`,
            );
          }
          if (!proposal.options.find((o) => o.id === args.chosenOption)) {
            throw new UsageError(
              `Option '${args.chosenOption}' is not in RFC ${args.rfcId}. Options: ${proposal.options.map((o) => o.id).join(", ")}.`,
            );
          }
        }
        // ACK gate: if an active pre-decision exists, every
        // role in (voters ∪ deciders) − {pre-decider} must have
        // posted a kind=ack or kind=object comment AFTER the
        // pre-decision's ts before decide is allowed. Silence is NOT
        // consent. There is no override — the only escape is `reject`.
        const optionAddedTs = await this.rfcOptionAddedEventTimestamps(proposal.id);
        const active = computeActivePreDecisionInLedger(comments, proposal.id, optionAddedTs);
        if (active !== null) {
          const required = new Set<RoleId>([
            ...proposal.voters,
            ...proposal.deciders,
          ]);
          required.delete(active.decidedBy);
          const responded = new Set<RoleId>(
            comments
              .filter(
                (c) =>
                  c.ts > active.ts &&
                  (c.kind === "ack" || c.kind === "object"),
              )
              .map((c) => c.role),
          );
          const outstanding = [...required].filter((r) => !responded.has(r));
          if (outstanding.length > 0) {
            throw new UsageError(
              `RFC ${proposal.id} has an active pre-decision (option '${active.chosenOption}' by ${active.decidedBy}); ` +
                `waiting for ACK from: ${outstanding.join(", ")}. ` +
                `Each role must run \`gojaja rfc ack ${proposal.id}\` or \`gojaja rfc object ${proposal.id} --rationale ...\` ` +
                `before this RFC can be decided. There is no override; if a role is unreachable, ` +
                `run \`gojaja rfc reject ${proposal.id} --rationale ...\` and open a new RFC ` +
                `without that role in voters/deciders.`,
            );
          }
        }
      }
      // reject bypasses the ACK gate by design — it is the
      // only escape from an ACK-stalled pre-decision.
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

  // ---- RFC v2 state transitions ------------------------------------------

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
      const { proposal } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
      // allowed in non-terminal states (`open` / `revising`).
      // Pre-decide is no longer a status; if an active pre-decision
      // exists, this add-option silently invalidates it (see
      // `computeActivePreDecisionInLedger`). The decider can re-issue
      // `rfc pre-decide` to start a fresh ACK round on the updated
      // option set.
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
  }): Promise<RfcComment> {
    // pre-decide is a structured comment with kind=pre-decision.
    // commentRfc enforces decider gate + chosenOption-exists + rationale
    // non-empty, so this is a thin wrapper. RFC status stays `open`;
    // the ACK gate inside decideRfc is what makes pre-decide meaningful.
    return this.commentRfc({
      rfcId: input.rfcId,
      role: input.decidedBy,
      preferred: input.chosenOption,
      rationale: input.rationale,
      replyTo: null,
      kind: "pre-decision",
    });
  }

  async ackRfc(input: {
    rfcId: string;
    role: RoleId;
    rationale?: string;
  }): Promise<RfcComment> {
    // structured ACK. commentRfc enforces caller-is-required
    // + active-pre-decision-exists + caller-is-not-pre-decider, plus
    // forces `preferred` to the active pre-decision's chosenOption.
    return this.commentRfc({
      rfcId: input.rfcId,
      role: input.role,
      preferred: "",     // ignored; commentRfc overrides with the pre-decision's option
      rationale: input.rationale ?? "",
      replyTo: null,
      kind: "ack",
    });
  }

  async objectRfc(input: {
    rfcId: string;
    role: RoleId;
    rationale: string;
    preferredOption?: string;
  }): Promise<RfcComment> {
    // structured objection. rationale required (enforced by
    // commentRfc); preferredOption optional ("just not the proposed
    // one") or any existing option id (validated by commentRfc).
    return this.commentRfc({
      rfcId: input.rfcId,
      role: input.role,
      preferred: input.preferredOption ?? "",
      rationale: input.rationale,
      replyTo: null,
      kind: "object",
    });
  }

  async withdrawRfcPreDecision(input: {
    rfcId: string;
    role: RoleId;
    rationale: string;
  }): Promise<RfcComment> {
    validateRoleId(input.role);
    const rationale = String(input.rationale ?? "").trim();
    if (rationale.length === 0) {
      throw new UsageError(
        "Withdraw rationale must be non-empty (tells the team why you " +
          "are revoking your pre-decision).",
      );
    }

    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal, comments } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
      if (proposal.status !== "open" && proposal.status !== "revising") {
        throw new UsageError(
          `RFC ${input.rfcId} is ${proposal.status}; cannot withdraw on a ` +
            `closed RFC.`,
        );
      }
      const optionAddedTs = await this.rfcOptionAddedEventTimestamps(proposal.id);
      const active = computeActivePreDecisionInLedger(
        comments,
        proposal.id,
        optionAddedTs,
      );
      if (active === null) {
        throw new UsageError(
          `RFC ${input.rfcId} has no active pre-decision to withdraw.`,
        );
      }
      if (input.role !== active.decidedBy) {
        throw new ForbiddenError(
          `Role '${input.role}' did not post the active pre-decision on ` +
            `${input.rfcId} (it was posted by '${active.decidedBy}'). ` +
            `Only the original pre-decider can withdraw.`,
        );
      }

      const comment: RfcComment = {
        id: newId(),
        rfcId: proposal.id,
        role: input.role,
        ts: new Date().toISOString(),
        preferred: "",
        replyTo: null,
        rationale,
        kind: "withdraw",
      };
      const nextLedger = [...comments, comment];
      await atomicWriteFile(
        this.abs(rfcCommentsFile(proposal.id, proposal.slug)),
        yaml.dump(nextLedger, { lineWidth: 100, noRefs: true }),
      );
      // Emitted as a regular RFC_COMMENT (with payload.kind = "withdraw")
      // so existing event consumers (manifest projection, history,
      // dashboards) need no new branches; the withdraw is just another
      // structured comment, same shape as ack / object / pre-decision.
      await this.recordEventInternal({
        type: "RFC_COMMENT",
        from: input.role,
        to: "*",
        ref: proposal.id,
        payload: {
          rfcId: proposal.id,
          role: input.role,
          preferred: "",
          rationale,
          commentId: comment.id,
          replyTo: null,
          kind: "withdraw",
        },
      });
      // Advance commenter's per-RFC read cursor (they just authored
      // the latest comment, so by definition have read everything up
      // to and including it).
      const cursorTarget = this.abs(rfcReadCursorPath(input.role, proposal.id));
      await fsp.mkdir(path.dirname(cursorTarget), { recursive: true });
      await atomicWriteJson(cursorTarget, { lastSeenCommentId: comment.id });
      return comment;
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
      const { proposal } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
      if (proposal.status !== "open") {
        throw new UsageError(
          `Cannot revise ${input.rfcId} in state ${proposal.status}; ` +
            `revise is only valid from 'open'.`,
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
      const { proposal } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
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
    // read time.
    const board = await this.readTaskBoard();
    if (!board.tasks[taskId]) {
      throw new UsageError(
        `Task '${taskId}' is not on the board. Existing ids: ${
          Object.keys(board.tasks).sort().join(", ") || "(none)"
        }.`,
      );
    }
    return this.withLock(`rfc-${input.rfcId}`, async () => {
      const { proposal } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
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
      const { proposal } = await this.readRfcUnchecked(input.rfcId, {
        lockHeld: true,
      });
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

  private async readRfcUnchecked(
    rfcId: string,
    opts: { lockHeld?: boolean } = {},
  ): Promise<{
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
      // The repair mutates proposal.yaml + emits an event, so it must
      // run under the rfc-${id} lock. But several callers (commentRfc,
      // decideRfc, addOption, ...) already hold that lock when they
      // call us — re-entering `withLock` on the same key would
      // self-deadlock, because the file lock is NOT reentrant. Those
      // callers pass `lockHeld: true` so we repair inline; lockless
      // readers (readRfc, listRfcs, the manifest projection) take the
      // lock here.
      if (opts.lockHeld) {
        return this.repairFinalisedRfc(rfcId, slug);
      }
      return this.withLock(`rfc-${rfcId}`, () =>
        this.repairFinalisedRfc(rfcId, slug),
      );
    }
    return snapshot;
  }

  /**
   * Forward-complete a half-written `finaliseRfc` (decision.json on disk
   * but proposal.yaml still `open`). MUST be called with the rfc-${id}
   * lock already held — it re-reads under the lock and no-ops if another
   * writer already repaired the shape. Writes proposal.yaml and emits a
   * single RFC_REPAIRED event.
   */
  private async repairFinalisedRfc(
    rfcId: string,
    slug: string,
  ): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }> {
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
    // visibility rules. Active = open / revising (pre-decide
    // is no longer a status; it's a comment kind that produces a
    // computed `pendingPreDecision` summary).
    const active: RfcProposal[] = [
      ...(await this.listRfcs({ status: "open" })),
      ...(await this.listRfcs({ status: "revising" })),
    ];
    const out: RfcSummary[] = [];
    for (const p of active) {
      const isDecider = p.deciders.includes(role);
      const isVoter = p.voters.includes(role);
      const isCreator = p.createdBy === role;
      if (!isDecider && !isVoter && !isCreator) continue;
      // Read the comments ledger once per RFC; everything derives.
      const { comments } = await this.readRfcUnchecked(p.id);
      const myComments = comments.filter((c) => c.role === role);
      const commented = myComments.length > 0;
      const lastSeen = await this.readRfcSeenCursor(role, p.id);
      const unreadComments = lastSeen
        ? comments.findIndex((c) => c.id === lastSeen) === -1
          ? comments.length
          : comments.length - (comments.findIndex((c) => c.id === lastSeen) + 1)
        : comments.length;

      // pre-decision computation. If there's an active
      // pre-decision (latest kind=pre-decision comment, not
      // invalidated by a later add-option), compute who still needs
      // to ACK and whether THIS role owes one.
      const optionAddedTs = await this.rfcOptionAddedEventTimestamps(p.id);
      const active_pd = computeActivePreDecisionInLedger(comments, p.id, optionAddedTs);
      let pendingPreDecision: RfcSummary["pendingPreDecision"];
      if (active_pd !== null) {
        const required = new Set<RoleId>([...p.voters, ...p.deciders]);
        required.delete(active_pd.decidedBy);
        const responded = new Set<RoleId>(
          comments
            .filter(
              (c) =>
                c.ts > active_pd.ts && (c.kind === "ack" || c.kind === "object"),
            )
            .map((c) => c.role),
        );
        const awaitingAckFrom = [...required].filter((r) => !responded.has(r));
        pendingPreDecision = {
          decidedBy: active_pd.decidedBy,
          chosenOption: active_pd.chosenOption,
          ts: active_pd.ts,
          rationale: active_pd.rationale,
          awaitingAckFrom,
          myAckOwed: required.has(role) && !responded.has(role),
        };
      }

      // per-status filtering rules.
      switch (p.status) {
        case "open": {
          // If a pre-decision is pending AND this role still owes an
          // ACK, keep them in the manifest — they have a structured
          // task. If a pre-decision is pending AND they have already
          // responded, keep deciders (they may need to act on
          // outcomes); drop voters who have responded.
          if (pendingPreDecision !== undefined) {
            if (pendingPreDecision.myAckOwed) break; // surface unconditionally
            if (isVoter && !isDecider) continue;
            break;
          }
          // No pending pre-decision: regular open-state rule. Voter
          // (not decider) who has already commented AND has no unread
          // comments by others falls out.
          if (isVoter && !isDecider && commented && unreadComments === 0) continue;
          break;
        }
        case "revising": {
          // Only the creator (rewriter) and deciders need this on
          // their dashboard. Other voters wait for re-open.
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
        role: isDecider ? "decider" : "voter",
        commented,
        unreadComments,
        relatedTasks: p.relatedTasks,
      };
      if (pendingPreDecision !== undefined) {
        summary.pendingPreDecision = pendingPreDecision;
      }
      out.push(summary);
    }
    return out;
  }

  // ---- helpers ------------------------------------------------------------

  /**
   * Resolve a relative path under the layer to an absolute path on
   * disk, routing via `classifyPath`:
   *
   *   - user-tree paths (`config.yaml`, `roles/<id>.md`,
   *     `state/project_state.md`, `project.json`, `VERSION`,
   *     `.gitignore`, `protocol/**`) → `this.userRoot`.
   *   - central-tree paths (`state/task_board.yaml`, `comms/**`,
   *     `rfcs/**`, `worklog/**`, `locks/**`) → `this.centralRoot`.
   *
   * In v2 single-root mode the two roots are identical, so the
   * classifier still runs but both branches collapse to the same path
   * — behaviour identical to pre-PR9.1 code.
   *
   * `resolveInside` is applied per-tree, so a path that would escape
   * one root cannot accidentally escape the other (`..` segments are
   * still rejected as before).
   */
  private abs(rel: string): string {
    const scope = classifyPath(rel);
    const root = scope === "user" ? this.userRoot : this.centralRoot;
    return resolveInside(root, rel);
  }
}

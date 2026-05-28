import type {
  CursorState,
  Event,
  Manifest,
  ProjectConfig,
  RfcComment,
  RfcDecision,
  RfcOption,
  RfcProposal,
  RfcStatus,
  RoleConfig,
  RoleId,
  SessionInfo,
  Task,
  TaskBoard,
  TaskStatus,
} from "./types";

/**
 * Storage abstraction. All command-layer code talks to a Store; the local
 * filesystem implementation lives in `local-fs-store.ts`. A future HTTP
 * transport implements the same interface against a remote coordinator.
 *
 * Methods must be:
 *   - asynchronous (Promise-returning)
 *   - request/response shaped (no in-flight callbacks that outlive the call)
 *   - safe to retry on transient failure (idempotent where possible)
 *
 * Read methods MUST produce consistent snapshots: callers can never observe a
 * half-written record. The LocalFsStore achieves this with atomic
 * write-and-rename plus immutable per-record files; remote implementations
 * are free to use other techniques as long as the contract holds.
 */
export interface Store {
  /** Path semantics: this Store's logical root, used in error messages. */
  readonly rootDescription: string;

  // ---- bootstrap ----------------------------------------------------------

  /** True if the layer has been initialised at this root. */
  isInitialised(): Promise<boolean>;

  /** Create the empty directory skeleton and the VERSION marker. */
  initialise(version: string): Promise<void>;

  /** Read the VERSION marker, throws if missing. */
  readVersion(): Promise<string>;

  // ---- locking ------------------------------------------------------------

  /**
   * Run `fn` while holding a named exclusive lock. Lock keys are arbitrary
   * strings; collisions across different categories should be avoided by
   * convention (e.g. `role-PM`, `events-seq`, `state-task_board`).
   *
   * Implementations must detect stale locks (dead PID, expired lease) and
   * recover automatically, emitting a LOCK_BROKEN audit event when they do.
   */
  withLock<T>(
    key: string,
    fn: () => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;

  // ---- events -------------------------------------------------------------

  /**
   * Append a new event. The store assigns the id (ULID) and ts. The returned
   * Event is fully populated. Implementations must persist the event durably
   * before returning.
   */
  appendEvent(input: Omit<Event, "id" | "ts">): Promise<Event>;

  /**
   * Return events strictly after `afterId` (exclusive), oldest first. An
   * empty `afterId` returns all events. The list is bounded by `limit` if
   * given (default: no limit; callers should always supply one in production).
   */
  listEventsAfter(afterId: string, limit?: number): Promise<Event[]>;

  // ---- cursors ------------------------------------------------------------

  readCursor(role: string): Promise<CursorState>;

  /**
   * Atomically update a role's cursor. The mutator receives the current state
   * and must return the new state. The Store guarantees no other writer can
   * mutate the same cursor between the read and write.
   */
  updateCursor(
    role: string,
    mutator: (current: CursorState) => CursorState,
  ): Promise<CursorState>;

  // ---- sessions -----------------------------------------------------------

  /**
   * Claim a role lease. Fails if a live (non-expired) session already exists.
   * If `force` is true and the existing session is stale, take it over and
   * emit SESSION_TAKEOVER.
   */
  claimSession(role: string, ttlSeconds: number, force?: boolean): Promise<SessionInfo>;

  releaseSession(role: string, sessionId: string): Promise<void>;

  readSession(role: string): Promise<SessionInfo | null>;

  /**
   * Scan all session files and return the one whose `sessionId` matches.
   * Returns `null` if no live session has that id. Used to translate the
   * `MA_SESSION` environment variable back into a role identity.
   */
  findSessionById(sessionId: string): Promise<SessionInfo | null>;

  touchHeartbeat(role: string, sessionId: string): Promise<void>;

  // ---- composite operations -----------------------------------------------

  /**
   * Publish a REPORT event targeted at `to`. The event is the source of
   * truth; recipients see it via their next `openOrCreatePlan` call (which
   * filters the global event stream by recipient role).
   */
  publishReport(input: {
    from: RoleId;
    to: RoleId;
    ref?: string;
    message: string;
  }): Promise<Event>;

  /**
   * Publish a WORKLOG event (broadcast to "*") AND write a markdown copy
   * to `worklog/<role>/<id>.md` for human-readable browsing in git.
   */
  publishWorklog(input: { from: RoleId; message: string }): Promise<Event>;

  /**
   * Generate a manifest for the role, or return the outstanding one.
   *
   * If `cursor.pendingManifest` is non-null and the underlying file is
   * readable, that exact manifest is returned (idempotency across retry).
   * Otherwise, a fresh manifest is built from events with `id > cursor`
   * filtered by `to ∈ {role, "*"} && from !== role`, persisted under
   * `comms/pending/<role>/<token>.json`, and the cursor is stamped with
   * the new `pendingManifest` token.
   */
  openOrCreatePlan(role: RoleId): Promise<Manifest>;

  /**
   * Consume an outstanding manifest. Validates the token against the
   * cursor's `pendingManifest`. On success, advances `ackedThrough` to
   * the manifest's `advanceCursorTo`, clears `pendingManifest`, and
   * removes the manifest file.
   *
   * The returned `previousCursor` is the `ackedThrough` value before the
   * advance, for caller observability.
   */
  ackManifest(role: RoleId, token: string): Promise<{
    role: RoleId;
    previousCursor: string;
    ackedThrough: string;
    eventsAcked: number;
  }>;

  // ---- config & roles -----------------------------------------------------

  readConfig(): Promise<ProjectConfig>;

  /**
   * Atomic read-modify-write of `config.yaml` under the `config-yaml`
   * lock. ALL multi-step config mutations (createRole, createRfc, role
   * setting changes, ...) MUST go through this — without a single
   * coordinated lock, concurrent RMW from different code paths
   * (e.g. createRole + createRfc) would lose one writer's changes when
   * their own resource lock (`roles-create` / `rfcs`) does not exclude
   * each other.
   */
  updateConfig(
    mutator: (current: ProjectConfig) => ProjectConfig,
  ): Promise<ProjectConfig>;

  /**
   * Atomic full-config write. Caller is responsible for shape AND must
   * already hold the `config-yaml` lock. Prefer `updateConfig` for any
   * read-modify-write pattern.
   */
  writeConfig(config: ProjectConfig): Promise<void>;

  /**
   * Create a role end-to-end: register it in `config.yaml` AND write the
   * `roles/<id>.md` human contract. Atomic at the operation level via a
   * `roles-create` lock. Refuses if `id` already exists in either place.
   */
  createRole(input: {
    id: RoleId;
    title?: string;
    description?: string;
    owns?: string[];
    reportsTo?: RoleId[];
    mustNotEdit?: string[];
  }): Promise<RoleConfig>;

  /** Read the markdown role contract; throws ENOENT-like UsageError. */
  readRoleFile(role: RoleId): Promise<string>;

  /**
   * Remove a role from `config.yaml`, delete its markdown contract,
   * and invalidate any live session for it. Does NOT touch the task
   * board (open assignments are left in place), worklogs, inbox, or
   * the event stream — those are audit artifacts.
   *
   * Emits a `ROLE_DELETED` system event.
   *
   * @throws UsageError if `id` is not currently registered.
   */
  deleteRole(input: {
    id: RoleId;
    actor: RoleId | "SYSTEM";
  }): Promise<{ role: RoleId; removedSessions: number }>;

  // ---- wait sentinel ------------------------------------------------------

  /**
   * Write the `comms/pending/<role>/.wait` sentinel (used by
   * `agentctl wait --mode exit`). Returns the absolute path written.
   */
  writeWaitSentinel(role: RoleId): Promise<{ path: string; writtenAt: string }>;

  // ---- task board ---------------------------------------------------------

  /**
   * Read the whole task board. Returns the default empty board if the
   * underlying file has not been created yet.
   */
  readTaskBoard(): Promise<TaskBoard>;

  /**
   * Create a new task. The store assigns `id` (next `T-NNNN`) and
   * timestamps; emits `TASK_CREATED`. Owner may be null; if non-null and
   * the role is configured, also emits `TASK_ASSIGNED`.
   */
  createTask(input: {
    title: string;
    owner?: RoleId | null;
    priority?: string;
    dependsOn?: string[];
    acceptance?: string;
    actor: RoleId | "SYSTEM";
  }): Promise<Task>;

  /**
   * Reassign a task to a different owner. Emits `TASK_ASSIGNED`.
   * `actor` is the role performing the change (for the event's `from`).
   */
  assignTask(input: {
    taskId: string;
    newOwner: RoleId;
    actor: RoleId | "SYSTEM";
  }): Promise<Task>;

  /**
   * Set a task's status. Emits `TASK_STATUS_CHANGED`. Refuses if the
   * status string is not a known `TaskStatus`.
   */
  setTaskStatus(input: {
    taskId: string;
    newStatus: TaskStatus;
    actor: RoleId | "SYSTEM";
  }): Promise<Task>;

  /** Read a single task; throws UsageError if id unknown. */
  readTask(taskId: string): Promise<Task>;

  // ---- RFCs ---------------------------------------------------------------

  /**
   * Create a new RFC. Allocates the next sequential `RFC-NNNN` id (under
   * a `rfcs` lock; nextRfcId persisted in config.yaml). Validates slug.
   * Refuses duplicate slugs (i.e. another RFC dir matching the same
   * `RFC-XXXX-<slug>` suffix already exists). Emits `RFC_CREATED`.
   */
  createRfc(input: {
    slug: string;
    title: string;
    voters: RoleId[];
    deciders: RoleId[];
    options: RfcOption[];
    deadline?: string | null;
    createdBy: RoleId | "SYSTEM";
    /** PR8g: free-form context. Optional in PR8g (warned if empty). */
    description?: string;
    /** PR8g: linked task ids. Validated against task board. */
    relatedTasks?: string[];
  }): Promise<RfcProposal>;

  /**
   * Add or overwrite a role's comment on an open RFC. Emits `RFC_COMMENT`.
   * Refuses if the RFC is not in status `open`. The framework does NOT
   * require the role to be in the voters list — non-voters may comment,
   * since real teams often add cross-cutting context.
   */
  /**
   * Append a comment to the RFC's `comments.yaml` ledger.
   *
   * PR8g semantics (changed from PR8f):
   * - Append-only; multiple comments per role are preserved in order.
   * - `replyTo` ties the comment to either the RFC root (`null`) or
   *   another comment by id.
   * - If RFC status is `pre-decide` AND the commenter is NOT the role
   *   that posted the pending pre-decision, the status auto-reopens
   *   to `open` and an `RFC_PRE_DECISION_OBJECTED` event is emitted
   *   alongside the regular `RFC_COMMENT` event. The pre-decider
   *   themselves may comment without triggering the auto-reopen
   *   (lets them add reasoning to their own pending round).
   */
  commentRfc(input: {
    rfcId: string;
    role: RoleId;
    preferred: string;
    rationale: string;
    replyTo?: string | null;
  }): Promise<RfcComment>;

  /**
   * PR8g: add a new option to an open or revising RFC. Any role with a
   * session may add (the discussion is collaborative). Refused once the
   * RFC has moved to `pre-decide`, `accepted`, `rejected`, or
   * `superseded` — adding an option mid-pre-decision would invalidate
   * the round; reopen first by commenting.
   */
  addRfcOption(input: {
    rfcId: string;
    actor: RoleId;
    optionId: string;
    summary: string;
    rationale: string;
  }): Promise<RfcOption>;

  /**
   * PR8g: post a pre-decision. Decider gate (FORBIDDEN otherwise).
   * Status flips to `pre-decide`; the proposal's `preDecision` field
   * carries the proposal. Voters/deciders can then either stay silent
   * (silent ACK) or comment to object — comments by anyone other than
   * the pre-decider auto-reopen the RFC (see `commentRfc`).
   */
  preDecideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string;
    rationale: string;
  }): Promise<RfcProposal>;

  /**
   * Decide an RFC (accept with a chosen option). The caller's role must
   * be in the proposal's `deciders` list (ForbiddenError otherwise; that
   * class arrives in PR7, but we already throw UsageError today).
   * Refuses if the RFC is not `open` or the option id is unknown.
   * Emits `RFC_DECIDED` with `outcome=accepted`.
   */
  decideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string;
    rationale: string;
  }): Promise<RfcDecision>;

  /** Reject an RFC. Same deciders gate. Emits `RFC_DECIDED` with `outcome=rejected`. */
  rejectRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    rationale: string;
  }): Promise<RfcDecision>;

  /**
   * PR8g: kick an RFC back to the creator for rewrite. Decider gate.
   * Status moves to `revising`; the rationale is captured in the
   * `RFC_REVISION_REQUESTED` event and tells the creator what to fix.
   * `editRfc` re-opens it.
   */
  reviseRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    rationale: string;
  }): Promise<RfcProposal>;

  /**
   * PR8g: update an RFC in `revising` state and re-open it. The actor
   * must be either the original creator OR a decider. At least one of
   * `title` / `description` / `options` / `deadline` must be provided.
   * Comments are preserved across the revise → edit cycle.
   */
  editRfc(input: {
    rfcId: string;
    actor: RoleId;
    rationale: string;
    title?: string;
    description?: string;
    options?: RfcOption[];
    deadline?: string | null;
  }): Promise<RfcProposal>;

  /**
   * PR8g: attach a task id to the RFC's `relatedTasks` list. The task
   * must exist in `state/task_board.yaml`. Idempotent — adding an
   * already-linked id is a no-op (still returns the proposal).
   */
  linkTaskToRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal>;

  /** PR8g: counterpart to `linkTaskToRfc`. Idempotent. */
  unlinkTaskFromRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal>;

  /**
   * PR8g: mark this role as having seen all comments up to the
   * latest one on this RFC at the time of call. Updates the
   * per-role-per-RFC cursor used by `manifest.rfcs[*].unreadComments`.
   * Idempotent.
   */
  markRfcSeen(input: {
    role: RoleId;
    rfcId: string;
  }): Promise<{ lastSeenCommentId: string | null }>;

  /** Read a proposal + (optionally) its comments and decision. */
  readRfc(rfcId: string): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }>;

  /** Enumerate RFCs, oldest first. Optionally filter by status. */
  listRfcs(filter?: { status?: RfcStatus }): Promise<RfcProposal[]>;

  // ---- ownership-gated writes --------------------------------------------

  /**
   * Atomically write a file under the layer root, gated by the actor's
   * `config.yaml:roles[actor].owns`. The path must be relative, must
   * resolve inside `.multi-agent/` (no `..` escapes), and must appear in
   * the actor's `owns` list. If the same path also appears in the actor's
   * `mustNotEdit` list, the write is refused regardless of `owns` (defence
   * in depth).
   *
   * `actor` can be a role id or `"SYSTEM"`. `"SYSTEM"` bypasses the gate
   * — the human running the CLI by hand should still be able to repair
   * state files. Doctor (PR9) will flag SYSTEM writes as needing audit.
   */
  /**
   * Write into a state file under ownership gating. Three modes:
   *
   *   - `overwrite` (default): replace the entire file with `content`.
   *     Use when you genuinely want to rewrite the whole document.
   *   - `append`: append `appendText` to the existing file. Existing
   *     content is preserved byte-for-byte; no automatic newline
   *     prefix — the caller decides how to delimit. Empty file is
   *     treated as zero existing bytes.
   *   - `replace`: literal-string find-and-replace. The default
   *     refuses to act when `oldText` matches anywhere other than
   *     exactly once (count===0 or count>1); `batch: true` allows
   *     N>1. `oldText`/`newText` are literal strings — no regex.
   *
   * All three modes flow through `requireOwnership` first (owns +
   * mustNotEdit + path canonical-form gate).
   */
  writeStateFile(
    input:
      | {
          actor: RoleId | "SYSTEM";
          relPath: string;
          content: string;
          mode?: "overwrite";
        }
      | {
          actor: RoleId | "SYSTEM";
          relPath: string;
          mode: "append";
          appendText: string;
        }
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
    /** Set when `mode === "replace"`. */
    replacedOccurrences?: number;
  }>;
}

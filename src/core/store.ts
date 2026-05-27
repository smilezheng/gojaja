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

  /** Atomic full-config write. Caller is responsible for shape. */
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
  }): Promise<RfcProposal>;

  /**
   * Add or overwrite a role's comment on an open RFC. Emits `RFC_COMMENT`.
   * Refuses if the RFC is not in status `open`. The framework does NOT
   * require the role to be in the voters list — non-voters may comment,
   * since real teams often add cross-cutting context.
   */
  commentRfc(input: {
    rfcId: string;
    role: RoleId;
    preferred: string;
    rationale: string;
  }): Promise<RfcComment>;

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

  /** Read a proposal + (optionally) its comments and decision. */
  readRfc(rfcId: string): Promise<{
    proposal: RfcProposal;
    comments: RfcComment[];
    decision: RfcDecision | null;
  }>;

  /** Enumerate RFCs, oldest first. Optionally filter by status. */
  listRfcs(filter?: { status?: RfcStatus }): Promise<RfcProposal[]>;
}

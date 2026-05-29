import type {
  CursorState,
  Deliverable,
  Event,
  Manifest,
  ProjectConfig,
  RfcComment,
  RfcCommentKind,
  RfcDecision,
  RfcOption,
  RfcProposal,
  RfcStatus,
  RoleConfig,
  RoleId,
  SessionInfo,
  Task,
  TaskAsset,
  TaskBoard,
  TaskStatus,
  WaitState,
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
   * `GOJAJA_SESSION` environment variable back into a role identity.
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
    /**
     * Sender. Accepts `"SYSTEM"` so a human running the CLI without
     * `GOJAJA_SESSION` can leave a directed message to a role
     * (symmetric with `rfc new` / `rfc comment` / `task new` /
     * `state edit`'s SYSTEM paths). The recipient `to` must still be
     * a registered role — humans send TO roles, not as roles, and
     * the receiver always knows whether the directive came from a
     * peer agent or from the project owner.
     */
    from: RoleId | "SYSTEM";
    to: RoleId;
    ref?: string;
    message: string;
  }): Promise<Event>;

  /**
   * Publish a WORKLOG event (broadcast to "*") AND write a markdown copy
   * to `worklog/<role>/<id>.md` for human-readable browsing in git.
   */
  publishWorklog(input: {
    from: RoleId;
    message: string;
    /**
     * Sub-classification. Default (`undefined`) is a regular team-wide
     * progress update, visible to every role. `"idle"` is reserved for
     * the `wait --for task-assigned` auto-broadcast: payload survives
     * in the audit stream as a normal WORKLOG, but
     * `filterVisibleEventsForRole` narrows it to task-board owners
     * only so peer idle agents are not woken by it (which would
     * otherwise create a mutual-wakeup loop).
     */
    kind?: "idle";
  }): Promise<Event>;

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

  // ---- event projection ---------------------------------------------------

  /**
   * Project the global event stream onto the slice that should land in
   * `<role>`'s manifest. Filters out:
   *   - own events (`from === role`)
   *   - events directed elsewhere (`to !== role && to !== "*"`)
   *   - broadcast events the role is not a stakeholder of, per the
   *     per-type rules documented on the implementation.
   *
   * Used by `openOrCreatePlan` to build `manifest.events` and by
   * `gojaja wait --for attention` to wake the role only when an
   * actually-relevant event arrived. The events themselves stay on
   * disk; this is purely a view function.
   */
  filterVisibleEventsForRole(events: Event[], role: RoleId): Promise<Event[]>;

  // ---- wait state ---------------------------------------------------------

  /**
   * Read the current wait session for `role`, if any. `null` means no
   * wait session is in progress (fresh start).
   */
  readWaitState(role: RoleId): Promise<WaitState | null>;

  /**
   * Atomically persist a wait session. Called once when a fresh wait
   * session opens.
   */
  writeWaitState(state: WaitState): Promise<void>;

  /**
   * Remove the wait session for `role`. Idempotent: a missing file is
   * not an error. Called only on a terminal verdict (ATTENTION /
   * CONDITION_MET / TIMEOUT) so a host-killed wait can be resumed.
   */
  clearWaitState(role: RoleId): Promise<void>;

  // ---- task board ---------------------------------------------------------

  /**
   * Read the whole task board. Returns the default empty board if the
   * underlying file has not been created yet.
   */
  readTaskBoard(): Promise<TaskBoard>;

  /**
   * Create a new task. The store assigns `id` (next `T-NNNN`) and
   * timestamps; emits `TASK_CREATED`. Owner may be null; if non-null and
   * the role is configured, also emits `TASK_ASSIGNED`. Records the
   * `actor` as the task's `creator` (audit; not changed by later
   * `assignTask` calls).
   *
   * extra optional inputs land directly on the task record.
   * `parent` is validated for existence + non-cyclicity + depth limit.
   * `assets` / `deliverables` are validated for path shape (file refs
   * must stay inside the project tree and outside `.gojaja/`).
   *
   * `reviewers` are roles authorised to mark this task Done
   * regardless of ownership; they also become stakeholders for the
   * task's `TASK_STATUS_CHANGED` events (visible in their manifest
   * without the owner sending an explicit report).
   */
  createTask(input: {
    title: string;
    owner?: RoleId | null;
    priority?: string;
    dependsOn?: string[];
    acceptance?: string;
    actor: RoleId | "SYSTEM";
    // parent?: string | null;
    assets?: TaskAsset[];
    deliverables?: Deliverable[];
    tags?: string[];
    // reviewers?: RoleId[];
  }): Promise<Task>;

  /**
   * Reassign a task to a different owner. Emits `TASK_ASSIGNED`.
   * `actor` is the role performing the change (for the event's `from`).
   * Does NOT change `task.assignedBy` — that field records the original
   * assigner; reassignment history lives in the event stream.
   */
  assignTask(input: {
    taskId: string;
    newOwner: RoleId;
    actor: RoleId | "SYSTEM";
  }): Promise<Task>;

  /**
   * Set a task's status. Emits `TASK_STATUS_CHANGED`. Refuses if the
   * status string is not a known `TaskStatus`.
   *
   * when `newStatus === "Done"`, every `kind: "file"` deliverable
   * is checked against the project tree. Any missing file refuses the
   * transition with `UsageError` listing the offenders, UNLESS
   * `forceIncomplete` is true, in which case the transition succeeds
   * and a `TASK_DELIVERABLE_BYPASSED` event is emitted *before* the
   * status change so the audit trail is unambiguous.
   */
  setTaskStatus(input: {
    taskId: string;
    newStatus: TaskStatus;
    actor: RoleId | "SYSTEM";
    /** bypass file-deliverable gate; emits an audit event. */
    forceIncomplete?: boolean;
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
    /** Free-form context. Soft-required (warning if empty). */
    description?: string;
    /** linked task ids. Validated against task board. */
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
   * semantics (collapsed pre-decide back to a comment kind):
   * - Append-only; multiple comments per role are preserved in order.
   * - `replyTo` ties the comment to the RFC root (`null`) or another
   *   comment by id.
   * - `kind` selects between regular discussion (undefined),
   *   `"pre-decision"` (decider posts a proposal awaiting ACK),
   *   `"ack"` (caller agrees with the active pre-decision), or
   *   `"object"` (caller disagrees; rationale required).
   * - Posting `kind === "pre-decision"` requires the caller to be in
   *   `deciders` (FORBIDDEN otherwise). It implicitly invalidates any
   *   prior pre-decision's ACK round because the ACK gate only looks
   *   at responses with `ts > latest-pre-decision.ts`.
   * - Posting `kind === "ack"` or `"object"` requires the caller to
   *   be in `(voters ∪ deciders) − {pre-decider}` and that an active
   *   pre-decision exists.
   * - There is no status transition cascade. RFC status stays `open`.
   *   The `decideRfc` gate computes pending-pre-decide + outstanding
   *   ACKs at decide time.
   *
   * Prefer `preDecideRfc` / `ackRfc` / `objectRfc` for the structured
   * paths; this lower-level method exists for tests and a future
   * generic `--kind` flag.
   */
  commentRfc(input: {
    rfcId: string;
    /**
     * Plain discussion comments accept `"SYSTEM"` (no `GOJAJA_SESSION`)
     * so a human running the CLI can leave guidance on an RFC they
     * opened, mirroring `rfc new`'s SYSTEM path. Structured kinds
     * (`pre-decision` / `ack` / `object`) reject `"SYSTEM"`: those
     * carry a position and must be borne by a registered role.
     */
    role: RoleId | "SYSTEM";
    preferred: string;
    rationale: string;
    replyTo?: string | null;
    kind?: RfcCommentKind;
  }): Promise<RfcComment>;

  /**
   * add a new option to an open or revising RFC. Any role with a
   * session may add (the discussion is collaborative). Refused in
   * terminal states (`accepted`, `rejected`, `superseded`).
   *
   * if there is an active pre-decision, calling this
   * silently invalidates that pre-decision (the ACK round becomes
   * moot because voters were ACKing a now-outdated option set).
   * The decider can re-issue `preDecideRfc` to start a fresh round.
   * The existing `RFC_OPTION_ADDED` event provides the audit signal.
   */
  addRfcOption(input: {
    rfcId: string;
    actor: RoleId;
    optionId: string;
    summary: string;
    rationale: string;
  }): Promise<RfcOption>;

  /**
   * post a pre-decision. Thin wrapper over `commentRfc` with
   * `kind: "pre-decision"`. Decider gate (FORBIDDEN otherwise);
   * validates `chosenOption` exists. Returns the just-written comment
   * so callers can echo its id.
   *
   * RFC status remains `open` — pre-decision is metadata on a
   * comment, not a state transition. The `decideRfc` ACK gate is
   * what enforces "all required roles must respond before deciding".
   */
  preDecideRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    chosenOption: string;
    rationale: string;
  }): Promise<RfcComment>;

  /**
   * record an explicit ACK to the active pre-decision.
   * Caller must be in `(voters ∪ deciders) − {pre-decider}`. Rationale
   * is optional (a bare "yes" is meaningful). Refuses if no active
   * pre-decision exists or if the caller is the pre-decider.
   */
  ackRfc(input: {
    rfcId: string;
    role: RoleId;
    rationale?: string;
  }): Promise<RfcComment>;

  /**
   * record an explicit objection to the active pre-decision.
   * Same caller-set + active-required gates as `ackRfc`. Rationale
   * required. `preferredOption` is the option the objector would
   * rather the decider pick; may be empty if they have no preference
   * (just "not C").
   */
  objectRfc(input: {
    rfcId: string;
    role: RoleId;
    rationale: string;
    preferredOption?: string;
  }): Promise<RfcComment>;

  /**
   * Withdraw the active pre-decision. Caller must be the role that
   * posted that pre-decision (decider self-revoke); appends a
   * `kind: "withdraw"` comment which `computeActivePreDecisionInLedger`
   * reads back to clear the active state. Existing ack / object
   * comments stay in the ledger but are no longer counted (they
   * predate any future pre-decision's `ts`, so the standard
   * `c.ts > active.ts` gate naturally invalidates them).
   *
   * Refuses with USAGE if there is no active pre-decision or with
   * ForbiddenError if the caller is not its author. There is no
   * "undo a withdraw" — to re-propose, post a fresh `pre-decide`.
   */
  withdrawRfcPreDecision(input: {
    rfcId: string;
    role: RoleId;
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
    /**
     * Option id to lock in. Required when the proposal has at least
     * one option; must be empty / null for brainstorm-mode RFCs
     * (proposal.options.length === 0), in which case the decision
     * carries the takeaway via `rationale` alone.
     */
    chosenOption: string | null;
    rationale: string;
  }): Promise<RfcDecision>;

  /** Reject an RFC. Same deciders gate. Emits `RFC_DECIDED` with `outcome=rejected`. */
  rejectRfc(input: {
    rfcId: string;
    decidedBy: RoleId;
    rationale: string;
  }): Promise<RfcDecision>;

  /**
   * kick an RFC back to the creator for rewrite. Decider gate.
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
   * update an RFC in `revising` state and re-open it. The actor
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
   * attach a task id to the RFC's `relatedTasks` list. The task
   * must exist in `state/task_board.yaml`. Idempotent — adding an
   * already-linked id is a no-op (still returns the proposal).
   */
  linkTaskToRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal>;

  /** counterpart to `linkTaskToRfc`. Idempotent. */
  unlinkTaskFromRfc(input: {
    rfcId: string;
    actor: RoleId;
    taskId: string;
  }): Promise<RfcProposal>;

  /**
   * mark this role as having seen all comments up to the
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
   * resolve inside `.gojaja/` (no `..` escapes), and must appear in
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

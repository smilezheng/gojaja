import type { CursorState, Event, SessionInfo } from "./types";

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

  touchHeartbeat(role: string, sessionId: string): Promise<void>;
}

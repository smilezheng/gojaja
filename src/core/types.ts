/**
 * Shared types for the multi-agent coordination layer.
 *
 * All persisted records use plain JSON-serialisable shapes so they can move
 * unchanged across a future HTTP transport.
 */

export type RoleId = string;

/** Canonical event types emitted into comms/events/. */
export type EventType =
  | "REPORT"
  | "WORKLOG"
  | "TASK_CREATED"
  | "TASK_ASSIGNED"
  | "TASK_STATUS_CHANGED"
  | "RFC_CREATED"
  | "RFC_COMMENT"
  | "RFC_DECIDED"
  | "RFC_REPAIRED"
  | "SESSION_CLAIMED"
  | "SESSION_RELEASED"
  | "SESSION_TAKEOVER"
  | "ROLE_DELETED"
  | "LOCK_BROKEN"
  | "SYSTEM";

export interface Event {
  /** ULID, lexicographically sortable by creation time. */
  id: string;
  /** ISO-8601 UTC timestamp. */
  ts: string;
  type: EventType;
  /** Role that emitted the event, or "SYSTEM". */
  from: RoleId | "SYSTEM";
  /** Destination role, or "*" for broadcast. */
  to: RoleId | "*";
  /** Optional reference id (RFC id, task id, etc.). */
  ref?: string;
  /** Structured payload; shape depends on `type`. */
  payload: Record<string, unknown>;
}

/** Per-role consumer cursor. */
export interface CursorState {
  role: RoleId;
  /** ULID of the last event that has been processed, "" before first ack. */
  ackedThrough: string;
  /** ULID of an outstanding manifest awaiting ack, or null. */
  pendingManifest: string | null;
  updatedAt: string;
}

/**
 * Compact identity + protocol reminder for a role. Embedded into every
 * manifest so a context-compressed agent can re-anchor itself simply by
 * re-running `agentctl plan` — without paying the cost of a full role
 * file read on every turn.
 *
 * Fields are omitted when empty (e.g. an empty `owns` list is not
 * serialised) to keep agent prompts tight.
 */
export interface RoleReminder {
  id: RoleId;
  title: string;
  /** Files this role may write. Omitted if empty. */
  owns?: string[];
  /** Files this role must not write. Omitted if empty. */
  mustNotEdit?: string[];
  /** Default report recipients. Omitted if empty. */
  reportsTo?: RoleId[];
  /** One-line protocol summary; identical for every role. */
  protocol: string;
}

/**
 * The canonical protocol one-liner. Kept very short by design — it ships in
 * every manifest and we do not want to inflate agent prompts.
 */
export const PROTOCOL_ONE_LINER =
  "Loop: plan -> ack --token <t> -> wait. All writes via agentctl; never hand-edit .multi-agent/.";

/**
 * Snapshot of work pending for a role, produced by `plan` and consumed by
 * `ack`. The manifest is the only thing that can advance a cursor: ack
 * never reads "current latest event", it only advances to
 * `advanceCursorTo`. This pins down exactly which events the agent has
 * been shown and prevents the v0.1 "ack races concurrent writes" loss.
 */
export interface Manifest {
  /** ULID, also the file name under comms/pending/<role>/. */
  ackToken: string;
  role: RoleId;
  generatedAt: string;
  /**
   * The ULID the cursor will be set to on successful ack. May be larger
   * than the largest event id in `events` when the manifest also covers
   * filtered-out events (e.g. ones the role sent itself).
   */
  advanceCursorTo: string;
  /** Pre-cursor event id (the value of cursor.ackedThrough at plan time). */
  fromCursor: string;
  /** All events the role should attend to, oldest first. */
  events: Event[];
  /** Self-anchoring identity + protocol summary. */
  roleReminder: RoleReminder;
  /**
   * Tasks currently requiring this role's attention. Tasks are owned by
   * exactly one role; this list is filtered by `owner == role` AND
   * `status ∈ ACTIVE_TASK_STATUSES`. Minimal fields by design — call
   * `agentctl task show <id>` for the full record.
   */
  tasks: TaskSummary[];
  /**
   * Open RFCs that need this role's action. Includes:
   *   - voter: role is in `voters` and has not commented yet,
   *   - decider: role is in `deciders`, until the RFC is closed.
   */
  rfcs: RfcSummary[];
}

/** Payload shape for type=REPORT events. */
export interface ReportPayload {
  message: string;
}

/** Payload shape for type=WORKLOG events. */
export interface WorklogPayload {
  message: string;
}

/**
 * Per-role configuration. The single source of truth for ownership,
 * reporting structure, and any field that later commands (write-state,
 * role reminder, RFC voter lists) consume programmatically. The markdown
 * file under `roles/<id>.md` is for humans and the agent prompt; this
 * structured record is for the machine.
 */
export interface RoleConfig {
  title: string;
  description: string;
  /** Relative file paths the role is allowed to write. Enforced in PR7. */
  owns: string[];
  /** Roles this one should send REPORTs to by default. Advisory in PR3. */
  reportsTo: RoleId[];
  /** Relative file paths the role must not write. Advisory in PR3. */
  mustNotEdit: string[];
}

export interface ProjectConfig {
  schemaVersion: string;
  roles: Record<RoleId, RoleConfig>;
  /**
   * Auto-allocator for RFC ids. Persisted in config.yaml (alongside roles)
   * because RFC dirs live under `rfcs/` and the file-system itself is not
   * a reliable counter (deleted RFC ids would be reused otherwise).
   */
  rfcCounter?: number;
}

/**
 * Task lifecycle states. The framework does not enforce transitions in
 * v2; any role with write access may set any status. A more constrained
 * state machine arrives with PR7 ownership enforcement if that proves
 * necessary in practice.
 */
export type TaskStatus =
  | "Backlog"
  | "Ready"
  | "InProgress"
  | "Blocked"
  | "Review"
  | "Done";

export const TASK_STATUSES: ReadonlyArray<TaskStatus> = [
  "Backlog",
  "Ready",
  "InProgress",
  "Blocked",
  "Review",
  "Done",
];

/**
 * The set of statuses we consider "actively requiring the owner's
 * attention" — used to filter the per-role manifest. Backlog and Done
 * fall outside this set: Backlog is product/PM space, Done is history.
 */
export const ACTIVE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "Ready",
  "InProgress",
  "Blocked",
  "Review",
]);

export interface Task {
  /** `T-NNNN` (zero-padded, 4 digits minimum). Auto-assigned by the store. */
  id: string;
  title: string;
  status: TaskStatus;
  owner: RoleId | null;
  /** "P0" | "P1" | "P2" | "P3" — string-typed to allow project extensions. */
  priority: string;
  /** Other task ids this depends on. */
  dependsOn: string[];
  /** Multi-line acceptance criteria; free-form prose. */
  acceptance: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBoard {
  schemaVersion: string;
  /**
   * Last assigned numeric id. Stored separately from the tasks map so
   * deleting a task does not allow id reuse.
   */
  nextId: number;
  /** Tasks keyed by id for O(1) lookup; YAML preserves insertion order. */
  tasks: Record<string, Task>;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  /** Subset of dependsOn that are not yet `Done`. */
  blockedBy: string[];
}

/** Payload shape for type=TASK_CREATED events. */
export interface TaskCreatedPayload {
  taskId: string;
  title: string;
  owner: RoleId | null;
  priority: string;
}

/** Payload shape for type=TASK_ASSIGNED events. */
export interface TaskAssignedPayload {
  taskId: string;
  previousOwner: RoleId | null;
  newOwner: RoleId;
}

/** Payload shape for type=TASK_STATUS_CHANGED events. */
export interface TaskStatusChangedPayload {
  taskId: string;
  previousStatus: TaskStatus;
  newStatus: TaskStatus;
}

/**
 * RFC lifecycle. Intentionally minimal:
 *
 *   open        -> accepted | rejected
 *   accepted    -> (terminal in v2; superseded via a future v2.x command)
 *   rejected    -> (terminal)
 *
 * The state machine is enforced; transitions outside this graph are
 * refused. We deliberately do NOT auto-compute acceptance from comments:
 * `decide` and `reject` are explicit acts by a role in the deciders list.
 */
export type RfcStatus = "open" | "accepted" | "rejected" | "superseded";

export interface RfcOption {
  /** Short id like "A" / "B" / "stay-on-sqlite". */
  id: string;
  summary: string;
}

export interface RfcProposal {
  id: string;
  slug: string;
  title: string;
  status: RfcStatus;
  /** Roles that SHOULD comment. Advisory; non-voters may still comment. */
  voters: RoleId[];
  /** Roles that MAY call `rfc decide` or `rfc reject`. Enforced. */
  deciders: RoleId[];
  options: RfcOption[];
  /** Informational; the framework does not auto-expire RFCs. */
  deadline: string | null;
  createdAt: string;
  /** Role or "SYSTEM" — recorded as the event's `from`. */
  createdBy: RoleId | "SYSTEM";
}

export interface RfcComment {
  rfcId: string;
  role: RoleId;
  ts: string;
  /** Preferred option id. May be empty if the commenter has no preference. */
  preferred: string;
  rationale: string;
}

export interface RfcDecision {
  rfcId: string;
  /** Role of the decider. */
  decidedBy: RoleId;
  ts: string;
  /** "accepted" | "rejected"; superseded handled via separate command. */
  outcome: "accepted" | "rejected";
  /** Chosen option id when accepted; null when rejected. */
  chosenOption: string | null;
  rationale: string;
}

/** Payload shape for RFC_CREATED events. */
export interface RfcCreatedPayload {
  rfcId: string;
  title: string;
  voters: RoleId[];
  deciders: RoleId[];
}

/** Payload shape for RFC_COMMENT events. */
export interface RfcCommentPayload {
  rfcId: string;
  role: RoleId;
  preferred: string;
  rationale: string;
}

/** Payload shape for RFC_DECIDED events. */
export interface RfcDecidedPayload {
  rfcId: string;
  decidedBy: RoleId;
  outcome: "accepted" | "rejected";
  chosenOption: string | null;
  rationale: string;
}

export interface RfcSummary {
  id: string;
  title: string;
  status: RfcStatus;
  /** This role's expected involvement; precomputed to avoid client logic. */
  role: "voter" | "decider";
  /** Whether the role has already left a comment. */
  commented: boolean;
}

/** Role lease metadata. */
export interface SessionInfo {
  role: RoleId;
  sessionId: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  /** Soft TTL after which other claimers may take over. */
  leaseTtlSeconds: number;
}

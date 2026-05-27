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
  | "RFC_CREATED"
  | "RFC_COMMENT"
  | "RFC_DECIDED"
  | "SESSION_CLAIMED"
  | "SESSION_RELEASED"
  | "SESSION_TAKEOVER"
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

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

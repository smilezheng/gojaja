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
  | "RFC_OPTION_ADDED"
  | "RFC_REVISION_REQUESTED"
  | "RFC_REVISED"
  | "RFC_TASK_LINKED"
  | "RFC_TASK_UNLINKED"
  /**
   * Auto-emitted by the framework when an RFC has accumulated a
   * regular discussion comment from every required commenter
   * (`(voters ∪ deciders) − {createdBy if not SYSTEM}`) and has no
   * active pre-decision yet. Tells deciders "discussion has covered
   * the room; you can now `rfc pre-decide`". Re-emitted if a fresh
   * comment lands after the previous READY-event (and before any
   * pre-decision is posted), so a late voter still gets the chance
   * to be heard. Suppressed once a pre-decision is active. See
   * PROTOCOL.md → RFC v2 for the full state machine.
   */
  | "RFC_READY_TO_DECIDE"
  | "TASK_DELIVERABLE_BYPASSED"
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
 * re-running `gojaja plan` — without paying the cost of a full role
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
  "Loop: plan -> ack <t> -> wait. " +
  "Lost your role? Run `gojaja role show <you>`. " +
  "Writes via gojaja only; never hand-edit .gojaja/.";

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
   * `gojaja task show <id>` for the full record.
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
  /**
   * Optional sub-classification.
   *
   * - undefined (default) — regular worklog: a substantive progress
   *   update meant for the whole team. Visible to every role's
   *   manifest (the original WORKLOG visibility rule).
   * - `"idle"` — auto-emitted by `gojaja wait --for task-assigned` at
   *   session open, telling task-board owners "this role is free,
   *   give it work". An idle worklog has no informational value to
   *   peer roles who are themselves idle; broadcasting it to
   *   everyone caused mutual-wakeup loops between idle agents.
   *   `filterVisibleEventsForRole` therefore narrows
   *   `kind: "idle"` worklogs to task-board owners only.
   */
  kind?: "idle";
}

/**
 * Per-role configuration. The single source of truth for ownership,
 * reporting structure, and any field that later commands (state edit,
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

/**
 * Maximum depth of the `parent` chain. `createTask` refuses anything
 * that would create a chain longer than this. Five layers cover
 * CTO -> PM -> epic -> story -> subtask; deeper trees usually mean a
 * task that should be split into siblings, not nested.
 */
export const MAX_TASK_DEPTH = 5;

/**
 * Pointer to a reference material the task owner needs to read to do
 * the work. Pure information; framework never auto-resolves URLs or
 * requires files to exist.
 *   - kind="file" : repo-relative path; refused if the path tries to
 *     escape the repo via `..`. NOT refused for not-yet-existing files.
 *   - kind="url"  : opaque external link; framework treats as a string.
 */
export interface TaskAsset {
  kind: "file" | "url";
  ref: string;
  description: string;
}

/**
 * Hard output the task MUST produce before it can be marked Done.
 *   - kind="file"   : repo-relative path. `setTaskStatus(... Done)`
 *     refuses unless the path exists on disk; `--force-incomplete`
 *     bypasses with a logged `TASK_DELIVERABLE_BYPASSED` event.
 *   - kind="url"    : URL that must be produced (Figma link, etc.).
 *     Framework cannot verify; renderer marks it as unverifiable.
 *   - kind="manual" : free-text requirement (e.g. "post a design link
 *     in worklog"). Framework only displays; no verification.
 */
export interface Deliverable {
  kind: "file" | "url" | "manual";
  ref: string;
  description: string;
}

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

  /**
   * Parent task id, or null for top-level tasks. Forms a tree; cycles
   * and chains longer than `MAX_TASK_DEPTH` are refused at write time.
   * Status is INTENTIONALLY not auto-propagated to/from parent.
   */
  parent: string | null;
  /**
   * Role that originally created the task. `"SYSTEM"` for tasks
   * created by the CLI with no active session. Immutable after
   * creation — `assignTask` does NOT update it; reassignment history
   * lives in the event stream.
   */
  creator: RoleId | "SYSTEM";
  /** Reference materials (design docs, Figma links, ...). */
  assets: TaskAsset[];
  /** Required outputs; file-kind entries are gated on Done. */
  deliverables: Deliverable[];
  /** Free-form labels for filtering / grouping. */
  tags: string[];

  /**
   * Roles authorised to mark this task `Done` even when they are not
   * the task's owner. Reviewers are also automatic stakeholders for
   * the task's lifecycle — `TASK_STATUS_CHANGED` events surface to
   * them in their manifest without the owner needing to send an
   * explicit report.
   *
   * Empty array means "no review hop"; the task-board-owner role
   * remains a fallback for sign-off.
   */
  reviewers: RoleId[];
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

  // ---- Task-tree fields (omitted in JSON when empty / N/A) ----

  /** Parent task id, when this task is a subtask. */
  parent?: string;
  /**
   * Per-status counts of this task's immediate children. Only attached
   * to summaries of tasks that have at least one child, so leaf tasks
   * stay tight.
   */
  childCounts?: {
    ready: number;
    inProgress: number;
    blocked: number;
    review: number;
    done: number;
  };
  /**
   * Number of `kind: "file"` deliverables whose `ref` does not exist on
   * disk at manifest-generation time. Zero = omitted. Lets epic owners
   * see "still missing 2 hard outputs" without opening every task.
   */
  unmetDeliverables?: number;
  /** Tags, when non-empty. */
  tags?: string[];
  /** Reviewers list, when non-empty. Lets the agent see at a glance
   *  who can mark the task Done besides themselves. */
  reviewers?: RoleId[];
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
 * Payload for `TASK_DELIVERABLE_BYPASSED` events. Emitted by
 * `setTaskStatus` immediately BEFORE the `TASK_STATUS_CHANGED` event
 * when `--force-incomplete` is used to mark a task Done while one or
 * more `kind: "file"` deliverables are still missing on disk. The
 * event is the durable audit record of "this approval was knowingly
 * given".
 */
export interface TaskDeliverableBypassedPayload {
  taskId: string;
  /** Repo-relative paths that were checked and not found. */
  missing: string[];
  /** Role that ran the bypass. SYSTEM for CLI-only operators. */
  by: RoleId | "SYSTEM";
}

/**
 * RFC lifecycle:
 *
 *   open ─── rfc comment / ack / object / add-option / pre-decide (comment) ──▶ open
 *   open ─── rfc decide (ACK gate) ──▶ accepted (terminal)
 *   open ─── rfc reject ──▶ rejected (terminal; the only escape from an
 *                                    ACK-stalled pre-decision)
 *   open ─── rfc revise ──▶ revising
 *   revising ─── rfc edit ──▶ open
 *   revising ─── rfc reject ──▶ rejected (terminal)
 *
 * Pre-decide is a structured `kind: "pre-decision"` comment, not a
 * status. Consensus is enforced via a strict ACK gate inside
 * `decideRfc`, not via state transitions. See docs/RFC.md.
 */
export type RfcStatus =
  | "open"
  | "revising"
  | "accepted"
  | "rejected"
  | "superseded";

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

  /**
   * Free-form context. The creator is responsible for making the RFC
   * legible to anyone who has not been in the conversation: problem
   * statement, constraints, what the options actually entail. Decider
   * is expected to `rfc revise` if this is too thin to act on.
   *
   * Soft-required: a warning is printed if empty. A future release
   * will promote this to a hard requirement.
   */
  description: string;

  /**
   * Tasks this RFC is decided in the context of. Lets voters/deciders
   * pull up the affected work via `gojaja task show <id>`.
   * Validated against `state/task_board.yaml` at write time.
   */
  relatedTasks: string[];
}

/**
 * A comment carries one of three structured "kinds" that drive the
 * ACK gate, or no kind at all (regular discussion).
 */
export type RfcCommentKind = "pre-decision" | "ack" | "object" | "withdraw";

export interface RfcComment {
  /**
   * Globally-unique ULID, used as the target of `replyTo` and as the
   * read-cursor anchor in `comms/cursors/<role>/rfc-<id>.json`.
   */
  id: string;
  rfcId: string;
  /**
   * Author of the comment. Plain discussion comments may carry
   * `"SYSTEM"` (a human running the CLI without `GOJAJA_SESSION`,
   * symmetric to `rfc new`'s `createdBy: "SYSTEM"`). Structured kinds
   * (`pre-decision` / `ack` / `object`) reject `"SYSTEM"` at the
   * store layer because they require a role to bear the position.
   */
  role: RoleId | "SYSTEM";
  ts: string;
  /**
   * Preferred option id. May be empty if the commenter has no
   * preference. For `kind === "ack"`, this is forced to match the
   * active pre-decision's `chosenOption`.
   */
  preferred: string;
  /**
   * `null` = reply to the RFC root.
   * Otherwise = id of another comment in the same RFC's `comments.yaml`.
   */
  replyTo: string | null;
  rationale: string;
  /**
   * Structured kind. Undefined/absent on a regular discussion comment.
   * Only `ack` and `object` comments count toward the `decideRfc` ACK
   * gate; a regular comment from a required role does NOT advance the
   * gate (you must explicitly state your position via `rfc ack` or
   * `rfc object`).
   */
  kind?: RfcCommentKind;
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
  /** See `RfcComment.role` — `"SYSTEM"` allowed for plain comments only. */
  role: RoleId | "SYSTEM";
  preferred: string;
  rationale: string;
  /** Lets `grep payload.kind` find pre-decision / ack / object posts. */
  kind?: RfcCommentKind;
  commentId?: string;
  replyTo?: string | null;
}

/** Payload shape for RFC_DECIDED events. */
export interface RfcDecidedPayload {
  rfcId: string;
  decidedBy: RoleId;
  outcome: "accepted" | "rejected";
  chosenOption: string | null;
  rationale: string;
}

/**
 * Payload shape for RFC_READY_TO_DECIDE events.
 *
 * Carries the snapshot of who satisfied the comment-coverage gate so
 * downstream consumers (dashboards, audit, future `gojaja doctor`)
 * can render "this RFC reached pre-decide-able after roles X, Y, Z
 * had all weighed in" without re-reading the whole comments ledger.
 */
export interface RfcReadyToDecidePayload {
  rfcId: string;
  /**
   * Roles whose plain `rfc comment` participation made this RFC
   * pre-decide-able. Equals `(voters ∪ deciders) − {createdBy if not
   * SYSTEM}` at the moment the event was emitted.
   */
  requiredCommenters: RoleId[];
}

// ---- RFC event payloads ------------------------------------------------

export interface RfcOptionAddedPayload {
  rfcId: string;
  optionId: string;
  summary: string;
  addedBy: RoleId;
  rationale: string;
}

export interface RfcRevisionRequestedPayload {
  rfcId: string;
  requestedBy: RoleId;
  rationale: string;
}

export interface RfcRevisedPayload {
  rfcId: string;
  revisedBy: RoleId;
  rationale: string;
  changed: Array<"title" | "description" | "options" | "deadline">;
}

export interface RfcTaskLinkChangePayload {
  rfcId: string;
  taskId: string;
  by: RoleId;
}

export interface RfcSummary {
  id: string;
  title: string;
  status: RfcStatus;
  /** This role's expected involvement; precomputed to avoid client logic. */
  role: "voter" | "decider";
  /** Whether the role has already left at least one comment. */
  commented: boolean;
  /**
   * Number of comments newer than this role's last `rfc show` of this
   * RFC (per-role read marker in `comms/cursors/<role>/rfc-<id>.json`).
   * Lets the agent prioritise RFCs with new discussion.
   */
  unreadComments: number;
  /** Tasks linked to this RFC (resolved-against-task-board ids). */
  relatedTasks: string[];
  /**
   * Present iff a `kind: "pre-decision"` comment is the latest
   * pre-decision AND has no subsequent `RFC_OPTION_ADDED` event
   * invalidating it. Tells voters / non-pre-decider deciders what
   * has been proposed AND who is still expected to ack / object.
   *
   * Silence does NOT count as consent — `decideRfc` is gated on
   * `awaitingAckFrom` being empty.
   */
  pendingPreDecision?: {
    decidedBy: RoleId;
    chosenOption: string;
    ts: string;
    rationale: string;
    /**
     * Roles in `(voters ∪ deciders) − {decidedBy}` who have NOT yet
     * posted a `kind: ack` or `kind: object` comment after `ts`.
     * `decideRfc` refuses until this is empty.
     */
    awaitingAckFrom: RoleId[];
    /**
     * True iff THIS role is in the required-ACK set and hasn't yet
     * responded. Lets the agent decide whether the next move is
     * `rfc ack` / `rfc object`.
     */
    myAckOwed: boolean;
  };
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

// ---- wait-until ----------------------------------------------------------

/**
 * The "what am I waiting for" predicate selector. `attention` triggers
 * an ATTENTION exit on any visible event for the role; the rest trigger
 * a CONDITION_MET exit on a more specific match. See `evaluateWaitCondition`
 * in `local-fs-store.ts` for the per-kind predicate body.
 */
export type WaitConditionKind =
  | "attention"
  | "rfc-decided"
  | "rfc-acked"
  | "task-assigned"
  | "report-from"
  | "event-ref";

export interface WaitCondition {
  kind: WaitConditionKind;
  /**
   * Auxiliary reference. Meaning depends on `kind`:
   *   - `rfc-decided`, `rfc-acked`: RFC id (`RFC-NNNN`).
   *   - `report-from`: sender role id.
   *   - `event-ref`: arbitrary event `ref` string.
   *   - `attention`, `task-assigned`: unused (must be absent).
   */
  ref?: string;
}

/**
 * Persisted at `comms/pending/<role>/wait.json`. Written when a wait
 * session opens; cleared on a terminal verdict (ATTENTION /
 * CONDITION_MET / TIMEOUT).
 *
 * Two purposes:
 *   1. Let a `wait` re-invoked with no deadline flags resume the SAME
 *      deadline + condition after the host harness killed the prior
 *      blocking call, and de-duplicate the `--for task-assigned` idle
 *      worklog broadcast across such a resume.
 *   2. Make "who is waiting for what until when" externally observable
 *      (PR9 `gojaja doctor`).
 */
export interface WaitState {
  role: RoleId;
  /** ISO-8601 UTC deadline, or `null` for an indefinite wait. */
  deadline: string | null;
  for: WaitCondition;
  /** ISO-8601 UTC; recorded when the session opened. */
  startedAt: string;
  /** Cursor value at session start, used by the doctor for diagnostics. */
  ackedThroughAtStart: string;
  /** True once the idle worklog has been posted (only used with task-assigned). */
  idleBroadcastSent: boolean;
}

/**
 * Terminal verdicts produced by `gojaja wait`. A single `wait` call
 * blocks (polling internally) until one of these fires — there is no
 * voluntary "resume" exit; the call only ends early if the host harness
 * kills it, in which case the agent re-runs `gojaja wait` to continue.
 */
export type WaitStatus = "attention" | "condition_met" | "timeout";

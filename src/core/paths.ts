import * as path from "node:path";
import { PathValidationError } from "./errors";

/**
 * Canonical relative path layout inside the .multi-agent directory.
 *
 * Anything not enumerated here is not part of the contract. Commands must go
 * through these helpers so that all path concatenation happens in one place,
 * and so the future HTTP transport can swap the on-disk root for a remote
 * resource id without command-layer changes.
 */
export const Paths = {
  versionFile: "VERSION",
  configFile: "config.yaml",
  auditLog: "audit.log",
  taskBoardFile: "state/task_board.yaml",
  projectStateFile: "state/project_state.md",

  protocolDir: "protocol",
  rolesDir: "roles",
  stateDir: "state",
  commsDir: "comms",
  rfcsDir: "rfcs",
  worklogDir: "worklog",
  locksDir: "locks",

  eventsDir: "comms/events",
  cursorsDir: "comms/cursors",
  pendingDir: "comms/pending",
  sessionsDir: "comms/sessions",
  heartbeatsDir: "comms/heartbeats",
} as const;

export function rolePaths(role: string) {
  return {
    roleFile: path.posix.join(Paths.rolesDir, `${role}.md`),
    cursorFile: path.posix.join(Paths.cursorsDir, `${role}.json`),
    pendingDir: path.posix.join(Paths.pendingDir, role),
    sessionFile: path.posix.join(Paths.sessionsDir, `${role}.json`),
    heartbeatFile: path.posix.join(Paths.heartbeatsDir, `${role}.json`),
    worklogDir: path.posix.join(Paths.worklogDir, role),
    lockFile: path.posix.join(Paths.locksDir, `role-${role}.lock`),
  };
}

export function manifestPath(role: string, ackToken: string): string {
  return path.posix.join(Paths.pendingDir, role, `${ackToken}.json`);
}

export function eventPath(eventId: string): string {
  return path.posix.join(Paths.eventsDir, `${eventId}.json`);
}

export function worklogEntryPath(role: string, eventId: string): string {
  return path.posix.join(Paths.worklogDir, role, `${eventId}.md`);
}

/**
 * Sentinel written by `agentctl wait --mode exit`. Its presence means the
 * role's window has voluntarily yielded between turns and is waiting for
 * an external trigger to resume.
 */
export function waitSentinelPath(role: string): string {
  return path.posix.join(Paths.pendingDir, role, ".wait");
}

export function rfcDir(rfcId: string, slug: string): string {
  return path.posix.join(Paths.rfcsDir, `${rfcId}-${slug}`);
}

export function rfcProposalPath(rfcId: string, slug: string): string {
  return path.posix.join(rfcDir(rfcId, slug), "proposal.yaml");
}

/**
 * PR8g: comments moved from per-role JSON files
 * (`comments/<role>.json`) to a single threaded ledger
 * (`comments.yaml`) per RFC. The legacy per-role directory is detected
 * on read and reported as a clear migration error — alpha-only hard
 * cut, no auto-migrator.
 */
export function rfcCommentsFile(rfcId: string, slug: string): string {
  return path.posix.join(rfcDir(rfcId, slug), "comments.yaml");
}

/**
 * Pre-PR8g layout. Kept only so the back-compat detector can name the
 * directory in its error message. Never used for new writes.
 */
export function rfcLegacyCommentsDir(rfcId: string, slug: string): string {
  return path.posix.join(rfcDir(rfcId, slug), "comments");
}

export function rfcDecisionPath(rfcId: string, slug: string): string {
  return path.posix.join(rfcDir(rfcId, slug), "decision.json");
}

/**
 * Per-role-per-RFC read cursor for PR8g `unreadComments` accounting.
 * Updated whenever the role calls `rfc show <id>` (unless --no-mark-seen).
 */
export function rfcReadCursorPath(role: string, rfcId: string): string {
  return path.posix.join(Paths.cursorsDir, role, `rfc-${rfcId}.json`);
}

/**
 * Resolve a relative path against a root, refusing anything that escapes the
 * root via `..` or absolute components. All command-layer path construction
 * MUST go through this so user/agent input can never reach `fs.*` directly.
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new PathValidationError("Empty relative path.");
  }
  if (path.isAbsolute(rel)) {
    throw new PathValidationError(`Absolute paths are not allowed: ${rel}`);
  }
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(absRoot, rel);
  const relFromRoot = path.relative(absRoot, absTarget);
  if (
    relFromRoot.startsWith("..") ||
    path.isAbsolute(relFromRoot) ||
    relFromRoot.split(path.sep).includes("..")
  ) {
    throw new PathValidationError(
      `Path '${rel}' resolves outside of '${absRoot}'.`,
    );
  }
  return absTarget;
}

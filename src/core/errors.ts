/**
 * Typed errors. The CLI maps each class to a stable exit code so callers
 * (LLM agents and external tooling) can branch deterministically.
 */

export type ExitCode = number;

export class AgentctlError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;

  constructor(code: string, message: string, exitCode: ExitCode = 1) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends AgentctlError {
  constructor(message: string) {
    super("USAGE", message, 2);
  }
}

export class NotInitializedError extends AgentctlError {
  constructor(root: string) {
    super(
      "NOT_INITIALIZED",
      `No .multi-agent layer found at ${root}. Run 'agentctl init' first.`,
      3,
    );
  }
}

export class AlreadyInitializedError extends AgentctlError {
  constructor(root: string) {
    super(
      "ALREADY_INITIALIZED",
      `.multi-agent layer already exists at ${root}. Use 'agentctl upgrade' or 'agentctl reset' instead.`,
      4,
    );
  }
}

export class UnknownRoleError extends AgentctlError {
  constructor(role: string) {
    super("UNKNOWN_ROLE", `Unknown role: ${role}`, 5);
  }
}

export class LockTimeoutError extends AgentctlError {
  constructor(key: string, waitedMs: number) {
    super(
      "LOCK_TIMEOUT",
      `Timed out after ${waitedMs}ms waiting for lock '${key}'.`,
      6,
    );
  }
}

export class PathValidationError extends AgentctlError {
  constructor(message: string) {
    super("PATH_INVALID", message, 7);
  }
}

export class StateCorruptionError extends AgentctlError {
  constructor(message: string) {
    super("STATE_CORRUPT", message, 8);
  }
}

/**
 * Raised when a caller is authenticated but lacks the configured
 * permission to perform a write. Distinct from UsageError so scripts and
 * agents can distinguish "you said it wrong" from "you are not allowed".
 */
export class ForbiddenError extends AgentctlError {
  constructor(message: string) {
    super("FORBIDDEN", message, 9);
  }
}

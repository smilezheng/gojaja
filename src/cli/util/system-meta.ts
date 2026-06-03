import * as os from "node:os";
import type { SystemActorMeta } from "../../core/types";

/**
 * Collect forensic metadata about the current process for stamping
 * onto `actorMeta` of any event emitted with `from: "SYSTEM"` (PR9
 * SYSTEM-2).
 *
 * Threat model context: `--as-system` (SYSTEM-1) made the bypass
 * explicit but doesn't tell an auditor WHICH process invoked it. If
 * an agent later turns out to have escalated, the audit log needs
 * enough breadcrumbs to identify the originating shell — pid + ppid
 * + cwd + hostname + user + tty give a credible trace without
 * depending on the host's history file (which agents can rewrite).
 *
 * No side effects. Safe to call repeatedly. All fields fall back to
 * sentinel strings rather than throwing — corruption of forensic
 * metadata must never block a legitimate SYSTEM operation.
 */
export function gatherSystemMeta(): SystemActorMeta {
  return {
    pid: process.pid,
    ppid: typeof process.ppid === "number" ? process.ppid : -1,
    cwd: safeCwd(),
    hostname: safeHostname(),
    user: safeUser(),
    tty: detectTty(),
  };
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return "(cwd-unavailable)";
  }
}

function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return "(hostname-unavailable)";
  }
}

function safeUser(): string {
  try {
    const info = os.userInfo();
    if (info.username && info.username.length > 0) return info.username;
  } catch {
    // fall through to env vars
  }
  return (
    process.env.USER ??
    process.env.LOGNAME ??
    process.env.USERNAME ??
    "(user-unknown)"
  );
}

/**
 * Best-effort TTY identifier:
 *   - `$SSH_TTY` if set (remote shell) — most informative.
 *   - "(local)" if stdin is a TTY but no SSH_TTY (local terminal).
 *   - "(non-tty)" otherwise (pipe / heredoc / agent shell / cron).
 *
 * Resolving the actual pty device path requires platform-specific
 * syscalls; the trade-off here is breadth (works on every platform
 * Node supports) over precision (no `/dev/pts/3`-level detail).
 */
function detectTty(): string {
  const ssh = process.env.SSH_TTY;
  if (ssh && ssh.trim().length > 0) return ssh.trim();
  if (process.stdin.isTTY) return "(local)";
  return "(non-tty)";
}

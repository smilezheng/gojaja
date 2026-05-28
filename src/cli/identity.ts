import { UsageError } from "../core/errors";
import type { Store } from "../core/store";
import type { RoleId, SessionInfo } from "../core/types";
import { validateRoleId } from "../core/role-id";

/**
 * Resolve the calling agent's identity for commands that need an
 * authenticated role.
 *
 * Resolution rules:
 *   1. If `GOJAJA_SESSION` is set in the environment, look it up in
 *      `comms/sessions/`. Missing or unknown → UsageError.
 *   2. If both `GOJAJA_SESSION` and an explicit role argument are present,
 *      they must agree; otherwise UsageError.
 *   3. If `GOJAJA_SESSION` is absent and `requireSession` is true → UsageError.
 *   4. If `GOJAJA_SESSION` is absent and only a role argument is given,
 *      validate the role name format but do not perform a session check.
 *      (Used by read-only or bootstrap commands like `init`.)
 */
export interface ResolvedIdentity {
  role: RoleId;
  session: SessionInfo | null;
}

export async function resolveIdentity(
  store: Store,
  opts: { explicitRole?: string; requireSession: boolean },
): Promise<ResolvedIdentity> {
  const envSession = process.env.GOJAJA_SESSION;
  if (envSession) {
    const session = await store.findSessionById(envSession);
    if (!session) {
      // findSessionById refuses BOTH "unknown session id" AND
      // "session past its lease". Both are auth failures; the message
      // is intentionally generic so an attacker probing for valid ids
      // cannot tell which case they triggered.
      throw new UsageError(
        `GOJAJA_SESSION='${envSession}' is not a live session. ` +
          `Either remove the env var, or run 'gojaja claim <role>' first.`,
      );
    }
    if (opts.explicitRole && opts.explicitRole !== session.role) {
      throw new UsageError(
        `Role argument '${opts.explicitRole}' does not match the role of ` +
          `GOJAJA_SESSION ('${session.role}'). Drop the argument, or unset GOJAJA_SESSION.`,
      );
    }
    // Auto-renew the lease on every authenticated command. Without this
    // a busy agent that never explicitly heartbeats gets its session
    // taken over the moment the default 30-minute TTL elapses. Failures
    // propagate (e.g. another window has just taken over the session) —
    // that is the correct behaviour: the caller's session is no longer
    // valid and downstream writes must not proceed.
    await store.touchHeartbeat(session.role, session.sessionId);
    return { role: session.role, session };
  }
  if (opts.requireSession) {
    throw new UsageError(
      "GOJAJA_SESSION is required for this command. Run 'gojaja claim <role>' first " +
        "and export the printed session id as GOJAJA_SESSION.",
    );
  }
  if (!opts.explicitRole) {
    throw new UsageError(
      "No role specified and GOJAJA_SESSION is unset. Pass the role as a positional " +
        "argument, or claim a role first.",
    );
  }
  validateRoleId(opts.explicitRole);
  return { role: opts.explicitRole, session: null };
}

/**
 * Helper for commands that accept either an authenticated agent (with
 * `GOJAJA_SESSION` set) OR a bare human invocation (no session → `"SYSTEM"`
 * bypass for bootstrap / repair).
 *
 * Critical semantic: if `GOJAJA_SESSION` is SET, resolution MUST succeed.
 * A stale or invalid token does NOT silently fall through to SYSTEM,
 * which would otherwise bypass every ownership check. The previous
 * pattern (`try { resolveIdentity(...) } catch { return "SYSTEM" }`) was
 * a silent privilege escalation in the face of token expiry.
 */
export async function resolveActor(
  store: Store,
): Promise<{ actor: RoleId | "SYSTEM" }> {
  if (process.env.GOJAJA_SESSION) {
    const { role } = await resolveIdentity(store, { requireSession: true });
    return { actor: role };
  }
  return { actor: "SYSTEM" };
}

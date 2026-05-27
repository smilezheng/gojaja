import { UsageError } from "../core/errors";
import type { Store } from "../core/store";
import type { RoleId, SessionInfo } from "../core/types";
import { validateRoleId } from "../core/role-id";

/**
 * Resolve the calling agent's identity for commands that need an
 * authenticated role.
 *
 * Resolution rules:
 *   1. If `MA_SESSION` is set in the environment, look it up in
 *      `comms/sessions/`. Missing or unknown → UsageError.
 *   2. If both `MA_SESSION` and an explicit role argument are present,
 *      they must agree; otherwise UsageError.
 *   3. If `MA_SESSION` is absent and `requireSession` is true → UsageError.
 *   4. If `MA_SESSION` is absent and only a role argument is given,
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
  const envSession = process.env.MA_SESSION;
  if (envSession) {
    const session = await store.findSessionById(envSession);
    if (!session) {
      throw new UsageError(
        `MA_SESSION='${envSession}' is not a known session. ` +
          `Either remove the env var, or run 'agentctl claim <role>' first.`,
      );
    }
    if (opts.explicitRole && opts.explicitRole !== session.role) {
      throw new UsageError(
        `Role argument '${opts.explicitRole}' does not match the role of ` +
          `MA_SESSION ('${session.role}'). Drop the argument, or unset MA_SESSION.`,
      );
    }
    return { role: session.role, session };
  }
  if (opts.requireSession) {
    throw new UsageError(
      "MA_SESSION is required for this command. Run 'agentctl claim <role>' first " +
        "and export the printed session id as MA_SESSION.",
    );
  }
  if (!opts.explicitRole) {
    throw new UsageError(
      "No role specified and MA_SESSION is unset. Pass the role as a positional " +
        "argument, or claim a role first.",
    );
  }
  validateRoleId(opts.explicitRole);
  return { role: opts.explicitRole, session: null };
}

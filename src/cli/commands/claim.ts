import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";

const DEFAULT_TTL_SECONDS = 1800; // 30 minutes

export async function runClaim(args: ParsedArgs): Promise<number> {
  const role = args.positional[0];
  if (!role) {
    throw new UsageError(
      "Usage: gojaja claim <role> [--ttl <seconds>] [--eval] [--json]",
    );
  }
  const ttlRaw = optionalString(args.flags, "ttl");
  const ttl = ttlRaw ? Number(ttlRaw) : DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new UsageError(`Invalid --ttl: ${ttlRaw}`);
  }
  const force = boolFlag(args.flags, "force");
  const json = boolFlag(args.flags, "json");
  const evalMode = boolFlag(args.flags, "eval");
  if (evalMode && json) {
    throw new UsageError("--eval and --json cannot be combined.");
  }
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());

  const store = await openStoreOrThrow(root);
  // Refuse claims for roles that are not registered. Without this check
  // a typo (`gojaja claim Forntend`) silently creates a "phantom" role
  // session that no other agent's manifest will ever route to, and the
  // agent ends up waiting forever for tasks it can never receive.
  const config = await store.readConfig();
  if (!config.roles[role]) {
    throw new UsageError(
      `Unknown role '${role}'. Create it first: gojaja role create ${role} "<title>"`,
    );
  }
  const session = await store.claimSession(role, ttl, force);

  if (evalMode) {
    // Step 4a: shell-eval-friendly output. Agent runs:
    //   eval "$(gojaja claim PM --eval)"
    // and the env var is exported in the current shell in one step.
    // Anything other than the export line (incl. trailing whitespace
    // ambiguities) breaks `eval`, so format is strict.
    process.stdout.write(`export GOJAJA_SESSION=${session.sessionId}\n`);
  } else if (json) {
    process.stdout.write(JSON.stringify({ status: "claimed", session }) + "\n");
  } else {
    process.stdout.write(
      `Claimed role '${session.role}' (session ${session.sessionId}, lease ${session.leaseTtlSeconds}s).\n` +
        `Export this in your shell so follow-up commands authenticate as ${session.role}:\n\n` +
        `  export GOJAJA_SESSION=${session.sessionId}\n\n` +
        `Tip: \`eval "$(gojaja claim ${session.role} --eval)"\` does this in one step.\n`,
    );
  }
  return 0;
}

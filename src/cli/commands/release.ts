import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";

export async function runRelease(args: ParsedArgs): Promise<number> {
  const explicitRole = args.positional[0];
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const { role, session } = await resolveIdentity(store, {
    explicitRole,
    requireSession: true,
  });
  if (!session) {
    throw new UsageError(
      `Could not resolve a live session for role '${role}'. Is MA_SESSION set correctly?`,
    );
  }

  await store.releaseSession(role, session.sessionId);

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "released",
        role,
        sessionId: session.sessionId,
        hint: "unset MA_SESSION",
      }) + "\n",
    );
  } else {
    // Step 10: include a concrete `unset` hint. Without it, the shell
    // still has the stale MA_SESSION exported and subsequent commands
    // in the same shell fail with "session not found", which agents
    // often mis-diagnose as a framework bug.
    process.stdout.write(
      `Released session ${session.sessionId} for role '${role}'.\n` +
        `Remember to unset MA_SESSION in this shell: \`unset MA_SESSION\`\n`,
    );
  }
  return 0;
}

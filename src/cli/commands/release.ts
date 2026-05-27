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
      JSON.stringify({ status: "released", role, sessionId: session.sessionId }) + "\n",
    );
  } else {
    process.stdout.write(`Released session ${session.sessionId} for role '${role}'.\n`);
  }
  return 0;
}

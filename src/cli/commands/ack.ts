import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import { nextLoopHint } from "../next-hint";

export async function runAck(args: ParsedArgs): Promise<number> {
  const explicitRole = args.positional[0];
  const token = requireString(args.flags, "token");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const { role } = await resolveIdentity(store, {
    explicitRole,
    requireSession: true,
  });

  const result = await store.ackManifest(role, token);

  if (json) {
    process.stdout.write(JSON.stringify({ status: "acked", ...result }) + "\n");
  } else {
    process.stdout.write(
      `Acked ${result.eventsAcked} event(s) for role '${role}': ` +
        `${result.previousCursor || "(start)"} -> ${result.ackedThrough || "(unchanged)"}\n` +
        nextLoopHint({ json, actor: role }),
    );
  }
  return 0;
}

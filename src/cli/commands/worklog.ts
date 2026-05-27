import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";

export async function runWorklog(args: ParsedArgs): Promise<number> {
  const message = requireString(args.flags, "message");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const { role: from } = await resolveIdentity(store, {
    requireSession: true,
  });

  const event = await store.publishWorklog({ from, message });

  if (json) {
    process.stdout.write(JSON.stringify({ status: "logged", event }) + "\n");
  } else {
    process.stdout.write(`Logged worklog entry ${event.id} for ${from}.\n`);
  }
  return 0;
}

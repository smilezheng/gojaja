import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import { nextLoopHint } from "../next-hint";

export async function runReport(args: ParsedArgs): Promise<number> {
  const to = requireString(args.flags, "to");
  const message = requireString(args.flags, "message");
  const ref = optionalString(args.flags, "ref");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const { role: from } = await resolveIdentity(store, {
    requireSession: true,
  });

  const event = await store.publishReport({ from, to, ref, message });

  if (json) {
    process.stdout.write(JSON.stringify({ status: "reported", event }) + "\n");
  } else {
    process.stdout.write(
      `Reported ${event.id} from ${from} to ${to}` +
        (ref ? ` (ref=${ref})` : "") +
        `.\n` +
        nextLoopHint({ json, actor: from }),
    );
  }
  return 0;
}

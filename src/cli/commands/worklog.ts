import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import { nextLoopHint } from "../next-hint";
import { requireText } from "../util/text-input";

export async function runWorklog(args: ParsedArgs): Promise<number> {
  // --message: inline, stdin, or $EDITOR — see requireText.
  const message = await requireText(args.flags, "message");
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
    process.stdout.write(
      `Logged worklog entry ${event.id} for ${from}.\n` +
        nextLoopHint({ json, actor: from }),
    );
  }
  return 0;
}

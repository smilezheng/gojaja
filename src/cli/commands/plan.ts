import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";

export async function runPlan(args: ParsedArgs): Promise<number> {
  const explicitRole = args.positional[0];
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const { role } = await resolveIdentity(store, {
    explicitRole,
    requireSession: true,
  });

  const manifest = await store.openOrCreatePlan(role);

  if (json) {
    process.stdout.write(JSON.stringify(manifest) + "\n");
    return 0;
  }

  process.stdout.write(`Plan for role '${role}'\n`);
  process.stdout.write(`  ack token       : ${manifest.ackToken}\n`);
  process.stdout.write(`  from cursor     : ${manifest.fromCursor || "(none)"}\n`);
  process.stdout.write(`  advanceCursorTo : ${manifest.advanceCursorTo || "(unchanged)"}\n`);
  process.stdout.write(`  unread events   : ${manifest.events.length}\n`);
  for (const e of manifest.events) {
    const payload =
      typeof e.payload?.message === "string"
        ? `: ${(e.payload.message as string).split("\n")[0]}`
        : "";
    process.stdout.write(`    - ${e.id} [${e.type}] ${e.from} -> ${e.to}${payload}\n`);
  }
  process.stdout.write(
    `\nWhen done processing, run:\n  agentctl ack ${role} --token ${manifest.ackToken}\n`,
  );
  return 0;
}

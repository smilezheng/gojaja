import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";

export async function runPlan(args: ParsedArgs): Promise<number> {
  const explicitRole = args.positional[0];
  // JSON output is the agent-facing default. Humans running `agentctl
  // plan` interactively get the text rendering; everything piped, redirected
  // or invoked from a child_process gets JSON automatically. Without this
  // an agent that simply runs `agentctl plan` ends up parsing the human
  // text and missing manifest.tasks / manifest.rfcs, which the runtime
  // contract (PROTOCOL.md, runtime body) promises will always be there.
  const json = boolFlag(args.flags, "json") || !process.stdout.isTTY;
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

  // PROTOCOL.md promises that plan surfaces tasks and rfcs. Failing to
  // print them in text mode silently violated that contract — the agent
  // reads what the user sees on screen and would never know about its
  // tasks or open RFCs.
  process.stdout.write(`  active tasks    : ${manifest.tasks.length}\n`);
  for (const t of manifest.tasks) {
    const blockers = t.blockedBy.length > 0 ? ` (blocked by ${t.blockedBy.join(",")})` : "";
    process.stdout.write(
      `    - ${t.id} [${t.status}] ${t.priority}: ${t.title}${blockers}\n`,
    );
  }

  process.stdout.write(`  pending RFCs    : ${manifest.rfcs.length}\n`);
  for (const r of manifest.rfcs) {
    const commentedMark = r.commented ? " (commented)" : "";
    process.stdout.write(`    - ${r.id} [${r.role}]${commentedMark}: ${r.title}\n`);
  }

  process.stdout.write(
    `\nWhen done processing, run:\n  agentctl ack ${role} --token ${manifest.ackToken}\n`,
  );
  return 0;
}

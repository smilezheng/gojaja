import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor } from "../identity";
import { nextLoopHint } from "../next-hint";

export async function runReport(args: ParsedArgs): Promise<number> {
  const to = requireString(args.flags, "to");
  const message = requireString(args.flags, "message");
  const ref = optionalString(args.flags, "ref");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  // SYSTEM is allowed: a human running the CLI without
  // `GOJAJA_SESSION` can direct a message at a specific role. The
  // recipient `to` must still be a registered role (validated in
  // store.publishReport). Symmetric with `rfc new` / `rfc comment`
  // / `task new` / `state edit`'s SYSTEM paths. Agents should
  // continue to claim a role first; `report` from SYSTEM is the
  // project-owner channel into the team.
  const { actor } = await resolveActor(store);

  const event = await store.publishReport({ from: actor, to, ref, message });

  if (json) {
    process.stdout.write(JSON.stringify({ status: "reported", event }) + "\n");
  } else {
    process.stdout.write(
      `Reported ${event.id} from ${actor} to ${to}` +
        (ref ? ` (ref=${ref})` : "") +
        `.\n` +
        nextLoopHint({ json, actor }),
    );
  }
  return 0;
}

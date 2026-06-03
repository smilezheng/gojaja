import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor } from "../identity";
import { nextLoopHint } from "../next-hint";
import { requireText } from "../util/text-input";
import { gatherSystemMeta } from "../util/system-meta";

export async function runReport(args: ParsedArgs): Promise<number> {
  const to = requireString(args.flags, "to");
  // --message accepts inline text, stdin (heredoc/pipe), or $EDITOR
  // when no inline value is given. Inline is what existing tests and
  // most agent automation use; stdin is the safe path for multi-line
  // content containing backticks or $ (see postmortem 2026-06-02).
  const message = await requireText(args.flags, "message");
  const ref = optionalString(args.flags, "ref");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  // SYSTEM is allowed but no longer the implicit default for an
  // unset GOJAJA_SESSION (PR9 SYSTEM-1). The caller must pass
  // `--as-system` to surface "yes, this is the project owner
  // intentionally sending without claiming a role first". A bare
  // `gojaja report --to X --message Y` with no session and no
  // `--as-system` now fails USAGE instead of silently auditing as
  // `from: SYSTEM` — the previous behaviour collapsed against an
  // agent process that simply unset its own env var.
  const asSystem = boolFlag(args.flags, "as-system");
  const { actor } = await resolveActor(store, { allowSystemBypass: asSystem });
  // PR9 SYSTEM-2: stamp forensic metadata onto the emitted event when
  // the actor is SYSTEM. Role-bearing events trace through the session
  // record; SYSTEM events have no session, so the trace lives inline.
  const actorMeta = actor === "SYSTEM" ? gatherSystemMeta() : undefined;

  const event = await store.publishReport({ from: actor, to, ref, message, actorMeta });

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

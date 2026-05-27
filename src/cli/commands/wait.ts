import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import type { Event, RoleId } from "../../core/types";
import type { Store } from "../../core/store";

const DEFAULT_IDLE_MINUTES = 10;

function parseFiniteNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`Invalid --${name}: ${raw}`);
  }
  return n;
}

async function visibleEventCountAfter(
  store: Store,
  role: RoleId,
  cursor: string,
): Promise<number> {
  const events = await store.listEventsAfter(cursor);
  let count = 0;
  for (const e of events as Event[]) {
    if (e.from === role) continue;
    if (e.to === role || e.to === "*") count++;
  }
  return count;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWait(args: ParsedArgs): Promise<number> {
  const explicitRole = args.positional[0];
  const mode = (optionalString(args.flags, "mode") ?? "block") as "block" | "exit";
  if (mode !== "block" && mode !== "exit") {
    throw new UsageError(`Unknown --mode '${mode}'. Use block or exit.`);
  }
  const idleMinutes =
    parseFiniteNumber("idle", optionalString(args.flags, "idle")) ??
    DEFAULT_IDLE_MINUTES;
  const idleSeconds = parseFiniteNumber(
    "idle-seconds",
    optionalString(args.flags, "idle-seconds"),
  );
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, {
    explicitRole,
    requireSession: true,
  });

  if (mode === "exit") {
    const sentinel = await store.writeWaitSentinel(role);
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "wait_exit", role, sentinel }) + "\n",
      );
    } else {
      process.stdout.write(
        `Wrote wait sentinel for ${role}; exiting. ` +
          `Resume by re-prompting the agent window.\n` +
          `  ${sentinel.path}\n`,
      );
    }
    return 0;
  }

  // block mode
  const waitMs =
    idleSeconds !== undefined
      ? idleSeconds * 1000
      : idleMinutes * 60 * 1000;
  const startedAt = new Date().toISOString();
  if (waitMs > 0) await sleep(waitMs);

  const cursor = (await store.readCursor(role)).ackedThrough;
  const count = await visibleEventCountAfter(store, role, cursor);
  const status = count > 0 ? "ATTENTION" : "IDLE";
  const endedAt = new Date().toISOString();

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: status.toLowerCase(),
        role,
        newEventCount: count,
        waitedMs: waitMs,
        startedAt,
        endedAt,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    `${status} role=${role} newEvents=${count} waitedMs=${waitMs}\n` +
      (status === "ATTENTION"
        ? `Next step: agentctl plan\n`
        : `Next step: end the turn cleanly.\n`),
  );
  return 0;
}

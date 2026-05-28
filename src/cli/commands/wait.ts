import {
  boolFlag,
  optionalString,
  parseDuration,
  type ParsedArgs,
} from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveIdentity } from "../identity";
import type {
  Event,
  RoleId,
  WaitCondition,
  WaitConditionKind,
  WaitStatus,
} from "../../core/types";
import type { Store } from "../../core/store";

/**
 * Default deadline when neither `--until` nor `--in` is supplied. Mirrors
 * the pre-PR8i `--idle 10` block-mode default so handbook muscle memory
 * keeps working: bare `gojaja wait` still buys ~10 minutes of patience
 * for new attention.
 */
const DEFAULT_WAIT_MS = 10 * 60 * 1000;

/**
 * Default cadence between event re-checks. Tuned to be small enough to
 * fit comfortably inside Cursor's host-side shell timeout while large
 * enough to keep CPU and stdout noise negligible on long Codex/Claude
 * waits. Tests pass a shorter `--poll-interval` to keep the wall clock
 * cost low.
 */
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Errors flagged here all map to USAGE. We surface the new shape so a
 * scripted caller that passed a removed flag (`--mode`, `--idle`) sees
 * the migration path inline.
 */
function rejectRemovedFlags(args: ParsedArgs): void {
  const removed = ["mode", "idle", "idle-seconds"];
  for (const name of removed) {
    if (args.flags[name] !== undefined) {
      throw new UsageError(
        `--${name} was removed in PR8i. Use \`gojaja wait --in <duration>\` ` +
          `or \`--until <ISO>\` instead; see \`gojaja wait -h\`.`,
      );
    }
  }
}

function parseConditionToken(raw: string | undefined): WaitCondition {
  if (raw === undefined) return { kind: "attention" };
  const [head, ...rest] = raw.split(":");
  const ref = rest.join(":");
  const requireRef = (k: WaitConditionKind): WaitCondition => {
    if (!ref) {
      throw new UsageError(
        `--for ${k} requires a target: '${k}:<id>'.`,
      );
    }
    return { kind: k, ref };
  };
  const forbidRef = (k: WaitConditionKind): WaitCondition => {
    if (ref) {
      throw new UsageError(
        `--for ${k} does not take a target ('${raw}'). Drop the ':...' suffix.`,
      );
    }
    return { kind: k };
  };
  switch (head) {
    case "attention":
      return forbidRef("attention");
    case "task-assigned":
      return forbidRef("task-assigned");
    case "rfc-decided":
      return requireRef("rfc-decided");
    case "rfc-acked":
      return requireRef("rfc-acked");
    case "report-from":
      return requireRef("report-from");
    case "event-ref":
      return requireRef("event-ref");
    default:
      throw new UsageError(
        `Unknown --for '${raw}'. Supported: attention, rfc-decided:<id>, ` +
          `rfc-acked:<id>, task-assigned, report-from:<role>, event-ref:<id>.`,
      );
  }
}

/**
 * Format a `WaitCondition` back to its CLI token form. Echoed in the
 * RESUME exit so the agent can literally copy/paste the next command.
 */
function formatConditionToken(cond: WaitCondition): string {
  if (cond.ref) return `${cond.kind}:${cond.ref}`;
  return cond.kind;
}

/**
 * Per-condition predicate. Returns the first matching event (oldest by
 * ULID) or null. `attention` produces ATTENTION; the other kinds
 * produce CONDITION_MET.
 *
 * PR8n note: for `kind: "attention"`, the upstream `findFirstHit` pre-
 * filters events through `Store.filterVisibleEventsForRole`, so this
 * function only sees events that would actually appear in the role's
 * manifest. The simple to/from check is the historical equivalent and
 * is kept for back-compat when the filter is unavailable.
 */
function matchEvent(
  e: Event,
  cond: WaitCondition,
  role: RoleId,
): boolean {
  switch (cond.kind) {
    case "attention":
      // events have been pre-filtered upstream; any event here is
      // already a relevant attention signal.
      return true;
    case "rfc-decided":
      return e.type === "RFC_DECIDED" && e.ref === cond.ref;
    case "rfc-acked": {
      if (e.type !== "RFC_COMMENT" || e.ref !== cond.ref) return false;
      const kind = (e.payload as { kind?: unknown }).kind;
      return kind === "ack" || kind === "object";
    }
    case "task-assigned": {
      if (e.type !== "TASK_ASSIGNED") return false;
      const newOwner = (e.payload as { newOwner?: unknown }).newOwner;
      return newOwner === role;
    }
    case "report-from":
      return (
        e.type === "REPORT" && e.from === cond.ref && e.to === role
      );
    case "event-ref":
      return e.ref === cond.ref;
    default:
      return false;
  }
}

async function findFirstHit(
  store: Store,
  role: RoleId,
  cursor: string,
  cond: WaitCondition,
): Promise<{ event: Event; count: number } | null> {
  let events = (await store.listEventsAfter(cursor)) as Event[];
  // PR8n: for `--for attention`, pre-filter through the same projection
  // that builds `manifest.events`. Otherwise wait would wake the role
  // for broadcast events that plan would have hidden — a guaranteed
  // useless turn.
  if (cond.kind === "attention") {
    events = await store.filterVisibleEventsForRole(events, role);
  }
  let hit: Event | null = null;
  let count = 0;
  for (const e of events) {
    if (matchEvent(e, cond, role)) {
      if (hit === null) hit = e;
      count++;
    }
  }
  if (hit === null) return null;
  return { event: hit, count };
}

interface WaitTimes {
  deadlineIso: string;
  deadlineMs: number;
  pollIntervalMs: number;
  startedAtIso: string;
}

function resolveDeadline(args: ParsedArgs, nowMs: number): WaitTimes {
  const until = optionalString(args.flags, "until");
  const inFlag = optionalString(args.flags, "in");
  if (until !== undefined && inFlag !== undefined) {
    throw new UsageError("Pass --until or --in, not both.");
  }
  const pollRaw = optionalString(args.flags, "poll-interval");
  const pollIntervalMs =
    pollRaw !== undefined ? parseDuration(pollRaw) : DEFAULT_POLL_INTERVAL_MS;
  if (pollIntervalMs <= 0) {
    throw new UsageError("--poll-interval must be > 0.");
  }
  let deadlineMs: number;
  let deadlineIso: string;
  if (until !== undefined) {
    if (!/T.*(Z|[+-]\d{2}:?\d{2})$/.test(until)) {
      throw new UsageError(
        `--until '${until}' must be an ISO-8601 instant ` +
          `(use 'Z' or an explicit '+HH:MM' offset; bare local times are rejected).`,
      );
    }
    const parsed = Date.parse(until);
    if (!Number.isFinite(parsed)) {
      throw new UsageError(`--until '${until}' is not a valid ISO timestamp.`);
    }
    deadlineMs = parsed;
    deadlineIso = new Date(parsed).toISOString();
  } else if (inFlag !== undefined) {
    const dur = parseDuration(inFlag);
    deadlineMs = nowMs + dur;
    deadlineIso = new Date(deadlineMs).toISOString();
  } else {
    deadlineMs = nowMs + DEFAULT_WAIT_MS;
    deadlineIso = new Date(deadlineMs).toISOString();
  }
  return {
    deadlineIso,
    deadlineMs,
    pollIntervalMs,
    startedAtIso: new Date(nowMs).toISOString(),
  };
}

interface ExitContext {
  role: RoleId;
  json: boolean;
  cond: WaitCondition;
  deadlineIso: string;
  startedAtIso: string;
}

function emit(
  status: WaitStatus,
  ctx: ExitContext,
  extra: Record<string, unknown>,
): number {
  if (ctx.json) {
    process.stdout.write(
      JSON.stringify({
        status,
        role: ctx.role,
        deadline: ctx.deadlineIso,
        sessionStartedAt: ctx.startedAtIso,
        condition: formatConditionToken(ctx.cond),
        ...extra,
      }) + "\n",
    );
    return 0;
  }
  switch (status) {
    case "attention":
      process.stdout.write(
        `ATTENTION role=${ctx.role} newEvents=${extra.newEventCount ?? 0} ` +
          `deadline=${ctx.deadlineIso}\n` +
          `Next: gojaja plan\n`,
      );
      return 0;
    case "condition_met":
      process.stdout.write(
        `CONDITION_MET condition=${formatConditionToken(ctx.cond)} ` +
          `role=${ctx.role}\n` +
          `Next: gojaja plan\n`,
      );
      return 0;
    case "resume": {
      const forSuffix =
        ctx.cond.kind === "attention"
          ? ""
          : ` --for ${formatConditionToken(ctx.cond)}`;
      process.stdout.write(
        `RESUME deadline=${ctx.deadlineIso} ` +
          `chunkSleptMs=${extra.chunkSleptMs ?? 0}\n` +
          `Next: gojaja wait --until ${ctx.deadlineIso}${forSuffix}\n`,
      );
      return 0;
    }
    case "timeout":
      process.stdout.write(
        `TIMEOUT role=${ctx.role} deadline=${ctx.deadlineIso}\n` +
          `Next: end the turn cleanly, or take initiative.\n`,
      );
      return 0;
  }
}

export async function runWait(args: ParsedArgs): Promise<number> {
  rejectRemovedFlags(args);

  const explicitRole = args.positional[0];
  const json = boolFlag(args.flags, "json");
  const root =
    optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const { role } = await resolveIdentity(store, {
    explicitRole,
    requireSession: true,
  });

  const condition = parseConditionToken(optionalString(args.flags, "for"));

  // Refuse to wait while a plan manifest is outstanding — without this
  // guard every event in the pending manifest would re-trigger ATTENTION,
  // looping the agent. Pre-PR8i behaviour, preserved.
  const cursorState = await store.readCursor(role);
  if (cursorState.pendingManifest !== null) {
    throw new UsageError(
      `Role '${role}' has an outstanding manifest awaiting ack ` +
        `(token ${cursorState.pendingManifest}). ` +
        `Run 'gojaja ack --token ${cursorState.pendingManifest}' first; ` +
        `then 'gojaja wait'.`,
    );
  }

  const nowMs = Date.now();
  const times = resolveDeadline(args, nowMs);

  // Find or open a wait session. The session record is what makes the
  // `--for task-assigned` idle broadcast a one-shot rather than a
  // per-chunk spam: subsequent chunks find idleBroadcastSent=true and
  // skip publishing.
  let waitState = await store.readWaitState(role);
  const exitCtx: ExitContext = {
    role,
    json,
    cond: condition,
    deadlineIso: times.deadlineIso,
    startedAtIso: waitState?.startedAt ?? times.startedAtIso,
  };

  // Immediate TIMEOUT path: deadline already in the past at entry.
  if (times.deadlineMs <= nowMs) {
    await store.clearWaitState(role);
    return emit("timeout", exitCtx, {});
  }

  // First chunk of a new session — record state + maybe broadcast idle.
  if (waitState === null) {
    waitState = {
      role,
      deadline: times.deadlineIso,
      for: condition,
      startedAt: times.startedAtIso,
      ackedThroughAtStart: cursorState.ackedThrough,
      idleBroadcastSent: false,
    };
    if (condition.kind === "task-assigned") {
      await store.publishWorklog({
        from: role,
        message:
          `${role} is idle since ${waitState.startedAt}; ` +
          `waiting for new task assignment until ${times.deadlineIso}.`,
      });
      waitState.idleBroadcastSent = true;
    }
    await store.writeWaitState(waitState);
    exitCtx.startedAtIso = waitState.startedAt;
  }

  // Pre-sleep event check: if the answer is already on disk we exit
  // before sleeping. This is what makes RESUME -> RESUME -> ... cheap
  // when events are already piling up.
  const cursor = cursorState.ackedThrough;
  const pre = await findFirstHit(store, role, cursor, condition);
  if (pre !== null) {
    await store.clearWaitState(role);
    if (condition.kind === "attention") {
      return emit("attention", exitCtx, { newEventCount: pre.count });
    }
    return emit("condition_met", exitCtx, {
      matchedEventId: pre.event.id,
    });
  }

  const chunkMs = Math.min(
    times.deadlineMs - Date.now(),
    times.pollIntervalMs,
  );
  if (chunkMs > 0) await sleep(chunkMs);

  const post = await findFirstHit(store, role, cursor, condition);
  if (post !== null) {
    await store.clearWaitState(role);
    if (condition.kind === "attention") {
      return emit("attention", exitCtx, { newEventCount: post.count });
    }
    return emit("condition_met", exitCtx, {
      matchedEventId: post.event.id,
    });
  }

  const remainingAfter = times.deadlineMs - Date.now();
  if (remainingAfter > 0) {
    return emit("resume", exitCtx, { chunkSleptMs: chunkMs });
  }
  await store.clearWaitState(role);
  return emit("timeout", exitCtx, {});
}

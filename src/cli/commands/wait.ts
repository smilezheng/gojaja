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
  WaitState,
  WaitStatus,
} from "../../core/types";
import type { Store } from "../../core/store";

/**
 * How often `wait` re-checks the event stream WHILE it is blocked. This
 * is an in-process cadence, not a re-invocation interval: a single
 * `wait` call parks the agent and loops internally every poll-interval
 * until the condition fires or the deadline passes. So it costs no agent
 * tokens (one tool call for the whole wait); a smaller value only means
 * snappier detection at negligible CPU. Tests pass a shorter value to
 * keep wall-clock cost low.
 */
const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePollIntervalMs(args: ParsedArgs): number {
  const pollRaw = optionalString(args.flags, "poll-interval");
  const ms = pollRaw !== undefined ? parseDuration(pollRaw) : DEFAULT_POLL_INTERVAL_MS;
  if (ms <= 0) throw new UsageError("--poll-interval must be > 0.");
  return ms;
}

/**
 * Reject flags from earlier wait shapes so a scripted caller passing
 * them sees a clear pointer at the current surface rather than the
 * `--mode` / `--idle` flag being silently ignored.
 */
function rejectRemovedFlags(args: ParsedArgs): void {
  const removed = ["mode", "idle", "idle-seconds"];
  for (const name of removed) {
    if (args.flags[name] !== undefined) {
      throw new UsageError(
        `--${name} is not a wait flag. Use \`gojaja wait --in <duration>\` ` +
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
 * CONDITION_MET verdict so the agent sees what fired.
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
 * For `kind: "attention"`, the upstream `findFirstHit` pre-filters
 * events through `Store.filterVisibleEventsForRole`, so this function
 * only sees events that would actually appear in the role's manifest.
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
  // for `--for attention`, pre-filter through the same projection
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
  startedAtIso: string;
}

function resolveDeadline(args: ParsedArgs, nowMs: number): WaitTimes {
  const until = optionalString(args.flags, "until");
  const inFlag = optionalString(args.flags, "in");
  if (until !== undefined && inFlag !== undefined) {
    throw new UsageError("Pass --until or --in, not both.");
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
    // Only called when --until or --in is present; the no-flag case is
    // handled by the caller (indefinite / resume).
    throw new UsageError("resolveDeadline requires --until or --in.");
  }
  return {
    deadlineIso,
    deadlineMs,
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

  const requestedCondition = parseConditionToken(optionalString(args.flags, "for"));

  // Refuse to wait while a plan manifest is outstanding — without this
  // guard every event in the pending manifest would re-trigger ATTENTION
  // the moment we poll.
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
  const pollIntervalMs = resolvePollIntervalMs(args);
  const existing = await store.readWaitState(role);

  // Deadline resolution. `deadlineMs === Infinity` means an indefinite
  // wait (no `--in` / `--until`): the call blocks until an event /
  // condition fires or the host harness kills it. `deadline` on disk is
  // `null` for that case.
  //
  // With NO deadline flags AND a session already on disk, we RESUME it:
  // this is how the agent continues the SAME wait after the host killed
  // the previous (long-blocking) call — re-run `gojaja wait` and it
  // picks the original deadline + condition back up. A resumed finite
  // deadline that has already passed resolves to an immediate TIMEOUT
  // below, NOT a surprise fresh wait.
  const hasDeadlineFlag =
    optionalString(args.flags, "until") !== undefined ||
    optionalString(args.flags, "in") !== undefined;

  let deadlineIso: string | null;
  let deadlineMs: number;
  let cond: WaitCondition;
  let startedAtIso: string;
  let resuming = false;
  if (hasDeadlineFlag) {
    const times = resolveDeadline(args, nowMs);
    deadlineIso = times.deadlineIso;
    deadlineMs = times.deadlineMs;
    cond = requestedCondition;
    startedAtIso = times.startedAtIso;
  } else if (existing) {
    const ms = existing.deadline === null ? Infinity : Date.parse(existing.deadline);
    deadlineMs = Number.isFinite(ms) || ms === Infinity ? ms : Infinity;
    deadlineIso = deadlineMs === Infinity ? null : existing.deadline;
    cond = existing.for;
    startedAtIso = existing.startedAt;
    resuming = true;
  } else {
    deadlineMs = Infinity;
    deadlineIso = null;
    cond = requestedCondition;
    startedAtIso = new Date(nowMs).toISOString();
  }

  const deadlineLabel = deadlineIso ?? "indefinite";
  const exitCtx: ExitContext = {
    role,
    json,
    cond,
    deadlineIso: deadlineLabel,
    startedAtIso,
  };

  // Finite deadline already in the past → TIMEOUT immediately.
  // (Infinity never satisfies this.)
  if (deadlineMs <= nowMs) {
    await store.clearWaitState(role);
    return emit("timeout", exitCtx, {});
  }

  // Open the session on a fresh wait: records the deadline (so a killed
  // call can be resumed) and makes the `--for task-assigned` idle
  // worklog a one-shot. Resuming reuses the existing session untouched.
  if (!resuming) {
    const waitState: WaitState = {
      role,
      deadline: deadlineIso,
      for: cond,
      startedAt: startedAtIso,
      ackedThroughAtStart: cursorState.ackedThrough,
      idleBroadcastSent: false,
    };
    if (cond.kind === "task-assigned") {
      await store.publishWorklog({
        from: role,
        message:
          `${role} is idle since ${waitState.startedAt}; ` +
          `waiting for new task assignment ` +
          `${deadlineIso ? `until ${deadlineIso}` : "indefinitely"}.`,
      });
      waitState.idleBroadcastSent = true;
    }
    await store.writeWaitState(waitState);
  }

  // Print a start line BEFORE blocking so the agent can see the wall
  // clock at entry (and, if the host kills the call mid-block, infer how
  // long it ran / what the host's per-tool-call timeout is). Skipped in
  // --json mode so stdout stays a single parseable object.
  if (!json) {
    process.stdout.write(
      `WAITING role=${role} now=${new Date().toISOString()} ` +
        `deadline=${deadlineLabel} for=${formatConditionToken(cond)}\n`,
    );
  }

  // Block until the condition fires or the deadline passes. We poll the
  // event stream every poll-interval INSIDE this one process — the agent
  // stays parked in a single tool call (no per-poll re-invocation, no
  // token cost). An indefinite wait loops here until an event fires or
  // the host harness kills the call; the agent then re-runs `gojaja
  // wait` (no args) to continue.
  const cursor = cursorState.ackedThrough;
  while (Date.now() < deadlineMs) {
    const hit = await findFirstHit(store, role, cursor, cond);
    if (hit !== null) {
      await store.clearWaitState(role);
      if (cond.kind === "attention") {
        return emit("attention", exitCtx, { newEventCount: hit.count });
      }
      return emit("condition_met", exitCtx, { matchedEventId: hit.event.id });
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  // One last check at the deadline boundary before declaring TIMEOUT.
  const last = await findFirstHit(store, role, cursor, cond);
  if (last !== null) {
    await store.clearWaitState(role);
    if (cond.kind === "attention") {
      return emit("attention", exitCtx, { newEventCount: last.count });
    }
    return emit("condition_met", exitCtx, { matchedEventId: last.event.id });
  }
  await store.clearWaitState(role);
  return emit("timeout", exitCtx, {});
}

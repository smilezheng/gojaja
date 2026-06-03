import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runReport } from "../src/cli/commands/report";
import { runTask } from "../src/cli/commands/task";
import { runRfc } from "../src/cli/commands/rfc";
import {
  gatherSystemMeta,
} from "../src/cli/util/system-meta";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * PR9 SYSTEM-2 forensic-metadata contract.
 *
 * Every event emitted with `from === "SYSTEM"` must carry an
 * `actorMeta` slice describing the process that produced it (pid,
 * ppid, cwd, hostname, user, tty). Role-bearing events MUST NOT
 * carry actorMeta — their trace lives in the session record.
 *
 * `gatherSystemMeta` is exercised both directly (helper-unit) and
 * end-to-end through the CLI handlers (integration). The helper's
 * fallback paths (cwd / hostname / user / tty unavailable) cannot
 * be exercised under normal Node so we cover the happy-path shape
 * only.
 */

interface Ctx { root: string; store: LocalFsStore }

async function freshStore(): Promise<Ctx> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-sysmeta-"));
  const store = new LocalFsStore(path.join(root, ".gojaja"), {
    safetyMarginMs: 0,
  });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "Product Manager",
    owns: ["state/project_state.md", "state/task_board.yaml"],
  });
  await store.createRole({ id: "Backend", title: "Backend" });
  return { root, store };
}

function args(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return { command: positional[0] ?? "", positional, flags };
}

describe("gatherSystemMeta (helper unit)", () => {
  it("returns all the expected fields with reasonable shapes", () => {
    const m = gatherSystemMeta();
    expect(typeof m.pid).toBe("number");
    expect(m.pid).toBeGreaterThan(0);
    expect(typeof m.ppid).toBe("number");
    expect(typeof m.cwd).toBe("string");
    expect(m.cwd.length).toBeGreaterThan(0);
    expect(typeof m.hostname).toBe("string");
    expect(m.hostname.length).toBeGreaterThan(0);
    expect(typeof m.user).toBe("string");
    expect(m.user.length).toBeGreaterThan(0);
    expect(typeof m.tty).toBe("string");
    expect(m.tty.length).toBeGreaterThan(0);
  });

  it("captures the current process pid, not some other process", () => {
    const m = gatherSystemMeta();
    expect(m.pid).toBe(process.pid);
  });

  it("captures the current cwd at call time", () => {
    const m = gatherSystemMeta();
    expect(m.cwd).toBe(process.cwd());
  });
});

describe("SYSTEM events carry actorMeta; role events do not", () => {
  let ctx: Ctx;
  let savedEnv: string | undefined;
  beforeEach(async () => {
    ctx = await freshStore();
    savedEnv = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = savedEnv;
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("report --as-system stamps actorMeta with the current process info", async () => {
    await runReport(
      args([], {
        to: "Backend",
        message: "owner directive",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const r = events.find((e) => e.type === "REPORT");
    expect(r).toBeDefined();
    expect(r?.from).toBe("SYSTEM");
    expect(r?.actorMeta).toBeDefined();
    expect(r?.actorMeta?.pid).toBe(process.pid);
    expect(r?.actorMeta?.cwd).toBe(process.cwd());
  });

  it("report with a role session does NOT carry actorMeta", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await runReport(
      args([], {
        to: "Backend",
        message: "from PM",
        root: ctx.root,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const r = events.find((e) => e.type === "REPORT");
    expect(r).toBeDefined();
    expect(r?.from).toBe("PM");
    // Role-bearing events trace via the session record, not on the
    // event itself. actorMeta must be absent.
    expect(r?.actorMeta).toBeUndefined();
  });

  it("task new --as-system stamps actorMeta on TASK_CREATED and TASK_ASSIGNED", async () => {
    await runTask(
      args(["new"], {
        title: "seed",
        owner: "Backend",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const created = events.find((e) => e.type === "TASK_CREATED");
    const assigned = events.find((e) => e.type === "TASK_ASSIGNED");
    expect(created?.actorMeta?.pid).toBe(process.pid);
    expect(assigned?.actorMeta?.pid).toBe(process.pid);
  });

  it("rfc new --as-system stamps actorMeta on RFC_CREATED", async () => {
    await runRfc(
      args(["new", "policy"], {
        title: "Policy",
        deciders: "PM",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const created = events.find((e) => e.type === "RFC_CREATED");
    expect(created?.actorMeta).toBeDefined();
    expect(created?.actorMeta?.pid).toBe(process.pid);
    expect(created?.actorMeta?.user.length).toBeGreaterThan(0);
  });

  it("rfc comment --as-system stamps actorMeta on RFC_COMMENT", async () => {
    const proposal = await ctx.store.createRfc({
      slug: "ctx",
      title: "ctx",
      voters: [],
      deciders: ["PM"],
      options: [],
      createdBy: "SYSTEM",
      description: "",
      relatedTasks: [],
    });
    await runRfc(
      args(["comment", proposal.id], {
        rationale: "owner context",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const c = events.find((e) => e.type === "RFC_COMMENT");
    expect(c?.actorMeta).toBeDefined();
    expect(c?.actorMeta?.pid).toBe(process.pid);
  });

  it("a role-bearing task assign does NOT carry actorMeta even if --as-system is set", async () => {
    // Live session always wins (SYSTEM-1 invariant). The flag is
    // ignored, and so is the (non-existent) actorMeta gathering.
    // Assign to a DIFFERENT owner than the current one so the store
    // actually emits TASK_ASSIGNED (same-owner reassigns short-
    // circuit on the previousOwner === newOwner check).
    const t = await ctx.store.createTask({
      title: "t",
      owner: "Backend",
      actor: "SYSTEM",
    });
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await runTask(
      args(["assign", t.id], {
        to: "PM",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    // Two TASK_ASSIGNED events: one from createTask (SYSTEM → Backend),
    // and the second from our reassign (PM → PM). The most recent one
    // is the role-bearing reassign we care about.
    const assigned = events
      .filter((e) => e.type === "TASK_ASSIGNED")
      .pop();
    expect(assigned?.from).toBe("PM");
    expect(assigned?.actorMeta).toBeUndefined();
  });
});

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runReport } from "../src/cli/commands/report";
import { runState } from "../src/cli/commands/state";
import { runTask } from "../src/cli/commands/task";
import { runRfc } from "../src/cli/commands/rfc";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * PR9 SYSTEM-1 gate contract.
 *
 * Each CLI command that previously defaulted to actor=SYSTEM when
 * GOJAJA_SESSION was unset must now refuse that path unless the
 * caller passes `--as-system`. Three scenarios per command:
 *
 *   1. no session + no --as-system → USAGE error (refused).
 *   2. no session + --as-system → succeeds as actor=SYSTEM.
 *   3. live session → succeeds as the session's role; --as-system
 *      ignored if also present (the session always wins).
 *
 * These tests are the regression contract: if a future commit
 * reintroduces the implicit-SYSTEM default, scenario (1) will start
 * passing instead of failing and the suite will catch it.
 */

interface Ctx { root: string; store: LocalFsStore }

async function freshStore(): Promise<Ctx> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-sysgate-"));
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

describe("SYSTEM-1: gate refuses implicit SYSTEM, accepts explicit --as-system", () => {
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

  // -------------------------------------------------------------------
  // report
  // -------------------------------------------------------------------

  it("report: refuses bare-human invocation without --as-system", async () => {
    await expect(
      runReport(
        args([], { to: "Backend", message: "hello", root: ctx.root }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("report: accepts --as-system and records from=SYSTEM", async () => {
    await runReport(
      args([], {
        to: "Backend",
        message: "hello from owner",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const reports = events.filter((e) => e.type === "REPORT");
    expect(reports).toHaveLength(1);
    expect(reports[0].from).toBe("SYSTEM");
    expect(reports[0].to).toBe("Backend");
  });

  it("report: accepts a live session and records the role as the actor", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await runReport(
      args([], {
        to: "Backend",
        message: "hello from PM",
        root: ctx.root,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const reports = events.filter((e) => e.type === "REPORT");
    expect(reports[0].from).toBe("PM");
  });

  // -------------------------------------------------------------------
  // state edit
  // -------------------------------------------------------------------

  it("state edit: refuses without --as-system (no session)", async () => {
    await expect(
      runState(
        args(["edit"], {
          file: "state/project_state.md",
          content: "x",
          root: ctx.root,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("state edit: accepts --as-system and writes via the SYSTEM bypass", async () => {
    const code = await runState(
      args(["edit"], {
        file: "state/project_state.md",
        content: "explicit owner content\n",
        root: ctx.root,
        "as-system": true,
      }),
    );
    expect(code).toBe(0);
    const onDisk = await fsp.readFile(
      path.join(ctx.root, ".gojaja", "state", "project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("explicit owner content\n");
  });

  // -------------------------------------------------------------------
  // task new
  // -------------------------------------------------------------------

  it("task new: refuses bare-human invocation without --as-system", async () => {
    await expect(
      runTask(
        args(["new"], {
          title: "seed",
          owner: "Backend",
          root: ctx.root,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("task new: accepts --as-system and records actor=SYSTEM", async () => {
    await runTask(
      args(["new"], {
        title: "seed",
        owner: "Backend",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const board = await ctx.store.readTaskBoard();
    const t = Object.values(board.tasks)[0];
    expect(t.title).toBe("seed");
    // The TASK_CREATED audit event records SYSTEM as the originating
    // actor, regardless of the task's own assignedBy field semantics.
    const events = await ctx.store.listEventsAfter("");
    const created = events.find((e) => e.type === "TASK_CREATED");
    expect(created?.from).toBe("SYSTEM");
  });

  // -------------------------------------------------------------------
  // rfc new
  // -------------------------------------------------------------------

  it("rfc new: refuses bare-human invocation without --as-system", async () => {
    await expect(
      runRfc(
        args(["new", "policy"], {
          title: "Policy",
          deciders: "PM",
          root: ctx.root,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rfc new: accepts --as-system and records createdBy=SYSTEM", async () => {
    await runRfc(
      args(["new", "policy"], {
        title: "Policy",
        deciders: "PM",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const rfcs = await ctx.store.listRfcs();
    expect(rfcs).toHaveLength(1);
    expect(rfcs[0].createdBy).toBe("SYSTEM");
  });

  // -------------------------------------------------------------------
  // rfc comment (plain — structured kinds always need a session)
  // -------------------------------------------------------------------

  it("rfc comment: refuses bare-human invocation without --as-system", async () => {
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
    await expect(
      runRfc(
        args(["comment", proposal.id], {
          rationale: "from the owner",
          root: ctx.root,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rfc comment: accepts --as-system", async () => {
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
        rationale: "from the owner",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const { comments } = await ctx.store.readRfc(proposal.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].role).toBe("SYSTEM");
  });

  // -------------------------------------------------------------------
  // session-wins-over-flag invariant
  // -------------------------------------------------------------------

  it("a live session always beats --as-system (no silent escalation)", async () => {
    // An agent that includes --as-system "just in case" must NOT be
    // promoted to SYSTEM authority. The presence of GOJAJA_SESSION
    // is the strong signal; --as-system is the weak human opt-in
    // and only kicks in when the env var is unset.
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await runReport(
      args([], {
        to: "Backend",
        message: "with both",
        root: ctx.root,
        "as-system": true,
        json: true,
      }),
    );
    const events = await ctx.store.listEventsAfter("");
    const reports = events.filter((e) => e.type === "REPORT");
    expect(reports[0].from).toBe("PM");
  });
});

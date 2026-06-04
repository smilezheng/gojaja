import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runReport } from "../src/cli/commands/report";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * v3.0.x K — SYSTEM broadcast announcements.
 *
 * `publishReport` now accepts `to === "*"` when `from === "SYSTEM"`.
 * Peers (`from: <RoleId>`) cannot broadcast — they must address a
 * specific recipient (or use `worklog` for team-visible progress
 * notes).
 *
 * These tests pin the four interesting paths:
 *   1. SYSTEM + to=*    → succeeds; event records to="*".
 *   2. Peer + to=*      → USAGE refused.
 *   3. SYSTEM + to=Bob  → still works (unchanged from prior behaviour).
 *   4. CLI:  --to '*' --as-system    → succeeds end-to-end.
 *   5. CLI:  --to '*' without flag    → SYSTEM-1 gate fires first.
 */

interface Ctx { projectRoot: string; root: string; store: LocalFsStore }

async function freshStore(): Promise<Ctx> {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-broadcast-"));
  const layerRoot = path.join(projectRoot, ".gojaja");
  const store = new LocalFsStore(layerRoot, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "PM",
    owns: ["state/task_board.yaml"],
  });
  await store.createRole({ id: "Backend", title: "Backend" });
  return { projectRoot, root: layerRoot, store };
}

function args(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "report", positional: [], flags };
}

describe("Store.publishReport: SYSTEM broadcast", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("accepts to === '*' when from === SYSTEM", async () => {
    const event = await ctx.store.publishReport({
      from: "SYSTEM",
      to: "*",
      message: "Team meeting in 10 minutes.",
    });
    expect(event.type).toBe("REPORT");
    expect(event.from).toBe("SYSTEM");
    expect(event.to).toBe("*");
    expect(event.payload.message).toBe("Team meeting in 10 minutes.");
  });

  it("refuses to === '*' when from is a peer role", async () => {
    await expect(
      ctx.store.publishReport({
        from: "PM",
        to: "*" as never,
        message: "everyone listen",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("still allows directed report when from === SYSTEM (unchanged)", async () => {
    const event = await ctx.store.publishReport({
      from: "SYSTEM",
      to: "Backend",
      message: "Please ship login by EOD.",
    });
    expect(event.to).toBe("Backend");
  });

  it("still rejects unknown recipient when from === SYSTEM and to is a role id", async () => {
    await expect(
      ctx.store.publishReport({
        from: "SYSTEM",
        to: "Frontend",
        message: "typo recipient",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("runReport CLI: SYSTEM broadcast end-to-end", () => {
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
    await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("--to '*' --as-system succeeds and records the broadcast event", async () => {
    const code = await runReport(
      args({
        to: "*",
        message: "Quarterly all-hands tomorrow at 10:00.",
        root: ctx.projectRoot,
        "as-system": true,
        json: true,
      }),
    );
    expect(code).toBe(0);
    const events = await ctx.store.listEventsAfter("");
    const r = events.find((e) => e.type === "REPORT");
    expect(r?.from).toBe("SYSTEM");
    expect(r?.to).toBe("*");
  });

  it("--to '*' without --as-system fails the SYSTEM-1 gate before the store sees it", async () => {
    await expect(
      runReport(
        args({
          to: "*",
          message: "spoof attempt",
          root: ctx.projectRoot,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("--to '*' with a live PEER session is refused by the store layer", async () => {
    const s = await ctx.store.claimSession("PM", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await expect(
      runReport(
        args({
          to: "*",
          message: "spoof attempt as PM",
          root: ctx.projectRoot,
        }),
      ),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

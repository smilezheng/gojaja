import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runRole } from "../src/cli/commands/role";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-role-cli-"));
  const root = path.join(projectRoot, ".multi-agent");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  return { projectRoot, root, store };
}

interface Captured { stdout: string; release: () => void }
function captureStdout(): Captured {
  const cap: Captured = { stdout: "", release: () => undefined };
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    cap.stdout += chunk;
    return true;
  };
  cap.release = () => {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  };
  return cap;
}

function args(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "role", positional, flags };
}

describe("agentctl role (CLI: TBD nags)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("PR8e: 'role create' without a description prints a TODO block telling the user to fill TBD", async () => {
    // The freshly-rendered roles/<id>.md keeps TBD in the Role and
    // Responsibilities sections. Without surfacing this in the create
    // output, users walk away thinking 'role create' is the whole
    // setup and discover the missing self-introduction much later
    // (via every-turn agent confusion).
    const cap = captureStdout();
    try {
      const code = await runRole(args(
        ["create", "PM", "Product Manager"],
        { root: ctx.projectRoot },
      ));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("TODO");
      expect(cap.stdout).toContain("roles/PM.md");
      expect(cap.stdout).toContain("TBD");
    } finally {
      cap.release();
    }
  });

  it("PR8e: 'role create --json' carries needsFill: true for an unfilled role", async () => {
    const cap = captureStdout();
    try {
      await runRole(args(
        ["create", "PM", "Product Manager"],
        { root: ctx.projectRoot, json: true },
      ));
      const parsed = JSON.parse(cap.stdout);
      expect(parsed.needsFill).toBe(true);
      expect(parsed.rolePath).toBe(".multi-agent/roles/PM.md");
    } finally {
      cap.release();
    }
  });

  it("PR8e: 'role list' annotates TBD rows; clean rows have no marker", async () => {
    // PM left as TBD; TL gets its markdown manually completed.
    await ctx.store.createRole({ id: "PM", title: "Product Manager" });
    await ctx.store.createRole({ id: "TL", title: "Tech Lead", description: "Owns architecture; signs off RFCs." });
    const tlPath = path.join(ctx.root, "roles/TL.md");
    let md = await fsp.readFile(tlPath, "utf8");
    md = md.replace(/- TBD.*/g, "- Lead architecture; review RFCs.");
    await fsp.writeFile(tlPath, md);

    const cap = captureStdout();
    try {
      const code = await runRole(args(["list"], { root: ctx.projectRoot }));
      expect(code).toBe(0);
      // PM row should carry the marker; TL row should not.
      const lines = cap.stdout.split("\n");
      const pmLine = lines.find((l) => l.startsWith("PM "));
      const tlLine = lines.find((l) => l.startsWith("TL "));
      expect(pmLine).toBeDefined();
      expect(tlLine).toBeDefined();
      expect(pmLine).toContain("(TBD: fill role markdown)");
      expect(tlLine).not.toContain("(TBD");
    } finally {
      cap.release();
    }
  });
});

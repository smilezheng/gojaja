import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";

async function freshLayer() {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-init-"));
  const root = path.join(projectRoot, ".gojaja");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  return { projectRoot, root, store };
}

describe("Store.initialise (PR8f-B project_state.md skeleton)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshLayer(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("creates state/project_state.md with Vision / Milestones / Acceptance criteria TBD sections", async () => {
    await ctx.store.initialise("2.0.0-test");

    const stateFile = path.join(ctx.root, "state/project_state.md");
    const md = await fsp.readFile(stateFile, "utf8");

    expect(md).toContain("# Project state");
    expect(md).toContain("## Vision");
    expect(md).toContain("## Milestones");
    expect(md).toContain("## Acceptance criteria");
    // Each of the three editable sections seeds a TBD so the user
    // sees clearly where to fill in. The handbook tells agents to
    // ask the user to fill these before judging Done.
    expect(md.match(/TBD/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    // Cross-reference to the file's intended owner role exists so a
    // reader can trace authority back to config.yaml.
    expect(md).toContain("state/project_state.md");
  });

  it("seeds the skeleton only on first init; AlreadyInitializedError on second run", async () => {
    await ctx.store.initialise("2.0.0-test");
    const stateFile = path.join(ctx.root, "state/project_state.md");
    const before = await fsp.readFile(stateFile, "utf8");
    // Simulate a user already starting to fill the skeleton.
    const userContent = before.replace("TBD — one paragraph.", "We build a thing for someone.");
    await fsp.writeFile(stateFile, userContent);

    // Re-running initialise must throw; we must NOT clobber the
    // user's in-progress edits.
    await expect(ctx.store.initialise("2.0.0-test")).rejects.toMatchObject({
      code: "ALREADY_INITIALIZED",
    });
    const after = await fsp.readFile(stateFile, "utf8");
    expect(after).toBe(userContent);
  });
});

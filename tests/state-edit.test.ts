import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runState } from "../src/cli/commands/state";
import type { ParsedArgs } from "../src/cli/argv";

async function freshProject() {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-state-edit-"));
  const root = path.join(projectRoot, ".multi-agent");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({
    id: "PM",
    title: "Product Manager",
    owns: ["state/project_state.md", "state/decisions.md"],
  });
  await store.createRole({
    id: "TL",
    title: "Tech Lead",
    owns: ["state/architecture.md"],
  });
  return { projectRoot, root, store };
}

function args(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "state", positional: ["edit"], flags };
}

describe("Store.writeStateFile — append mode (PR8f-B)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("appends text to an existing file without touching the prior content", async () => {
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "EXISTING\n",
    });
    const result = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/project_state.md",
      mode: "append",
      appendText: "APPENDED\n",
    });
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("EXISTING\nAPPENDED\n");
    expect(result.bytesWritten).toBe("APPENDED\n".length);
  });

  it("appending to an absent file creates it with just the appended bytes", async () => {
    const result = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/decisions.md",
      mode: "append",
      appendText: "FIRST ENTRY\n",
    });
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/decisions.md"),
      "utf8",
    );
    expect(onDisk).toBe("FIRST ENTRY\n");
    expect(result.bytesWritten).toBe("FIRST ENTRY\n".length);
  });
});

describe("Store.writeStateFile — replace mode (PR8f-B)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => {
    ctx = await freshProject();
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "alpha beta gamma\n",
    });
  });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("replaces exactly one occurrence and reports replacedOccurrences: 1", async () => {
    const result = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/project_state.md",
      mode: "replace",
      oldText: "beta",
      newText: "DELTA",
    });
    expect(result.replacedOccurrences).toBe(1);
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("alpha DELTA gamma\n");
  });

  it("refuses when old text is not found (USAGE, file untouched)", async () => {
    await expect(
      ctx.store.writeStateFile({
        actor: "PM",
        relPath: "state/project_state.md",
        mode: "replace",
        oldText: "NOT-PRESENT",
        newText: "x",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("alpha beta gamma\n");
  });

  it("refuses when old text appears multiple times without --batch", async () => {
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "TODO TODO TODO\n",
    });
    await expect(
      ctx.store.writeStateFile({
        actor: "PM",
        relPath: "state/project_state.md",
        mode: "replace",
        oldText: "TODO",
        newText: "DONE",
      }),
    ).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringMatching(/appears 3 times/),
    });
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("TODO TODO TODO\n");
  });

  it("replaces all occurrences when --batch is passed", async () => {
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "TODO TODO TODO\n",
    });
    const result = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/project_state.md",
      mode: "replace",
      oldText: "TODO",
      newText: "DONE",
      batch: true,
    });
    expect(result.replacedOccurrences).toBe(3);
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("DONE DONE DONE\n");
  });

  it("supports an empty replacement (deletes the matched text)", async () => {
    const result = await ctx.store.writeStateFile({
      actor: "PM",
      relPath: "state/project_state.md",
      mode: "replace",
      oldText: "beta ",
      newText: "",
    });
    expect(result.replacedOccurrences).toBe(1);
    const onDisk = await fsp.readFile(
      path.join(ctx.root, "state/project_state.md"),
      "utf8",
    );
    expect(onDisk).toBe("alpha gamma\n");
  });

  it("ownership gate still applies: PM cannot replace in TL-owned architecture.md", async () => {
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/architecture.md",
      content: "TL owns this\n",
    });
    await expect(
      ctx.store.writeStateFile({
        actor: "PM",
        relPath: "state/architecture.md",
        mode: "replace",
        oldText: "TL",
        newText: "PM",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

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

describe("agentctl state (CLI dispatcher, PR8f-C)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("rejects an unknown subcommand with a USAGE listing the valid ones", async () => {
    // Future-proofing: when we add more subcommands (e.g. show), this
    // gate prevents typos from silently being misinterpreted.
    await expect(
      runState({
        command: "state",
        positional: ["bogus"],
        flags: { file: "state/x.md", root: ctx.projectRoot },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects a missing subcommand with the same usage hint", async () => {
    await expect(
      runState({
        command: "state",
        positional: [],
        flags: { file: "state/x.md", root: ctx.projectRoot },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("agentctl state edit CLI — flag-exclusion matrix (PR8f-B)", () => {
  let ctx: { projectRoot: string; root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.projectRoot, { recursive: true, force: true }); });

  it("rejects --content together with --append", async () => {
    await expect(
      runState(args({
        file: "state/project_state.md",
        content: "x",
        append: "y",
        root: ctx.projectRoot,
      })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects --replace without --with", async () => {
    await expect(
      runState(args({
        file: "state/project_state.md",
        replace: "x",
        root: ctx.projectRoot,
      })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects --with without --replace", async () => {
    await expect(
      runState(args({
        file: "state/project_state.md",
        with: "y",
        root: ctx.projectRoot,
      })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects --batch outside of --replace", async () => {
    await expect(
      runState(args({
        file: "state/project_state.md",
        append: "x",
        batch: true,
        root: ctx.projectRoot,
      })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("rejects --content together with --replace", async () => {
    await expect(
      runState(args({
        file: "state/project_state.md",
        content: "x",
        replace: "a",
        with: "b",
        root: ctx.projectRoot,
      })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("human output names the mode (Wrote / Appended / Replaced)", async () => {
    await ctx.store.writeStateFile({
      actor: "SYSTEM",
      relPath: "state/project_state.md",
      content: "hello world\n",
    });
    const cap = captureStdout();
    try {
      await runState(args({
        file: "state/project_state.md",
        replace: "world",
        with: "moon",
        root: ctx.projectRoot,
      }));
      expect(cap.stdout).toContain("Replaced 1 occurrence");
    } finally { cap.release(); }
  });
});

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { buildArtifact, writeArtifactFile } from "../src/cli/prompts";
import {
  CLAUDE_MARKER_BEGIN,
  CLAUDE_MARKER_END,
} from "../src/cli/prompts/claude";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-prompt-"));
  const store = new LocalFsStore(path.join(root, ".multi-agent"));
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "Product Manager" });
  return { root, store };
}

describe("buildArtifact", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("every target body contains plan + MA_SESSION + role name", () => {
    for (const t of ["codex", "claude", "cursor", "generic"] as const) {
      const a = buildArtifact(t, "PM", ctx.root);
      expect(a.body).toContain("agentctl plan");
      expect(a.body).toContain("MA_SESSION");
      expect(a.activation).toContain("PM");
      expect(a.activation).toContain(ctx.root);
    }
  });

  it("codex artifact lists exactly two files: SKILL.md and openai.yaml", () => {
    const a = buildArtifact("codex", "PM", ctx.root);
    const names = a.files.map((f) => path.basename(f.path)).sort();
    expect(names).toEqual(["SKILL.md", "openai.yaml"]);
  });

  it("cursor artifact targets .cursor/rules/multi-agent-runtime.mdc with alwaysApply", () => {
    const a = buildArtifact("cursor", "PM", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(
      path.join(ctx.root, ".cursor", "rules", "multi-agent-runtime.mdc"),
    );
    expect(a.files[0].content).toContain("alwaysApply: true");
  });

  it("claude artifact is a marker-block targeting <root>/CLAUDE.md", () => {
    const a = buildArtifact("claude", "PM", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(path.join(ctx.root, "CLAUDE.md"));
    expect(a.files[0].mode).toBe("marker-block");
    expect(a.files[0].markerBegin).toBe(CLAUDE_MARKER_BEGIN);
    expect(a.files[0].markerEnd).toBe(CLAUDE_MARKER_END);
  });

  it("generic artifact writes no files", () => {
    const a = buildArtifact("generic", "PM", ctx.root);
    expect(a.files).toEqual([]);
  });
});

describe("writeArtifactFile", () => {
  let ctx: { root: string; store: LocalFsStore };
  let codexHomeOrig: string | undefined;
  let codexHomeTmp: string;
  beforeEach(async () => {
    ctx = await freshProject();
    codexHomeTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-codex-home-"));
    codexHomeOrig = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHomeTmp;
  });
  afterEach(async () => {
    if (codexHomeOrig !== undefined) process.env.CODEX_HOME = codexHomeOrig;
    else delete process.env.CODEX_HOME;
    await fsp.rm(codexHomeTmp, { recursive: true, force: true });
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("codex --write creates SKILL.md and openai.yaml under CODEX_HOME", async () => {
    const a = buildArtifact("codex", "PM", ctx.root);
    for (const f of a.files) await writeArtifactFile(f);
    const skill = await fsp.readFile(
      path.join(codexHomeTmp, "skills", "multi-agent-runtime", "SKILL.md"),
      "utf8",
    );
    const openai = await fsp.readFile(
      path.join(codexHomeTmp, "skills", "multi-agent-runtime", "agents", "openai.yaml"),
      "utf8",
    );
    expect(skill).toContain("multi-agent-runtime");
    expect(skill).toContain("agentctl plan");
    expect(openai).toContain("display_name");
  });

  it("cursor --write creates the .cursor/rules file inside the project", async () => {
    const a = buildArtifact("cursor", "PM", ctx.root);
    for (const f of a.files) await writeArtifactFile(f);
    const content = await fsp.readFile(
      path.join(ctx.root, ".cursor", "rules", "multi-agent-runtime.mdc"),
      "utf8",
    );
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("agentctl plan");
  });

  it("claude --write upserts a marker block; idempotent on re-run", async () => {
    const a = buildArtifact("claude", "PM", ctx.root);
    const target = a.files[0].path;
    // Pre-existing CLAUDE.md with the user's content; we should preserve it.
    await fsp.writeFile(target, "# My project\n\nHand-written notes.\n");
    const first = await writeArtifactFile(a.files[0]);
    expect(first).toBe("wrote");
    const after1 = await fsp.readFile(target, "utf8");
    expect(after1).toContain("Hand-written notes");
    expect(after1).toContain(CLAUDE_MARKER_BEGIN);
    expect(after1).toContain(CLAUDE_MARKER_END);

    const second = await writeArtifactFile(a.files[0]);
    expect(second).toBe("skipped");
    const after2 = await fsp.readFile(target, "utf8");
    expect(after2).toBe(after1);
  });

  it("cursor --write refuses to clobber an unrelated existing file", async () => {
    const a = buildArtifact("cursor", "PM", ctx.root);
    const target = a.files[0].path;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "# user's hand-written cursor rule\n");
    await expect(writeArtifactFile(a.files[0])).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("cursor --write re-overwrites a previously generated file (idempotent install)", async () => {
    const a = buildArtifact("cursor", "PM", ctx.root);
    expect(await writeArtifactFile(a.files[0])).toBe("wrote");
    expect(await writeArtifactFile(a.files[0])).toBe("skipped");
  });
});

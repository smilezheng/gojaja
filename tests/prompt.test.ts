import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import {
  buildActivation,
  buildRuntime,
  writeArtifactFile,
} from "../src/cli/prompts";
import {
  CLAUDE_MARKER_BEGIN,
  CLAUDE_MARKER_END,
} from "../src/cli/prompts/claude";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-prompt-"));
  const store = new LocalFsStore(path.join(root, ".multi-agent"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  // Several roles are configured so the no-role-intrusion regression has
  // multiple strings to scan against.
  await store.createRole({ id: "PM", title: "Product Manager" });
  await store.createRole({ id: "TL", title: "Tech Lead" });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  return { root, store };
}

const TARGETS = ["codex", "claude", "cursor", "generic"] as const;

describe("buildRuntime (role-free)", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("every target body contains plan + MA_SESSION but never a role id", async () => {
    const config = await ctx.store.readConfig();
    const roleIds = Object.keys(config.roles);
    expect(roleIds.length).toBeGreaterThanOrEqual(3);

    for (const t of TARGETS) {
      const a = buildRuntime(t, ctx.root);
      expect(a.body).toContain("agentctl plan");
      expect(a.body).toContain("MA_SESSION");
      for (const id of roleIds) {
        // Body MUST NOT mention any role id; role binding lives in
        // activate (per-window), not in the host-shared runtime.
        expect(a.body).not.toMatch(new RegExp(`\\b${id}\\b`));
        for (const f of a.files) {
          expect(f.content).not.toMatch(new RegExp(`\\b${id}\\b`));
        }
      }
    }
  });

  it("codex artifact lists exactly two files: SKILL.md and openai.yaml", () => {
    const a = buildRuntime("codex", ctx.root);
    const names = a.files.map((f) => path.basename(f.path)).sort();
    expect(names).toEqual(["SKILL.md", "openai.yaml"]);
  });

  it("cursor artifact targets .cursor/rules/multi-agent-runtime.mdc with alwaysApply", () => {
    const a = buildRuntime("cursor", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(
      path.join(ctx.root, ".cursor", "rules", "multi-agent-runtime.mdc"),
    );
    expect(a.files[0].content).toContain("alwaysApply: true");
  });

  it("claude artifact is a marker-block targeting <root>/CLAUDE.md", () => {
    const a = buildRuntime("claude", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(path.join(ctx.root, "CLAUDE.md"));
    expect(a.files[0].mode).toBe("marker-block");
    expect(a.files[0].markerBegin).toBe(CLAUDE_MARKER_BEGIN);
    expect(a.files[0].markerEnd).toBe(CLAUDE_MARKER_END);
  });

  it("generic artifact writes no files", () => {
    const a = buildRuntime("generic", ctx.root);
    expect(a.files).toEqual([]);
  });

  it("Step 6: cursor body recommends `wait --mode exit` (cursor chat times out long blocks)", () => {
    const a = buildRuntime("cursor", ctx.root);
    expect(a.body).toContain("agentctl wait --mode exit");
    // Must NOT recommend the default `agentctl wait` alone — the cursor
    // host kills sleeping shells before --idle 10 elapses.
    expect(a.body).not.toMatch(/agentctl wait\s*\n/);
  });

  it("Step 6: non-cursor bodies keep block-mode default `agentctl wait`", () => {
    for (const t of ["codex", "claude", "generic"] as const) {
      const a = buildRuntime(t, ctx.root);
      expect(a.body).toContain("agentctl wait");
      expect(a.body).not.toContain("agentctl wait --mode exit");
    }
  });

  it("M1: codex SKILL.md is project-agnostic — same bytes for any projectRoot", async () => {
    const a1 = buildRuntime("codex", "/tmp/project-A");
    const b1 = buildRuntime("codex", "/Users/someone/code/project-B");
    const skillA = a1.files.find((f) => path.basename(f.path) === "SKILL.md");
    const skillB = b1.files.find((f) => path.basename(f.path) === "SKILL.md");
    expect(skillA).toBeDefined();
    expect(skillB).toBeDefined();
    expect(skillA!.content).toBe(skillB!.content);
    // And the skill should NOT contain either of those project paths.
    expect(skillA!.content).not.toContain("/tmp/project-A");
    expect(skillA!.content).not.toContain("/Users/someone/code/project-B");
  });
});

describe("buildActivation (role-bound, never persisted)", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("contains the role name and the project root for every target", () => {
    for (const t of TARGETS) {
      const s = buildActivation(t, "PM", ctx.root);
      expect(s).toContain("PM");
      expect(s).toContain(ctx.root);
    }
  });

  it("codex activation includes the $multi-agent-runtime trigger phrase", () => {
    const s = buildActivation("codex", "PM", ctx.root);
    expect(s).toContain("$multi-agent-runtime");
  });

  it("cursor and claude activations stay short — they assume the runtime body is installed", () => {
    const cursor = buildActivation("cursor", "PM", ctx.root);
    const claude = buildActivation("claude", "PM", ctx.root);
    // Short: well under 2 KB, NOT the multi-KB runtime body. The
    // budget was bumped from 800 to 1500 in PR8e to accommodate the
    // "run role show + agentctl -h" three-step onboarding sequence
    // that prevents the agent from skipping self-introduction.
    expect(cursor.length).toBeLessThan(1500);
    expect(claude.length).toBeLessThan(1500);
    expect(cursor).not.toContain("Collaboration handbook");
    expect(claude).not.toContain("Collaboration handbook");
    // PR8e content invariants: the new snippet must address the agent
    // in the second person and route it through eval + role show + -h.
    expect(cursor).toContain("You are the PM agent");
    expect(cursor).toContain('eval "$(agentctl claim PM --eval)"');
    expect(cursor).toContain("agentctl role show PM");
    expect(cursor).toContain("agentctl -h");
  });

  it("generic activation bundles the runtime body because there is no install location", () => {
    const s = buildActivation("generic", "PM", ctx.root);
    // Should be substantially larger because it includes the full body.
    expect(s.length).toBeGreaterThan(2000);
    expect(s).toContain("Collaboration handbook"); // default body includes handbook
    expect(s).toContain("BEGIN");
    expect(s).toContain("END");
  });

  it("generic activation with withHandbook=false omits the handbook", () => {
    const s = buildActivation("generic", "PM", ctx.root, { withHandbook: false });
    expect(s).not.toContain("Collaboration handbook");
    expect(s).toContain("agentctl plan");
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
    const a = buildRuntime("codex", ctx.root);
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
    const a = buildRuntime("cursor", ctx.root);
    for (const f of a.files) await writeArtifactFile(f);
    const content = await fsp.readFile(
      path.join(ctx.root, ".cursor", "rules", "multi-agent-runtime.mdc"),
      "utf8",
    );
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("agentctl plan");
  });

  it("claude --write upserts a marker block; idempotent on re-run", async () => {
    const a = buildRuntime("claude", ctx.root);
    const target = a.files[0].path;
    await fsp.writeFile(target, "# My project\n\nHand-written notes.\n");
    const first = await writeArtifactFile(a.files[0]);
    expect(first).toBe("wrote");
    const after1 = await fsp.readFile(target, "utf8");
    expect(after1).toContain("Hand-written notes");
    expect(after1).toContain(CLAUDE_MARKER_BEGIN);
    expect(after1).toContain(CLAUDE_MARKER_END);

    const second = await writeArtifactFile(a.files[0]);
    expect(second).toBe("unchanged");
    const after2 = await fsp.readFile(target, "utf8");
    expect(after2).toBe(after1);
  });

  it("cursor --write refuses to clobber an unrelated existing file", async () => {
    const a = buildRuntime("cursor", ctx.root);
    const target = a.files[0].path;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "# user's hand-written cursor rule\n");
    await expect(writeArtifactFile(a.files[0])).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  it("cursor --write is idempotent across re-runs", async () => {
    const a = buildRuntime("cursor", ctx.root);
    expect(await writeArtifactFile(a.files[0])).toBe("wrote");
    expect(await writeArtifactFile(a.files[0])).toBe("unchanged");
  });

  it("PR8d --force-rewrite bypasses the byte-equal short-circuit", async () => {
    // Without force, byte-equal content is preserved (returns 'unchanged');
    // with force, the file is overwritten even when bytes match — useful
    // when the operator wants to confirm the install came from the
    // current template (e.g. after upgrading the CLI).
    const a = buildRuntime("cursor", ctx.root);
    expect(await writeArtifactFile(a.files[0])).toBe("wrote");
    expect(await writeArtifactFile(a.files[0])).toBe("unchanged");
    expect(await writeArtifactFile(a.files[0], { force: true })).toBe("wrote");
  });
});

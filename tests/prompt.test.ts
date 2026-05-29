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
import { runPrompt } from "../src/cli/commands/prompt";
import {
  RUNTIME_MARKER_BEGIN,
  RUNTIME_MARKER_END,
} from "../src/cli/prompts/markers";

async function freshProject() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-prompt-"));
  const store = new LocalFsStore(path.join(root, ".gojaja"), { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  // Several roles are configured so the no-role-intrusion regression has
  // multiple strings to scan against.
  await store.createRole({ id: "PM", title: "Product Manager" });
  await store.createRole({ id: "TL", title: "Tech Lead" });
  await store.createRole({ id: "Backend", title: "Backend Engineer" });
  return { root, store };
}

const TARGETS = ["agents", "claude", "cursor", "generic"] as const;

describe("buildRuntime (role-free)", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshProject(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("every target body contains plan + GOJAJA_SESSION but never a role id", async () => {
    const config = await ctx.store.readConfig();
    const roleIds = Object.keys(config.roles);
    expect(roleIds.length).toBeGreaterThanOrEqual(3);

    for (const t of TARGETS) {
      const a = buildRuntime(t, ctx.root);
      expect(a.body).toContain("gojaja plan");
      expect(a.body).toContain("GOJAJA_SESSION");
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

  it("agents artifact is a marker-block targeting <root>/AGENTS.md", () => {
    const a = buildRuntime("agents", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(path.join(ctx.root, "AGENTS.md"));
    expect(a.files[0].mode).toBe("marker-block");
    expect(a.files[0].markerBegin).toBe(RUNTIME_MARKER_BEGIN);
    expect(a.files[0].markerEnd).toBe(RUNTIME_MARKER_END);
  });

  it("cursor artifact targets .cursor/rules/gojaja-runtime.mdc with alwaysApply", () => {
    const a = buildRuntime("cursor", ctx.root);
    expect(a.files).toHaveLength(1);
    expect(a.files[0].path).toBe(
      path.join(ctx.root, ".cursor", "rules", "gojaja-runtime.mdc"),
    );
    expect(a.files[0].content).toContain("alwaysApply: true");
  });

  it("claude artifact writes AGENTS.md (canonical) + a CLAUDE.md @AGENTS.md importer", () => {
    const a = buildRuntime("claude", ctx.root);
    expect(a.files).toHaveLength(2);
    const byName = Object.fromEntries(a.files.map((f) => [path.basename(f.path), f]));
    // AGENTS.md carries the real runtime; CLAUDE.md is a one-line pointer.
    expect(byName["AGENTS.md"]).toBeDefined();
    expect(byName["AGENTS.md"].mode).toBe("marker-block");
    expect(byName["AGENTS.md"].content).toContain("gojaja plan");
    expect(byName["CLAUDE.md"]).toBeDefined();
    expect(byName["CLAUDE.md"].mode).toBe("marker-block");
    expect(byName["CLAUDE.md"].content).toContain("@AGENTS.md");
    // The importer must NOT duplicate the runtime body.
    expect(byName["CLAUDE.md"].content).not.toContain("gojaja plan");
    for (const f of a.files) {
      expect(f.markerBegin).toBe(RUNTIME_MARKER_BEGIN);
      expect(f.markerEnd).toBe(RUNTIME_MARKER_END);
    }
  });

  it("agents target writes a single canonical AGENTS.md marker block", () => {
    const ag = buildRuntime("agents", ctx.root);
    expect(ag.files).toHaveLength(1);
    expect(ag.files[0].path).toBe(path.join(ctx.root, "AGENTS.md"));
    expect(ag.files[0].mode).toBe("marker-block");
    expect(ag.files[0].content).toContain("gojaja plan");
  });

  it("generic artifact writes no files", () => {
    const a = buildRuntime("generic", ctx.root);
    expect(a.files).toEqual([]);
  });

  it("every target recommends the uniform blocking `gojaja wait` (no per-host --poll-interval pin)", () => {
    // wait now blocks internally for the whole deadline, so there is no
    // need to pin a short --poll-interval per host. The recommendation
    // is identical everywhere, and removed legacy flags must not return.
    for (const t of ["agents", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, ctx.root);
      expect(a.body).toContain("gojaja wait");
      expect(a.body).not.toContain("--poll-interval");
      expect(a.body).not.toContain("--mode exit");
      expect(a.body).not.toContain("--mode block");
      expect(a.body).not.toContain("RESUME");
    }
  });

  it("every target's runtime body explicitly forbids ending a turn without `wait` (PR8w hard rule)", () => {
    // The most common per-turn failure mode is "agent answers the user
    // in chat and ends the turn unparked" — the role goes deaf and no
    // event can wake it. The runtime body must call this out as a
    // rule, not just as step 5 of "Every turn", because step 5 reads
    // as one of N choices. Two phrasings here:
    //   - the imperative rule in `## Rules`
    //   - the explicit carve-out for conversational-only turns
    // Both must be present in every host's body, and the
    // "End-of-turn ritual" framing must position `wait` as the only
    // legitimate end of turn (not just "another step").
    for (const t of ["agents", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, ctx.root);
      expect(a.body).toMatch(/NEVER end a turn without `gojaja wait`/);
      expect(a.body).toMatch(/conversational message/i);
      expect(a.body).toMatch(/End-of-turn ritual/);
    }
  });

  it("agents AGENTS.md block is project-path-agnostic — same bytes for any projectRoot", async () => {
    // The block goes into <root>/AGENTS.md (project-local), but its
    // CONTENT bakes no absolute path: gojaja discovers the root from cwd
    // at runtime. So the block bytes are identical regardless of root,
    // and never leak a machine-specific path into a committed file.
    const a1 = buildRuntime("agents", "/tmp/project-A");
    const b1 = buildRuntime("agents", "/Users/someone/code/project-B");
    expect(a1.files[0].content).toBe(b1.files[0].content);
    expect(a1.files[0].content).not.toContain("/tmp/project-A");
    expect(a1.files[0].content).not.toContain("/Users/someone/code/project-B");
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

  it("agents activation is the standard snippet (runtime lives in AGENTS.md, not a skill)", () => {
    const s = buildActivation("agents", "PM", ctx.root);
    expect(s).toContain("You are the PM agent");
    expect(s).toContain('eval "$(gojaja claim PM --eval)"');
    // No skill-invocation trigger phrase anymore.
    expect(s).not.toContain("$gojaja-runtime");
  });

  it("cursor and claude activations stay short — they assume the runtime body is installed", () => {
    const cursor = buildActivation("cursor", "PM", ctx.root);
    const claude = buildActivation("claude", "PM", ctx.root);
    // Short: well under 2 KB, NOT the multi-KB runtime body. The
    // budget was bumped from 800 to 1500 in PR8e to accommodate the
    // "run role show + gojaja -h" three-step onboarding sequence
    // that prevents the agent from skipping self-introduction.
    expect(cursor.length).toBeLessThan(1500);
    expect(claude.length).toBeLessThan(1500);
    expect(cursor).not.toContain("Collaboration handbook");
    expect(claude).not.toContain("Collaboration handbook");
    // PR8e content invariants: the new snippet must address the agent
    // in the second person and route it through eval + role show + -h.
    expect(cursor).toContain("You are the PM agent");
    expect(cursor).toContain('eval "$(gojaja claim PM --eval)"');
    expect(cursor).toContain("gojaja role show PM");
    expect(cursor).toContain("gojaja -h");
  });

  it("generic activation bundles the runtime body because there is no install location", () => {
    const s = buildActivation("generic", "PM", ctx.root);
    // Should be substantially larger because it includes the full body.
    expect(s.length).toBeGreaterThan(2000);
    expect(s).toContain("When to use which"); // default body includes the cheatsheet
    expect(s).toContain("gojaja handbook"); // pointer to the full policy
  });

  it("generic activation with withHandbook=false omits the cheatsheet", () => {
    const s = buildActivation("generic", "PM", ctx.root, { withHandbook: false });
    expect(s).not.toContain("When to use which");
    expect(s).toContain("gojaja plan");
  });
});

describe("writeArtifactFile", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => {
    ctx = await freshProject();
  });
  afterEach(async () => {
    await fsp.rm(ctx.root, { recursive: true, force: true });
  });

  it("agents --write upserts a marker block in <root>/AGENTS.md, preserving prior content", async () => {
    const a = buildRuntime("agents", ctx.root);
    const target = a.files[0].path;
    expect(target).toBe(path.join(ctx.root, "AGENTS.md"));
    await fsp.writeFile(target, "# My project\n\nHand-written agent notes.\n");
    const first = await writeArtifactFile(a.files[0]);
    expect(first).toBe("wrote");
    const after = await fsp.readFile(target, "utf8");
    expect(after).toContain("Hand-written agent notes");
    expect(after).toContain(RUNTIME_MARKER_BEGIN);
    expect(after).toContain("gojaja plan");
  });

  it("agents --write is idempotent across re-runs", async () => {
    const a = buildRuntime("agents", ctx.root);
    expect(await writeArtifactFile(a.files[0])).toBe("wrote");
    expect(await writeArtifactFile(a.files[0])).toBe("unchanged");
  });

  it("prompt --write reports coexisting runtime files (duplicate-injection guard)", async () => {
    // AGENTS.md is read by Cursor too, so installing agents (AGENTS.md)
    // and cursor (.mdc) in one project means a Cursor window injects the
    // block twice. `prompt --json` surfaces every installed runtime file
    // so the CLI can warn; assert the detection sees both.
    const cap = (() => {
      let buf = "";
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
        buf += c;
        return true;
      };
      return { drain: () => buf, release: () => { (process.stdout as unknown as { write: typeof orig }).write = orig; } };
    })();
    try {
      await runPrompt({ command: "prompt", positional: [], flags: { target: "agents", write: true, json: true, root: ctx.root } });
      await runPrompt({ command: "prompt", positional: [], flags: { target: "cursor", write: true, json: true, root: ctx.root } });
      const lines = cap.drain().trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]);
      expect(last.installedRuntimeFiles).toContain("AGENTS.md");
      expect(last.installedRuntimeFiles).toContain(".cursor/rules/gojaja-runtime.mdc");
    } finally {
      cap.release();
    }
  });

  it("cursor --write creates the .cursor/rules file inside the project", async () => {
    const a = buildRuntime("cursor", ctx.root);
    for (const f of a.files) await writeArtifactFile(f);
    const content = await fsp.readFile(
      path.join(ctx.root, ".cursor", "rules", "gojaja-runtime.mdc"),
      "utf8",
    );
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("gojaja plan");
  });

  it("claude --write upserts a marker block; idempotent on re-run", async () => {
    const a = buildRuntime("claude", ctx.root);
    const target = a.files[0].path;
    await fsp.writeFile(target, "# My project\n\nHand-written notes.\n");
    const first = await writeArtifactFile(a.files[0]);
    expect(first).toBe("wrote");
    const after1 = await fsp.readFile(target, "utf8");
    expect(after1).toContain("Hand-written notes");
    expect(after1).toContain(RUNTIME_MARKER_BEGIN);
    expect(after1).toContain(RUNTIME_MARKER_END);

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

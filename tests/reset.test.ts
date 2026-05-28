import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReset, __test__ } from "../src/cli/commands/reset";
import { LocalFsStore } from "../src/core/local-fs-store";
import {
  CLAUDE_MARKER_BEGIN,
  CLAUDE_MARKER_END,
} from "../src/cli/prompts/claude";
import type { ParsedArgs } from "../src/cli/argv";

const { stripClaudeMarkerBlock } = __test__;

async function freshProject(): Promise<{ projectRoot: string; basename: string }> {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-reset-"));
  return { projectRoot, basename: path.basename(projectRoot) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function capture(): {
  stdout: string;
  release: () => void;
  drain: () => string;
} {
  let buf = "";
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    buf += chunk;
    return true;
  };
  return {
    get stdout() {
      return buf;
    },
    release: () => {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    },
    drain: () => {
      const v = buf;
      buf = "";
      return v;
    },
  };
}

function args(flags: Record<string, string | boolean>): ParsedArgs {
  return { command: "reset", positional: [], flags };
}

async function initLayer(projectRoot: string): Promise<void> {
  const layerRoot = path.join(projectRoot, ".multi-agent");
  const store = new LocalFsStore(layerRoot, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "PM" });
}

async function writeCursorRule(projectRoot: string, content = "managed rule"): Promise<void> {
  const dir = path.join(projectRoot, ".cursor", "rules");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "multi-agent-runtime.mdc"), content);
}

async function writeClaudeWithBlock(projectRoot: string, surrounding: string = ""): Promise<string> {
  const block = `${CLAUDE_MARKER_BEGIN}\n# managed content\n${CLAUDE_MARKER_END}`;
  const text = surrounding
    ? `${surrounding}\n\n${block}\n`
    : `${block}\n`;
  const target = path.join(projectRoot, "CLAUDE.md");
  await fsp.writeFile(target, text);
  return text;
}

describe("agentctl reset", () => {
  let savedSession: string | undefined;
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    savedSession = process.env.MA_SESSION;
    delete process.env.MA_SESSION;
    cap = capture();
  });
  afterEach(() => {
    cap.release();
    if (savedSession === undefined) delete process.env.MA_SESSION;
    else process.env.MA_SESSION = savedSession;
  });

  it("refuses when MA_SESSION is set", async () => {
    const { projectRoot } = await freshProject();
    process.env.MA_SESSION = "01HZSESSION";
    try {
      await expect(runReset(args({ root: projectRoot }))).rejects.toMatchObject({
        code: "USAGE",
      });
    } finally {
      delete process.env.MA_SESSION;
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("nothing-to-remove: pristine project prints a safe message and exits 0", async () => {
    const { projectRoot } = await freshProject();
    try {
      const code = await runReset(args({ root: projectRoot }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("Nothing to remove");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preview (no --confirm) lists planned removals and does NOT delete anything", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      await writeCursorRule(projectRoot);
      const code = await runReset(args({ root: projectRoot }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("Reset preview");
      expect(cap.stdout).toContain(".multi-agent");
      expect(cap.stdout).toContain("multi-agent-runtime.mdc");
      expect(cap.stdout).toContain(`agentctl reset --confirm ${basename}`);
      // Still on disk.
      expect(await exists(path.join(projectRoot, ".multi-agent"))).toBe(true);
      expect(await exists(path.join(projectRoot, ".cursor/rules/multi-agent-runtime.mdc"))).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("--dry-run + --confirm shows preview, no delete", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      const code = await runReset(args({ root: projectRoot, confirm: basename, "dry-run": true }));
      expect(code).toBe(0);
      expect(cap.stdout).toContain("Dry-run: nothing was removed.");
      expect(await exists(path.join(projectRoot, ".multi-agent"))).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("--confirm with wrong token raises USAGE", async () => {
    const { projectRoot } = await freshProject();
    try {
      await initLayer(projectRoot);
      await expect(
        runReset(args({ root: projectRoot, confirm: "totally-wrong" })),
      ).rejects.toMatchObject({ code: "USAGE" });
      expect(await exists(path.join(projectRoot, ".multi-agent"))).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("full reset removes .multi-agent/ and the Cursor rule (+ empty parent dirs)", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      await writeCursorRule(projectRoot);
      const code = await runReset(args({ root: projectRoot, confirm: basename }));
      expect(code).toBe(0);
      expect(await exists(path.join(projectRoot, ".multi-agent"))).toBe(false);
      expect(await exists(path.join(projectRoot, ".cursor/rules/multi-agent-runtime.mdc"))).toBe(false);
      // Empty .cursor/rules/ and .cursor/ also cleaned.
      expect(await exists(path.join(projectRoot, ".cursor/rules"))).toBe(false);
      expect(await exists(path.join(projectRoot, ".cursor"))).toBe(false);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("strips the CLAUDE.md marker block but preserves surrounding user content", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      const surrounding = "# My Project\n\nI keep my own notes here.";
      await writeClaudeWithBlock(projectRoot, surrounding);
      await runReset(args({ root: projectRoot, confirm: basename }));
      const text = await fsp.readFile(path.join(projectRoot, "CLAUDE.md"), "utf8");
      expect(text).toContain("My Project");
      expect(text).toContain("I keep my own notes here");
      expect(text).not.toContain(CLAUDE_MARKER_BEGIN);
      expect(text).not.toContain(CLAUDE_MARKER_END);
      expect(text).not.toContain("managed content");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("deletes CLAUDE.md entirely when the marker block was its only content", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      await writeClaudeWithBlock(projectRoot, "");
      await runReset(args({ root: projectRoot, confirm: basename }));
      expect(await exists(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("--purge-codex-skill removes ~/.codex skill when present (via CODEX_HOME override)", async () => {
    const { projectRoot, basename } = await freshProject();
    const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-reset-codex-"));
    const skillDir = path.join(fakeHome, "skills", "multi-agent-runtime");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "managed");
    const savedCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeHome;
    try {
      await initLayer(projectRoot);
      const code = await runReset(args({
        root: projectRoot,
        confirm: basename,
        "purge-codex-skill": true,
      }));
      expect(code).toBe(0);
      expect(await exists(skillDir)).toBe(false);
    } finally {
      if (savedCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodex;
      await fsp.rm(projectRoot, { recursive: true, force: true });
      await fsp.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("without --purge-codex-skill leaves the Codex skill untouched", async () => {
    const { projectRoot, basename } = await freshProject();
    const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-reset-codex-"));
    const skillDir = path.join(fakeHome, "skills", "multi-agent-runtime");
    await fsp.mkdir(skillDir, { recursive: true });
    await fsp.writeFile(path.join(skillDir, "SKILL.md"), "managed");
    const savedCodex = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fakeHome;
    try {
      await initLayer(projectRoot);
      await runReset(args({ root: projectRoot, confirm: basename }));
      expect(await exists(skillDir)).toBe(true);
    } finally {
      if (savedCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodex;
      await fsp.rm(projectRoot, { recursive: true, force: true });
      await fsp.rm(fakeHome, { recursive: true, force: true });
    }
  });

  it("JSON output shape for preview / reset / nothing-to-remove", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      // 1. nothing-to-remove
      await runReset(args({ root: projectRoot, json: true }));
      const empty = JSON.parse(cap.drain().trim());
      expect(empty.status).toBe("nothing-to-remove");

      // 2. preview
      await initLayer(projectRoot);
      await runReset(args({ root: projectRoot, json: true }));
      const preview = JSON.parse(cap.drain().trim());
      expect(preview.status).toBe("preview");
      expect(preview.confirmToken).toBe(basename);
      expect(preview.willRemove.some((it: { kind: string }) => it.kind === "layer-dir")).toBe(true);

      // 3. reset
      await runReset(args({ root: projectRoot, confirm: basename, json: true }));
      const done = JSON.parse(cap.drain().trim());
      expect(done.status).toBe("reset");
      expect(done.removed.some((it: { kind: string }) => it.kind === "layer-dir")).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("stripClaudeMarkerBlock", () => {
  it("returns input unchanged when markers are absent", () => {
    const text = "# README\n\nno block here\n";
    expect(stripClaudeMarkerBlock(text)).toBe(text);
  });

  it("preserves a leading user heading", () => {
    const text = `# My Project\n\n${CLAUDE_MARKER_BEGIN}\nbody\n${CLAUDE_MARKER_END}\n\nMore notes.\n`;
    const stripped = stripClaudeMarkerBlock(text);
    expect(stripped).toContain("My Project");
    expect(stripped).toContain("More notes.");
    expect(stripped).not.toContain(CLAUDE_MARKER_BEGIN);
  });

  it("collapses excessive blank lines after stripping", () => {
    const text = `A\n\n\n\n${CLAUDE_MARKER_BEGIN}\nbody\n${CLAUDE_MARKER_END}\n\n\n\nB\n`;
    const stripped = stripClaudeMarkerBlock(text);
    expect(stripped).not.toMatch(/\n{3,}/);
    expect(stripped).toContain("A");
    expect(stripped).toContain("B");
  });
});

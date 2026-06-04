import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runReset, __test__ } from "../src/cli/commands/reset";
import { LocalFsStore } from "../src/core/local-fs-store";

const execFileP = promisify(execFile);
import {
  RUNTIME_MARKER_BEGIN as CLAUDE_MARKER_BEGIN,
  RUNTIME_MARKER_END as CLAUDE_MARKER_END,
} from "../src/cli/prompts/markers";
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
  const layerRoot = path.join(projectRoot, ".gojaja");
  const store = new LocalFsStore(layerRoot, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  await store.createRole({ id: "PM", title: "PM" });
}

async function writeCursorRule(projectRoot: string, content = "managed rule"): Promise<void> {
  const dir = path.join(projectRoot, ".cursor", "rules");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "gojaja-runtime.mdc"), content);
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

describe("gojaja reset", () => {
  let savedSession: string | undefined;
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    savedSession = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
    cap = capture();
  });
  afterEach(() => {
    cap.release();
    if (savedSession === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = savedSession;
  });

  it("refuses when GOJAJA_SESSION is set", async () => {
    const { projectRoot } = await freshProject();
    process.env.GOJAJA_SESSION = "01HZSESSION";
    try {
      await expect(runReset(args({ root: projectRoot }))).rejects.toMatchObject({
        code: "USAGE",
      });
    } finally {
      delete process.env.GOJAJA_SESSION;
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
      expect(cap.stdout).toContain(".gojaja");
      expect(cap.stdout).toContain("gojaja-runtime.mdc");
      expect(cap.stdout).toContain(`gojaja reset --confirm ${basename}`);
      // Still on disk.
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(true);
      expect(await exists(path.join(projectRoot, ".cursor/rules/gojaja-runtime.mdc"))).toBe(true);
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
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(true);
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
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("full reset removes .gojaja/ and the Cursor rule (+ empty parent dirs)", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      await writeCursorRule(projectRoot);
      // PR9.x: reset now refuses on dirty / non-git roots without
      // --force, matching `gojaja init`'s posture. Tests use tmpdirs
      // that are not git repos, so they opt out of the git-state gate.
      const code = await runReset(args({ root: projectRoot, confirm: basename, force: true }));
      expect(code).toBe(0);
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(false);
      expect(await exists(path.join(projectRoot, ".cursor/rules/gojaja-runtime.mdc"))).toBe(false);
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
      await runReset(args({ root: projectRoot, confirm: basename, force: true }));
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
      await runReset(args({ root: projectRoot, confirm: basename, force: true }));
      expect(await exists(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("strips the AGENTS.md marker block but preserves surrounding user content", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      const block = `${CLAUDE_MARKER_BEGIN}\n# managed content\n${CLAUDE_MARKER_END}`;
      await fsp.writeFile(
        path.join(projectRoot, "AGENTS.md"),
        `# My agents\n\nProject-specific agent notes.\n\n${block}\n`,
      );
      await runReset(args({ root: projectRoot, confirm: basename, force: true }));
      const text = await fsp.readFile(path.join(projectRoot, "AGENTS.md"), "utf8");
      expect(text).toContain("Project-specific agent notes");
      expect(text).not.toContain(CLAUDE_MARKER_BEGIN);
      expect(text).not.toContain("managed content");
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("deletes AGENTS.md entirely when the marker block was its only content", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      const block = `${CLAUDE_MARKER_BEGIN}\n# managed content\n${CLAUDE_MARKER_END}`;
      await fsp.writeFile(path.join(projectRoot, "AGENTS.md"), `${block}\n`);
      await runReset(args({ root: projectRoot, confirm: basename, force: true }));
      expect(await exists(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
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
      await runReset(args({ root: projectRoot, confirm: basename, force: true, json: true }));
      const done = JSON.parse(cap.drain().trim());
      expect(done.status).toBe("reset");
      expect(done.removed.some((it: { kind: string }) => it.kind === "layer-dir")).toBe(true);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

/**
 * PR9.x: reset refuses on a dirty or non-git project unless --force,
 * mirroring `gojaja init`'s posture. The execute path runs the
 * git-state probe AFTER --confirm matches.
 */
describe("gojaja reset: git-state safety gate", () => {
  let savedSession: string | undefined;
  let cap: ReturnType<typeof capture>;
  beforeEach(() => {
    savedSession = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
    cap = capture();
  });
  afterEach(() => {
    cap.release();
    if (savedSession === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = savedSession;
  });

  it("refuses on a non-git project unless --force", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      await initLayer(projectRoot);
      await expect(
        runReset(args({ root: projectRoot, confirm: basename })),
      ).rejects.toMatchObject({ code: "USAGE" });
      // Layer untouched.
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(true);
      // --force bypasses, succeeds.
      const code = await runReset(
        args({ root: projectRoot, confirm: basename, force: true }),
      );
      expect(code).toBe(0);
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(false);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("refuses on a dirty git tree unless --force", async () => {
    const { projectRoot, basename } = await freshProject();
    try {
      // Real git init so the gate sees a work tree.
      await execFileP("git", ["init", "-q"], { cwd: projectRoot });
      // Commit something so HEAD exists; then leave dirty content.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "first\n");
      await execFileP("git", ["add", "."], { cwd: projectRoot });
      await execFileP(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
        { cwd: projectRoot },
      );
      await initLayer(projectRoot);
      // Mutate without committing → dirty.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "second\n");
      await expect(
        runReset(args({ root: projectRoot, confirm: basename })),
      ).rejects.toMatchObject({ code: "USAGE" });
      expect(await exists(path.join(projectRoot, ".gojaja"))).toBe(true);
      // --force bypasses.
      const code = await runReset(
        args({ root: projectRoot, confirm: basename, force: true }),
      );
      expect(code).toBe(0);
    } finally {
      await fsp.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("preview JSON surfaces the git state alongside the plan", async () => {
    const { projectRoot } = await freshProject();
    try {
      await initLayer(projectRoot);
      await runReset(args({ root: projectRoot, json: true }));
      const preview = JSON.parse(cap.drain().trim());
      expect(preview.git).toBeDefined();
      // Tmpdir, no git init → not-a-repo.
      expect(preview.git.kind).toBe("not-a-repo");
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

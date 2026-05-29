import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexSkillDir,
  otherCodexProjects,
  registerCodexProject,
  unregisterCodexProject,
} from "../src/cli/prompts/codex-registry";

// The registry keys off CODEX_HOME; point it at a temp dir per test so
// we never touch a developer's real ~/.codex.
describe("codex skill reference counting", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-codexhome-"));
    prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    // The skill dir must exist for unregister to persist (it refuses to
    // recreate a dir the caller is about to delete).
    await fsp.mkdir(codexSkillDir(), { recursive: true });
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevHome;
    await fsp.rm(home, { recursive: true, force: true });
  });

  it("register is idempotent and dedups", async () => {
    await registerCodexProject("/proj/a");
    await registerCodexProject("/proj/a");
    await registerCodexProject("/proj/b");
    expect((await otherCodexProjects("/proj/zzz")).sort()).toEqual(["/proj/a", "/proj/b"]);
  });

  it("otherCodexProjects excludes the queried project", async () => {
    await registerCodexProject("/proj/a");
    await registerCodexProject("/proj/b");
    expect(await otherCodexProjects("/proj/a")).toEqual(["/proj/b"]);
  });

  it("unregister returns the remaining projects (the ref count)", async () => {
    await registerCodexProject("/proj/a");
    await registerCodexProject("/proj/b");
    const remaining = await unregisterCodexProject("/proj/a");
    expect(remaining).toEqual(["/proj/b"]);
    // last one out → empty, signalling the skill dir is now safe to delete
    const empty = await unregisterCodexProject("/proj/b");
    expect(empty).toEqual([]);
  });

  it("unregister of an unknown project is a no-op", async () => {
    await registerCodexProject("/proj/a");
    const remaining = await unregisterCodexProject("/proj/never-registered");
    expect(remaining).toEqual(["/proj/a"]);
  });

  it("missing registry reads as empty (skill predating ref-counting)", async () => {
    expect(await otherCodexProjects("/proj/a")).toEqual([]);
  });
});

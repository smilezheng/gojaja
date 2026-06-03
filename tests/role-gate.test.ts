import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import { runRole } from "../src/cli/commands/role";
import { Paths } from "../src/core/paths";
import type { ParsedArgs } from "../src/cli/argv";

/**
 * PR9 SYSTEM-3 ownership gate for `role create` / `role delete`.
 *
 * Both commands now follow the same authorisation pattern:
 *   - actor === "SYSTEM" (via `--as-system`) → allowed (bootstrap).
 *   - actor is a role whose `owns` list contains `config.yaml` →
 *     allowed (delegated HR / Admin pattern).
 *   - any other actor → ForbiddenError (exit code 9).
 *
 * The prior rules — "no session = SYSTEM = allowed" for create and
 * "session-set = refuse" for delete — both leaked the trust boundary
 * to env-var presence. SYSTEM-3 unifies them around the explicit
 * ownership of `config.yaml`.
 */

interface Ctx { projectRoot: string; root: string; store: LocalFsStore }

async function freshProject(): Promise<Ctx> {
  const projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "gojaja-rolegate-"));
  const root = path.join(projectRoot, ".gojaja");
  const store = new LocalFsStore(root, { safetyMarginMs: 0 });
  await store.initialise("2.0.0-test");
  return { projectRoot, root, store };
}

function args(positional: string[], flags: Record<string, string | boolean>): ParsedArgs {
  return { command: positional[0] ?? "", positional, flags };
}

describe("SYSTEM-3 role create gate", () => {
  let ctx: Ctx;
  let savedEnv: string | undefined;
  beforeEach(async () => {
    ctx = await freshProject();
    savedEnv = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = savedEnv;
    await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("refuses bare-human invocation (no session, no flag)", async () => {
    await expect(
      runRole(args(["create", "PM"], { root: ctx.projectRoot })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("accepts --as-system as the project-owner bootstrap path", async () => {
    const code = await runRole(
      args(["create", "PM"], {
        root: ctx.projectRoot,
        "as-system": true,
        json: true,
      }),
    );
    expect(code).toBe(0);
    const config = await ctx.store.readConfig();
    expect(config.roles.PM).toBeDefined();
  });

  it("refuses a non-SYSTEM actor lacking config.yaml ownership", async () => {
    // Bootstrap: create a Worker role with no config.yaml owns.
    await ctx.store.createRole({ id: "Worker", title: "Worker" });
    const s = await ctx.store.claimSession("Worker", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await expect(
      runRole(
        args(["create", "Sneaky"], {
          root: ctx.projectRoot,
          json: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts a non-SYSTEM actor whose owns includes config.yaml (delegation)", async () => {
    // Bootstrap an HR role with config.yaml in its owns.
    await ctx.store.createRole({
      id: "HR",
      title: "HR",
      owns: [Paths.configFile],
    });
    const s = await ctx.store.claimSession("HR", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const code = await runRole(
      args(["create", "NewRole"], {
        root: ctx.projectRoot,
        json: true,
      }),
    );
    expect(code).toBe(0);
    const config = await ctx.store.readConfig();
    expect(config.roles.NewRole).toBeDefined();
  });
});

describe("SYSTEM-3 role delete gate", () => {
  let ctx: Ctx;
  let savedEnv: string | undefined;
  beforeEach(async () => {
    ctx = await freshProject();
    savedEnv = process.env.GOJAJA_SESSION;
    delete process.env.GOJAJA_SESSION;
    // Pre-seed a role we can repeatedly try to delete.
    await ctx.store.createRole({ id: "Target", title: "Target" });
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.GOJAJA_SESSION;
    else process.env.GOJAJA_SESSION = savedEnv;
    await fsp.rm(ctx.projectRoot, { recursive: true, force: true });
  });

  it("refuses bare-human invocation (no session, no flag)", async () => {
    await expect(
      runRole(args(["delete", "Target"], { root: ctx.projectRoot })),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("accepts --as-system (replaces the old 'GOJAJA_SESSION must be unset' rule)", async () => {
    const code = await runRole(
      args(["delete", "Target"], {
        root: ctx.projectRoot,
        "as-system": true,
        json: true,
      }),
    );
    expect(code).toBe(0);
    const config = await ctx.store.readConfig();
    expect(config.roles.Target).toBeUndefined();
  });

  it("refuses a session for a role lacking config.yaml ownership", async () => {
    const s = await ctx.store.claimSession("Target", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    await expect(
      runRole(args(["delete", "Target"], { root: ctx.projectRoot })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts a session for a role whose owns includes config.yaml (HR can delete)", async () => {
    await ctx.store.createRole({
      id: "HR",
      title: "HR",
      owns: [Paths.configFile],
    });
    const s = await ctx.store.claimSession("HR", 60);
    process.env.GOJAJA_SESSION = s.sessionId;
    const code = await runRole(
      args(["delete", "Target"], {
        root: ctx.projectRoot,
        json: true,
      }),
    );
    expect(code).toBe(0);
    const config = await ctx.store.readConfig();
    expect(config.roles.Target).toBeUndefined();
    // ROLE_DELETED event should record HR as the actor, not SYSTEM.
    const events = await ctx.store.listEventsAfter("");
    const del = events.find((e) => e.type === "ROLE_DELETED");
    expect(del?.from).toBe("HR");
  });
});

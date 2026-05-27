import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFsStore } from "../src/core/local-fs-store";
import type { ProjectConfig } from "../src/core/types";

async function freshStore() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ma-role-"));
  const store = new LocalFsStore(root);
  await store.initialise("2.0.0-test");
  return { root, store };
}

describe("Store.createRole", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("creates both config entry and roles/<id>.md", async () => {
    const r = await ctx.store.createRole({
      id: "PM",
      title: "Product Manager",
      description: "Owns scope and acceptance",
      owns: ["state/project_state.md"],
      reportsTo: [],
      mustNotEdit: ["state/architecture.md"],
    });
    expect(r.title).toBe("Product Manager");

    const md = await fsp.readFile(
      path.join(ctx.root, "roles", "PM.md"),
      "utf8",
    );
    expect(md).toContain("Product Manager");
    expect(md).toContain("Role id: `PM`");
    // Should not duplicate machine-readable scope inside the markdown.
    expect(md).toContain("config.yaml");
    expect(md).not.toContain("state/architecture.md"); // owned by config, not markdown

    const configRaw = await fsp.readFile(
      path.join(ctx.root, "config.yaml"),
      "utf8",
    );
    const config = yaml.load(configRaw) as ProjectConfig;
    expect(config.roles.PM.owns).toEqual(["state/project_state.md"]);
    expect(config.roles.PM.mustNotEdit).toEqual(["state/architecture.md"]);
  });

  it("refuses to create a duplicate role", async () => {
    await ctx.store.createRole({ id: "PM", title: "Product Manager" });
    await expect(
      ctx.store.createRole({ id: "PM", title: "Other" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("refuses if roles/<id>.md exists but config entry does not (defensive)", async () => {
    await fsp.mkdir(path.join(ctx.root, "roles"), { recursive: true });
    await fsp.writeFile(path.join(ctx.root, "roles", "PM.md"), "# pre-existing\n");
    await expect(
      ctx.store.createRole({ id: "PM", title: "PM" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("validates role id", async () => {
    await expect(
      ctx.store.createRole({ id: "../etc", title: "x" }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      ctx.store.createRole({ id: "SYSTEM", title: "x" }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("serialises concurrent creates of the same id (only one succeeds)", async () => {
    const results = await Promise.allSettled([
      ctx.store.createRole({ id: "PM", title: "A" }),
      ctx.store.createRole({ id: "PM", title: "B" }),
      ctx.store.createRole({ id: "PM", title: "C" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(2);
    const config = await ctx.store.readConfig();
    expect(Object.keys(config.roles)).toEqual(["PM"]);
  });
});

describe("Store.readConfig / writeConfig", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("initialise seeds an empty config", async () => {
    const config = await ctx.store.readConfig();
    expect(config.schemaVersion).toBe("2.0.0-test");
    expect(config.roles).toEqual({});
  });

  it("rejects malformed yaml as StateCorruptionError", async () => {
    await fsp.writeFile(path.join(ctx.root, "config.yaml"), "::: not: yaml: :::\n");
    await expect(ctx.store.readConfig()).rejects.toMatchObject({
      code: "STATE_CORRUPT",
    });
  });

  it("rejects missing schemaVersion as StateCorruptionError", async () => {
    await fsp.writeFile(path.join(ctx.root, "config.yaml"), "roles: {}\n");
    await expect(ctx.store.readConfig()).rejects.toMatchObject({
      code: "STATE_CORRUPT",
    });
  });
});

describe("Store.readRoleFile", () => {
  let ctx: { root: string; store: LocalFsStore };
  beforeEach(async () => { ctx = await freshStore(); });
  afterEach(async () => { await fsp.rm(ctx.root, { recursive: true, force: true }); });

  it("returns markdown content for an existing role", async () => {
    await ctx.store.createRole({ id: "PM", title: "Product Manager" });
    const md = await ctx.store.readRoleFile("PM");
    expect(md).toContain("Product Manager");
  });

  it("throws UnknownRoleError for a missing role", async () => {
    await expect(ctx.store.readRoleFile("PM")).rejects.toMatchObject({
      code: "UNKNOWN_ROLE",
    });
  });
});

import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runRoleCreate(args: ParsedArgs): Promise<number> {
  // `agentctl role create <id> [<title>]` — title is also accepted as the
  // second positional argument for ergonomics, since most users will spell
  // it out at the same time as the id.
  const id = args.positional[1];
  if (!id) {
    throw new UsageError(
      "Usage: agentctl role create <id> [<title>] [--description <text>] [--owns <a,b>] [--reports-to <r1,r2>] [--must-not-edit <a,b>]",
    );
  }
  const title =
    args.positional[2] ?? optionalString(args.flags, "title") ?? `${id} Agent`;
  const description = optionalString(args.flags, "description") ?? "";
  const owns = splitList(optionalString(args.flags, "owns"));
  const reportsTo = splitList(optionalString(args.flags, "reports-to"));
  const mustNotEdit = splitList(optionalString(args.flags, "must-not-edit"));
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  const roleConfig = await store.createRole({
    id,
    title,
    description,
    owns,
    reportsTo,
    mustNotEdit,
  });

  if (json) {
    process.stdout.write(
      JSON.stringify({ status: "created", role: { id, ...roleConfig } }) + "\n",
    );
  } else {
    process.stdout.write(
      `Created role '${id}' (${roleConfig.title}).\n` +
        `Edit '.multi-agent/config.yaml' under 'roles.${id}' to set owns / reportsTo / mustNotEdit.\n` +
        `Next step: 'agentctl prompt ${id} --target <codex|claude|cursor|generic>' to get the agent activation prompt.\n`,
    );
  }
  return 0;
}

async function runRoleList(args: ParsedArgs): Promise<number> {
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  const ids = Object.keys(config.roles).sort();

  if (json) {
    process.stdout.write(
      JSON.stringify({
        roles: ids.map((id) => ({ id, ...config.roles[id] })),
      }) + "\n",
    );
    return 0;
  }
  if (ids.length === 0) {
    process.stdout.write(
      "No roles configured. Create one with: agentctl role create <id> <title>\n",
    );
    return 0;
  }
  for (const id of ids) {
    const r = config.roles[id];
    process.stdout.write(`${id.padEnd(12)} ${r.title}\n`);
  }
  return 0;
}

async function runRoleShow(args: ParsedArgs): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    throw new UsageError("Usage: agentctl role show <id>");
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  const cfg = config.roles[id];
  if (!cfg) {
    throw new UsageError(`Unknown role '${id}'. Roles: ${Object.keys(config.roles).sort().join(", ") || "(none)"}`);
  }
  const md = await store.readRoleFile(id);

  if (json) {
    process.stdout.write(
      JSON.stringify({ id, config: cfg, markdown: md }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`# config.yaml: roles.${id}\n\n`);
  process.stdout.write(`title:        ${cfg.title}\n`);
  process.stdout.write(`description:  ${cfg.description || "(empty)"}\n`);
  process.stdout.write(`owns:         ${cfg.owns.join(", ") || "(none)"}\n`);
  process.stdout.write(`reportsTo:    ${cfg.reportsTo.join(", ") || "(none)"}\n`);
  process.stdout.write(`mustNotEdit:  ${cfg.mustNotEdit.join(", ") || "(none)"}\n`);
  process.stdout.write(`\n# roles/${id}.md\n\n`);
  process.stdout.write(md);
  if (!md.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

async function runRoleDelete(args: ParsedArgs): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    throw new UsageError(
      "Usage: agentctl role delete <id>\n" +
        "  Project-governance operation; must be run from a shell with no MA_SESSION exported.",
    );
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // role delete is restricted to SYSTEM at the store layer; we don't
  // call resolveIdentity / resolveActor here because MA_SESSION must be
  // unset for this to succeed and we want a clear error path if not.
  if (typeof process.env.MA_SESSION === "string" && process.env.MA_SESSION.length > 0) {
    throw new UsageError(
      "`role delete` must be run from a shell with no MA_SESSION exported. " +
        "Run `unset MA_SESSION` (or open a fresh shell) and try again.",
    );
  }
  const { role, removedSessions } = await store.deleteRole({ id, actor: "SYSTEM" });

  if (json) {
    process.stdout.write(
      JSON.stringify({ status: "deleted", role, removedSessions }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`Deleted role '${role}'.\n`);
  if (removedSessions > 0) {
    process.stdout.write(
      `Invalidated 1 live session for '${role}'. Any agent window that still has\n` +
        `MA_SESSION exported for this role will hit a USAGE "session not found" error\n` +
        `on its next authenticated command — that window should \`unset MA_SESSION\`\n` +
        `or claim a new role.\n`,
    );
  }
  process.stdout.write(
    `Open task assignments owned by '${role}' (if any) are left in place.\n` +
      `Recreating a role with the same id reinherits them, or use\n` +
      `  agentctl task assign <task-id> --to <other-role>\n` +
      `to move them.\n`,
  );
  return 0;
}

export async function runRole(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "create":
      return runRoleCreate(args);
    case "list":
      return runRoleList(args);
    case "show":
      return runRoleShow(args);
    case "delete":
      return runRoleDelete(args);
    default:
      throw new UsageError(
        "Usage: agentctl role <create|list|show|delete> [args]\n" +
          "  agentctl role create <id> [<title>] [--description <text>] [--owns <a,b>] [--reports-to <r1,r2>] [--must-not-edit <a,b>]\n" +
          "  agentctl role list\n" +
          "  agentctl role show <id>\n" +
          "  agentctl role delete <id>",
      );
  }
}

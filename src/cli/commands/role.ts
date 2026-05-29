import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import type { Store } from "../../core/store";
import type { RoleId } from "../../core/types";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Detect whether a role's markdown contract still contains TBD
 * placeholders from the freshly-created template. The template seeds
 * two TBD spots: the Role description and the Responsibilities bullet.
 * Users need to fill these in by hand — they are the agent's main
 * self-introduction. This helper is reused by `role create` (nag),
 * `role list` (annotation), and `activate` (hard refusal).
 *
 * Exported for tests and for activate.ts.
 */
export async function roleMarkdownHasTbd(store: Store, role: RoleId): Promise<boolean> {
  try {
    const md = await store.readRoleFile(role);
    return /\bTBD\b/.test(md);
  } catch {
    // No markdown on disk → treat as "needs filling" (caller will get
    // a more specific error if it tries to act on this role).
    return true;
  }
}

async function runRoleCreate(args: ParsedArgs): Promise<number> {
  // `gojaja role create <id> [<title>]` — title is also accepted as the
  // second positional argument for ergonomics, since most users will spell
  // it out at the same time as the id.
  const id = args.positional[1];
  if (!id) {
    throw new UsageError(
      "Usage: gojaja role create <id> [<title>] [--description <text>] [--owns <a,b>] [--reports-to <r1,r2>] [--must-not-edit <a,b>]",
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

  // The freshly-rendered roles/<id>.md contains TBD placeholders for
  // the Role description and Responsibilities sections. These are the
  // agent's primary self-introduction; leaving them as TBD means the
  // agent runs with only its id and title, and will repeatedly bounce
  // questions back to the user. Surface this in both JSON and human
  // output so installer scripts and humans both notice.
  const needsFill = await roleMarkdownHasTbd(store, id);
  const rolePath = `.gojaja/roles/${id}.md`;

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "created",
        role: { id, ...roleConfig },
        needsFill,
        rolePath,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `Created role '${id}' (${roleConfig.title}).\n` +
        `Edit '.gojaja/config.yaml' under 'roles.${id}' to set owns / reportsTo / mustNotEdit.\n` +
        `Next step: 'gojaja prompt --target agents --write' to install the runtime ` +
        `(use --target claude if you use Claude Code), ` +
        `then 'gojaja activate ${id} --target <host>' for each agent window.\n`,
    );
    if (needsFill) {
      // Hard-printed so a user who skims past the line above still sees
      // it — the TBD sections are the most common first-week silent
      // failure mode (agent has no description, asks the user trivial
      // role-clarifying questions every turn).
      process.stdout.write(
        `\nTODO: open ${rolePath} and fill in the TBD sections\n` +
          `      (Role description and Responsibilities). Without these,\n` +
          `      the agent runs with only its id and title, and 'gojaja\n` +
          `      activate ${id} ...' will refuse to issue an activation\n` +
          `      snippet until they are filled in.\n`,
      );
    }
  }
  return 0;
}

async function runRoleList(args: ParsedArgs): Promise<number> {
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const config = await store.readConfig();
  const ids = Object.keys(config.roles).sort();

  // Precompute TBD status per role so we can both flag rows in the
  // human view and ship a structured field in JSON. Cheap because the
  // md files are small and N is the number of roles (usually < 10).
  const needsFill: Record<string, boolean> = {};
  for (const id of ids) {
    needsFill[id] = await roleMarkdownHasTbd(store, id);
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        roles: ids.map((id) => ({ id, ...config.roles[id], needsFill: needsFill[id] })),
      }) + "\n",
    );
    return 0;
  }
  if (ids.length === 0) {
    process.stdout.write(
      "No roles configured. Create one with: gojaja role create <id> <title>\n",
    );
    return 0;
  }
  for (const id of ids) {
    const r = config.roles[id];
    const marker = needsFill[id] ? "  (TBD: fill role markdown)" : "";
    process.stdout.write(`${id.padEnd(12)} ${r.title}${marker}\n`);
  }
  return 0;
}

async function runRoleShow(args: ParsedArgs): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    throw new UsageError("Usage: gojaja role show <id>");
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
  process.stdout.write(
    `owns:         ${cfg.owns.join(", ") || "(none)"}` +
      `  # write-allowed paths; entries can be files or directory prefixes\n`,
  );
  process.stdout.write(
    `reportsTo:    ${cfg.reportsTo.join(", ") || "(none)"}` +
      `  # escalation chain (advisory; used by the handbook)\n`,
  );
  process.stdout.write(
    `mustNotEdit:  ${cfg.mustNotEdit.join(", ") || "(none)"}` +
      `  # hard deny list; overrides owns\n`,
  );
  process.stdout.write(`\n# roles/${id}.md\n\n`);
  process.stdout.write(md);
  if (!md.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

async function runRoleDelete(args: ParsedArgs): Promise<number> {
  const id = args.positional[1];
  if (!id) {
    throw new UsageError(
      "Usage: gojaja role delete <id>\n" +
        "  Project-governance operation; must be run from a shell with no GOJAJA_SESSION exported.",
    );
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // role delete is restricted to SYSTEM at the store layer; we don't
  // call resolveIdentity / resolveActor here because GOJAJA_SESSION must be
  // unset for this to succeed and we want a clear error path if not.
  if (typeof process.env.GOJAJA_SESSION === "string" && process.env.GOJAJA_SESSION.length > 0) {
    throw new UsageError(
      "`role delete` must be run from a shell with no GOJAJA_SESSION exported. " +
        "Run `unset GOJAJA_SESSION` (or open a fresh shell) and try again.",
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
        `GOJAJA_SESSION exported for this role will hit a USAGE "session not found" error\n` +
        `on its next authenticated command — that window should \`unset GOJAJA_SESSION\`\n` +
        `or claim a new role.\n`,
    );
  }
  process.stdout.write(
    `Open task assignments owned by '${role}' (if any) are left in place.\n` +
      `Recreating a role with the same id reinherits them, or use\n` +
      `  gojaja task assign <task-id> --to <other-role>\n` +
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
        "Usage: gojaja role <create|list|show|delete> [args]\n" +
          "  gojaja role create <id> [<title>] [--description <text>] [--owns <a,b>] [--reports-to <r1,r2>] [--must-not-edit <a,b>]\n" +
          "  gojaja role list\n" +
          "  gojaja role show <id>\n" +
          "  gojaja role delete <id>",
      );
  }
}

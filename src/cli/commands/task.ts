import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  boolFlag,
  multiFlag,
  optionalString,
  requireString,
  type ParsedArgs,
} from "../argv";
import { UsageError } from "../../core/errors";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor } from "../identity";
import {
  TASK_STATUSES,
  type Deliverable,
  type RoleId,
  type Task,
  type TaskAsset,
  type TaskStatus,
} from "../../core/types";

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * parse `kind:ref[::description]` from a single `--asset` /
 * `--deliverable` flag value. We use `::` (not `:`) as the description
 * separator so URLs survive intact.
 */
function parseKindRef(
  raw: string,
  fieldName: string,
  allowed: ReadonlyArray<string>,
): { kind: string; ref: string; description: string } {
  const sepIdx = raw.indexOf(":");
  if (sepIdx <= 0) {
    throw new UsageError(
      `${fieldName} '${raw}' must be 'kind:ref' or 'kind:ref::description' ` +
        `(kind in ${allowed.join("|")}).`,
    );
  }
  const kind = raw.slice(0, sepIdx);
  if (!allowed.includes(kind)) {
    throw new UsageError(
      `${fieldName} '${raw}': unknown kind '${kind}'. Use one of ${allowed.join("|")}.`,
    );
  }
  const rest = raw.slice(sepIdx + 1);
  // `::` splits ref from description; first `::` only.
  const descIdx = rest.indexOf("::");
  let ref: string;
  let description: string;
  if (descIdx >= 0) {
    ref = rest.slice(0, descIdx);
    description = rest.slice(descIdx + 2);
  } else {
    ref = rest;
    description = "";
  }
  return { kind, ref, description };
}

function parseAssets(rawArgs: string[] | undefined): TaskAsset[] {
  return multiFlag(rawArgs, "asset").map((raw) => {
    const { kind, ref, description } = parseKindRef(raw, "--asset", ["file", "url"]);
    return { kind: kind as TaskAsset["kind"], ref, description };
  });
}

function parseDeliverables(rawArgs: string[] | undefined): Deliverable[] {
  return multiFlag(rawArgs, "deliverable").map((raw) => {
    const { kind, ref, description } = parseKindRef(raw, "--deliverable", [
      "file",
      "url",
      "manual",
    ]);
    return { kind: kind as Deliverable["kind"], ref, description };
  });
}

function parseTags(rawArgs: string[] | undefined): string[] {
  return multiFlag(rawArgs, "tag")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * pull all `--reviewer <role>` repetitions from raw argv.
 * Each value is a role id; validation happens in `Store.createTask`.
 */
function parseReviewers(rawArgs: string[] | undefined): string[] {
  return multiFlag(rawArgs, "reviewer")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

async function actorRole(args: ParsedArgs): Promise<{ root: string; actor: RoleId | "SYSTEM" }> {
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  // Tasks may be created by an agent (with GOJAJA_SESSION) or by the human
  // running CLI manually before any role has claimed a session. Both
  // are valid; resolveActor distinguishes "no session at all" (SYSTEM
  // bypass) from "stale/invalid GOJAJA_SESSION" (propagated as USAGE error
  // — must NOT silently fall through to SYSTEM).
  const { actor } = await resolveActor(store);
  return { root, actor };
}

async function runTaskNew(args: ParsedArgs): Promise<number> {
  const title = requireString(args.flags, "title");
  const owner = optionalString(args.flags, "owner") ?? null;
  const priority = optionalString(args.flags, "priority") ?? "P2";
  const dependsOn = splitList(optionalString(args.flags, "depends-on"));
  const acceptance = optionalString(args.flags, "acceptance") ?? "";
  const parent = optionalString(args.flags, "parent") ?? null;
  const assets = parseAssets(args.rawArgs);
  const deliverables = parseDeliverables(args.rawArgs);
  const tags = parseTags(args.rawArgs);
  const reviewers = parseReviewers(args.rawArgs);
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.createTask({
    title,
    owner,
    priority,
    dependsOn,
    acceptance,
    actor,
    parent,
    assets,
    deliverables,
    tags,
    reviewers,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "created", task }) + "\n");
  } else {
    process.stdout.write(
      `Created ${task.id} (${task.status}, ${task.priority})` +
        (task.owner ? ` -> ${task.owner}` : "") +
        (task.parent ? ` under ${task.parent}` : "") +
        `: ${task.title}\n`,
    );
  }
  return 0;
}

async function runTaskAssign(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  const newOwner = requireString(args.flags, "to");
  if (!taskId) {
    throw new UsageError("Usage: gojaja task assign <task-id> --to <role>");
  }
  const json = boolFlag(args.flags, "json");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.assignTask({ taskId, newOwner, actor });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "assigned", task }) + "\n");
  } else {
    process.stdout.write(`Assigned ${task.id} -> ${task.owner}\n`);
  }
  return 0;
}

async function runTaskStatus(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  const newStatusRaw = args.positional[2];
  if (!taskId || !newStatusRaw) {
    throw new UsageError(
      `Usage: gojaja task status <task-id> <${TASK_STATUSES.join("|")}>`,
    );
  }
  if (!(TASK_STATUSES as readonly string[]).includes(newStatusRaw)) {
    throw new UsageError(
      `Invalid status '${newStatusRaw}'. Use one of: ${TASK_STATUSES.join(", ")}.`,
    );
  }
  const newStatus = newStatusRaw as TaskStatus;
  const json = boolFlag(args.flags, "json");
  const forceIncomplete = boolFlag(args.flags, "force-incomplete");
  const { root, actor } = await actorRole(args);
  const store = await openStoreOrThrow(root);
  const task = await store.setTaskStatus({
    taskId,
    newStatus,
    actor,
    forceIncomplete,
  });
  if (json) {
    process.stdout.write(JSON.stringify({ status: "updated", task }) + "\n");
  } else {
    process.stdout.write(`${task.id} status -> ${task.status}\n`);
  }
  return 0;
}

async function runTaskList(args: ParsedArgs): Promise<number> {
  const ownerFilter = optionalString(args.flags, "owner");
  const statusFilter = optionalString(args.flags, "status");
  const tagFilters = parseTags(args.rawArgs);
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const board = await store.readTaskBoard();
  let tasks: Task[] = Object.values(board.tasks);
  if (ownerFilter) tasks = tasks.filter((t) => t.owner === ownerFilter);
  if (statusFilter) {
    if (!(TASK_STATUSES as readonly string[]).includes(statusFilter)) {
      throw new UsageError(`Invalid --status '${statusFilter}'.`);
    }
    tasks = tasks.filter((t) => t.status === statusFilter);
  }
  if (tagFilters.length > 0) {
    // OR-match across multiple --tag values. A task with any
    // matching tag passes the filter.
    tasks = tasks.filter((t) => tagFilters.some((f) => t.tags.includes(f)));
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  if (json) {
    process.stdout.write(JSON.stringify({ tasks }) + "\n");
    return 0;
  }
  if (tasks.length === 0) {
    process.stdout.write("(no matching tasks)\n");
    return 0;
  }
  for (const t of tasks) {
    process.stdout.write(
      `${t.id.padEnd(8)} ${t.status.padEnd(11)} ${(t.owner ?? "-").padEnd(12)} ${t.priority.padEnd(4)} ${t.title}\n`,
    );
  }
  return 0;
}

/**
 * helper for `task show` — does the file referenced by a
 * `kind: "file"` asset/deliverable exist on disk? Returns false for
 * out-of-tree refs (defence; create-time validation rejected them).
 */
async function fileRefExists(projectRoot: string, ref: string): Promise<boolean> {
  const abs = path.resolve(projectRoot, ref);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

async function runTaskShow(args: ParsedArgs): Promise<number> {
  const taskId = args.positional[1];
  if (!taskId) {
    throw new UsageError("Usage: gojaja task show <task-id>");
  }
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);
  const task = await store.readTask(taskId);
  if (json) {
    // For JSON consumers also include resolved on-disk states so the
    // agent does not need to re-stat from script.
    const board = await store.readTaskBoard();
    const children = Object.values(board.tasks)
      .filter((t) => t.parent === task.id)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        priority: t.priority,
      }));
    const deliverablesStatus = await Promise.all(
      task.deliverables.map(async (d) => ({
        ...d,
        exists: d.kind === "file" ? await fileRefExists(root, d.ref) : null,
      })),
    );
    process.stdout.write(
      JSON.stringify({ task, children, deliverablesStatus }) + "\n",
    );
    return 0;
  }

  process.stdout.write(`id:         ${task.id}\n`);
  process.stdout.write(`title:      ${task.title}\n`);
  process.stdout.write(`status:     ${task.status}\n`);
  process.stdout.write(`owner:      ${task.owner ?? "(unassigned)"}\n`);
  if (task.parent) process.stdout.write(`parent:     ${task.parent}\n`);
  process.stdout.write(`priority:   ${task.priority}\n`);
  if (task.tags.length > 0) process.stdout.write(`tags:       ${task.tags.join(", ")}\n`);
  if (task.creator) process.stdout.write(`creator:    ${task.creator}\n`);
  if (task.reviewers.length > 0)
    process.stdout.write(`reviewers:  ${task.reviewers.join(", ")}\n`);
  process.stdout.write(`dependsOn:  ${task.dependsOn.join(", ") || "(none)"}\n`);
  process.stdout.write(`createdAt:  ${task.createdAt}\n`);
  process.stdout.write(`updatedAt:  ${task.updatedAt}\n`);

  // Children — re-read board for the reverse index.
  const board = await store.readTaskBoard();
  const children = Object.values(board.tasks)
    .filter((t) => t.parent === task.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (children.length > 0) {
    process.stdout.write(`\nchildren:\n`);
    for (const c of children) {
      process.stdout.write(
        `  ${c.id.padEnd(8)} ${c.status.padEnd(11)} ${(c.owner ?? "-").padEnd(12)} ${c.priority.padEnd(4)} "${c.title}"\n`,
      );
    }
  }

  if (task.assets.length > 0) {
    process.stdout.write(`\nassets:\n`);
    for (const a of task.assets) {
      process.stdout.write(
        `  ${a.kind.padEnd(6)} ${a.ref}${a.description ? `  -- ${a.description}` : ""}\n`,
      );
    }
  }

  if (task.deliverables.length > 0) {
    process.stdout.write(`\ndeliverables:\n`);
    for (const d of task.deliverables) {
      let mark = "[?]";
      if (d.kind === "file") {
        mark = (await fileRefExists(root, d.ref)) ? "[x]" : "[ ]";
      }
      process.stdout.write(
        `  ${mark} ${d.kind.padEnd(6)} ${d.ref}${d.description ? `  -- ${d.description}` : ""}\n`,
      );
    }
  }

  if (task.acceptance.trim().length > 0) {
    process.stdout.write(`\nacceptance:\n${task.acceptance}\n`);
  }
  return 0;
}

export async function runTask(args: ParsedArgs): Promise<number> {
  const sub = args.positional[0];
  switch (sub) {
    case "new":
      return runTaskNew(args);
    case "assign":
      return runTaskAssign(args);
    case "status":
      return runTaskStatus(args);
    case "list":
      return runTaskList(args);
    case "show":
      return runTaskShow(args);
    default:
      throw new UsageError(
        "Usage: gojaja task <new|assign|status|list|show> [args]\n" +
          "  gojaja task new --title <text> [--owner <role>] [--priority P0|P1|P2|P3]\n" +
          "                   [--depends-on T-XXXX,...] [--acceptance <text>] [--parent T-XXXX]\n" +
          "                   [--tag <label> ...] [--reviewer <role> ...]\n" +
          "                   [--asset 'kind:ref::desc' ...]\n" +
          "                   [--deliverable 'kind:ref::desc' ...]\n" +
          "  gojaja task assign <task-id> --to <role>\n" +
          `  gojaja task status <task-id> <${TASK_STATUSES.join("|")}> [--force-incomplete]\n` +
          "  gojaja task list [--owner <role>] [--status <s>] [--tag <label> ...]\n" +
          "  gojaja task show <task-id>",
      );
  }
}

import * as path from "node:path";
import { boolFlag, optionalString, type ParsedArgs } from "../argv";
import { discoverProjectRoot } from "../runtime";
import {
  inspectMigrate,
  planMigrate,
  performMigrate,
  MigrateNoLayerError,
  MigrateAlreadyV3Error,
} from "../migrate";

/**
 * `gojaja migrate` — v2 → v3 layer walker.
 *
 * Behaviour:
 *   - default (no flags): print a dry-run preview of what would be
 *     migrated; make no changes.
 *   - `--execute`: actually perform the migration. The user tree
 *     is left intact (central-classified files are COPIED, not
 *     moved) so the v2 layer remains as a safety net.
 *   - `--cleanup`: after a successful execute (or against an
 *     already-migrated layer), remove the central-classified files
 *     from the user tree. Idempotent — re-running on a clean layer
 *     is a no-op.
 *
 * Output is JSON-friendly via `--json` for automation.
 */
export async function runMigrate(args: ParsedArgs): Promise<number> {
  const root = path.resolve(
    optionalString(args.flags, "root") ?? (await discoverProjectRoot()),
  );
  const execute = boolFlag(args.flags, "execute");
  const cleanup = boolFlag(args.flags, "cleanup");
  const json = boolFlag(args.flags, "json");

  const inspection = await inspectMigrate(root);

  if (!execute && !cleanup) {
    // Dry-run preview.
    const plan = await planMigrate(inspection);
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "dry-run", inspection, plan }) + "\n",
      );
      return 0;
    }
    printDryRun(plan);
    return 0;
  }

  try {
    const result = await performMigrate(root, { cleanup });
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "migrated", result }) + "\n",
      );
    } else {
      process.stdout.write(
        `Migrated ${result.layerDir}\n` +
          `  v${result.fromVersion} -> v${result.toVersion}\n` +
          `  project id:    ${result.projectId}\n` +
          `  central root:  ${result.centralRoot}\n` +
          `  files copied:  ${result.copied}\n` +
          (cleanup
            ? `  cleaned up:    ${result.cleanedUp} files removed from user tree\n`
            : `\nUser tree files NOT removed (safety net). Re-run with\n` +
              `'gojaja migrate --cleanup' once you've confirmed the v3\n` +
              `layout works.\n`),
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof MigrateNoLayerError) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ status: "no-layer", error: err.message }) + "\n",
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      return 2;
    }
    if (err instanceof MigrateAlreadyV3Error) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ status: "already-v3", message: err.message }) + "\n",
        );
      } else {
        process.stdout.write(`${err.message}\n`);
      }
      return 0;
    }
    throw err;
  }
}

function printDryRun(plan: ReturnType<typeof planMigrate> extends Promise<infer T> ? T : never): void {
  const insp = plan.inspection;
  if (insp.action.kind === "no-layer") {
    process.stdout.write(
      `No .gojaja layer at ${insp.layerDir}. Run 'gojaja init' first.\n`,
    );
    return;
  }
  if (insp.action.kind === "already-v3") {
    process.stdout.write(
      `${insp.layerDir} is already on v3 (project.json present, id=${insp.project!.id}).\n` +
        `No copy required. Use 'gojaja migrate --cleanup' if any leftover\n` +
        `central-classified files remain in the user tree.\n`,
    );
    return;
  }
  const ready = insp.action;
  const totalBytes = plan.copies.reduce((acc, c) => acc + c.bytes, 0);
  process.stdout.write(
    `Dry-run: migrate ${insp.layerDir}\n` +
      `  v${ready.fromVersion} -> v3.0.0\n` +
      `  project id (new):  ${ready.projectId}\n` +
      `  central root:      ${ready.centralRoot}\n` +
      `  files to copy:     ${plan.copies.length} (${totalBytes} bytes)\n` +
      `  files marked for cleanup later: ${plan.cleanup.length}\n` +
      `\n` +
      `Re-run with 'gojaja migrate --execute' to apply.\n` +
      `Add '--cleanup' to also remove central-classified files from the user\n` +
      `tree (the default keeps them as a safety net).\n`,
  );
}

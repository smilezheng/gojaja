import * as path from "node:path";
import { LocalFsStore } from "../../core/local-fs-store";
import { LAYER_DIRNAME, SCHEMA_VERSION } from "../runtime";
import type { ParsedArgs } from "../argv";
import { boolFlag, optionalString } from "../argv";

export async function runInit(args: ParsedArgs): Promise<number> {
  const root = path.resolve(
    optionalString(args.flags, "root") ?? args.positional[0] ?? process.cwd(),
  );
  const layerDir = path.join(root, LAYER_DIRNAME);
  const store = new LocalFsStore(layerDir);
  const json = boolFlag(args.flags, "json");

  if (await store.isInitialised()) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ status: "already_initialised", root: layerDir }) + "\n",
      );
    } else {
      process.stderr.write(
        `multi-agent layer already initialised at ${layerDir}\n`,
      );
    }
    return 4;
  }

  await store.initialise(SCHEMA_VERSION);

  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: "initialised",
        root: layerDir,
        version: SCHEMA_VERSION,
      }) + "\n",
    );
  } else {
    process.stdout.write(`Initialised multi-agent layer (v${SCHEMA_VERSION}) at ${layerDir}\n`);
  }
  return 0;
}

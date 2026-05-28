import {
  CLI_VERSION,
  discoverProjectRoot,
  openStoreOrThrow,
} from "../runtime";
import type { ParsedArgs } from "../argv";
import { boolFlag, optionalString } from "../argv";

export async function runVersion(args: ParsedArgs): Promise<number> {
  const json = boolFlag(args.flags, "json");
  const cliVersion = CLI_VERSION;

  let schemaVersion: string | null = null;
  try {
    const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
    const store = await openStoreOrThrow(root);
    schemaVersion = await store.readVersion();
  } catch {
    schemaVersion = null;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({ cli: cliVersion, schema: schemaVersion }) + "\n",
    );
  } else {
    process.stdout.write(`gojaja ${cliVersion}\n`);
    if (schemaVersion) {
      process.stdout.write(`schema   ${schemaVersion}\n`);
    } else {
      process.stdout.write("schema   (not initialised)\n");
    }
  }
  return 0;
}

import { boolFlag, optionalString, requireString, type ParsedArgs } from "../argv";
import { discoverProjectRoot, openStoreOrThrow } from "../runtime";
import { resolveActor } from "../identity";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

export async function runWriteState(args: ParsedArgs): Promise<number> {
  const relPath = requireString(args.flags, "file");
  const json = boolFlag(args.flags, "json");
  const root = optionalString(args.flags, "root") ?? (await discoverProjectRoot());
  const store = await openStoreOrThrow(root);

  // Identity: agent invocations (MA_SESSION set) get their gated role;
  // bare human invocations bypass via "SYSTEM" (see Store.requireOwnership).
  // A stale/invalid MA_SESSION must NOT silently downgrade to SYSTEM —
  // that would be privilege escalation against the ownership gate.
  const { actor } = await resolveActor(store);

  let content = optionalString(args.flags, "content");
  if (content === undefined) content = await readStdin();
  if (typeof content !== "string") content = "";

  const result = await store.writeStateFile({ actor, relPath, content });

  if (json) {
    process.stdout.write(
      JSON.stringify({ status: "wrote", actor, ...result }) + "\n",
    );
  } else {
    process.stdout.write(
      `Wrote ${result.relPath} (${Buffer.byteLength(content)} bytes) as ${actor}.\n`,
    );
  }
  return 0;
}

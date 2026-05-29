import type { ParsedArgs } from "../argv";
import { boolFlag } from "../argv";
import { COLLABORATION_HANDBOOK } from "../prompts/handbook";

/**
 * `gojaja handbook [--json]`
 *
 * Prints the full collaboration handbook — the judgement layer (when to
 * use worklog vs report vs RFC, escalation, RFC multi-round mechanics,
 * deliverable gates, task lifecycle, the hard "don't"s).
 *
 * This used to be embedded in every host's injected runtime prompt,
 * which pushed that prompt past ~300 lines (too long for CLAUDE.md's
 * ~200-line budget). It is reference material an agent consults when
 * making a judgement call, not something it needs re-read every turn —
 * so it lives here, fetched on demand. The always-injected runtime
 * card keeps only the loop, identity recovery, the hard invariants, and
 * a pointer to this command.
 */
export async function runHandbook(args: ParsedArgs): Promise<number> {
  const json = boolFlag(args.flags, "json");
  if (json) {
    process.stdout.write(JSON.stringify({ handbook: COLLABORATION_HANDBOOK }) + "\n");
    return 0;
  }
  process.stdout.write(COLLABORATION_HANDBOOK);
  if (!COLLABORATION_HANDBOOK.endsWith("\n")) process.stdout.write("\n");
  return 0;
}

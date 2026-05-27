import { UsageError } from "../core/errors";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that are unambiguously boolean — they MUST NOT consume the next
 * token as a value. Without this, `agentctl plan --json PM` greedily
 * parses as `flags.json="PM"` and `positional=[]`, losing the role
 * argument and silently disabling the JSON contract that agents rely on.
 *
 * Add new boolean flags here when introduced. Keep this list tight; any
 * flag genuinely capable of taking a value belongs in the value-taking
 * branch below.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "json",
  "write",
  "force",
  "no-handbook",
  "no-wait",
  "help",
  "version",
]);

/**
 * Minimal argv parser. We deliberately avoid a heavyweight CLI library to
 * keep the dependency surface tight and the JSON output contract crisp.
 *
 * Supported forms:
 *   - `--flag` (boolean true; either declared in BOOLEAN_FLAGS or with no
 *     non-flag token immediately following)
 *   - `--flag=value`
 *   - `--flag value`  (only when `flag` is NOT in BOOLEAN_FLAGS and value
 *     does not itself start with `--`)
 *   - positional args in declaration order
 *
 * The parser does not know which flags belong to which command; command
 * handlers pull what they need from `flags` and validate.
 */
export function parseArgv(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "help", positional: [], flags: {} };
  }
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const name = arg.slice(2);
        // Booleans never consume the next token — protects positional args
        // from being silently eaten when the user (or a script) writes
        // `--json <role>`.
        if (BOOLEAN_FLAGS.has(name)) {
          flags[name] = true;
          continue;
        }
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    positional.push(arg);
  }

  return { command, positional, flags };
}

export function requireString(
  flags: Record<string, string | boolean>,
  name: string,
): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(`Missing required --${name} value.`);
  }
  return v;
}

export function optionalString(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function boolFlag(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  return flags[name] === true || flags[name] === "true";
}

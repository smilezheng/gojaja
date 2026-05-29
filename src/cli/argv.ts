import { UsageError } from "../core/errors";

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /**
   * original argv slice (minus the leading command). Kept so
   * commands like `task new` can recover multi-valued flags
   * (`--asset` repeated, `--tag` repeated, ...) via `multiFlag`.
   * `flags` only stores the last occurrence, which is fine for the
   * 95% case but loses information for accumulating flags.
   *
   * Optional so existing test fixtures that hand-build ParsedArgs
   * without this field keep compiling; consumers must tolerate an
   * absent / empty slice.
   */
  rawArgs?: string[];
}

/**
 * Flags that are unambiguously boolean — they MUST NOT consume the next
 * token as a value. Without this, `gojaja plan --json PM` greedily
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
  "help",
  "version",
  "eval",
  "force-rewrite",
  "no-copy",
  "batch",
  "no-mark-seen",
  "force-incomplete",
  "no-open",
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
    return { command: "help", positional: [], flags: {}, rawArgs: [] };
  }
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const rawArgs = rest.slice();

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

  return { command, positional, flags, rawArgs };
}

/**
 * collect all occurrences of `--<name> <value>` (or
 * `--<name>=<value>`) from the original argv slice. Returns values in
 * declaration order. Boolean-form `--name` with no value is silently
 * skipped (we only care about value-bearing repeats for accumulating
 * flags like `--asset`, `--deliverable`, `--tag`).
 */
export function multiFlag(rawArgs: string[] | undefined, name: string): string[] {
  if (!rawArgs) return [];
  const out: string[] = [];
  const eqPrefix = `--${name}=`;
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i];
    if (tok === `--${name}`) {
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.push(next);
        i++;
      }
    } else if (tok.startsWith(eqPrefix)) {
      out.push(tok.slice(eqPrefix.length));
    }
  }
  return out;
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

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepted forms (suffix letter mandatory; no compound forms like `1h30m`):
 *   `<n>ms` `<n>s` `<n>m` `<n>h` `<n>d`
 *
 * Examples: `30s`, `10m`, `4h`, `1d`. Bare numbers and other suffixes are
 * rejected with a `UsageError` so the caller can surface the offending
 * flag name in the message.
 *
 * @throws UsageError on parse failure.
 */
export function parseDuration(raw: string): number {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
  if (!m) {
    throw new UsageError(
      `Invalid duration '${raw}'. Use forms like 30s, 10m, 4h, 1d, 500ms.`,
    );
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new UsageError(`Invalid duration '${raw}': value must be >= 0.`);
  }
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60 * 1000;
    case "h":
      return n * 60 * 60 * 1000;
    case "d":
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new UsageError(`Invalid duration '${raw}'.`);
  }
}

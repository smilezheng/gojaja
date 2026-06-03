import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { newId } from "../../core/ids";
import { UsageError } from "../../core/errors";

/**
 * Resolve a multi-line "body text" CLI argument without paying the
 * shell-eval tax.
 *
 * The standard `--message "..."` shape is unsafe in interactive shells:
 * zsh and bash both perform command substitution on backticks and
 * `$(...)` inside double quotes, so a literal Markdown fenced code
 * block in a `--message` value executes the embedded commands.
 * A real incident on 2026-06-02 (state-file truncation, force-
 * pushed empty branches, mis-advanced task statuses) motivated
 * the explicit-channel design below.
 *
 * `requireText` accepts three explicit channels, in priority order:
 *
 *   1. Inline `--<name> <text>` (non-empty string, not "-") — used as-is.
 *   2. Explicit stdin sentinel — `--<name> -` OR bare `--<name>` with no
 *      value (which `parseArgv` records as `flags[name] === true`).
 *      Both forms read stdin to EOF. Mirrors `git commit -F -`.
 *      Heredoc with a quoted delimiter (`<<'EOF'`) suppresses ALL
 *      shell expansion in the body, which is the safe canonical form.
 *   3. Flag absent + stdin is a TTY + $EDITOR / $VISUAL set — spawn the
 *      editor on a temp file, return the saved buffer with
 *      `#`-prefixed comment lines stripped. Matches `git commit`
 *      without `-m`.
 *
 * Stdin reading is opt-in (channels 2 + 3) rather than auto-detected on
 * absence. This is deliberate: agent automation and CI environments
 * frequently inherit a non-TTY stdin that is never closed, and an
 * implicit "if stdin is non-TTY then read it" rule deadlocks there.
 * Forcing `-` / bare-flag for stdin and EDITOR-or-USAGE-error for
 * absence keeps every code path bounded.
 *
 * For OPTIONAL multi-line text fields, see `resolveOptionalText`
 * (same opt-in shape; absence returns "" rather than throwing).
 */
export interface ResolveTextOptions {
  /** Open $EDITOR when stdin is a TTY and no inline value. Default true. */
  allowEditor?: boolean;
  /** Testing seam: override stdin reader. */
  readStdin?: () => Promise<string>;
  /** Testing seam: override TTY check. */
  isStdinTTY?: () => boolean;
  /** Testing seam: override editor invocation. */
  openEditor?: (name: string) => Promise<string>;
}

export async function requireText(
  flags: Record<string, string | boolean>,
  name: string,
  opts: ResolveTextOptions = {},
): Promise<string> {
  const v = flags[name];

  // (1) inline value (non-empty, not the "-" stdin sentinel).
  if (typeof v === "string" && v !== "-" && v.length > 0) return v;

  // (2) explicit stdin: --flag - OR bare --flag.
  if (v === true || v === "-") {
    const reader = opts.readStdin ?? readAllStdin;
    const buf = await reader();
    const trimmed = buf.replace(/\s+$/, "");
    if (trimmed.length === 0) {
      throw new UsageError(
        `Empty --${name} from stdin. Pipe content via a heredoc (use\n` +
          `'<<'EOF' ... EOF' with single-quoted delimiter to keep backticks\n` +
          `and $ literal) or via a file redirect.`,
      );
    }
    return trimmed;
  }

  // (3) absent + TTY: open $EDITOR.
  if (v === undefined) {
    const tty = (opts.isStdinTTY ?? isStdinTTY)();
    if (tty && opts.allowEditor !== false) {
      const openEditor = opts.openEditor ?? openEditorForBody;
      return await openEditor(name);
    }
    throw new UsageError(
      `Missing --${name}. Provide it inline OR via stdin:\n` +
        `  gojaja <cmd> ... --${name} - <<'EOF'\n` +
        `  your ${name} here\n` +
        `  EOF\n` +
        `Single-quoted heredoc delimiter ('EOF') keeps backticks and $ literal\n` +
        `— the safe shape for any multi-line content. Interactive shells with\n` +
        `$EDITOR set also accept the bare 'gojaja <cmd> ...' form (no --${name}).`,
    );
  }

  // (4) defensive: empty inline value or any other shape.
  throw new UsageError(`--${name} requires a value (or use '--${name} -' for stdin).`);
}

/**
 * Optional counterpart of `requireText`. Returns "" when the flag is
 * absent — preserving the legacy `optionalString(...) ?? ""` semantics
 * — and reads stdin only on explicit opt-in (`--flag -` or bare
 * `--flag`). Never opens $EDITOR.
 */
export async function resolveOptionalText(
  flags: Record<string, string | boolean>,
  name: string,
  opts: { readStdin?: () => Promise<string> } = {},
): Promise<string> {
  const v = flags[name];
  if (typeof v === "string" && v !== "-") return v;
  if (v === true || v === "-") {
    const reader = opts.readStdin ?? readAllStdin;
    const buf = await reader();
    return buf.replace(/\s+$/, "");
  }
  return "";
}

/**
 * Read all of `process.stdin` to EOF and return as a string.
 *
 * Returns "" immediately if stdin is a TTY — a TTY means a human is at
 * the keyboard and there's no piped content, so blocking on stdin would
 * deadlock waiting for the user to type EOF themselves.
 *
 * Otherwise consumes the full stdin stream until the writer closes it.
 * Callers must only invoke this when they know stdin holds the intended
 * payload (heredoc / pipe / redirect).
 */
export function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
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

export function isStdinTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Open $EDITOR (or $VISUAL / $GIT_EDITOR) on a temp file inside
 * `$TMPDIR/gojaja-edit/`, wait for save+quit, then return the buffer
 * with `#`-prefixed comment lines stripped and outer whitespace
 * trimmed.
 *
 * The header lines in the seeded buffer are themselves `#`-prefixed
 * so the user sees instructions but the saved body is clean.
 *
 * Throws `UsageError` if:
 *   - no editor env var is set,
 *   - the editor exits non-zero (treated as user cancel),
 *   - the resulting body is empty after stripping comments.
 *
 * Always deletes the temp file (best-effort) before returning.
 */
export async function openEditorForBody(name: string): Promise<string> {
  const editor = pickEditor();
  if (!editor) {
    throw new UsageError(
      `No --${name} given and no $EDITOR / $VISUAL set. Either provide --${name} <text>, ` +
        `pipe via heredoc, or set $EDITOR.`,
    );
  }
  const tmpDir = path.join(os.tmpdir(), "gojaja-edit");
  await fsp.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${newId()}.txt`);
  const header =
    `# Enter the ${name} for this gojaja command.\n` +
    `# Lines starting with '#' are ignored. Save and quit to send;\n` +
    `# leave empty (or quit without saving) to abort.\n` +
    `\n`;
  await fsp.writeFile(file, header, "utf8");
  try {
    await spawnEditor(editor, file);
    const raw = await fsp.readFile(file, "utf8");
    const body = raw
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n")
      .replace(/^\s+|\s+$/g, "");
    if (body.length === 0) {
      throw new UsageError(`Empty ${name}. Aborting.`);
    }
    return body;
  } finally {
    fsp.unlink(file).catch(() => {});
  }
}

function pickEditor(): string | null {
  // Same precedence as git: GIT_EDITOR > VISUAL > EDITOR. We do not
  // fall back to vi/vim implicitly — environments like CI containers
  // often have a broken vi (no termcap), and a silent hang there is
  // worse than a USAGE error.
  const candidates = [
    process.env.GIT_EDITOR,
    process.env.VISUAL,
    process.env.EDITOR,
  ];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  return null;
}

function spawnEditor(cmd: string, file: string): Promise<void> {
  // Editor strings may carry flags ("code -w", "subl -nw"); honor them
  // by splitting on whitespace the same way git does. Quoted paths
  // containing spaces are not supported, but neither does git out of
  // the box; users with such paths set GIT_EDITOR to a wrapper script.
  const parts = cmd.split(/\s+/);
  const exe = parts[0];
  const args = [...parts.slice(1), file];
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(exe, args, { stdio: "inherit" });
    } catch (err) {
      reject(
        new UsageError(
          `Failed to launch editor (${cmd}): ${(err as Error).message}`,
        ),
      );
      return;
    }
    proc.on("error", (err) =>
      reject(
        new UsageError(`Failed to launch editor (${cmd}): ${err.message}`),
      ),
    );
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new UsageError(`Editor (${cmd}) exited with code ${code}.`));
    });
  });
}

import { spawn } from "node:child_process";

/**
 * Best-effort copy of `text` to the OS clipboard.
 *
 * We deliberately do not depend on the `clipboardy` npm package; it
 * carries large vendored binaries and breaks under restricted execution
 * (asar / single-file Node binaries). Instead we shell out to whichever
 * native clipboard tool is installed:
 *
 *   - macOS:    pbcopy        (always present on Darwin)
 *   - Linux:    wl-copy       (Wayland)  → fall back to
 *               xclip         (X11 with xclip)  → fall back to
 *               xsel          (X11 with xsel)
 *   - Windows:  clip.exe      (always present on modern Windows)
 *
 * Returns the name of the tool that succeeded, or `null` if no tool
 * worked (no clipboard available — caller should print the snippet
 * for manual copy).
 *
 * Never throws — clipboard is a UX nice-to-have, not a critical path.
 */
export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates = candidatesForPlatform();
  for (const cand of candidates) {
    const ok = await runClipboardCmd(cand.cmd, cand.args, text);
    if (ok) return cand.cmd;
  }
  return null;
}

interface Candidate { cmd: string; args: string[] }

function candidatesForPlatform(): Candidate[] {
  switch (process.platform) {
    case "darwin":
      return [{ cmd: "pbcopy", args: [] }];
    case "win32":
      return [{ cmd: "clip.exe", args: [] }, { cmd: "clip", args: [] }];
    case "linux":
    case "freebsd":
    case "openbsd":
      return [
        { cmd: "wl-copy", args: [] },
        // xclip needs an explicit selection or it copies to PRIMARY only.
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
    default:
      return [];
  }
}

function runClipboardCmd(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      // ENOENT raised synchronously on some platforms.
      resolve(false);
      return;
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
    try {
      proc.stdin!.write(text);
      proc.stdin!.end();
    } catch {
      resolve(false);
    }
  });
}

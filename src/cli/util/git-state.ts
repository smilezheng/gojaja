import { execFile } from "node:child_process";

/**
 * Shared `git status` probe used by destructive / structural
 * commands (`gojaja init`, `gojaja reset`, ...).
 *
 * The framework writes / deletes files outside `src/`; if the user
 * hasn't committed their working tree, they have no clean revert
 * path when something goes wrong. We surface that risk explicitly:
 *
 *   - clean       — `git status --porcelain` empty inside a work tree.
 *   - dirty       — work tree has uncommitted changes; sample of up to
 *                   10 lines kept for display.
 *   - not-a-repo  — `git` missing, or cwd is outside any work tree.
 *
 * The probe runs `git` with a 5s timeout so a broken / hanging git
 * install can never wedge a destructive command indefinitely.
 */
export type GitState =
  | { kind: "clean" }
  | { kind: "dirty"; sample: string[] }
  | { kind: "not-a-repo" };

export async function inspectGit(root: string): Promise<GitState> {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === null || inside.trim() !== "true") {
    return { kind: "not-a-repo" };
  }
  const status = await runGit(root, ["status", "--porcelain"]);
  if (status === null || status.trim().length === 0) {
    return { kind: "clean" };
  }
  const sample = status
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 10);
  return { kind: "dirty", sample };
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

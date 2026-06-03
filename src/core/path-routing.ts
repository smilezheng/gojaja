import { Paths } from "./paths";

/**
 * Two-tree routing for the on-disk layer (RFC-0001).
 *
 * v3 splits `.gojaja/` into a small git-tracked user tree at
 * `<project>/.gojaja/` and a per-user / per-machine central tree at
 * `~/.gojaja/projects/<id>/`. Every relative path under the layer
 * is statically classified into one of those two scopes; `SplitStore`
 * routes file I/O to the correct physical root.
 *
 * Classification rule (the "fresh clone" test):
 *
 *   - **user**: a freshly cloned project needs this file BEFORE the
 *     agent team starts running. It is a slow-changing project-level
 *     contract.
 *   - **central**: runtime / mutable / per-machine. Never touches git.
 *
 * In v2 (`schema: 2.0.0-*`), the user tree and central tree are the
 * same physical directory; the classifier is consulted but both
 * branches resolve to the same root. PR9.2 introduces the actual
 * split on `schema: 3.0.0`.
 */
export type PathScope = "user" | "central";

/**
 * Return the routing scope for a relative path under the layer root.
 *
 * The path is expected to be a normalised forward-slash relative path
 * (the same shape produced by the helpers in `./paths.ts`). Leading
 * `./` and backslash separators are tolerated for defensive parity
 * with `resolveInside` callers, but consumers should pass canonical
 * forms.
 *
 * @see RFC-0001 §2.6 for the routing table.
 */
export function classifyPath(rel: string): PathScope {
  const norm = rel.replace(/^\.\//, "").replace(/\\/g, "/");

  // ---- user-tree (git-tracked, slow-changing) ---------------------------

  // Bootstrap markers — both VERSION (legacy v2 schema marker) and
  // project.json (v3 ULID + name + schema) travel with the source.
  if (norm === Paths.versionFile) return "user";
  if (norm === "project.json") return "user";

  // Project-level contract files. config.yaml carries ownership
  // (`roles[id].owns / mustNotEdit`), so a fresh clone needs it
  // before the first `gojaja claim` to enforce the gates.
  if (norm === Paths.configFile) return "user";
  if (norm === Paths.gitignoreFile) return "user";

  // Human-authored docs.
  if (norm === Paths.projectStateFile) return "user";

  // Role briefs (markdown) are the role-level contract, read by
  // `gojaja role show` and surfaced in prompts. Required at clone.
  if (norm === Paths.rolesDir) return "user";
  if (norm.startsWith(Paths.rolesDir + "/")) return "user";

  // Optional protocol/ directory ships protocol docs with the project.
  if (norm === Paths.protocolDir) return "user";
  if (norm.startsWith(Paths.protocolDir + "/")) return "user";

  // ---- central-tree (runtime, never in git) ----------------------------

  // Everything else: state/task_board.yaml, comms/**, rfcs/**,
  // worklog/**, locks/**. Defaulting to central means new runtime
  // surfaces added in future PRs land in the right tree without
  // updating this function — only NEW user-tree contracts need an
  // explicit case above.
  return "central";
}

/**
 * Convenience predicate: are these two roots logically identical?
 * Used by the store to short-circuit per-write classification in
 * single-root (v2) mode.
 */
export function isSplitMode(userRoot: string, centralRoot: string): boolean {
  return userRoot !== centralRoot;
}

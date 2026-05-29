/**
 * The runtime artifact a host needs once per project (or once per user,
 * in the Codex case). Role-agnostic by contract — two agent windows
 * playing different roles in the same project share the same artifact.
 *
 * The runtime is what teaches the agent the protocol and the heuristics
 * (PROTOCOL + HANDBOOK). The role binding happens later, per chat
 * window, via the `activate` command — which is role-specific and never
 * touches disk.
 */
export interface RuntimeArtifact {
  /** Body to stdout (also what `--write` would persist, for review). */
  body: string;
  /** Files to write when `--write` is set. May be empty (generic target). */
  files: Array<{
    /** Absolute or `~`-prefixed path; the writer expands `~`. */
    path: string;
    /** File body. */
    content: string;
    /**
     * Mode: `replace` overwrites any existing file (but refuses to
     * clobber an unrelated file lacking our marker phrase);
     * `marker-block` inserts/updates a marker section.
     */
    mode: "replace" | "marker-block";
    /** Used only when mode === "marker-block". */
    markerBegin?: string;
    markerEnd?: string;
  }>;
}

// `agents` is the canonical target: it writes AGENTS.md, the cross-tool
// project system-prompt standard (read by Codex, Cursor, Copilot,
// Windsurf, Zed, ...). `claude` additionally drops a one-line
// `@AGENTS.md` importer into CLAUDE.md for Claude Code (which does not
// read AGENTS.md natively yet). `cursor` is an optional fallback (a
// standalone .cursor/rules/*.mdc) for older Cursor versions or
// .mdc-specific features. `generic` prints the body and installs nothing.
export type Target = "agents" | "claude" | "cursor" | "generic";

/** Shared shape for per-target prompt artifacts. */
export interface PromptArtifact {
  /** The full human-readable prompt body for stdout. */
  body: string;
  /** Files to write when `--write` is set. */
  files: Array<{
    /** Absolute or `~`-prefixed path; the writer expands `~`. */
    path: string;
    /** File body. */
    content: string;
    /**
     * Mode: `replace` overwrites any existing file (but refuses to
     * clobber an unrelated file lacking our marker block where
     * applicable); `marker-block` inserts/updates a marker section.
     */
    mode: "replace" | "marker-block";
    /** Used only when mode === "marker-block". */
    markerBegin?: string;
    markerEnd?: string;
  }>;
  /**
   * Short line the user pastes into the agent chat to activate a
   * specific role for that window.
   */
  activation: string;
}

export type Target = "codex" | "claude" | "cursor" | "generic";

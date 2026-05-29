/**
 * Shared marker strings that delimit gojaja's managed block inside a
 * host file the user also owns (CLAUDE.md, AGENTS.md). Kept in a neutral
 * module so both claude.ts and agents.ts can import them without a
 * circular dependency. `reset` strips, and `prompt` upserts, exactly
 * this block.
 */
export const RUNTIME_MARKER_BEGIN = "<!-- gojaja-runtime:BEGIN -->";
export const RUNTIME_MARKER_END = "<!-- gojaja-runtime:END -->";

import type { ProjectConfig, ProjectSettings } from "./types";

/**
 * Defaults for every tunable knob exposed in `config.yaml:settings`.
 * Kept in core (not in `local-fs-store.ts`) so consumers can resolve
 * settings without owning a `Store`: `gojaja wait` reads the layer
 * directly via the store, but unit tests and future callers
 * (CHANGELOG generators, doctor reports) can resolve a freshly-read
 * config without re-routing through the store.
 *
 * All duration knobs are returned in milliseconds so downstream
 * consumers do not each re-parse the same string.
 */
export interface ResolvedSettings {
  /** Auto-archive threshold for Done tasks (ms). */
  taskArchiveAfterMs: number;
  /** Cadence for the watch auto-archive sweep (ms). */
  taskArchiveSweepEveryMs: number;
  /** Default `wait --poll-interval` when the flag is not passed (ms). */
  waitPollIntervalMs: number;
  /** "live without wait" silence threshold for the dashboard (ms). */
  stalledThresholdMs: number;
  /** Maximum events the watch dashboard keeps in `/api/state`. */
  dashboardEventTail: number;
}

const DEFAULT_TASK_ARCHIVE_AFTER = "48h";
const DEFAULT_TASK_ARCHIVE_SWEEP_EVERY = "30m";
const DEFAULT_WAIT_POLL_INTERVAL = "10s";
const DEFAULT_STALLED_THRESHOLD = "60s";
const DEFAULT_DASHBOARD_EVENT_TAIL = 300;

/**
 * Defaults broken out so callers (init seed, doctor reports, schema
 * docs) can echo the same canonical strings the parser accepts.
 */
export const DEFAULT_PROJECT_SETTINGS: Required<ProjectSettings> = {
  taskArchiveAfter: DEFAULT_TASK_ARCHIVE_AFTER,
  taskArchiveSweepEvery: DEFAULT_TASK_ARCHIVE_SWEEP_EVERY,
  waitPollInterval: DEFAULT_WAIT_POLL_INTERVAL,
  stalledThreshold: DEFAULT_STALLED_THRESHOLD,
  dashboardEventTail: DEFAULT_DASHBOARD_EVENT_TAIL,
};

/**
 * Mirror of `cli/argv.ts:parseDuration` — duplicated here so `core/`
 * does not depend on `cli/`. The grammar is identical (`<n>ms`,
 * `<n>s`, `<n>m`, `<n>h`, `<n>d`; bare numbers and compound forms
 * rejected). Returns `null` instead of throwing so the caller can
 * fall back to a default rather than blowing up the watch dashboard
 * or the `wait` command on a hand-edited config.yaml.
 */
function parseDurationOrNull(raw: string): number | null {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
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
      return null;
  }
}

/**
 * Tolerantly parse a duration string from `config.yaml`. We do NOT
 * throw on a malformed value — settings tuning is an operator
 * convenience, and a bad string in config.yaml should not brick the
 * watch dashboard or the wait command. Falls back to the default
 * duration if the string fails to parse or is non-positive.
 */
function resolveDurationMs(raw: unknown, fallbackRaw: string): number {
  const fallbackMs = parseDurationOrNull(fallbackRaw);
  // Defaults are constants under test; they always parse.
  const fallback = fallbackMs === null ? 0 : fallbackMs;
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const ms = parseDurationOrNull(raw);
  if (ms === null || ms <= 0) return fallback;
  return ms;
}

function resolvePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return fallback;
  }
  return Math.floor(raw);
}

/**
 * Project-config → resolved milliseconds / counts. Pure function:
 * given the same `ProjectConfig` it always returns the same output.
 * Callers can short-circuit the read by caching the resolved object;
 * watch reads the config once at startup, wait reads it per invocation.
 */
export function resolveSettings(config: ProjectConfig): ResolvedSettings {
  const s = config.settings ?? {};
  return {
    taskArchiveAfterMs: resolveDurationMs(
      s.taskArchiveAfter,
      DEFAULT_TASK_ARCHIVE_AFTER,
    ),
    taskArchiveSweepEveryMs: resolveDurationMs(
      s.taskArchiveSweepEvery,
      DEFAULT_TASK_ARCHIVE_SWEEP_EVERY,
    ),
    waitPollIntervalMs: resolveDurationMs(
      s.waitPollInterval,
      DEFAULT_WAIT_POLL_INTERVAL,
    ),
    stalledThresholdMs: resolveDurationMs(
      s.stalledThreshold,
      DEFAULT_STALLED_THRESHOLD,
    ),
    dashboardEventTail: resolvePositiveInt(
      s.dashboardEventTail,
      DEFAULT_DASHBOARD_EVENT_TAIL,
    ),
  };
}

/**
 * Resolved defaults — useful for tests and for the help text that
 * needs to echo the canonical default values without parsing
 * config.yaml.
 */
export const DEFAULT_RESOLVED_SETTINGS: ResolvedSettings = resolveSettings({
  schemaVersion: "0",
  roles: {},
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_RESOLVED_SETTINGS,
  resolveSettings,
} from "../src/core/settings";
import type { ProjectConfig } from "../src/core/types";

const baseConfig = (): ProjectConfig => ({
  schemaVersion: "3.0.0",
  roles: {},
});

describe("resolveSettings — fallback to built-in defaults", () => {
  it("returns the built-in defaults when settings is missing", () => {
    const r = resolveSettings(baseConfig());
    expect(r.taskArchiveAfterMs).toBe(48 * 60 * 60 * 1000);
    expect(r.taskArchiveSweepEveryMs).toBe(30 * 60 * 1000);
    expect(r.waitPollIntervalMs).toBe(10 * 1000);
    expect(r.stalledThresholdMs).toBe(60 * 1000);
    expect(r.dashboardEventTail).toBe(300);
  });

  it("returns the same numbers as DEFAULT_RESOLVED_SETTINGS for the empty case", () => {
    expect(resolveSettings(baseConfig())).toEqual(DEFAULT_RESOLVED_SETTINGS);
  });

  it("DEFAULT_PROJECT_SETTINGS round-trips through resolveSettings", () => {
    const cfg: ProjectConfig = {
      ...baseConfig(),
      settings: { ...DEFAULT_PROJECT_SETTINGS },
    };
    expect(resolveSettings(cfg)).toEqual(DEFAULT_RESOLVED_SETTINGS);
  });
});

describe("resolveSettings — explicit overrides", () => {
  it("accepts custom durations and counts", () => {
    const cfg: ProjectConfig = {
      ...baseConfig(),
      settings: {
        taskArchiveAfter: "7d",
        taskArchiveSweepEvery: "5m",
        waitPollInterval: "2s",
        stalledThreshold: "120s",
        dashboardEventTail: 500,
      },
    };
    const r = resolveSettings(cfg);
    expect(r.taskArchiveAfterMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(r.taskArchiveSweepEveryMs).toBe(5 * 60 * 1000);
    expect(r.waitPollIntervalMs).toBe(2000);
    expect(r.stalledThresholdMs).toBe(120 * 1000);
    expect(r.dashboardEventTail).toBe(500);
  });
});

describe("resolveSettings — tolerant of malformed inputs", () => {
  it("falls back to the default when a duration string is unparseable", () => {
    const cfg: ProjectConfig = {
      ...baseConfig(),
      settings: { taskArchiveAfter: "yesterday" as unknown as string },
    };
    expect(resolveSettings(cfg).taskArchiveAfterMs).toBe(
      DEFAULT_RESOLVED_SETTINGS.taskArchiveAfterMs,
    );
  });

  it("falls back to the default when waitPollInterval is non-positive", () => {
    const cfg: ProjectConfig = {
      ...baseConfig(),
      settings: { waitPollInterval: "0s" },
    };
    expect(resolveSettings(cfg).waitPollIntervalMs).toBe(
      DEFAULT_RESOLVED_SETTINGS.waitPollIntervalMs,
    );
  });

  it("falls back to the default when dashboardEventTail is non-numeric or non-positive", () => {
    const a = resolveSettings({
      ...baseConfig(),
      settings: { dashboardEventTail: "many" as unknown as number },
    });
    const b = resolveSettings({
      ...baseConfig(),
      settings: { dashboardEventTail: 0 },
    });
    const c = resolveSettings({
      ...baseConfig(),
      settings: { dashboardEventTail: -10 },
    });
    expect(a.dashboardEventTail).toBe(300);
    expect(b.dashboardEventTail).toBe(300);
    expect(c.dashboardEventTail).toBe(300);
  });
});

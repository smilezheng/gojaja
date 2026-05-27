import { describe, expect, it } from "vitest";
import { COLLABORATION_HANDBOOK } from "../src/cli/prompts/handbook";
import { buildActivation, buildRuntime } from "../src/cli/prompts";

const KEY_TRIGGER_PHRASES: ReadonlyArray<RegExp> = [
  // Core stance + turn shape
  /agentctl is the team protocol/i,
  /Default to resolving with another agent before bouncing to the user/i,
  /every substantive turn must end with wait/i,

  // Worklog rules
  /3\+ turns without a worklog/,
  /Do NOT:\s*\n- Worklog every/,

  // Report vs RFC
  /Use report as "broadcast \+ at-mention"/,
  /a decision that cannot be unilaterally made by any one\nrole/,

  // Upstream / escalation
  /Blocked on T-XXXX \(no movement 2t\)/,
  /\\?`?reportsTo\\?`?/, // mentions reportsTo at least once

  // User-vs-agent rules
  /exit code 9 \(FORBIDDEN\)/,
  /Do NOT edit\s+\\?`?config\.yaml\\?`?/,

  // Idle and lifecycle
  /Do NOT \\?`?release\\?`? the role/,
  /more than 5 turns since you last planned/,

  // Build/test breakage
  /Build \/ test breakage/,
  /halt your task work, and do NOT push commits on top/,

  // Hard don'ts block
  /Don't hand-edit anything under \\?`?\.multi-agent/,
];

describe("COLLABORATION_HANDBOOK", () => {
  it("keeps every key trigger phrase (sanity check against future edits)", () => {
    for (const re of KEY_TRIGGER_PHRASES) {
      expect(COLLABORATION_HANDBOOK).toMatch(re);
    }
  });

  it("is role-neutral: never names PM, TL, Backend, QA, DevOps directly", () => {
    expect(COLLABORATION_HANDBOOK).not.toMatch(/\bPM\b/);
    expect(COLLABORATION_HANDBOOK).not.toMatch(/\bTL\b/);
    expect(COLLABORATION_HANDBOOK).not.toMatch(/\bBackend\b/);
    expect(COLLABORATION_HANDBOOK).not.toMatch(/\bQA\b/);
    expect(COLLABORATION_HANDBOOK).not.toMatch(/\bDevOps\b/);
  });

  it("stays within a reasonable size budget (<8 KB of UTF-8)", () => {
    // Loaded once per session into the host's persistent area, so the
    // budget is generous compared to roleReminder. But still capped so
    // future edits notice when the handbook bloats.
    expect(Buffer.byteLength(COLLABORATION_HANDBOOK, "utf8")).toBeLessThan(8 * 1024);
  });
});

describe("buildRuntime handbook integration", () => {
  const PROJ = "/tmp/example-project";

  it("default runtime artifact includes the handbook for every target", () => {
    for (const t of ["codex", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, PROJ);
      expect(a.body).toContain("Collaboration handbook");
      // Runtime mechanics still present alongside the handbook.
      expect(a.body).toContain("agentctl plan");
      // Codex/Claude/Cursor also drop the handbook into the persistent file.
      if (t !== "generic") {
        expect(a.files[0].content).toContain("Collaboration handbook");
      }
    }
  });

  it("--no-handbook (withHandbook: false) omits the handbook section", () => {
    for (const t of ["codex", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, PROJ, { withHandbook: false });
      expect(a.body).not.toContain("Collaboration handbook");
      expect(a.body).not.toContain("Hard \"don't\"s");
      expect(a.body).toContain("agentctl plan");
      if (t !== "generic") {
        expect(a.files[0].content).not.toContain("Collaboration handbook");
      }
    }
  });

  it("dropping the handbook shrinks the cursor file by at least ~2 KB", () => {
    const withH = buildRuntime("cursor", PROJ).files[0].content;
    const noH = buildRuntime("cursor", PROJ, { withHandbook: false }).files[0].content;
    expect(withH.length - noH.length).toBeGreaterThan(2000);
  });

  it("generic activation carries the handbook too (since there is no install location)", () => {
    const s = buildActivation("generic", "PM", PROJ);
    expect(s).toContain("Collaboration handbook");
    const sNo = buildActivation("generic", "PM", PROJ, { withHandbook: false });
    expect(sNo).not.toContain("Collaboration handbook");
  });
});

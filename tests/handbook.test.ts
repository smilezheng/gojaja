import { describe, expect, it } from "vitest";
import { COLLABORATION_HANDBOOK } from "../src/cli/prompts/handbook";
import { buildActivation, buildRuntime } from "../src/cli/prompts";

/**
 * Trigger phrases the compressed handbook MUST keep present (verbatim
 * or whitespace-tolerant). Each catches an essential rule; if a future
 * edit accidentally deletes the rule, the test fails. Phrases are
 * deliberately specific enough to detect a behavioural regression and
 * loose enough to survive line-wrap / formatting tweaks.
 *
 * PR8q: relaxed from PR8b–PR8n phrasings after the handbook was
 * compressed for CLAUDE.md insertion. Trigger phrases now match the
 * compressed wording.
 */
const KEY_TRIGGER_PHRASES: ReadonlyArray<RegExp> = [
  // Core stance + turn shape
  /gojaja is the team protocol/i,
  /Default to resolving with another agent before bouncing to the user/i,
  /every substantive turn must end\s+with wait/i,

  // Channel selection (table heading + key invariants)
  /3\+ turns without a worklog/i,
  /"Broadcast \+ at-mention"/i,
  /a decision no single role can make alone/i,

  // Upstream / escalation
  /Blocked on T-XXXX \(no movement 2t\)/,
  /\breportsTo\b/, // mentions reportsTo at least once

  // User-vs-agent rules
  /exit code 9 \(FORBIDDEN\)/,
  /Do NOT edit\s+\\?`?config\.yaml\\?`?/,

  // Idle and lifecycle
  /Do NOT \\?`?release\\?`? the role/,
  /more than 5 turns since you last planned/,

  // Build/test breakage
  /Build \/ test breakage/,
  /halt\s+your task work, and do NOT push commits on top/,

  // Hard don'ts block
  /Don't hand-edit anything under \\?`?\.gojaja/,

  // Task-assignment rules
  /Task assignment is push, not pull/,
  /Don't self-assign by calling/,
  /Multi-role task pattern/,

  // RFC deciders are per-RFC
  /deciders are\s+\*\*per-RFC\*\*/,

  // RFC multi-round / pre-decide / revise rules
  /RFC multi-round discussion/,
  /Use revise when the topic is real but\s+the writeup is too thin/,
  /Silence does NOT count\s+as consent/,
  /myAckOwed: true/,
  /Plain `rfc comment`\s+does NOT advance the gate/,

  // Wait redesign + --for task-assigned
  /Idle \(no work\)[^\n]*wait --for task-assigned/,
  /one-shot per\s+wait session/,
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

  it("regex-based stricter check: handbook never names a role as the actor", () => {
    // The hardcoded `PM`, `TL`, ... blacklist above catches the common
    // four roles. But a project could define `Alice`, `ProductOwner`,
    // anything. The general invariant is: no sentence in the handbook
    // says "<RoleName> verbs ...". Catch that pattern with a regex so
    // hand edits cannot silently re-introduce role-coupled phrasing.
    const ROLE_ACT_PATTERN =
      /\b[A-Z][A-Za-z0-9_-]{1,30}\s+(should|must|will|may|owns|is the|gets|handles|reviews|approves)\b/g;
    const matches = COLLABORATION_HANDBOOK.match(ROLE_ACT_PATTERN) ?? [];
    // Allowlist: generic determiners / pronouns that take the same
    // grammatical shape as a role name but are obviously not roles.
    const GRAMMATICAL_ALLOW = new Set([
      "Each",
      "Any",
      "Every",
      "The",
      "Your",
      "No",
      "This",
      "That",
      "These",
      "Those",
      "All",
      "Both",
      "Plan",
      // Interrogatives that begin "Common temptations that are NOT the
      // user's job" rhetorical questions ("How should I word ...",
      // "Who should review ...") — not role names.
      "How",
      "Who",
      "What",
      "Why",
      "When",
      "Where",
      "Which",
    ]);
    const offenders = matches.filter((m) => {
      const first = m.split(/\s+/)[0];
      return !GRAMMATICAL_ALLOW.has(first);
    });
    expect(offenders).toEqual([]);
  });

  it("stays within a tight size budget (<12 KB of UTF-8)", () => {
    // The handbook ships into the host's persistent prompt area —
    // CLAUDE.md insertion in particular wants ~200 lines total
    // (Anthropic's guidance), so the handbook gets a hard <12 KB cap
    // here, well under the historical 8/10/12/14/16/18/20 KB ladder.
    // PR8q compressed the body by ~60% via table layout, removal of
    // PR-version markers, and dropping rationale paragraphs in favour
    // of the long-form policy in docs/HANDBOOK.md.
    expect(Buffer.byteLength(COLLABORATION_HANDBOOK, "utf8")).toBeLessThan(12 * 1024);
  });
});

describe("buildRuntime handbook integration", () => {
  const PROJ = "/tmp/example-project";

  it("PR8d gate: every target body announces 'applies only when this window is bound to a role' and forbids speculative gojaja calls", () => {
    // Without the gate, an unactivated chat window (user opened a fresh
    // Cursor tab to ask an unrelated question, never ran `activate`)
    // would still see the runtime body in its system prompt and could
    // reflexively run `gojaja plan` / `claim`, claiming a role the
    // user never intended. The gate localises the loop to actively
    // bound windows only.
    // Tolerate whitespace / newlines + minor phrasing shifts since the
    // body was compressed in PR8q.
    const GATE_RE = /ONLY when this window is bound to a role/i;
    const FORBID_RE = /do NOT speculatively run/i;
    for (const t of ["codex", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, PROJ);
      expect(a.body).toMatch(GATE_RE);
      expect(a.body).toMatch(FORBID_RE);
      if (t !== "generic") {
        expect(a.files[0].content).toMatch(GATE_RE);
      }
    }
  });

  it("default runtime artifact includes the handbook for every target", () => {
    for (const t of ["codex", "claude", "cursor", "generic"] as const) {
      const a = buildRuntime(t, PROJ);
      expect(a.body).toContain("Collaboration handbook");
      // Runtime mechanics still present alongside the handbook.
      expect(a.body).toContain("gojaja plan");
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
      expect(a.body).toContain("gojaja plan");
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

import { describe, expect, it } from "vitest";
import { HELP_TEXT, COMMAND_HELP, helpForCommand } from "../src/cli/help";

describe("gojaja help text (PR8e rewrite)", () => {
  it("opens with a one-paragraph description of what the tool is", () => {
    expect(HELP_TEXT).toMatch(/Coordination layer/i);
    expect(HELP_TEXT).toMatch(/multi-LLM-agent collaboration/i);
  });

  it("includes a Quickstart that walks through the one-time project setup", () => {
    expect(HELP_TEXT).toContain("Quickstart");
    expect(HELP_TEXT).toContain("gojaja init");
    expect(HELP_TEXT).toContain("gojaja role create");
    expect(HELP_TEXT).toContain("gojaja prompt --target");
    expect(HELP_TEXT).toContain("gojaja activate");
  });

  it("mentions both --eval and the post-release `unset GOJAJA_SESSION` hint", () => {
    // Both came up in PR8c/PR8d as common first-time mistakes; help
    // should mention them inline near the relevant command.
    expect(HELP_TEXT).toMatch(/eval "\$\(gojaja claim/);
    expect(HELP_TEXT).toContain("unset GOJAJA_SESSION");
  });

  it("documents exit codes with agent-actionable hints, matching errors.ts", () => {
    expect(HELP_TEXT).toContain("USAGE");
    expect(HELP_TEXT).toContain("3  NOT_INIT");
    expect(HELP_TEXT).toContain("8  STATE_CORRUPT");
    expect(HELP_TEXT).toContain("9  FORBIDDEN");
    expect(HELP_TEXT).toContain("Escalate");
  });

  it("points agents to 'gojaja handbook' for full policy", () => {
    expect(HELP_TEXT).toContain("gojaja handbook");
  });

  it("flags the role delete command and its SYSTEM-3 ownership gate", () => {
    // PR9 SYSTEM-3 replaced the "SYSTEM only — no GOJAJA_SESSION"
    // rule with a unified ownership-of-config.yaml gate. The help
    // text should mention both legitimate paths: --as-system and
    // the delegated role pattern.
    expect(HELP_TEXT).toContain("role delete");
    expect(HELP_TEXT).toContain("--as-system");
    expect(HELP_TEXT).toContain("config.yaml");
  });
});

describe("per-command help (gojaja <cmd> -h)", () => {
  it("returns a focused card for a known command, not the full manual", () => {
    const roleHelp = helpForCommand("role");
    expect(roleHelp).not.toBe(HELP_TEXT);
    expect(roleHelp.length).toBeLessThan(HELP_TEXT.length / 3);
    expect(roleHelp).toContain("gojaja role create");
    expect(roleHelp).toContain("gojaja role delete");
    expect(roleHelp).toContain("Full reference: gojaja -h");
  });

  it("the wait card does not imply running a wait", () => {
    const waitHelp = helpForCommand("wait");
    expect(waitHelp).toContain("gojaja wait");
    expect(waitHelp).toContain("Idle keepalive");
  });

  it("falls back to the full manual for an unknown command", () => {
    expect(helpForCommand("frobnicate")).toBe(HELP_TEXT);
  });

  it("every dispatchable command has a help card", () => {
    // Keep COMMAND_HELP in sync with the real command set. (handbook,
    // watch, etc. are easy to forget.)
    const commands = [
      "init", "version", "claim", "release", "plan", "ack", "report",
      "worklog", "role", "task", "rfc", "prompt", "activate", "wait",
      "watch", "state", "reset", "handbook",
    ];
    for (const c of commands) {
      expect(COMMAND_HELP[c], `missing help card for '${c}'`).toBeDefined();
    }
  });
});

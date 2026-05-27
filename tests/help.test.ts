import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../src/cli/help";

describe("agentctl help text (PR8e rewrite)", () => {
  it("opens with a one-paragraph description of what the tool is", () => {
    // First-time readers should not have to guess what 'multi-agent
    // coordination layer' means by reverse-engineering the commands.
    expect(HELP_TEXT).toMatch(/Multi-agent coordination layer/);
    expect(HELP_TEXT).toMatch(/filesystem-backed protocol/);
  });

  it("includes a Quickstart that walks through the one-time project setup", () => {
    expect(HELP_TEXT).toContain("Quickstart");
    expect(HELP_TEXT).toContain("agentctl init");
    expect(HELP_TEXT).toContain("agentctl role create");
    expect(HELP_TEXT).toContain("agentctl prompt --target");
    expect(HELP_TEXT).toContain("agentctl activate");
  });

  it("mentions both --eval and the post-release `unset MA_SESSION` hint", () => {
    // Both came up in PR8c/PR8d as common first-time mistakes; help
    // should mention them inline near the relevant command.
    expect(HELP_TEXT).toMatch(/eval "\$\(agentctl claim/);
    expect(HELP_TEXT).toContain("unset MA_SESSION");
  });

  it("documents exit codes 2 / 6 / 9 / 10 with agent-actionable hints", () => {
    expect(HELP_TEXT).toContain("USAGE");
    expect(HELP_TEXT).toContain("FORBIDDEN");
    expect(HELP_TEXT).toContain("STATE_CORRUPTION");
    expect(HELP_TEXT).toContain("escalate");
  });

  it("links to the doc set so users know where to dig deeper", () => {
    expect(HELP_TEXT).toContain("docs/PROTOCOL.md");
    expect(HELP_TEXT).toContain("docs/HANDBOOK.md");
    expect(HELP_TEXT).toContain("docs/SCHEMA.md");
    expect(HELP_TEXT).toContain("README.md");
  });

  it("flags the role delete command and its SYSTEM-only restriction", () => {
    expect(HELP_TEXT).toContain("role delete");
    expect(HELP_TEXT).toContain("SYSTEM only");
  });
});

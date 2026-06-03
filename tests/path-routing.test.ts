import { describe, expect, it } from "vitest";
import { classifyPath, isSplitMode } from "../src/core/path-routing";
import { Paths, rolePaths } from "../src/core/paths";

/**
 * Pure unit tests for the v3 path classifier (RFC-0001 §2.6). The
 * function has no side effects; tests exercise the routing table
 * directly.
 */

describe("classifyPath: user-tree paths (git-tracked)", () => {
  it("classifies the VERSION schema marker as user", () => {
    expect(classifyPath(Paths.versionFile)).toBe("user");
  });

  it("classifies project.json (v3 ULID marker) as user", () => {
    expect(classifyPath("project.json")).toBe("user");
  });

  it("classifies config.yaml as user (ownership contracts)", () => {
    expect(classifyPath(Paths.configFile)).toBe("user");
  });

  it("classifies .gitignore as user (lives next to the layer)", () => {
    expect(classifyPath(Paths.gitignoreFile)).toBe("user");
  });

  it("classifies state/project_state.md as user (human-authored)", () => {
    expect(classifyPath(Paths.projectStateFile)).toBe("user");
  });

  it("classifies the roles directory and every role brief as user", () => {
    expect(classifyPath(Paths.rolesDir)).toBe("user");
    expect(classifyPath(rolePaths("PM").roleFile)).toBe("user");
    expect(classifyPath(rolePaths("Backend").roleFile)).toBe("user");
    expect(classifyPath("roles/some-other-role.md")).toBe("user");
  });

  it("classifies the optional protocol/ tree as user", () => {
    expect(classifyPath(Paths.protocolDir)).toBe("user");
    expect(classifyPath("protocol/spec.md")).toBe("user");
    expect(classifyPath("protocol/nested/deep.md")).toBe("user");
  });
});

describe("classifyPath: central-tree paths (runtime, never in git)", () => {
  it("classifies state/task_board.yaml as central (mutable runtime)", () => {
    expect(classifyPath(Paths.taskBoardFile)).toBe("central");
  });

  it("classifies the comms/ tree as central (events, sessions, cursors)", () => {
    expect(classifyPath(Paths.eventsDir)).toBe("central");
    expect(classifyPath(Paths.sessionsDir)).toBe("central");
    expect(classifyPath(Paths.cursorsDir)).toBe("central");
    expect(classifyPath(Paths.pendingDir)).toBe("central");
    expect(classifyPath(Paths.heartbeatsDir)).toBe("central");
    expect(classifyPath("comms/events/01JZ9X7T.json")).toBe("central");
    expect(classifyPath("comms/sessions/PM.json")).toBe("central");
    expect(classifyPath("comms/cursors/PM/rfc-RFC-0001.json")).toBe("central");
    expect(classifyPath("comms/pending/PM/wait.json")).toBe("central");
  });

  it("classifies rfcs/ as central (in-flight discussion artifacts)", () => {
    expect(classifyPath(Paths.rfcsDir)).toBe("central");
    expect(classifyPath("rfcs/RFC-0001-central-root/proposal.yaml")).toBe(
      "central",
    );
    expect(classifyPath("rfcs/RFC-0001-central-root/comments.yaml")).toBe(
      "central",
    );
    expect(classifyPath("rfcs/RFC-0001-central-root/decision.json")).toBe(
      "central",
    );
  });

  it("classifies worklog/ as central (per-agent activity records)", () => {
    expect(classifyPath(Paths.worklogDir)).toBe("central");
    expect(classifyPath("worklog/PM/01JZ9X7T.md")).toBe("central");
  });

  it("classifies locks/ as central (per-resource file locks)", () => {
    expect(classifyPath(Paths.locksDir)).toBe("central");
    expect(classifyPath("locks/role-PM.lock")).toBe("central");
    expect(classifyPath("locks/config-yaml.lock")).toBe("central");
  });

  it("defaults unknown paths to central (forward compatibility)", () => {
    // Future runtime additions should NOT silently leak into git.
    // The "user" set is closed; "central" is the default.
    expect(classifyPath("audit.log")).toBe("central");
    expect(classifyPath("comms/unknown-new-subdir/x.json")).toBe("central");
    expect(classifyPath("state/some-future-runtime.yaml")).toBe("central");
  });
});

describe("classifyPath: normalisation", () => {
  it("tolerates a leading './' prefix", () => {
    expect(classifyPath("./" + Paths.configFile)).toBe("user");
    expect(classifyPath("./" + Paths.taskBoardFile)).toBe("central");
  });

  it("tolerates backslash separators (Windows-style input)", () => {
    expect(classifyPath("roles\\PM.md")).toBe("user");
    expect(classifyPath("comms\\events\\01JZ9X7T.json")).toBe("central");
  });
});

describe("isSplitMode", () => {
  it("is false when both roots point at the same path", () => {
    expect(isSplitMode("/foo/.gojaja", "/foo/.gojaja")).toBe(false);
  });

  it("is true when roots differ", () => {
    expect(
      isSplitMode("/foo/.gojaja", "/Users/x/.gojaja/projects/01JZ9X.../"),
    ).toBe(true);
  });
});

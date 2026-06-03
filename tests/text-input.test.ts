import { describe, expect, it } from "vitest";
import {
  requireText,
  resolveOptionalText,
} from "../src/cli/util/text-input";

/**
 * Unit tests for the multi-line text input helper. The seams
 * (`readStdin`, `isStdinTTY`, `openEditor`) are exercised via
 * dependency injection rather than touching real process.stdin or
 * spawning a real editor — both would be flaky in CI.
 */

describe("requireText: inline channel", () => {
  it("returns the inline value when --flag <text> is given", async () => {
    const out = await requireText({ message: "hello" }, "message");
    expect(out).toBe("hello");
  });

  it("preserves multi-line content and indentation in inline values", async () => {
    const out = await requireText({ message: "a\n  b\nc" }, "message");
    expect(out).toBe("a\n  b\nc");
  });

  it("does NOT touch stdin when an inline value is present", async () => {
    let stdinReads = 0;
    const out = await requireText({ message: "inline" }, "message", {
      readStdin: async () => {
        stdinReads++;
        return "from stdin";
      },
      isStdinTTY: () => false,
    });
    expect(out).toBe("inline");
    expect(stdinReads).toBe(0);
  });

  it("does NOT open the editor when an inline value is present", async () => {
    let editorOpens = 0;
    const out = await requireText({ message: "inline" }, "message", {
      isStdinTTY: () => true,
      openEditor: async () => {
        editorOpens++;
        return "from editor";
      },
    });
    expect(out).toBe("inline");
    expect(editorOpens).toBe(0);
  });
});

describe("requireText: stdin channel (explicit)", () => {
  it("reads stdin when --flag is bare (parsed as boolean true)", async () => {
    const out = await requireText({ message: true }, "message", {
      readStdin: async () => "from heredoc body\n",
    });
    expect(out).toBe("from heredoc body");
  });

  it("reads stdin when --flag is the explicit '-' sentinel", async () => {
    const out = await requireText({ message: "-" }, "message", {
      readStdin: async () => "from stdin via dash\n",
    });
    expect(out).toBe("from stdin via dash");
  });

  it("strips trailing whitespace but preserves internal newlines", async () => {
    const out = await requireText({ message: true }, "message", {
      readStdin: async () => "line1\n\nline3\n\n  \n",
    });
    expect(out).toBe("line1\n\nline3");
  });

  it("treats backticks and $ in stdin as literal — no double parse", async () => {
    const dangerous = "see `git push` and $(rm -rf /) — safe as data";
    const out = await requireText({ message: true }, "message", {
      readStdin: async () => dangerous,
    });
    expect(out).toBe(dangerous);
  });

  it("throws USAGE on empty stdin payload (--flag - but nothing piped)", async () => {
    await expect(
      requireText({ message: "-" }, "message", {
        readStdin: async () => "",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });

  it("throws USAGE on whitespace-only stdin payload", async () => {
    await expect(
      requireText({ message: true }, "message", {
        readStdin: async () => "   \n\n  \n",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("requireText: editor channel", () => {
  it("opens $EDITOR when the flag is absent and stdin is a TTY", async () => {
    let opened = "";
    const out = await requireText({}, "message", {
      isStdinTTY: () => true,
      openEditor: async (name) => {
        opened = name;
        return "buffer contents";
      },
    });
    expect(opened).toBe("message");
    expect(out).toBe("buffer contents");
  });

  it("does NOT open the editor when allowEditor=false; throws USAGE", async () => {
    await expect(
      requireText({}, "message", {
        isStdinTTY: () => true,
        allowEditor: false,
        openEditor: async () => "should not be called",
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("requireText: absent flag, non-TTY", () => {
  it("throws USAGE pointing at the safe heredoc form (never hangs on stdin)", async () => {
    // The critical never-hang invariant: when the flag is absent AND
    // stdin is non-TTY (e.g. CI / test runner / pipe with no source),
    // we must NOT call readStdin. A wrong implementation here will
    // dead-lock the entire test runner.
    let stdinReads = 0;
    await expect(
      requireText({}, "message", {
        isStdinTTY: () => false,
        readStdin: async () => {
          stdinReads++;
          return "";
        },
      }),
    ).rejects.toMatchObject({ code: "USAGE" });
    expect(stdinReads).toBe(0);
  });
});

describe("requireText: error message guides toward heredoc", () => {
  it("references the safe '<<'EOF'' shape in the USAGE error", async () => {
    try {
      await requireText({}, "rationale", {
        isStdinTTY: () => false,
        allowEditor: false,
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe("USAGE");
      expect(e.message ?? "").toMatch(/<<'EOF'/);
      expect(e.message ?? "").toMatch(/--rationale/);
    }
  });
});

describe("resolveOptionalText", () => {
  it("returns inline value when given (including empty string)", async () => {
    expect(
      await resolveOptionalText({ description: "hello" }, "description"),
    ).toBe("hello");
    expect(
      await resolveOptionalText({ description: "" }, "description"),
    ).toBe("");
  });

  it("returns empty string when flag is absent (does NOT read stdin)", async () => {
    let stdinReads = 0;
    const out = await resolveOptionalText({}, "description", {
      readStdin: async () => {
        stdinReads++;
        return "should not be reached";
      },
    });
    expect(out).toBe("");
    expect(stdinReads).toBe(0);
  });

  it("reads stdin only on explicit opt-in (bare flag or '-')", async () => {
    const fromBare = await resolveOptionalText(
      { description: true },
      "description",
      { readStdin: async () => "via heredoc" },
    );
    expect(fromBare).toBe("via heredoc");
    const fromDash = await resolveOptionalText(
      { description: "-" },
      "description",
      { readStdin: async () => "via dash" },
    );
    expect(fromDash).toBe("via dash");
  });

  it("allows empty stdin payload silently (returns '')", async () => {
    const out = await resolveOptionalText(
      { description: "-" },
      "description",
      { readStdin: async () => "" },
    );
    expect(out).toBe("");
  });
});

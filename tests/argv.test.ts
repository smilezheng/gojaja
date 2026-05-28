import { describe, expect, it } from "vitest";
import { parseArgv } from "../src/cli/argv";

describe("parseArgv — boolean flag whitelist", () => {
  it("regression C-03: --json never consumes the next token as a value", () => {
    // The bug: `gojaja plan --json PM` used to parse as flags.json="PM",
    // positional=[]. Then boolFlag('json') returns false and the role
    // argument is lost, leading to silent GOJAJA_SESSION errors.
    const r = parseArgv(["plan", "--json", "PM"]);
    expect(r.command).toBe("plan");
    expect(r.positional).toEqual(["PM"]);
    expect(r.flags.json).toBe(true);
  });

  it("--json=true PM also produces boolean + positional", () => {
    const r = parseArgv(["plan", "--json=true", "PM"]);
    expect(r.positional).toEqual(["PM"]);
    expect(r.flags.json).toBe("true"); // explicit =value keeps the string
  });

  it("non-boolean --target still consumes the following token", () => {
    const r = parseArgv(["prompt", "--target", "cursor", "--write"]);
    expect(r.command).toBe("prompt");
    expect(r.positional).toEqual([]);
    expect(r.flags.target).toBe("cursor");
    expect(r.flags.write).toBe(true);
  });

  it("boolean --write at end of argv yields true", () => {
    const r = parseArgv(["prompt", "--target", "cursor", "--write"]);
    expect(r.flags.write).toBe(true);
  });

  it("boolean --no-handbook does not consume positional", () => {
    const r = parseArgv(["activate", "PM", "--target", "cursor", "--no-handbook"]);
    expect(r.positional).toEqual(["PM"]);
    expect(r.flags["no-handbook"]).toBe(true);
    expect(r.flags.target).toBe("cursor");
  });

  it("mixed: --write before a positional argument still leaves the positional intact", () => {
    // `gojaja prompt --write` historically required no positional, but
    // a user accidentally typing `gojaja activate --write PM --target cursor`
    // should not lose PM either.
    const r = parseArgv(["activate", "--write", "PM", "--target", "cursor"]);
    expect(r.positional).toEqual(["PM"]);
    expect(r.flags.write).toBe(true);
    expect(r.flags.target).toBe("cursor");
  });
});

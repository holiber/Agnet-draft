import { describe, expect, it } from "vitest";

import { tokenizeCommandLine } from "../src/cli/command-line.js";

describe("tokenizeCommandLine", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommandLine("a b   c")).toEqual(["a", "b", "c"]);
  });

  it("supports single quotes", () => {
    expect(tokenizeCommandLine("say 'hello world'")).toEqual(["say", "hello world"]);
  });

  it("supports double quotes with escapes", () => {
    expect(tokenizeCommandLine('say "hello \\"world\\""')).toEqual(["say", 'hello "world"']);
  });

  it("supports backslash escapes outside quotes", () => {
    expect(tokenizeCommandLine("a\\ b c")).toEqual(["a b", "c"]);
  });

  it("throws on unterminated quotes", () => {
    expect(() => tokenizeCommandLine("a 'b")).toThrow(/Unterminated/);
    expect(() => tokenizeCommandLine('a "b')).toThrow(/Unterminated/);
  });
});


import { describe, expect, it } from "vitest";

import { assertCommandAllowed, sanitizeChildEnv } from "../src/internal/env-protection.js";

describe("sanitizeChildEnv", () => {
  it("returns original env when protection is disabled", () => {
    const env = { SECRET: "x", PATH: "/bin" };
    expect(sanitizeChildEnv(env)).toBe(env);
  });

  it("drops non-allowed keys when protection is enabled", () => {
    const env = {
      AGNET_PROTECT: "1",
      PATH: "/bin",
      HOME: "/home/x",
      SECRET: "x",
      OPENAI_API_KEY: "y"
    };
    const out = sanitizeChildEnv(env);
    expect(out.PATH).toBe("/bin");
    expect(out.HOME).toBe("/home/x");
    expect(out.SECRET).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    // Always preserves AGNET_* (for nested agents/tooling).
    expect(out.AGNET_PROTECT).toBe("1");
  });

  it("allows explicit keys via AGNET_ALLOW_ENV and prefix patterns", () => {
    const env = {
      AGNET_PROTECT: "1",
      AGNET_ALLOW_ENV: "OPENAI_API_KEY,MYAPP_*",
      PATH: "/bin",
      OPENAI_API_KEY: "k",
      MYAPP_TOKEN: "t",
      MYAPP_URL: "u",
      OTHER: "nope"
    };
    const out = sanitizeChildEnv(env);
    expect(out.OPENAI_API_KEY).toBe("k");
    expect(out.MYAPP_TOKEN).toBe("t");
    expect(out.MYAPP_URL).toBe("u");
    expect(out.OTHER).toBeUndefined();
  });
});

describe("assertCommandAllowed", () => {
  it("does nothing unless strict mode is enabled", () => {
    expect(() => assertCommandAllowed({ command: "bash", env: {} })).not.toThrow();
  });

  it("blocks commands not in AGNET_ALLOW_COMMANDS in strict mode", () => {
    const env = { AGNET_PROTECT_STRICT: "1", AGNET_ALLOW_COMMANDS: "node,/usr/bin/node" };
    expect(() => assertCommandAllowed({ command: "bash", env })).toThrow(/Blocked command/);
    expect(() => assertCommandAllowed({ command: "node", env })).not.toThrow();
  });
});


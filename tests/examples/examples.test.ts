import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { Agnet } from "../../src/agnet.js";

/**
 * Examples-as-tests safety net.
 *
 * Keep these snippets aligned with README examples.
 */
describe("README examples", () => {
  it("ask (human-style) and prompt (computer-style) work against the mock provider", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-examples-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    const agnet = new Agnet({ cwd });
    agnet.providers.register({
      agent: { id: "mock-agent", name: "Mock Agent", version: "0.0.0", skills: [{ id: "chat" }] },
      runtime: { transport: "cli", command: process.execPath, args: [mockAgentPath] }
    });

    const response = await agnet.ask("hello");
    expect(response).toBe("MockAgent response #1: hello");

    const result = await agnet.prompt("hello");
    expect(result.text).toBe("MockAgent response #1: hello");
    expect(result.providerId).toBe("mock-agent");
  });
});


import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { Agnet } from "../src/agnet.js";

function mockProviderConfig(params: { id: string; mockAgentPath: string; isDefault?: boolean }) {
  return {
    agent: {
      id: params.id,
      name: `Mock ${params.id}`,
      version: "0.0.0",
      skills: [{ id: "chat" }],
      ...(params.isDefault ? { extensions: { default: true } } : {})
    },
    runtime: { transport: "cli" as const, command: process.execPath, args: [params.mockAgentPath] }
  };
}

describe("Agnet API shortcuts (ask/prompt) + unified request input", () => {
  it("ask(request) is syntax sugar for chats.create(request).response()", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-shortcuts-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    const an = new Agnet({ cwd });
    an.providers.register(mockProviderConfig({ id: "mock-agent", mockAgentPath }));

    const a = await an.ask("hello");
    const b = await (await an.chats.create("hello")).response();
    expect(a).toBe(b);
    expect(a).toBe("MockAgent response #1: hello");
  });

  it("prompt(request) is syntax sugar for chats.create(request).result()", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-shortcuts-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    const an = new Agnet({ cwd });
    an.providers.register(mockProviderConfig({ id: "mock-agent", mockAgentPath }));

    const a = await an.prompt("hello");
    const b = await (await an.chats.create("hello")).result();
    expect(a.text).toBe(b.text);
    expect(a.providerId).toBe("mock-agent");
    expect(a.text).toBe("MockAgent response #1: hello");
  });

  it("supports object input (providerId optional) and string shorthand everywhere", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-shortcuts-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    const an = new Agnet({ cwd });
    an.providers.register(mockProviderConfig({ id: "mock-agent", mockAgentPath }));

    const a = await an.prompt({ prompt: "hello" });
    const b = await an.prompt("hello");
    expect(a.text).toBe("MockAgent response #1: hello");
    expect(b.text).toBe("MockAgent response #1: hello");
  });

  it("default provider resolution is deterministic: last registered unless a default is marked", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-shortcuts-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    // Case A: no default -> last registered wins.
    const an1 = new Agnet({ cwd });
    an1.providers.register(mockProviderConfig({ id: "p1", mockAgentPath }));
    an1.providers.register(mockProviderConfig({ id: "p2", mockAgentPath }));
    expect((await an1.prompt("hello")).providerId).toBe("p2");

    // Case B: default marked -> default wins even if registered earlier.
    const cwd2 = await mkdtemp(path.join(os.tmpdir(), "agnet-shortcuts-"));
    const an2 = new Agnet({ cwd: cwd2 });
    an2.providers.register(mockProviderConfig({ id: "p-default", mockAgentPath, isDefault: true }));
    an2.providers.register(mockProviderConfig({ id: "p-latest", mockAgentPath }));
    expect((await an2.prompt("hello")).providerId).toBe("p-default");
  });
});


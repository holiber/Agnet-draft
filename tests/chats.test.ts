import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { Agnet } from "../src/agnet.js";

describe("Agnet.chats", () => {
  it("creates a chat, sends a message, and can save/load from file", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-chat-"));
    const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

    const an = new Agnet({ cwd });
    an.providers.register({
      agent: { id: "mock-agent", name: "Mock Agent", version: "0.0.0", skills: [{ id: "chat" }] },
      runtime: { transport: "cli", command: process.execPath, args: [mockAgentPath] }
    });

    const chat = await an.chats.create({ providerId: "mock-agent" });
    const out = await chat.send("hello");
    expect(out).toBe("MockAgent response #1: hello\n");

    const savedPath = path.join(cwd, "chat.json");
    await chat.saveToFile(savedPath);

    const loaded = await an.chats.loadFromFile(savedPath);
    const out2 = await loaded.send("world");
    expect(out2).toBe("MockAgent response #2: world\n");
  });
});


import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import type {
  AgentToClientMessage,
  SessionCompleteMessage,
  SessionStreamMessage,
  ToolCallPlaceholderMessage
} from "../src/protocol.js";
import { spawnLocalAgent } from "../src/local-runtime.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      // Avoid keeping the event loop alive on Node versions that support it.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      (t as unknown as { unref?: () => void }).unref?.();
    })
  ]);
}

async function nextMessage(
  iter: AsyncIterator<unknown>,
  label: string
): Promise<AgentToClientMessage> {
  const res = await withTimeout(iter.next(), 2000, label);
  if (res.done) throw new Error(`Unexpected end of stream while waiting for ${label}`);
  return res.value as AgentToClientMessage;
}

async function waitForType<T extends AgentToClientMessage["type"]>(
  iter: AsyncIterator<unknown>,
  type: T
): Promise<Extract<AgentToClientMessage, { type: T }>> {
  while (true) {
    const msg = await nextMessage(iter, `message type ${type}`);
    if (msg.type === type) return msg as Extract<AgentToClientMessage, { type: T }>;
  }
}

describe("local runtime + mock-agent integration", () => {
  it("streams deterministically and preserves session history", async () => {
    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=4"]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();

      const ready = await waitForType(iter, "ready");
      expect(ready.version).toBe(1);

      await conn.transport.send({ type: "session/start", sessionId: "s1" });
      const started = await waitForType(iter, "session/started");
      expect(started.sessionId).toBe("s1");

      await conn.transport.send({ type: "session/send", sessionId: "s1", content: "hello" });

      const deltas: SessionStreamMessage[] = [];
      let complete: SessionCompleteMessage | undefined;
      while (!complete) {
        const msg = await nextMessage(iter, "stream/complete for turn #1");
        if (msg.type === "session/stream") deltas.push(msg);
        if (msg.type === "session/complete") complete = msg;
      }

      const combined = deltas
        .sort((a, b) => a.index - b.index)
        .map((d) => d.delta)
        .join("");
      expect(combined).toBe("MockAgent response #1: hello");
      expect(complete.history).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "MockAgent response #1: hello" }
      ]);

      await conn.transport.send({ type: "session/send", sessionId: "s1", content: "world" });
      const deltas2: SessionStreamMessage[] = [];
      let complete2: SessionCompleteMessage | undefined;
      while (!complete2) {
        const msg = await nextMessage(iter, "stream/complete for turn #2");
        if (msg.type === "session/stream") deltas2.push(msg);
        if (msg.type === "session/complete") complete2 = msg;
      }

      const combined2 = deltas2
        .sort((a, b) => a.index - b.index)
        .map((d) => d.delta)
        .join("");
      expect(combined2).toBe("MockAgent response #2: world");
      expect(complete2.history).toHaveLength(4);
      expect(complete2.history[0]?.content).toBe("hello");
      expect(complete2.history[2]?.content).toBe("world");
    } finally {
      await conn.close();
    }
  });

  it("can emit tool-call placeholder events", async () => {
    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=2", "--emitToolCalls"]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");

      await conn.transport.send({ type: "session/start", sessionId: "s-tool" });
      await waitForType(iter, "session/started");

      await conn.transport.send({
        type: "session/send",
        sessionId: "s-tool",
        content: "hi"
      });

      let sawToolCall = false;
      let sawComplete = false;

      while (!sawComplete) {
        const msg = await nextMessage(iter, "tool call and completion");
        if (msg.type === "tool/call") {
          const tool = msg as ToolCallPlaceholderMessage;
          sawToolCall = true;
          expect(tool.name).toBe("mock.tool");
          expect(tool.sessionId).toBe("s-tool");
        }
        if (msg.type === "session/complete") sawComplete = true;
      }

      expect(sawToolCall).toBe(true);
    } finally {
      await conn.close();
    }
  });
});


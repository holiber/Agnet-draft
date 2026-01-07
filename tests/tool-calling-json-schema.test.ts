import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import type {
  AgentToClientMessage,
  OpenAITool,
  SessionCompleteMessage,
  SessionStreamMessage,
  ToolCallMessage
} from "../src/protocol.js";
import { spawnLocalAgent } from "../src/local-runtime.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      // Avoid keeping the event loop alive on Node versions that support it.
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msg = await nextMessage(iter, `message type ${type}`);
    if (msg.type === type) return msg as Extract<AgentToClientMessage, { type: T }>;
  }
}

describe("OpenAI-style tool calling (JSON Schema)", () => {
  it("mock-agent can call a configured multiply tool and use the result", async () => {
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: {
          name: "multiply",
          description: "Multiply two numbers",
          parameters: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" }
            },
            required: ["a", "b"],
            additionalProperties: false
          }
        }
      }
    ];

    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=3", "--streaming=on", `--tools=${JSON.stringify(tools)}`]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();

      await waitForType(iter, "ready");

      await conn.transport.send({ type: "session/start", sessionId: "s-mul" });
      await waitForType(iter, "session/started");

      await conn.transport.send({
        type: "session/send",
        sessionId: "s-mul",
        content: "please multiply 6 and 7"
      });

      const call = (await waitForType(iter, "tool/call")) as ToolCallMessage;
      expect(call.sessionId).toBe("s-mul");
      expect(call.toolCall.type).toBe("function");
      expect(call.toolCall.function.name).toBe("multiply");

      const args = JSON.parse(call.toolCall.function.arguments) as { a: number; b: number };
      expect(args).toEqual({ a: 6, b: 7 });

      // Execute the tool (host-side) and send the result back.
      await conn.transport.send({
        type: "tool/result",
        sessionId: "s-mul",
        toolCallId: call.toolCall.id,
        content: String(args.a * args.b)
      });

      const deltas: SessionStreamMessage[] = [];
      let complete: SessionCompleteMessage | undefined;
      while (!complete) {
        const msg = await nextMessage(iter, "stream/complete for multiply turn");
        if (msg.type === "session/stream") deltas.push(msg);
        if (msg.type === "session/complete") complete = msg as SessionCompleteMessage;
      }

      const combined = deltas
        .sort((a, b) => a.index - b.index)
        .map((d) => d.delta)
        .join("");

      expect(combined).toContain("multiply(6, 7)");
      expect(combined).toContain("42");
      expect(complete.message.content).toContain("42");
    } finally {
      await conn.close();
    }
  });
});


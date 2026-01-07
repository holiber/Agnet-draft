import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import type {
  AgentToClientMessage,
  ChatEvent,
  ChatsCancelResultMessage,
  ChatsCreatedMessage,
  ChatsGetResultMessage,
  ChatsListResultMessage,
  TChat
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

async function nextMessage(iter: AsyncIterator<unknown>, label: string): Promise<AgentToClientMessage> {
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

function isChatEvent(msg: AgentToClientMessage): msg is ChatEvent {
  return (
    !!msg &&
    typeof msg === "object" &&
    typeof (msg as { type?: unknown }).type === "string" &&
    (msg as { type: string }).type.startsWith("chat.") ||
    (msg as { type: string }).type.startsWith("message.") ||
    (msg as { type: string }).type.startsWith("artifact.")
  );
}

describe("mock-agent Chats API (stdio framed)", () => {
  it("streams chat.started, multiple message.delta, then chat.completed", async () => {
    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=4", "--streaming=on"]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");

      await conn.transport.send({
        type: "chats/create",
        chatId: "c-stream",
        providerId: "mock-agent",
        title: "Stream chat",
        prompt: "hello"
      });
      const created = (await waitForType(iter, "chats/created")) as ChatsCreatedMessage;
      expect(created.chat.id).toBe("c-stream");
      expect(created.chat.location).toBe("local");
      expect(created.chat.persistence).toBe("ephemeral");
      expect(created.chat.canRead).toBe(true);
      expect(created.chat.canPost).toBe(true);
      expect(created.chat.channelType).toBe("chat");
      expect(created.chat.extra).toMatchObject({ hint: expect.stringMatching(/runs locally/i) });

      await conn.transport.send({ type: "chats/subscribe", chatId: "c-stream" });

      let sawStarted = false;
      const deltas: Array<Extract<ChatEvent, { type: "message.delta" }>> = [];
      let completed: Extract<ChatEvent, { type: "chat.completed" }> | undefined;

      while (!completed) {
        const msg = await nextMessage(iter, "chat stream completion");
        if (!isChatEvent(msg)) continue;
        if (msg.type === "chat.started") sawStarted = true;
        if (msg.type === "message.delta") deltas.push(msg);
        if (msg.type === "chat.completed") completed = msg;
      }

      expect(sawStarted).toBe(true);
      expect(deltas.length).toBeGreaterThan(1);
      const combined = deltas
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.delta)
        .join("");
      expect(combined).toBe("MockTask response #1: hello");
      expect(completed.chat.id).toBe("c-stream");
      expect(completed.chat._rawRest).toMatchObject({ status: "completed" });
    } finally {
      await conn.close();
    }
  });

  it("supports list/get with stable ordering and cursor+limit paging", async () => {
    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=3", "--streaming=on"]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");

      await conn.transport.send({ type: "chats/create", chatId: "c1", prompt: "one" });
      await waitForType(iter, "chats/created");
      await conn.transport.send({ type: "chats/create", chatId: "c2", prompt: "two" });
      await waitForType(iter, "chats/created");

      await conn.transport.send({ type: "chats/list", limit: "1" });
      const page1 = (await waitForType(iter, "chats/listResult")) as ChatsListResultMessage;
      expect(page1.chats.map((t) => t.id)).toEqual(["c1"]);
      expect(page1.nextCursor).toBeDefined();

      await conn.transport.send({ type: "chats/list", cursor: page1.nextCursor, limit: "10" });
      const page2 = (await waitForType(iter, "chats/listResult")) as ChatsListResultMessage;
      expect(page2.chats.map((t) => t.id)).toEqual(["c2"]);
      expect(page2.nextCursor).toBeUndefined();

      await conn.transport.send({ type: "chats/get", chatId: "c1" });
      const got1 = (await waitForType(iter, "chats/getResult")) as ChatsGetResultMessage;
      expect(got1.chat).toMatchObject({ id: "c1" } satisfies Partial<TChat>);
      expect(got1.chat._rawRest).toMatchObject({ status: "created" });

      await conn.transport.send({ type: "chats/get", chatId: "c2" });
      const got2 = (await waitForType(iter, "chats/getResult")) as ChatsGetResultMessage;
      expect(got2.chat).toMatchObject({ id: "c2" } satisfies Partial<TChat>);
      expect(got2.chat._rawRest).toMatchObject({ status: "created" });
    } finally {
      await conn.close();
    }
  });

  it("supports cancel, reflected in get, and subscribe emits chat.cancelled", async () => {
    const mockAgentPath = fileURLToPath(new URL("../bin/mock-agent.mjs", import.meta.url));
    const conn = spawnLocalAgent({
      command: process.execPath,
      args: [mockAgentPath, "--chunks=2", "--streaming=on"]
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");

      await conn.transport.send({ type: "chats/create", chatId: "c-cancel", prompt: "x" });
      await waitForType(iter, "chats/created");

      await conn.transport.send({ type: "chats/cancel", chatId: "c-cancel" });
      const cancelledRes = (await waitForType(iter, "chats/cancelResult")) as ChatsCancelResultMessage;
      expect(cancelledRes.ok).toBe(true);

      await conn.transport.send({ type: "chats/get", chatId: "c-cancel" });
      const got = (await waitForType(iter, "chats/getResult")) as ChatsGetResultMessage;
      expect(got.chat._rawRest).toMatchObject({ status: "cancelled" });

      await conn.transport.send({ type: "chats/subscribe", chatId: "c-cancel" });
      let cancelledEvent: Extract<ChatEvent, { type: "chat.cancelled" }> | undefined;
      while (!cancelledEvent) {
        const msg = await nextMessage(iter, "chat.cancelled event");
        if (!isChatEvent(msg)) continue;
        if (msg.type === "chat.cancelled") cancelledEvent = msg;
      }
      expect(cancelledEvent.chat._rawRest).toMatchObject({ status: "cancelled" });
    } finally {
      await conn.close();
    }
  });
});


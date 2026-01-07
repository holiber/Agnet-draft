import process from "node:process";

import { Api } from "../api/api.js";
import type { ChatMessage } from "../protocol.js";
import { spawnLocalAgent } from "../local-runtime.js";
import { nextMessage, randomId, sendAndWaitComplete, waitForType } from "../runtime/chat-client.js";
import { deleteChat, readChat, writeChat } from "../storage/chats.js";
import { ProvidersApi, type ProvidersApiContext } from "./providers-api.js";

export interface ChatsApiContext extends ProvidersApiContext {}

function toErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message;
  return String(err);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}

export class ChatsApi {
  private readonly providers: ProvidersApi;

  constructor(private readonly ctx: ChatsApiContext) {
    this.providers = new ProvidersApi(ctx);
  }

  @Api.endpoint("chats.create")
  async create(
    @Api.arg({ name: "providerId", type: "string", cli: { flag: "--provider" } })
    providerId?: string
  ): Promise<string> {
    const resolvedProviderId = await this.providers.resolveDefaultProviderId(providerId);
    const chatId = randomId("chat");
    await writeChat(this.ctx.cwd, chatId, { version: 1, chatId, providerId: resolvedProviderId, history: [] });
    return chatId;
  }

  @Api.endpoint("chats.send", { pattern: "serverStream" })
  async *send(
    @Api.arg({ name: "chatId", type: "string", required: true, cli: { flag: "--chat", aliases: ["--task", "--session"] } })
    chatId?: string,
    @Api.arg({ name: "prompt", type: "string", required: true, cli: { flag: "--prompt" } })
    prompt?: string
  ): AsyncIterable<string> {
    const resolvedChatId = requireNonEmptyString(chatId, "chatId");
    const content = requireNonEmptyString(prompt, "prompt");

    const chat = await readChat(this.ctx.cwd, resolvedChatId);
    const providerId = chat.providerId ?? "mock-agent";
    const runtime = await this.providers.resolveCliRuntime(providerId);

    const conn = spawnLocalAgent({
      command: runtime.command,
      args: Array.isArray(runtime.args) ? runtime.args : [],
      cwd: runtime.cwd,
      env: this.ctx.env ?? process.env
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");
      await conn.transport.send({ type: "session/start", sessionId: resolvedChatId });
      await waitForType(iter, "session/started");

      const history = Array.isArray(chat.history) ? (chat.history as ChatMessage[]) : ([] as ChatMessage[]);
      const priorUsers = history.filter(
        (m) => m && (m as ChatMessage).role === "user" && typeof (m as ChatMessage).content === "string"
      ) as ChatMessage[];

      for (const m of priorUsers) {
        await sendAndWaitComplete({ iter, transport: conn.transport, sessionId: resolvedChatId, content: m.content });
      }

      await conn.transport.send({ type: "session/send", sessionId: resolvedChatId, content });

      const deltasByIndex = new Map<number, string>();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msg = await nextMessage(iter, `stream/complete for chat "${resolvedChatId}"`);

        if (!msg || typeof msg !== "object") continue;
        const type = (msg as { type?: unknown }).type;
        if (type === "session/stream" && (msg as { sessionId?: unknown }).sessionId === resolvedChatId) {
          const stream = msg as { index?: unknown; delta?: unknown };
          const idx = typeof stream.index === "number" ? stream.index : deltasByIndex.size;
          const delta = typeof stream.delta === "string" ? stream.delta : "";
          deltasByIndex.set(idx, delta);
          yield delta;
          continue;
        }
        if (type === "session/complete" && (msg as { sessionId?: unknown }).sessionId === resolvedChatId) {
          const complete = msg as { history?: unknown };
          const completeHistory = Array.isArray(complete.history) ? (complete.history as ChatMessage[]) : history;
          await writeChat(this.ctx.cwd, resolvedChatId, {
            version: 1,
            chatId: resolvedChatId,
            providerId,
            history: completeHistory
          });
          break;
        }
      }

      const combined = [...deltasByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, d]) => d)
        .join("");
      if (!combined.endsWith("\n")) yield "\n";
    } catch (err) {
      throw new Error(toErrorMessage(err));
    } finally {
      await conn.close();
    }
  }

  @Api.endpoint("chats.close")
  async close(
    @Api.arg({ name: "chatId", type: "string", required: true, cli: { flag: "--chat", aliases: ["--task", "--session"] } })
    chatId?: string
  ): Promise<string> {
    const resolvedChatId = requireNonEmptyString(chatId, "chatId");
    await deleteChat(this.ctx.cwd, resolvedChatId);
    return "ok";
  }
}


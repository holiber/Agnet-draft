import { Api } from "../api/api.js";
import type { ChatMessage } from "../protocol.js";
import { readChat } from "../storage/chats.js";
import { ChatsApi, type ChatsApiContext } from "./chats-api.js";

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected non-empty string`);
  }
  return value;
}

function stripTrailingNewlineOnce(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * CLI-facing sugar APIs.
 *
 * Philosophy:
 * - `ask`: human-style, returns text
 * - `prompt`: computer-style, returns structured JSON
 */
export class ShortcutsApi {
  private readonly chats: ChatsApi;

  constructor(private readonly ctx: ChatsApiContext) {
    this.chats = new ChatsApi(ctx);
  }

  @Api.endpoint("ask")
  async ask(
    @Api.arg({ name: "prompt", type: "string", required: true, cli: { positionalIndex: 0 } })
    prompt: string,
    @Api.arg({ name: "providerId", type: "string", cli: { flag: "--provider" } })
    providerId?: string
  ): Promise<string> {
    const content = requireNonEmptyString(prompt, "prompt");
    const chatId = await this.chats.create(providerId);

    try {
      let out = "";
      for await (const delta of this.chats.send(chatId, content)) out += typeof delta === "string" ? delta : "";
      return out;
    } finally {
      // One-shot by default: don't clutter disk with short-lived chats.
      try {
        await this.chats.close(chatId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  @Api.endpoint("prompt")
  async prompt(
    @Api.arg({ name: "prompt", type: "string", required: true, cli: { positionalIndex: 0 } })
    prompt: string,
    @Api.arg({ name: "providerId", type: "string", cli: { flag: "--provider" } })
    providerId?: string
  ): Promise<{ text: string; chatId: string; providerId: string; history: ChatMessage[] }> {
    const content = requireNonEmptyString(prompt, "prompt");
    const chatId = await this.chats.create(providerId);

    try {
      let out = "";
      for await (const delta of this.chats.send(chatId, content)) out += typeof delta === "string" ? delta : "";
      const persisted = await readChat(this.ctx.cwd, chatId);
      return {
        text: stripTrailingNewlineOnce(out),
        chatId,
        providerId: persisted.providerId,
        history: Array.isArray(persisted.history) ? (persisted.history as ChatMessage[]) : []
      };
    } finally {
      try {
        await this.chats.close(chatId);
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}


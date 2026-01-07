import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import type { ChatMessage } from "./protocol.js";
import { spawnLocalAgent } from "./local-runtime.js";
import { randomId, sendAndWaitComplete, waitForType } from "./runtime/chat-client.js";
import { readChat, writeChat } from "./storage/chats.js";
import { readProvidersRegistrySync, writeProvidersRegistrySync } from "./storage/providers-registry.js";
import type {
  AgentConfig,
  AgentRegistrationInput,
  AgentRuntimeConfig,
  RegisteredProviderRef,
  RegisterOptions
} from "./providers.js";
import { registerProvider, validateAgentConfig } from "./providers.js";
import { parseAgentMdx } from "./agent-mdx.js";

// Re-export Tier1 provider config helpers/types.
export * from "./providers.js";

export type ProviderRef = RegisteredProviderRef;

export interface ProvidersRegistry {
  register: (input: AgentRegistrationInput, opts?: RegisterOptions) => ProviderRef;
  get: (selector: { type: string } | { id: string } | string) => ProviderRef | undefined;
  list: () => ProviderRef[];
}

export type TestConnectionParams = {
  providerIds?: string[];
};

export type TestConnectionResult = {
  ok: true;
  results: Array<{ providerId: string; ok: true } | { providerId: string; ok: false; error: string }>;
};

export interface Chat {
  readonly id: string;
  readonly providerId: string;
  readonly agentId: string;
  send: (prompt: string) => Promise<string>;
  saveToFile: (path: string) => Promise<void>;
}

/**
 * Unified request input for Agnet's primary entrypoints:
 * - agnet.ask(request)
 * - agnet.prompt(request)
 * - agnet.chats.create(request)
 */
export type TAgentRequest =
  | string
  | {
      providerId?: string;
      prompt: string;
    };

export type AgentResult = {
  text: string;
  chatId: string;
  providerId: string;
  agentId: string;
  history: ChatMessage[];
};

export interface ChatExecution {
  /**
   * Underlying chat session created for this request.
   *
   * Note: `Chat.send()` is multi-turn. `ChatExecution.response()/result()` refer to the initial request.
   */
  chat: Chat;

  /** Human-oriented output (text only). */
  response: () => Promise<string>;

  /** Structured output (metadata + history). */
  result: () => Promise<AgentResult>;
}

type PersistedChatV1 = {
  version: 1;
  providerId: string;
  agentId: string;
  chatId: string;
  history: ChatMessage[];
};

function requireCliRuntime(runtime: AgentRuntimeConfig): Extract<AgentRuntimeConfig, { transport: "cli" }> {
  if (runtime.transport !== "cli") {
    throw new Error(`Provider runtime does not support local CLI transport (got "${runtime.transport}")`);
  }
  return runtime;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function coerceAgentRequest(input: TAgentRequest): { providerId?: string; prompt: string } {
  if (typeof input === "string") {
    if (!isNonEmptyString(input)) throw new Error("Request prompt must be a non-empty string");
    return { prompt: input };
  }
  if (!input || typeof input !== "object") throw new Error("Invalid request: expected string or { prompt, providerId? }");
  const prompt = (input as { prompt?: unknown }).prompt;
  if (!isNonEmptyString(prompt)) throw new Error("Invalid request.prompt: expected non-empty string");
  const providerIdRaw = (input as { providerId?: unknown }).providerId;
  const providerId = providerIdRaw === undefined ? undefined : isNonEmptyString(providerIdRaw) ? providerIdRaw : undefined;
  return { prompt, providerId };
}

function stripTrailingNewlineOnce(text: string): string {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function isMarkedDefaultProvider(provider: ProviderRef): boolean {
  const ext = provider.card.extensions as unknown;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return false;
  const obj = ext as Record<string, unknown>;
  return obj.default === true || obj.isDefault === true;
}

async function runTaskSend(params: {
  cwd: string;
  provider: ProviderRef;
  chatId: string;
  prompt: string;
}): Promise<{ combined: string; history: ChatMessage[] }> {
  const runtime = params.provider.runtime;
  if (!runtime) throw new Error(`Provider "${params.provider.id}" has no runtime configured`);

  const cli = requireCliRuntime(runtime);

  const conn = spawnLocalAgent({
    command: cli.command,
    args: Array.isArray(cli.args) ? cli.args : [],
    cwd: cli.cwd,
    env: process.env
  });

  try {
    const iter = conn.transport[Symbol.asyncIterator]();
    await waitForType(iter, "ready");
    await conn.transport.send({ type: "session/start", sessionId: params.chatId });
    await waitForType(iter, "session/started");

    // Replay prior user prompts to rebuild state.
    const chat = await readChat(params.cwd, params.chatId);
    const history = Array.isArray(chat.history) ? (chat.history as ChatMessage[]) : ([] as ChatMessage[]);
    const priorUsers = history.filter(
      (m) => m && (m as ChatMessage).role === "user" && typeof (m as ChatMessage).content === "string"
    ) as ChatMessage[];
    for (const m of priorUsers) {
      await sendAndWaitComplete({ iter, transport: conn.transport, sessionId: params.chatId, content: m.content });
    }

    const { msg, combined } = await sendAndWaitComplete({
      iter,
      transport: conn.transport,
      sessionId: params.chatId,
      content: params.prompt
    });

    const completeHistory = Array.isArray(msg.history) ? (msg.history as ChatMessage[]) : history;
    return { combined, history: completeHistory };
  } finally {
    await conn.close();
  }
}

class TaskBackedChat implements Chat {
  constructor(
    private readonly opts: {
      cwd: string;
      provider: ProviderRef;
      chatId: string;
    }
  ) {}

  get id(): string {
    return this.opts.chatId;
  }

  get providerId(): string {
    return this.opts.provider.id;
  }

  get agentId(): string {
    return this.opts.provider.id;
  }

  async send(prompt: string): Promise<string> {
    if (!isNonEmptyString(prompt)) throw new Error("Chat.send(prompt) requires a non-empty string");

    const { combined, history } = await runTaskSend({
      cwd: this.opts.cwd,
      provider: this.opts.provider,
      chatId: this.opts.chatId,
      prompt
    });

    const existing = await readChat(this.opts.cwd, this.opts.chatId);
    await writeChat(this.opts.cwd, this.opts.chatId, {
      ...existing,
      history
    });

    // Match CLI behavior: ensure trailing newline.
    return combined.endsWith("\n") ? combined : combined + "\n";
  }

  async saveToFile(path: string): Promise<void> {
    const chat = await readChat(this.opts.cwd, this.opts.chatId);
    const payload: PersistedChatV1 = {
      version: 1,
      providerId: this.providerId,
      agentId: this.agentId,
      chatId: this.opts.chatId,
      history: Array.isArray(chat.history) ? chat.history : []
    };
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}

class TaskBackedChatExecution implements ChatExecution {
  readonly chat: Chat;
  private readonly provider: ProviderRef;
  private readonly chatId: string;
  private readonly cwd: string;
  private readonly responsePromise: Promise<string>;

  constructor(opts: { cwd: string; provider: ProviderRef; chatId: string; prompt: string }) {
    this.cwd = opts.cwd;
    this.provider = opts.provider;
    this.chatId = opts.chatId;
    this.chat = new TaskBackedChat({ cwd: opts.cwd, provider: opts.provider, chatId: opts.chatId });
    this.responsePromise = this.chat.send(opts.prompt);
  }

  async response(): Promise<string> {
    const text = await this.responsePromise;
    return stripTrailingNewlineOnce(text);
  }

  async result(): Promise<AgentResult> {
    const text = await this.response();
    const persisted = await readChat(this.cwd, this.chatId);
    const history = Array.isArray(persisted.history) ? (persisted.history as ChatMessage[]) : [];
    return {
      text,
      chatId: this.chatId,
      providerId: this.provider.id,
      agentId: this.provider.id,
      history
    };
  }
}

export class Agnet {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly providersById = new Map<string, ProviderRef>();

  constructor(opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
    this.cwd = opts?.cwd ?? process.cwd();
    this.env = opts?.env ?? process.env;

    // Load persisted providers eagerly (sync) to keep providers.get/list synchronous.
    const registry = readProvidersRegistrySync(this.cwd);
    for (const cfg of registry.providers) {
      try {
        const ref = registerProvider(cfg, { env: this.env });
        this.providersById.set(ref.id, ref);
      } catch {
        // Ignore invalid entries.
      }
    }
  }

  /**
   * Registry of configured providers.
   *
   * Providers are the SSOT-backed configuration layer for chat sources.
   */
  readonly providers: ProvidersRegistry = {
    register: (input, opts) => {
      const ref = registerProvider(input, { ...opts, env: opts?.env ?? this.env });
      // Keep deterministic ordering: last registration wins for default selection.
      if (this.providersById.has(ref.id)) this.providersById.delete(ref.id);
      this.providersById.set(ref.id, ref);

      // Persist only when a full AgentConfig is provided (or loadable from file/json).
      try {
        let cfg: AgentConfig;
        if (typeof input === "string") {
          const raw = readFileSync(input, "utf-8");
          const parsed = input.toLowerCase().endsWith(".agent.mdx") ? parseAgentMdx(raw, { path: input }) : JSON.parse(raw);
          cfg = validateAgentConfig(parsed);
        } else {
          cfg = validateAgentConfig(input as unknown);
        }
        const registry = readProvidersRegistrySync(this.cwd);
        const next = registry.providers.filter((p) => p?.agent?.id !== cfg.agent.id);
        next.push(cfg);
        writeProvidersRegistrySync(this.cwd, next);
      } catch {
        // No persistence for adapter-only registration.
      }

      return ref;
    },
    get: (selector) => {
      const id =
        typeof selector === "string"
          ? selector
          : isNonEmptyString((selector as { type?: unknown }).type)
            ? (selector as { type: string }).type
            : isNonEmptyString((selector as { id?: unknown }).id)
              ? (selector as { id: string }).id
              : "";
      return id ? this.providersById.get(id) : undefined;
    },
    list: () => [...this.providersById.values()]
  };

  /**
   * Human-style API sugar.
   *
   * Syntax sugar for: `await (await agnet.chats.create(request)).response()`
   */
  async ask(request: TAgentRequest): Promise<string> {
    const chat = await this.chats.create(request);
    return await chat.response();
  }

  /**
   * Computer-style API sugar.
   *
   * Syntax sugar for: `await (await agnet.chats.create(request)).result()`
   */
  async prompt(request: TAgentRequest): Promise<AgentResult> {
    const chat = await this.chats.create(request);
    return await chat.result();
  }

  readonly chats = {
    /**
     * Tier1: providers without remote chat listing should return [].
     * For now, this is intentionally minimal.
     */
    fetchList: async (): Promise<Chat[]> => {
      return [];
    },

    /**
     * Creates a multi-turn chat session (no prompt is sent).
     *
     * Note: This is separate from `chats.create(request)` which executes a request immediately.
     */
    open: async (opts?: { providerId?: string }): Promise<Chat> => {
      const provider = this.resolveDefaultProvider(opts?.providerId);
      const chatId = randomId("chat");
      await writeChat(this.cwd, chatId, { version: 1, chatId, providerId: provider.id, history: [] });
      return new TaskBackedChat({ cwd: this.cwd, provider, chatId });
    },

    /**
     * Core primitive: create a chat and execute a request through a provider.
     */
    create: async (request: TAgentRequest): Promise<ChatExecution> => {
      const { providerId, prompt } = coerceAgentRequest(request);
      const provider = this.resolveDefaultProvider(providerId);
      const chatId = randomId("chat");
      await writeChat(this.cwd, chatId, { version: 1, chatId, providerId: provider.id, history: [] });
      return new TaskBackedChatExecution({ cwd: this.cwd, provider, chatId, prompt });
    },

    loadFromFile: async (path: string): Promise<Chat> => {
      const raw = await readFile(path, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (err) {
        throw new Error(`Failed to parse chat JSON at "${path}": ${(err as Error).message}`);
      }
      if (!parsed || typeof parsed !== "object") throw new Error(`Invalid chat file at "${path}": expected object`);

      const obj = parsed as Partial<PersistedChatV1>;
      if (obj.version !== 1) throw new Error(`Invalid chat file at "${path}": unsupported version`);
      if (!isNonEmptyString(obj.providerId)) throw new Error(`Invalid chat file at "${path}": missing providerId`);
      if (!isNonEmptyString(obj.chatId)) throw new Error(`Invalid chat file at "${path}": missing chatId`);

      const provider = this.providers.get(obj.providerId);
      if (!provider) throw new Error(`Unknown provider "${obj.providerId}" while loading chat`);

      const history = Array.isArray(obj.history) ? (obj.history as ChatMessage[]) : [];
      await writeChat(this.cwd, obj.chatId, {
        version: 1,
        chatId: obj.chatId,
        providerId: provider.id,
        history
      });
      return new TaskBackedChat({ cwd: this.cwd, provider, chatId: obj.chatId });
    }
  };

  async testConnection(params: TestConnectionParams = {}): Promise<TestConnectionResult> {
    const selected = params.providerIds?.length ? params.providerIds : this.providers.list().map((p) => p.id);
    const results: TestConnectionResult["results"] = [];

    for (const providerId of selected) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        results.push({ providerId, ok: false, error: `Unknown provider: ${providerId}` });
        continue;
      }

      try {
        // "Cheap auth validation": ensure required auth can be resolved from env/opts.
        const kind = provider.card.auth?.kind ?? "none";
        const headers = provider.getAuthHeaders();
        if (kind === "bearer") {
          const auth = headers.Authorization ?? headers.authorization;
          if (!isNonEmptyString(auth) || !/^Bearer\s+\S+/.test(auth)) {
            throw new Error('Missing bearer token (expected "Authorization: Bearer <token>")');
          }
        } else if (kind === "apiKey") {
          const headerName = provider.card.auth?.header ?? "X-API-Key";
          const v = headers[headerName];
          if (!isNonEmptyString(v)) throw new Error(`Missing API key header: ${headerName}`);
        }
        results.push({ providerId, ok: true });
      } catch (err) {
        results.push({ providerId, ok: false, error: (err as Error).message });
      }
    }

    const failed = results.filter((r) => !r.ok) as Array<{ providerId: string; ok: false; error: string }>;
    if (failed.length > 0) {
      const detail = failed.map((f) => `${f.providerId}: ${f.error}`).join("; ");
      throw new Error(`testConnection failed: ${detail}`);
    }

    return { ok: true, results };
  }

  private resolveDefaultProvider(providerId?: string): ProviderRef {
    const explicit = providerId ? this.providers.get(providerId) : undefined;
    if (explicit) return explicit;

    const all = this.providers.list();
    if (all.length === 0) {
      throw new Error('No providers registered. Register one via "agnet.providers.register(...)" first.');
    }

    // Deterministic default:
    // 1) provider explicitly marked as default (if supported)
    // 2) otherwise — last registered provider
    const defaults = all.filter(isMarkedDefaultProvider);
    return defaults.length > 0 ? defaults[defaults.length - 1] : all[all.length - 1];
  }
}


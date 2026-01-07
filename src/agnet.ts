import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

import type { AgentRuntimeConfig, RegisteredAgentRef } from "./agent-interop.js";
import { AgentInterop } from "./agent-interop.js";
import type { ChatMessage } from "./protocol.js";
import { spawnLocalAgent } from "./local-runtime.js";
import { randomId, sendAndWaitComplete, waitForType } from "./runtime/task-client.js";
import { readTask, writeTask } from "./storage/tasks.js";

// Re-export Tier1 agent config helpers/types.
export * from "./agent-interop.js";

export interface ProviderRef extends RegisteredAgentRef {}

export interface ProvidersRegistry {
  register: AgentInterop["register"];
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

type PersistedChatV1 = {
  version: 1;
  providerId: string;
  agentId: string;
  taskId: string;
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

async function runTaskSend(params: {
  cwd: string;
  provider: ProviderRef;
  taskId: string;
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
    await conn.transport.send({ type: "session/start", sessionId: params.taskId });
    await waitForType(iter, "session/started");

    // Replay prior user prompts to rebuild state.
    const task = await readTask(params.cwd, params.taskId);
    const history = Array.isArray(task.history) ? (task.history as ChatMessage[]) : ([] as ChatMessage[]);
    const priorUsers = history.filter(
      (m) => m && (m as ChatMessage).role === "user" && typeof (m as ChatMessage).content === "string"
    ) as ChatMessage[];
    for (const m of priorUsers) {
      await sendAndWaitComplete({ iter, transport: conn.transport, sessionId: params.taskId, content: m.content });
    }

    const { msg, combined } = await sendAndWaitComplete({
      iter,
      transport: conn.transport,
      sessionId: params.taskId,
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
      taskId: string;
    }
  ) {}

  get id(): string {
    return this.opts.taskId;
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
      taskId: this.opts.taskId,
      prompt
    });

    const existing = await readTask(this.opts.cwd, this.opts.taskId);
    await writeTask(this.opts.cwd, this.opts.taskId, {
      ...existing,
      history
    });

    // Match CLI behavior: ensure trailing newline.
    return combined.endsWith("\n") ? combined : combined + "\n";
  }

  async saveToFile(path: string): Promise<void> {
    const task = await readTask(this.opts.cwd, this.opts.taskId);
    const payload: PersistedChatV1 = {
      version: 1,
      providerId: this.providerId,
      agentId: this.agentId,
      taskId: this.opts.taskId,
      history: Array.isArray(task.history) ? task.history : []
    };
    await writeFile(path, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  }
}

export class Agnet {
  private readonly interop = new AgentInterop();
  private readonly cwd: string;

  constructor(opts?: { cwd?: string }) {
    this.cwd = opts?.cwd ?? process.cwd();
  }

  /**
   * Registry of configured providers.
   *
   * Providers are the SSOT-backed configuration layer for chat sources.
   */
  readonly providers: ProvidersRegistry = {
    register: (input, opts) => this.interop.register(input, opts),
    get: (selector) => {
      const id =
        typeof selector === "string"
          ? selector
          : isNonEmptyString((selector as { type?: unknown }).type)
            ? (selector as { type: string }).type
            : isNonEmptyString((selector as { id?: unknown }).id)
              ? (selector as { id: string }).id
              : "";
      return id ? (this.interop.get(id) as ProviderRef | undefined) : undefined;
    },
    list: () => this.interop.list() as ProviderRef[]
  };

  /**
   * @deprecated Use `an.providers` (chat-first Tier1 API).
   */
  get agents(): ProvidersRegistry {
    return this.providers;
  }

  readonly chats = {
    /**
     * Tier1: providers without remote chat listing should return [].
     * For now, this is intentionally minimal.
     */
    fetchList: async (): Promise<Chat[]> => {
      return [];
    },

    create: async (opts?: { providerId?: string }): Promise<Chat> => {
      const provider = this.resolveDefaultProvider(opts?.providerId);
      const taskId = randomId("chat");
      await writeTask(this.cwd, taskId, { version: 1, taskId, agentId: provider.id, skill: "chat", history: [] });
      return new TaskBackedChat({ cwd: this.cwd, provider, taskId });
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
      if (!isNonEmptyString(obj.taskId)) throw new Error(`Invalid chat file at "${path}": missing taskId`);

      const provider = this.providers.get(obj.providerId);
      if (!provider) throw new Error(`Unknown provider "${obj.providerId}" while loading chat`);

      const history = Array.isArray(obj.history) ? (obj.history as ChatMessage[]) : [];
      await writeTask(this.cwd, obj.taskId, {
        version: 1,
        taskId: obj.taskId,
        agentId: provider.id,
        skill: "chat",
        history
      });
      return new TaskBackedChat({ cwd: this.cwd, provider, taskId: obj.taskId });
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
      throw new Error('No providers registered. Register one via "an.providers.register(...)" first.');
    }
    return all[0];
  }
}


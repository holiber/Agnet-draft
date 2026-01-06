import { readFile } from "node:fs/promises";
import process from "node:process";

import { Api } from "../api/api.js";
import type { AgentCard, AgentConfig, AgentRuntimeConfig } from "../agnet.js";
import { validateAgentConfig } from "../agnet.js";
import { parseAgentMdx } from "../agent-mdx.js";
import { spawnLocalAgent } from "../local-runtime.js";
import type { ChatMessage } from "../protocol.js";
import { nextMessage, randomId, sendAndWaitComplete, waitForType } from "../runtime/task-client.js";
import { readAgentsRegistry, writeAgentsRegistry } from "../storage/agents-registry.js";
import { deleteTask, readTask, writeTask } from "../storage/tasks.js";

export interface AgentsApiContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Used only for the built-in mock agent runtime.
   * Should be an absolute filesystem path to `bin/mock-agent.mjs`.
   */
  mockAgentPath: string;
}

function toErrorMessage(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseHeaderEnv(items: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items ?? []) {
    const eq = item.indexOf("=");
    if (eq === -1) throw new Error(`Invalid --header-env "${item}" (expected "Header=ENV_VAR")`);
    const header = item.slice(0, eq).trim();
    const envVar = item.slice(eq + 1).trim();
    if (!header || !envVar) throw new Error(`Invalid --header-env "${item}" (expected "Header=ENV_VAR")`);
    out[header] = envVar;
  }
  return out;
}

function requireCliRuntime(agentId: string, runtime: AgentRuntimeConfig): Extract<AgentRuntimeConfig, { transport: "cli" }> {
  if (runtime.transport !== "cli") {
    throw new Error(`Agent "${agentId}" does not support local CLI transport`);
  }
  return runtime;
}

export class AgentsApi {
  constructor(private readonly ctx: AgentsApiContext) {}

  private getBuiltInAgents(): AgentConfig[] {
    return [
      {
        agent: {
          id: "mock-agent",
          name: "Mock Agent",
          version: "0.0.0",
          description: "Deterministic, stdio-driven mock agent for tests",
          skills: [
            {
              id: "chat",
              description: "Chat-style interaction as a Task, streamed over stdio"
            }
          ]
        },
        runtime: {
          transport: "cli",
          command: process.execPath,
          args: [this.ctx.mockAgentPath]
        }
      }
    ];
  }

  private async resolveAgent(agentId: string): Promise<AgentConfig> {
    const builtInFound = this.getBuiltInAgents().find((a) => a.agent.id === agentId);
    if (builtInFound) return builtInFound;

    const registry = await readAgentsRegistry(this.ctx.cwd);
    const found = registry.agents.find((a) => a?.agent?.id === agentId);
    if (!found) throw new Error(`Unknown agent: ${agentId}`);
    return validateAgentConfig(found);
  }

  @Api.endpoint("agents.list")
  async list(
    @Api.arg({ name: "json", type: "boolean", cli: { flag: "--json" } })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    json?: boolean
  ): Promise<{ agents: Array<{ id: string; name: string; description?: string }> }> {
    const registry = await readAgentsRegistry(this.ctx.cwd);
    const agents = [...this.getBuiltInAgents(), ...registry.agents.map((a) => validateAgentConfig(a))]
      .map((a) => ({
        id: a.agent.id,
        name: a.agent.name,
        description: a.agent.description
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    return { agents };
  }

  @Api.endpoint("agents.describe")
  async describe(
    @Api.arg({ name: "agentId", type: "string", required: true, cli: { positionalIndex: 0 } })
    agentId: string,
    @Api.arg({ name: "json", type: "boolean", cli: { flag: "--json" } })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    json?: boolean
  ): Promise<{ agent: AgentCard }> {
    const registered = await this.resolveAgent(agentId);
    return { agent: registered.agent };
  }

  @Api.endpoint("agents.register")
  async register(
    @Api.arg({
      name: "files",
      type: "string[]",
      cli: { flag: "--files", repeatable: true }
    })
    files?: string[],

    @Api.arg({
      name: "file",
      type: "string",
      cli: { flag: "--file" }
    })
    file?: string,

    @Api.arg({ name: "json", type: "string", cli: { flag: "--json" } })
    inlineJson?: string,

    @Api.arg({ name: "bearerEnv", type: "string", cli: { flag: "--bearer-env" } })
    bearerEnv?: string,

    @Api.arg({ name: "apiKeyEnv", type: "string", cli: { flag: "--api-key-env" } })
    apiKeyEnv?: string,

    @Api.arg({ name: "headerEnv", type: "string[]", cli: { flag: "--header-env", repeatable: true } })
    headerEnv?: string[]
  ): Promise<{ ok: true; agentId: string } | { ok: true; agentIds: string[] }> {
    const fileList = [...(files ?? [])];
    if (fileList.length === 0 && file) fileList.push(file);

    const hasFiles = fileList.length > 0;
    if (!hasFiles && !inlineJson) throw new Error("Missing --files or --json");
    if (hasFiles && inlineJson) throw new Error("Use only one of --files/--file or --json");

    const configs: AgentConfig[] = [];
    if (inlineJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inlineJson) as unknown;
      } catch (err) {
        throw new Error(`Failed to parse JSON: ${toErrorMessage(err)}`);
      }
      try {
        configs.push(validateAgentConfig(parsed));
      } catch (err) {
        throw new Error(toErrorMessage(err));
      }
    } else {
      for (const p of fileList) {
        try {
          const raw = await readFile(p, "utf-8");
          const parsed = p.toLowerCase().endsWith(".agent.mdx")
            ? parseAgentMdx(raw, { path: p })
            : (JSON.parse(raw) as unknown);
          configs.push(validateAgentConfig(parsed));
        } catch (err) {
          throw new Error(`Failed to register "${p}": ${toErrorMessage(err)}`);
        }
      }
    }

    const headerEnvMap = parseHeaderEnv(headerEnv);
    for (const config of configs) {
      if (bearerEnv || apiKeyEnv || Object.keys(headerEnvMap).length > 0) {
        config.authRef = {
          ...(config.authRef ?? {}),
          ...(bearerEnv ? { bearerEnv } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          ...(Object.keys(headerEnvMap).length > 0
            ? { headerEnv: { ...(config.authRef?.headerEnv ?? {}), ...headerEnvMap } }
            : {})
        };
      }
    }

    const registry = await readAgentsRegistry(this.ctx.cwd);
    let next = registry.agents;
    const agentIds: string[] = [];
    for (const config of configs) {
      next = next.filter((a) => a?.agent?.id !== config.agent.id);
      next.push(config);
      agentIds.push(config.agent.id);
    }
    await writeAgentsRegistry(this.ctx.cwd, next);

    if (agentIds.length === 1) return { ok: true, agentId: agentIds[0] };
    return { ok: true, agentIds };
  }

  @Api.endpoint("agents.invoke", { pattern: "serverStream" })
  async *invoke(
    @Api.arg({ name: "agentId", type: "string", cli: { flag: "--agent" } })
    agentId?: string,

    @Api.arg({ name: "skill", type: "string", required: true, cli: { flag: "--skill" } })
    skill?: string,

    @Api.arg({ name: "prompt", type: "string", required: true, cli: { flag: "--prompt" } })
    prompt?: string
  ): AsyncIterable<string> {
    const resolvedAgentId = agentId ?? "mock-agent";
    if (!skill || !prompt) throw new Error("Missing --skill and/or --prompt");
    if (skill !== "chat") throw new Error(`Unknown skill: ${skill}`);

    const agent = await this.resolveAgent(resolvedAgentId);
    const runtime = requireCliRuntime(resolvedAgentId, agent.runtime);

    const sessionId = randomId("invoke");
    const conn = spawnLocalAgent({
      command: runtime.command,
      args: Array.isArray(runtime.args) ? runtime.args : [],
      cwd: runtime.cwd,
      env: this.ctx.env
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");
      await conn.transport.send({ type: "session/start", sessionId });
      await waitForType(iter, "session/started");

      await conn.transport.send({ type: "session/send", sessionId, content: prompt });

      const deltasByIndex = new Map<number, string>();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msg = await nextMessage(iter, `stream/complete for session "${sessionId}"`);
        if (!msg || typeof msg !== "object") continue;
        const type = (msg as { type?: unknown }).type;
        if (type === "session/stream" && (msg as { sessionId?: unknown }).sessionId === sessionId) {
          const stream = msg as { index?: unknown; delta?: unknown };
          const idx = typeof stream.index === "number" ? stream.index : deltasByIndex.size;
          const delta = typeof stream.delta === "string" ? stream.delta : "";
          deltasByIndex.set(idx, delta);
          yield delta;
          continue;
        }
        if (type === "session/complete" && (msg as { sessionId?: unknown }).sessionId === sessionId) {
          break;
        }
      }

      const combined = [...deltasByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, d]) => d)
        .join("");
      if (!combined.endsWith("\n")) yield "\n";
    } finally {
      await conn.close();
    }
  }

  @Api.endpoint("agents.task.open")
  async taskOpen(
    @Api.arg({ name: "agentId", type: "string", cli: { flag: "--agent" } })
    agentId?: string,
    @Api.arg({ name: "skill", type: "string", cli: { flag: "--skill" } })
    skill?: string
  ): Promise<string> {
    const resolvedAgentId = agentId ?? "mock-agent";
    const resolvedSkill = skill ?? "chat";
    if (resolvedSkill !== "chat") throw new Error(`Unknown skill: ${resolvedSkill}`);

    const taskId = randomId("task");
    await writeTask(this.ctx.cwd, taskId, {
      version: 1,
      taskId,
      agentId: resolvedAgentId,
      skill: resolvedSkill,
      history: []
    });
    return taskId;
  }

  @Api.endpoint("agents.task.send", { pattern: "serverStream" })
  async *taskSend(
    @Api.arg({
      name: "taskId",
      type: "string",
      required: true,
      cli: { flag: "--task", aliases: ["--session"] }
    })
    taskId?: string,
    @Api.arg({ name: "prompt", type: "string", required: true, cli: { flag: "--prompt" } })
    prompt?: string
  ): AsyncIterable<string> {
    if (!taskId || !prompt) throw new Error("Missing --task and/or --prompt");

    const task = await readTask(this.ctx.cwd, taskId);
    const agentId = task.agentId ?? "mock-agent";
    const skill = task.skill ?? "chat";
    if (skill !== "chat") throw new Error(`Unknown skill: ${skill}`);

    const agent = await this.resolveAgent(agentId);
    const runtime = requireCliRuntime(agentId, agent.runtime);

    const conn = spawnLocalAgent({
      command: runtime.command,
      args: Array.isArray(runtime.args) ? runtime.args : [],
      cwd: runtime.cwd,
      env: this.ctx.env
    });

    try {
      const iter = conn.transport[Symbol.asyncIterator]();
      await waitForType(iter, "ready");
      await conn.transport.send({ type: "session/start", sessionId: taskId });
      await waitForType(iter, "session/started");

      const history = Array.isArray(task.history) ? task.history : ([] as ChatMessage[]);
      const priorUsers = history.filter(
        (m) => m && (m as ChatMessage).role === "user" && typeof (m as ChatMessage).content === "string"
      ) as ChatMessage[];

      for (const m of priorUsers) {
        await sendAndWaitComplete({
          iter,
          transport: conn.transport,
          sessionId: taskId,
          content: m.content
        });
      }

      await conn.transport.send({ type: "session/send", sessionId: taskId, content: prompt });

      let completeHistory: ChatMessage[] | undefined;
      let nextIndex = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msg = await nextMessage(iter, `stream/complete for task "${taskId}"`);
        if (!msg || typeof msg !== "object") continue;

        const type = (msg as { type?: unknown }).type;
        if (type === "session/stream" && (msg as { sessionId?: unknown }).sessionId === taskId) {
          const stream = msg as { index?: unknown; delta?: unknown };
          void (typeof stream.index === "number" ? stream.index : nextIndex++);
          const delta = typeof stream.delta === "string" ? stream.delta : "";
          yield delta;
          continue;
        }
        if (type === "session/complete" && (msg as { sessionId?: unknown }).sessionId === taskId) {
          const complete = msg as { history?: unknown };
          completeHistory = Array.isArray(complete.history) ? (complete.history as ChatMessage[]) : undefined;
          break;
        }
      }

      yield "\n";

      await writeTask(this.ctx.cwd, taskId, {
        version: 1,
        taskId,
        agentId,
        skill,
        history: completeHistory ?? history
      });
    } finally {
      await conn.close();
    }
  }

  @Api.endpoint("agents.task.close")
  async taskClose(
    @Api.arg({
      name: "taskId",
      type: "string",
      required: true,
      cli: { flag: "--task", aliases: ["--session"] }
    })
    taskId?: string
  ): Promise<string> {
    if (!taskId) throw new Error("Missing --task");
    await deleteTask(this.ctx.cwd, taskId);
    return "ok";
  }

  // ---------------------------------------------------------------------------
  // Backwards-compatible "session" endpoints (hidden from docs/help).
  // ---------------------------------------------------------------------------

  @Api.endpoint("agents.session.open", { internal: true })
  async sessionOpen(
    @Api.arg({ name: "agentId", type: "string", cli: { flag: "--agent" } })
    agentId?: string,
    @Api.arg({ name: "skill", type: "string", cli: { flag: "--skill" } })
    skill?: string
  ): Promise<string> {
    return await this.taskOpen(agentId, skill);
  }

  @Api.endpoint("agents.session.send", { pattern: "serverStream", internal: true })
  async *sessionSend(
    @Api.arg({
      name: "sessionId",
      type: "string",
      required: true,
      cli: { flag: "--session", aliases: ["--task"] }
    })
    sessionId?: string,
    @Api.arg({ name: "prompt", type: "string", required: true, cli: { flag: "--prompt" } })
    prompt?: string
  ): AsyncIterable<string> {
    yield* this.taskSend(sessionId, prompt);
  }

  @Api.endpoint("agents.session.close", { internal: true })
  async sessionClose(
    @Api.arg({
      name: "sessionId",
      type: "string",
      required: true,
      cli: { flag: "--session", aliases: ["--task"] }
    })
    sessionId?: string
  ): Promise<string> {
    return await this.taskClose(sessionId);
  }
}


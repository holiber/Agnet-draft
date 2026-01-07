import { readFile } from "node:fs/promises";
import process from "node:process";

import { Api } from "../api/api.js";
import type { AgentCard, AgentConfig, AgentRuntimeConfig } from "../providers.js";
import { validateAgentConfig } from "../providers.js";
import { parseAgentMdx } from "../agent-mdx.js";
import { readProvidersRegistry, writeProvidersRegistry } from "../storage/providers-registry.js";

export interface ProvidersApiContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * Used only for the built-in mock provider runtime.
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

function requireCliRuntime(providerId: string, runtime: AgentRuntimeConfig): Extract<AgentRuntimeConfig, { transport: "cli" }> {
  if (runtime.transport !== "cli") {
    throw new Error(`Provider "${providerId}" does not support local CLI transport`);
  }
  return runtime;
}

function isMarkedDefaultAgent(agent: AgentCard): boolean {
  const ext = agent.extensions as unknown;
  if (!ext || typeof ext !== "object" || Array.isArray(ext)) return false;
  const obj = ext as Record<string, unknown>;
  return obj.default === true || obj.isDefault === true;
}

export class ProvidersApi {
  constructor(private readonly ctx: ProvidersApiContext) {}

  private getBuiltInProviders(): AgentConfig[] {
    return [
      {
        agent: {
          id: "mock-agent",
          name: "Mock Agent",
          version: "0.0.0",
          description: "Deterministic, stdio-driven mock provider for tests",
          skills: [{ id: "chat", description: "Chat-style interaction, streamed over stdio" }]
        },
        runtime: {
          transport: "cli",
          command: process.execPath,
          args: [this.ctx.mockAgentPath]
        }
      }
    ];
  }

  private async resolveProvider(providerId: string): Promise<AgentConfig> {
    const builtInFound = this.getBuiltInProviders().find((a) => a.agent.id === providerId);
    if (builtInFound) return builtInFound;

    const registry = await readProvidersRegistry(this.ctx.cwd);
    const found = registry.providers.find((a) => a?.agent?.id === providerId);
    if (!found) throw new Error(`Unknown provider: ${providerId}`);
    return validateAgentConfig(found);
  }

  /**
   * Deterministic default provider selection:
   * - if a provider is explicitly marked default (via `agent.extensions.default` or `agent.extensions.isDefault`) use it
   * - otherwise, use the last registered provider (by registry order)
   * - if none are registered, fall back to the last built-in provider (currently: mock-agent)
   */
  async resolveDefaultProviderId(explicitProviderId?: string): Promise<string> {
    if (typeof explicitProviderId === "string" && explicitProviderId.trim().length > 0) {
      const resolved = await this.resolveProvider(explicitProviderId);
      return resolved.agent.id;
    }

    const registry = await readProvidersRegistry(this.ctx.cwd);
    const persisted = registry.providers.map((a) => validateAgentConfig(a));
    const builtIns = this.getBuiltInProviders();

    const defaults = [...builtIns, ...persisted].filter((p) => isMarkedDefaultAgent(p.agent));
    if (defaults.length > 0) return defaults[defaults.length - 1].agent.id;

    if (persisted.length > 0) return persisted[persisted.length - 1].agent.id;
    if (builtIns.length > 0) return builtIns[builtIns.length - 1].agent.id;

    throw new Error("No providers available");
  }

  @Api.endpoint("providers.list")
  async list(
    @Api.arg({ name: "json", type: "boolean", cli: { flag: "--json" } })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    json?: boolean
  ): Promise<{ providers: Array<{ id: string; name: string; description?: string }> }> {
    const registry = await readProvidersRegistry(this.ctx.cwd);
    const providers = [...this.getBuiltInProviders(), ...registry.providers.map((a) => validateAgentConfig(a))]
      .map((a) => ({
        id: a.agent.id,
        name: a.agent.name,
        description: a.agent.description
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    return { providers };
  }

  @Api.endpoint("providers.describe")
  async describe(
    @Api.arg({ name: "providerId", type: "string", required: true, cli: { positionalIndex: 0 } })
    providerId: string,
    @Api.arg({ name: "json", type: "boolean", cli: { flag: "--json" } })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    json?: boolean
  ): Promise<{ provider: AgentCard }> {
    const registered = await this.resolveProvider(providerId);
    return { provider: registered.agent };
  }

  @Api.endpoint("providers.register")
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
  ): Promise<{ ok: true; providerId: string } | { ok: true; providerIds: string[] }> {
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

    const registry = await readProvidersRegistry(this.ctx.cwd);
    let next = registry.providers;
    const providerIds: string[] = [];
    for (const config of configs) {
      next = next.filter((a) => a?.agent?.id !== config.agent.id);
      next.push(config);
      providerIds.push(config.agent.id);
    }
    await writeProvidersRegistry(this.ctx.cwd, next);

    if (providerIds.length === 1) return { ok: true, providerId: providerIds[0] };
    return { ok: true, providerIds };
  }

  /**
   * Internal helper for the chats API.
   */
  async resolveCliRuntime(providerId: string): Promise<Extract<AgentRuntimeConfig, { transport: "cli" }>> {
    const p = await this.resolveProvider(providerId);
    return requireCliRuntime(providerId, p.runtime);
  }
}


import { readFileSync } from "node:fs";

import type { JsonObject } from "./protocol.js";
import { parseAgentMdx } from "./agent-mdx.js";

export type AuthKind = "none" | "bearer" | "apiKey";

export interface AgentMcpRequirement {
  tools: string[];
}

export interface AgentAuthRequirement {
  kind: AuthKind;
  /**
   * Header name to use when resolving auth material into HTTP headers.
   * Defaults:
   * - bearer: "Authorization"
   * - apiKey: "X-API-Key"
   */
  header?: string;
}

export interface AgentSkill {
  id: string;
  description?: string;
}

export interface AgentRule {
  id: string;
  text: string;
}

export interface AgentCard {
  id: string;
  name: string;
  version: string;
  description?: string;
  skills: AgentSkill[];
  rules?: AgentRule[];
  /**
   * Declares tool requirements only (no secrets).
   * Tier1: currently informational.
   */
  mcp?: AgentMcpRequirement;
  /**
   * Declares required auth *shape* only (no secrets).
   * Secrets are injected via RegisterOptions at registration time.
   */
  auth?: AgentAuthRequirement;
  /**
   * Escape hatch for Tier1 extensions (A2A-aligned).
   * `.agent.mdx` uses this for `systemPrompt` storage.
   */
  extensions?: JsonObject;
}

export type AgentRuntimeConfig =
  | {
      transport: "cli";
      command: string;
      args?: string[];
      cwd?: string;
    }
  | {
      transport: "http";
      baseUrl: string;
    }
  | {
      transport: "ipc";
      socketPath: string;
    };

/**
 * Non-secret references to where auth material can be loaded from.
 * These values are safe to persist to disk (they are env var names).
 */
export interface AuthFromEnvRef {
  bearerEnv?: string;
  apiKeyEnv?: string;
  headerEnv?: Record<string, string>;
}

export interface AgentConfig {
  agent: AgentCard;
  runtime: AgentRuntimeConfig;
  authRef?: AuthFromEnvRef;
}

export interface AuthMaterial {
  bearerToken?: string;
  apiKey?: string;
  /**
   * Escape hatch to pass fully resolved headers.
   * Values are treated as secrets and should not be persisted.
   */
  headers?: Record<string, string>;
}

export interface RegisterOptions {
  auth?: AuthMaterial;
  authFromEnv?: AuthFromEnvRef;
  env?: NodeJS.ProcessEnv;
}

export interface AgentAdapter {
  // Intentionally minimal for Tier1; implementations can extend this.
  readonly kind?: string;
}

export type AgentRegistrationInput =
  | { card: AgentCard; adapter: AgentAdapter }
  | AgentConfig
  | JsonObject
  | string;

export class AgentConfigError extends Error {
  override name = "AgentConfigError";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pathError(path: string, message: string): AgentConfigError {
  return new AgentConfigError(`Invalid AgentConfig at "${path}": ${message}`);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") throw pathError(path, "expected string");
  if (value.trim().length === 0) throw pathError(path, "expected non-empty string");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw pathError(path, "expected string");
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw pathError(path, "expected array");
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) throw pathError(path, "expected object");
  return value;
}

export function validateAgentCard(value: unknown, path = "agent"): AgentCard {
  const obj = requireRecord(value, path);
  const id = requireNonEmptyString(obj.id, `${path}.id`);
  const name = requireNonEmptyString(obj.name, `${path}.name`);
  const version = requireNonEmptyString(obj.version, `${path}.version`);
  const description = optionalString(obj.description, `${path}.description`);

  const skillsRaw = requireArray(obj.skills, `${path}.skills`);
  if (skillsRaw.length === 0) throw pathError(`${path}.skills`, "expected non-empty array");
  const skills: AgentSkill[] = skillsRaw.map((s, i) => {
    const skillObj = requireRecord(s, `${path}.skills[${i}]`);
    return {
      id: requireNonEmptyString(skillObj.id, `${path}.skills[${i}].id`),
      description: optionalString(skillObj.description, `${path}.skills[${i}].description`)
    };
  });

  let rules: AgentRule[] | undefined;
  if (obj.rules !== undefined) {
    const rulesRaw = requireArray(obj.rules, `${path}.rules`);
    rules = rulesRaw.map((r, i) => {
      const ruleObj = requireRecord(r, `${path}.rules[${i}]`);
      return {
        id: requireNonEmptyString(ruleObj.id, `${path}.rules[${i}].id`),
        text: requireNonEmptyString(ruleObj.text, `${path}.rules[${i}].text`)
      };
    });
  }

  let mcp: AgentMcpRequirement | undefined;
  if (obj.mcp !== undefined) {
    const mcpObj = requireRecord(obj.mcp, `${path}.mcp`);
    const toolsRaw = requireArray(mcpObj.tools, `${path}.mcp.tools`);
    mcp = {
      tools: toolsRaw.map((t, i) => requireNonEmptyString(t, `${path}.mcp.tools[${i}]`))
    };
  }

  let auth: AgentAuthRequirement | undefined;
  if (obj.auth !== undefined) {
    const authObj = requireRecord(obj.auth, `${path}.auth`);
    const kind = requireNonEmptyString(authObj.kind, `${path}.auth.kind`) as AuthKind;
    if (kind !== "none" && kind !== "bearer" && kind !== "apiKey") {
      throw pathError(`${path}.auth.kind`, `expected "none" | "bearer" | "apiKey"`);
    }
    auth = {
      kind,
      header: optionalString(authObj.header, `${path}.auth.header`)
    };
  }

  let extensions: JsonObject | undefined;
  if (obj.extensions !== undefined) {
    if (!isObject(obj.extensions)) throw pathError(`${path}.extensions`, "expected object");
    extensions = obj.extensions as JsonObject;
  }

  return { id, name, version, description, skills, rules, mcp, auth, extensions };
}

export function validateAgentRuntimeConfig(
  value: unknown,
  path = "runtime"
): AgentRuntimeConfig {
  const obj = requireRecord(value, path);
  const transport = requireNonEmptyString(obj.transport, `${path}.transport`);

  if (transport === "cli") {
    const command = requireNonEmptyString(obj.command, `${path}.command`);
    const argsRaw = obj.args;
    let args: string[] | undefined;
    if (argsRaw !== undefined) {
      const arr = requireArray(argsRaw, `${path}.args`);
      args = arr.map((a, i) => requireNonEmptyString(a, `${path}.args[${i}]`));
    }
    const cwd = optionalString(obj.cwd, `${path}.cwd`);
    return { transport: "cli", command, args, cwd };
  }

  if (transport === "http") {
    const baseUrl = requireNonEmptyString(obj.baseUrl, `${path}.baseUrl`);
    return { transport: "http", baseUrl };
  }

  if (transport === "ipc") {
    const socketPath = requireNonEmptyString(obj.socketPath, `${path}.socketPath`);
    return { transport: "ipc", socketPath };
  }

  throw pathError(`${path}.transport`, `unknown transport "${transport}"`);
}

export function validateAuthFromEnvRef(
  value: unknown,
  path = "authRef"
): AuthFromEnvRef {
  const obj = requireRecord(value, path);
  const bearerEnv = optionalString(obj.bearerEnv, `${path}.bearerEnv`);
  const apiKeyEnv = optionalString(obj.apiKeyEnv, `${path}.apiKeyEnv`);
  let headerEnv: Record<string, string> | undefined;
  if (obj.headerEnv !== undefined) {
    const rec = requireRecord(obj.headerEnv, `${path}.headerEnv`);
    headerEnv = {};
    for (const [k, v] of Object.entries(rec)) {
      headerEnv[k] = requireNonEmptyString(v, `${path}.headerEnv.${k}`);
    }
  }
  return { bearerEnv, apiKeyEnv, headerEnv };
}

export function validateAgentConfig(value: unknown, path = "$"): AgentConfig {
  const obj = requireRecord(value, path);
  const agent = validateAgentCard(obj.agent, "agent");
  const runtime = validateAgentRuntimeConfig(obj.runtime, "runtime");
  const authRef =
    obj.authRef !== undefined ? validateAuthFromEnvRef(obj.authRef, "authRef") : undefined;
  return { agent, runtime, authRef };
}

function mergeAuthFromEnvRefs(a?: AuthFromEnvRef, b?: AuthFromEnvRef): AuthFromEnvRef {
  return {
    bearerEnv: b?.bearerEnv ?? a?.bearerEnv,
    apiKeyEnv: b?.apiKeyEnv ?? a?.apiKeyEnv,
    headerEnv: { ...(a?.headerEnv ?? {}), ...(b?.headerEnv ?? {}) }
  };
}

function defaultHeaderFor(kind: AuthKind): string {
  if (kind === "bearer") return "Authorization";
  if (kind === "apiKey") return "X-API-Key";
  return "Authorization";
}

export function resolveAuthHeaders(params: {
  card: AgentCard;
  auth?: AuthMaterial;
  authFromEnv?: AuthFromEnvRef;
  env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const out: Record<string, string> = {};

  const env = params.env ?? process.env;
  const requirement = params.card.auth;
  const kind = requirement?.kind ?? "none";
  const headerName = requirement?.header ?? defaultHeaderFor(kind);

  // 1) Load from env refs (non-secret references).
  const ref = params.authFromEnv;
  if (ref?.headerEnv) {
    for (const [header, envName] of Object.entries(ref.headerEnv)) {
      const v = env[envName];
      if (typeof v === "string" && v.length > 0) out[header] = v;
    }
  }
  if (kind === "bearer" && ref?.bearerEnv) {
    const token = env[ref.bearerEnv];
    if (typeof token === "string" && token.length > 0) out[headerName] = `Bearer ${token}`;
  }
  if (kind === "apiKey" && ref?.apiKeyEnv) {
    const key = env[ref.apiKeyEnv];
    if (typeof key === "string" && key.length > 0) out[headerName] = key;
  }

  // 2) Overlay explicit auth material (secrets).
  if (params.auth?.headers) {
    for (const [k, v] of Object.entries(params.auth.headers)) out[k] = v;
  }
  if (kind === "bearer" && typeof params.auth?.bearerToken === "string") {
    out[headerName] = `Bearer ${params.auth.bearerToken}`;
  }
  if (kind === "apiKey" && typeof params.auth?.apiKey === "string") {
    out[headerName] = params.auth.apiKey;
  }

  return out;
}

export interface RegisteredAgentRef {
  id: string;
  card: AgentCard;
  runtime?: AgentRuntimeConfig;
  adapter?: AgentAdapter;
  getAuthHeaders: () => Record<string, string>;
}

export class AgentInterop {
  private readonly byId = new Map<string, RegisteredAgentRef>();

  register(input: AgentRegistrationInput, opts: RegisterOptions = {}): RegisteredAgentRef {
    if (typeof input === "string") {
      const raw = readFileSync(input, "utf-8");
      if (input.toLowerCase().endsWith(".agent.mdx")) {
        const config = parseAgentMdx(raw, { path: input });
        return this.register(config, opts);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (err) {
        throw new AgentConfigError(
          `Failed to parse JSON config at "${input}": ${(err as Error).message}`
        );
      }
      return this.register(parsed as JsonObject, opts);
    }

    if (isObject(input) && "adapter" in input && "card" in input) {
      const card = validateAgentCard((input as { card: unknown }).card, "card");
      const adapter = (input as { adapter: AgentAdapter }).adapter;
      const ref: RegisteredAgentRef = {
        id: card.id,
        card,
        adapter,
        getAuthHeaders: () =>
          resolveAuthHeaders({ card, auth: opts.auth, authFromEnv: opts.authFromEnv, env: opts.env })
      };
      this.byId.set(card.id, ref);
      return ref;
    }

    const config = validateAgentConfig(input as unknown, "$");
    const mergedRef = mergeAuthFromEnvRefs(config.authRef, opts.authFromEnv);
    const ref: RegisteredAgentRef = {
      id: config.agent.id,
      card: config.agent,
      runtime: config.runtime,
      getAuthHeaders: () =>
        resolveAuthHeaders({
          card: config.agent,
          auth: opts.auth,
          authFromEnv: mergedRef,
          env: opts.env
        })
    };
    this.byId.set(ref.id, ref);
    return ref;
  }

  get(agentId: string): RegisteredAgentRef | undefined {
    return this.byId.get(agentId);
  }

  list(): RegisteredAgentRef[] {
    return [...this.byId.values()];
  }

  listAgents(): AgentCard[] {
    return this.list().map((r) => r.card);
  }
}


#!/usr/bin/env node
/**
 * agentinterop
 *
 * Thin CLI wrapper for interacting with local AgentInterop agents over stdio.
 *
 * Notes:
 * - This file is intentionally plain ESM JavaScript so it can run in CI before `tsup` builds `dist/`.
 * - Transport framing: [uint32be byteLength][utf8 JSON bytes]
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { TextDecoder, TextEncoder } from "node:util";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage() {
  return `
AgentInterop CLI

Usage:
  agentinterop agents list [--json]
  agentinterop agents describe <agentId> [--json]
  agentinterop agents register --file <path>
  agentinterop agents register --json <inlineJson>
    [--bearer-env <ENV_VAR>]
    [--api-key-env <ENV_VAR>]
    [--header-env "<Header-Name>=<ENV_VAR>"] (repeatable)
  agentinterop agents invoke --skill <skill> --prompt <text> [--agent <agentId>]
  agentinterop agents session open [--agent <agentId>] [--skill <skill>]
  agentinterop agents session send --session <sessionId> --prompt <text>
  agentinterop agents session close --session <sessionId>

Notes:
  - The built-in demo agent is "mock-agent".
  - Registered agents are persisted to ./.cache/agentinterop/agents.json (safe: no secrets).
  - Skills are currently informational; the mock agent supports a single chat-like interaction.
`.trim();
}

function parseArgs(argv) {
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};

  const setFlag = (k, v) => {
    const existing = flags[k];
    if (existing === undefined) {
      flags[k] = v;
      return;
    }
    // Support repeatable flags by collecting values.
    if (Array.isArray(existing)) {
      existing.push(v);
      return;
    }
    flags[k] = [existing, v];
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      // Ignore passthrough for now (reserved).
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        setFlag(k, v);
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          setFlag(k, next);
          i++;
        } else {
          setFlag(k, true);
        }
      }
      continue;
    }
    positional.push(a);
  }

  return { positional, flags };
}

function boolFlag(flags, name) {
  const v = flags[name];
  return v === true || v === "true" || v === "1";
}

function strFlag(flags, name) {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function randomId(prefix) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

function encodeFrame(message) {
  const json = JSON.stringify(message);
  const body = textEncoder.encode(json);

  const header = new Uint8Array(4);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  view.setUint32(0, body.byteLength, false);

  const frame = new Uint8Array(4 + body.byteLength);
  frame.set(header, 0);
  frame.set(body, 4);
  return frame;
}

class FrameDecoder {
  /** @type {Uint8Array} */
  buffer = new Uint8Array(0);
  offset = 0;

  /**
   * @param {Uint8Array} chunk
   * @returns {unknown[]}
   */
  push(chunk) {
    if (!chunk || chunk.byteLength === 0) return [];

    if (this.offset > 0) {
      this.buffer = this.buffer.slice(this.offset);
      this.offset = 0;
    }

    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;

    /** @type {unknown[]} */
    const out = [];
    while (true) {
      const remaining = this.buffer.byteLength - this.offset;
      if (remaining < 4) break;

      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + this.offset,
        4
      );
      const length = view.getUint32(0, false);
      if (length > 100 * 1024 * 1024) throw new Error(`Frame too large: ${length} bytes`);
      if (remaining < 4 + length) break;

      const start = this.offset + 4;
      const end = start + length;
      const payload = this.buffer.slice(start, end);
      this.offset = end;

      const json = textDecoder.decode(payload);
      out.push(JSON.parse(json));
    }

    if (this.offset === this.buffer.byteLength) {
      this.buffer = new Uint8Array(0);
      this.offset = 0;
    }

    return out;
  }
}

class StdioJsonTransport {
  decoder = new FrameDecoder();
  /** @type {unknown[]} */
  queue = [];
  /** @type {Array<(value: IteratorResult<unknown>) => void>} */
  waiters = [];
  ended = false;

  /**
   * @param {import("node:stream").Readable} readable
   * @param {import("node:stream").Writable} writable
   */
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;

    this.onDataBound = (chunk) => this.onData(chunk);
    this.onEndBound = () => this.onEnd();
    this.onErrorBound = () => this.onError();

    this.readable.on("data", this.onDataBound);
    this.readable.on("end", this.onEndBound);
    this.readable.on("error", this.onErrorBound);
  }

  /**
   * @param {unknown} message
   */
  async send(message) {
    if (this.ended) throw new Error("Transport is closed");

    const frame = encodeFrame(message);
    const ok = this.writable.write(frame);
    if (!ok) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          this.writable.off("drain", onDrain);
          this.writable.off("error", onError);
        };
        this.writable.on("drain", onDrain);
        this.writable.on("error", onError);
      });
    }
  }

  close() {
    if (this.ended) return;
    this.ended = true;

    this.readable.off("data", this.onDataBound);
    this.readable.off("end", this.onEndBound);
    this.readable.off("error", this.onErrorBound);

    while (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve?.({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator]() {
    return { next: () => this.next() };
  }

  next() {
    if (this.queue.length > 0) {
      const value = this.queue.shift();
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  onData(chunk) {
    try {
      const messages = this.decoder.push(
        new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      );
      for (const msg of messages) this.enqueue(msg);
    } catch {
      this.onError();
    }
  }

  onEnd() {
    this.close();
  }

  onError() {
    // Fail closed.
    this.close();
  }

  enqueue(message) {
    const waiter = this.waiters.shift();
    if (waiter) return waiter({ done: false, value: message });
    this.queue.push(message);
  }
}

function spawnLocalAgent({ command, args, cwd, env }) {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env
  });

  const transport = new StdioJsonTransport(child.stdout, child.stdin);

  const close = async () => {
    transport.close();
    if (!child.killed) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
  };

  return { child, transport, close };
}

async function nextMessage(iter, label) {
  const t = setTimeout(() => fail(`Timeout waiting for ${label}`, 2), 2000);
  // Avoid keeping the event loop alive on Node versions that support it.
  t.unref?.();
  const res = await iter.next();
  clearTimeout(t);
  if (res.done) fail(`Unexpected end of stream while waiting for ${label}`, 2);
  return res.value;
}

async function waitForType(iter, type) {
  while (true) {
    const msg = await nextMessage(iter, `message type "${type}"`);
    if (msg && typeof msg === "object" && msg.type === type) return msg;
  }
}

async function sendAndWaitComplete(iter, transport, sessionId, content, { onDelta } = {}) {
  await transport.send({ type: "session/send", sessionId, content });

  /** @type {Map<number, string>} */
  const deltasByIndex = new Map();
  while (true) {
    const msg = await nextMessage(iter, `stream/complete for session "${sessionId}"`);
    if (!msg || typeof msg !== "object") continue;
    if (msg.type === "session/stream" && msg.sessionId === sessionId) {
      const idx = typeof msg.index === "number" ? msg.index : deltasByIndex.size;
      const delta = typeof msg.delta === "string" ? msg.delta : "";
      deltasByIndex.set(idx, delta);
      onDelta?.(delta);
      continue;
    }
    if (msg.type === "session/complete" && msg.sessionId === sessionId) {
      const ordered = [...deltasByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, d]) => d)
        .join("");
      return { msg, combined: ordered };
    }
  }
}

function getBuiltInAgents() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const mockAgentPath = path.join(here, "mock-agent.mjs");
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
            description: "Chat-style interaction over session/start + session/send"
          }
        ]
      },
      runtime: {
        transport: "cli",
        command: process.execPath,
        args: [mockAgentPath]
      }
    }
  ];
}

function agentsRegistryPath() {
  return path.join(process.cwd(), ".cache", "agentinterop", "agents.json");
}

async function readAgentsRegistry() {
  try {
    const raw = await readFile(agentsRegistryPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const agents = Array.isArray(parsed?.agents) ? parsed.agents : [];
    return { version: 1, agents };
  } catch {
    return { version: 1, agents: [] };
  }
}

async function writeAgentsRegistry(agents) {
  await mkdir(path.dirname(agentsRegistryPath()), { recursive: true });
  await writeFile(
    agentsRegistryPath(),
    JSON.stringify({ version: 1, agents }, null, 2) + "\n",
    "utf-8"
  );
}

function requireRecord(value, p) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid AgentConfig at "${p}": expected object`);
  }
  return value;
}

function requireNonEmptyString(value, p) {
  if (typeof value !== "string") throw new Error(`Invalid AgentConfig at "${p}": expected string`);
  if (value.trim().length === 0) {
    throw new Error(`Invalid AgentConfig at "${p}": expected non-empty string`);
  }
  return value;
}

function requireArray(value, p) {
  if (!Array.isArray(value)) throw new Error(`Invalid AgentConfig at "${p}": expected array`);
  return value;
}

function validateAgentConfig(value) {
  const obj = requireRecord(value, "$");
  const agent = requireRecord(obj.agent, "agent");
  requireNonEmptyString(agent.id, "agent.id");
  requireNonEmptyString(agent.name, "agent.name");
  requireNonEmptyString(agent.version, "agent.version");
  const skills = requireArray(agent.skills, "agent.skills");
  if (skills.length === 0) throw new Error(`Invalid AgentConfig at "agent.skills": expected non-empty array`);
  for (let i = 0; i < skills.length; i++) {
    const s = requireRecord(skills[i], `agent.skills[${i}]`);
    requireNonEmptyString(s.id, `agent.skills[${i}].id`);
  }

  const runtime = requireRecord(obj.runtime, "runtime");
  const transport = requireNonEmptyString(runtime.transport, "runtime.transport");
  if (transport === "cli") {
    requireNonEmptyString(runtime.command, "runtime.command");
    if (runtime.args !== undefined) {
      const args = requireArray(runtime.args, "runtime.args");
      for (let i = 0; i < args.length; i++) {
        requireNonEmptyString(args[i], `runtime.args[${i}]`);
      }
    }
  } else if (transport === "http") {
    requireNonEmptyString(runtime.baseUrl, "runtime.baseUrl");
  } else if (transport === "ipc") {
    requireNonEmptyString(runtime.socketPath, "runtime.socketPath");
  } else {
    throw new Error(`Invalid AgentConfig at "runtime.transport": unknown transport "${transport}"`);
  }

  if (obj.authRef !== undefined) {
    const ref = requireRecord(obj.authRef, "authRef");
    if (ref.bearerEnv !== undefined) requireNonEmptyString(ref.bearerEnv, "authRef.bearerEnv");
    if (ref.apiKeyEnv !== undefined) requireNonEmptyString(ref.apiKeyEnv, "authRef.apiKeyEnv");
    if (ref.headerEnv !== undefined) {
      const hdr = requireRecord(ref.headerEnv, "authRef.headerEnv");
      for (const [k, v] of Object.entries(hdr)) {
        requireNonEmptyString(v, `authRef.headerEnv.${k}`);
      }
    }
  }

  return obj;
}

async function resolveAgent(agentId) {
  const builtins = getBuiltInAgents();
  const builtInFound = builtins.find((a) => a.agent.id === agentId);
  if (builtInFound) return builtInFound;

  const registry = await readAgentsRegistry();
  const found = registry.agents.find((a) => a?.agent?.id === agentId);
  if (!found) fail(`Unknown agent: ${agentId}`);
  return validateAgentConfig(found);
}

function sessionsDir() {
  return path.join(process.cwd(), ".cache", "agentinterop", "sessions");
}

function sessionPath(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

async function readSession(sessionId) {
  try {
    const raw = await readFile(sessionPath(sessionId), "utf-8");
    return JSON.parse(raw);
  } catch {
    fail(`Session not found: ${sessionId}`);
  }
}

async function writeSession(sessionId, data) {
  await mkdir(sessionsDir(), { recursive: true });
  await writeFile(sessionPath(sessionId), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function cmdAgentsList(flags) {
  const registry = await readAgentsRegistry();
  const agents = [...getBuiltInAgents(), ...registry.agents.map((a) => validateAgentConfig(a))]
    .map((a) => ({
      id: a.agent.id,
      name: a.agent.name,
      description: a.agent.description
    }))
    // Stable ordering for tests and scripts.
    .sort((x, y) => x.id.localeCompare(y.id));
  // Default output is JSON for stable scripting and tests.
  if (!boolFlag(flags, "json") && flags.json !== undefined) {
    // `--json=false` is accepted but still prints JSON (reserved for future formats).
  }
  process.stdout.write(JSON.stringify({ agents }, null, 2) + "\n");
}

async function cmdAgentsDescribe(positional, flags) {
  const agentId = positional[2];
  if (!agentId) fail(`Missing <agentId>\n\n${usage()}`);

  const registered = await resolveAgent(agentId);
  const description = registered.agent;
  // Default output is JSON for stable scripting and tests.
  if (!boolFlag(flags, "json") && flags.json !== undefined) {
    // `--json=false` is accepted but still prints JSON (reserved for future formats).
  }
  process.stdout.write(JSON.stringify({ agent: description }, null, 2) + "\n");
}

function parseHeaderEnv(flags) {
  const v = flags["header-env"];
  const items = Array.isArray(v) ? v : v ? [v] : [];
  /** @type {Record<string, string>} */
  const out = {};
  for (const item of items) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq === -1) fail(`Invalid --header-env "${item}" (expected "Header=ENV_VAR")`);
    const header = item.slice(0, eq).trim();
    const envVar = item.slice(eq + 1).trim();
    if (!header || !envVar) fail(`Invalid --header-env "${item}" (expected "Header=ENV_VAR")`);
    out[header] = envVar;
  }
  return out;
}

async function cmdAgentsRegister(flags) {
  const file = strFlag(flags, "file");
  const json = strFlag(flags, "json");
  if (!file && !json) fail(`Missing --file or --json\n\n${usage()}`);
  if (file && json) fail(`Use only one of --file or --json\n\n${usage()}`);

  let parsed;
  try {
    const raw = file ? await readFile(file, "utf-8") : json;
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`Failed to parse JSON: ${err?.message ?? String(err)}`);
  }

  let config;
  try {
    config = validateAgentConfig(parsed);
  } catch (err) {
    fail(err?.message ?? String(err));
  }

  // Persist non-secret auth references (env var names) if provided.
  const bearerEnv = strFlag(flags, "bearer-env");
  const apiKeyEnv = strFlag(flags, "api-key-env");
  const headerEnv = parseHeaderEnv(flags);
  if (bearerEnv || apiKeyEnv || Object.keys(headerEnv).length > 0) {
    config.authRef = {
      ...(config.authRef ?? {}),
      ...(bearerEnv ? { bearerEnv } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(Object.keys(headerEnv).length > 0 ? { headerEnv: { ...(config.authRef?.headerEnv ?? {}), ...headerEnv } } : {})
    };
  }

  const registry = await readAgentsRegistry();
  const next = registry.agents.filter((a) => a?.agent?.id !== config.agent.id);
  next.push(config);
  await writeAgentsRegistry(next);

  process.stdout.write(JSON.stringify({ ok: true, agentId: config.agent.id }, null, 2) + "\n");
}

async function runOneShotChat({ agentId, prompt }) {
  const agent = await resolveAgent(agentId);
  if (agent.runtime.transport !== "cli") {
    fail(`Agent "${agentId}" does not support local CLI transport`);
  }
  const sessionId = randomId("invoke");
  const conn = spawnLocalAgent({
    command: agent.runtime.command,
    args: Array.isArray(agent.runtime.args) ? agent.runtime.args : []
  });
  try {
    const iter = conn.transport[Symbol.asyncIterator]();
    await waitForType(iter, "ready");
    await conn.transport.send({ type: "session/start", sessionId });
    await waitForType(iter, "session/started");

    const { combined } = await sendAndWaitComplete(iter, conn.transport, sessionId, prompt, {
      onDelta: (d) => process.stdout.write(d)
    });

    if (!combined.endsWith("\n")) process.stdout.write("\n");
  } finally {
    await conn.close();
  }
}

async function cmdAgentsInvoke(flags) {
  const agentId = strFlag(flags, "agent") ?? "mock-agent";
  const skill = strFlag(flags, "skill");
  const prompt = strFlag(flags, "prompt");

  if (!skill || !prompt) fail(`Missing --skill and/or --prompt\n\n${usage()}`);
  if (skill !== "chat") fail(`Unknown skill: ${skill}`);

  await runOneShotChat({ agentId, prompt });
}

async function cmdSessionOpen(flags) {
  const agentId = strFlag(flags, "agent") ?? "mock-agent";
  const skill = strFlag(flags, "skill") ?? "chat";
  if (skill !== "chat") fail(`Unknown skill: ${skill}`);

  const sessionId = randomId("session");
  await writeSession(sessionId, {
    version: 1,
    sessionId,
    agentId,
    skill,
    history: []
  });
  process.stdout.write(`${sessionId}\n`);
}

async function cmdSessionSend(flags) {
  const sessionId = strFlag(flags, "session");
  const prompt = strFlag(flags, "prompt");
  if (!sessionId || !prompt) fail(`Missing --session and/or --prompt\n\n${usage()}`);

  const sess = await readSession(sessionId);
  const agentId = sess.agentId ?? "mock-agent";
  const skill = sess.skill ?? "chat";
  if (skill !== "chat") fail(`Unknown skill: ${skill}`);

  const agent = await resolveAgent(agentId);
  if (agent.runtime.transport !== "cli") {
    fail(`Agent "${agentId}" does not support local CLI transport`);
  }
  const conn = spawnLocalAgent({
    command: agent.runtime.command,
    args: Array.isArray(agent.runtime.args) ? agent.runtime.args : []
  });
  try {
    const iter = conn.transport[Symbol.asyncIterator]();
    await waitForType(iter, "ready");
    await conn.transport.send({ type: "session/start", sessionId });
    await waitForType(iter, "session/started");

    // Replay prior user messages to reconstruct agent-side session state.
    const history = Array.isArray(sess.history) ? sess.history : [];
    const priorUsers = history.filter((m) => m && m.role === "user" && typeof m.content === "string");
    for (const m of priorUsers) {
      await sendAndWaitComplete(iter, conn.transport, sessionId, m.content);
    }

    const { msg } = await sendAndWaitComplete(iter, conn.transport, sessionId, prompt, {
      onDelta: (d) => process.stdout.write(d)
    });
    process.stdout.write("\n");

    await writeSession(sessionId, {
      version: 1,
      sessionId,
      agentId,
      skill,
      history: Array.isArray(msg.history) ? msg.history : history
    });
  } finally {
    await conn.close();
  }
}

async function cmdSessionClose(flags) {
  const sessionId = strFlag(flags, "session");
  if (!sessionId) fail(`Missing --session\n\n${usage()}`);
  await rm(sessionPath(sessionId), { force: true });
  process.stdout.write("ok\n");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv);

  if (boolFlag(flags, "help") || positional.length === 0) {
    process.stdout.write(usage() + "\n");
    return;
  }

  const [group, resource, action, subaction] = positional;

  if (group !== "agents") fail(usage());

  if (resource === "list") return cmdAgentsList(flags);
  if (resource === "describe") return cmdAgentsDescribe(positional, flags);
  if (resource === "register") return cmdAgentsRegister(flags);
  if (resource === "invoke") return cmdAgentsInvoke(flags);

  if (resource === "session") {
    if (action === "open") return cmdSessionOpen(flags);
    if (action === "send") return cmdSessionSend(flags);
    if (action === "close") return cmdSessionClose(flags);
  }

  fail(usage());
}

await main();

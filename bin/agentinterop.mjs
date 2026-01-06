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
import { parse as parseYaml } from "yaml";

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
  agentinterop agents register --files <path> [<path> ...]
  agentinterop agents register --file <path> (deprecated; use --files)
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
        if (k === "files") {
          // Special-case: --files accepts multiple paths until the next flag.
          let consumed = 0;
          for (let j = i + 1; j < argv.length; j++) {
            const next = argv[j];
            if (!next || next.startsWith("--")) break;
            setFlag(k, next);
            consumed++;
          }
          if (consumed === 0) setFlag(k, true);
          i += consumed;
          continue;
        }
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

function collapseWs(s) {
  return s.trim().replace(/\s+/g, " ");
}

function normalizeSectionId(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return s
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function mdxFail(filePath, message) {
  throw new Error(`Invalid .agent.mdx at "${filePath}": ${message}`);
}

function extractFrontmatter(raw, filePath) {
  const normalized = String(raw ?? "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) mdxFail(filePath, "missing required YAML frontmatter (expected starting '---')");

  const lines = normalized.split("\n");
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) mdxFail(filePath, "unterminated frontmatter (missing closing '---')");
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function parseHeadings(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  /** @type {Array<{level:number;text:string;line:number}>} */
  const out = [];

  let inFence = false;
  let fenceMarker = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(~~~|```)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (!m) continue;
    out.push({ level: m[1].length, text: m[2], line: i + 1 });
  }
  return out;
}

function sliceSection(lines, startIdx, endIdx) {
  const chunk = lines.slice(startIdx, endIdx);
  while (chunk.length > 0 && chunk[0].trim() === "") chunk.shift();
  while (chunk.length > 0 && chunk[chunk.length - 1].trim() === "") chunk.pop();
  return chunk.join("\n").trimEnd();
}

function parseSubsections(sectionMarkdown, filePath, sectionName) {
  const lines = String(sectionMarkdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const headings = parseHeadings(sectionMarkdown).filter((h) => h.level === 3);
  if (headings.length === 0) return [];

  const seen = new Set();
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const rawId = String(h.text ?? "").trim();
    const normalizedId = normalizeSectionId(rawId);
    if (!normalizedId) mdxFail(filePath, `${sectionName} subsection heading must produce a non-empty id`);
    if (seen.has(normalizedId)) {
      mdxFail(filePath, `Duplicate ${sectionName.toLowerCase()} id after normalization: "${normalizedId}"`);
    }
    seen.add(normalizedId);
    const startIdx = h.line;
    const endIdx = next ? next.line - 1 : lines.length;
    const body = sliceSection(lines, startIdx, endIdx);
    out.push({ rawId, normalizedId, body });
  }
  return out;
}

function parseAgentMdx(raw, filePath) {
  const { frontmatter, body } = extractFrontmatter(raw, filePath);

  let fm;
  try {
    fm = parseYaml(frontmatter);
  } catch (err) {
    mdxFail(filePath, `failed to parse YAML frontmatter: ${err?.message ?? String(err)}`);
  }
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) mdxFail(filePath, "frontmatter must be a YAML object");

  const fmAgent = fm.agent && typeof fm.agent === "object" && !Array.isArray(fm.agent) ? fm.agent : undefined;
  const fmExt = fm.extensions && typeof fm.extensions === "object" && !Array.isArray(fm.extensions) ? fm.extensions : undefined;
  const conflictChecks = [
    { label: "Description", isPresent: fm.description !== undefined || fmAgent?.description !== undefined },
    {
      label: "System Prompt",
      isPresent: fm.systemPrompt !== undefined || fmAgent?.systemPrompt !== undefined || fmExt?.systemPrompt !== undefined
    },
    { label: "Rules", isPresent: fm.rules !== undefined || fmAgent?.rules !== undefined },
    { label: "Skills", isPresent: fm.skills !== undefined || fmAgent?.skills !== undefined }
  ];
  for (const c of conflictChecks) {
    if (!c.isPresent) continue;
    const verb = c.label === "Rules" || c.label === "Skills" ? "are" : "is";
    mdxFail(filePath, `${c.label} ${verb} defined both in frontmatter and body. Choose exactly one source.`);
  }

  const id = typeof fm.id === "string" ? fm.id.trim() : "";
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  const version = typeof fm.version === "string" ? fm.version.trim() : "";
  if (!id) mdxFail(filePath, "missing required frontmatter field: id");
  if (!name) mdxFail(filePath, "missing required frontmatter field: name");
  if (!version) mdxFail(filePath, "missing required frontmatter field: version");
  if (!fm.runtime) mdxFail(filePath, "missing required frontmatter field: runtime");

  let mcp;
  if (fm.mcp !== undefined) {
    if (!fm.mcp || typeof fm.mcp !== "object" || Array.isArray(fm.mcp)) mdxFail(filePath, "frontmatter.mcp must be an object");
    if (fm.mcp.tools !== undefined) {
      if (!Array.isArray(fm.mcp.tools)) mdxFail(filePath, "frontmatter.mcp.tools must be an array");
      const tools = fm.mcp.tools.map((t, i) => {
        if (typeof t !== "string" || t.trim().length === 0) mdxFail(filePath, `frontmatter.mcp.tools[${i}] must be a non-empty string`);
        return t.trim();
      });
      mcp = { tools };
    }
  }

  let auth;
  if (fm.auth !== undefined) {
    if (!fm.auth || typeof fm.auth !== "object" || Array.isArray(fm.auth)) mdxFail(filePath, "frontmatter.auth must be an object");
    const kind = fm.auth.kind;
    const header = fm.auth.header;
    if (typeof kind !== "string" || kind.trim().length === 0) mdxFail(filePath, "frontmatter.auth.kind must be a non-empty string");
    const k = kind.trim();
    if (k !== "none" && k !== "bearer" && k !== "apiKey") mdxFail(filePath, 'frontmatter.auth.kind must be "none" | "bearer" | "apiKey"');
    if (header !== undefined && (typeof header !== "string" || header.trim().length === 0)) mdxFail(filePath, "frontmatter.auth.header must be a non-empty string");
    auth = { kind: k, ...(typeof header === "string" ? { header: header.trim() } : {}) };
  }

  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const headings = parseHeadings(body);
  const headingKey = (t) => collapseWs(String(t ?? "")).toLowerCase();
  const expected = [
    { level: 1, key: "description", label: "Description" },
    { level: 2, key: "system prompt", label: "System Prompt" },
    { level: 2, key: "rules", label: "Rules" },
    { level: 2, key: "skills", label: "Skills" }
  ];

  const found = [];
  let cursor = 0;
  for (const exp of expected) {
    let match;
    for (let i = cursor; i < headings.length; i++) {
      const h = headings[i];
      if (h.level === exp.level && headingKey(h.text) === exp.key) {
        match = h;
        cursor = i + 1;
        break;
      }
    }
    if (!match) mdxFail(filePath, `missing required markdown section: ${"#".repeat(exp.level)} ${exp.label}`);
    found.push(match);
  }

  const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty !== -1) {
    const first = lines[firstNonEmpty].trimStart();
    if (!/^#\s+description\s*$/i.test(collapseWs(first))) mdxFail(filePath, 'first markdown section must be "# Description"');
  }

  const [hDesc, hSys, hRules, hSkills] = found;
  const desc = sliceSection(lines, hDesc.line, hSys.line - 1);
  const sysPrompt = sliceSection(lines, hSys.line, hRules.line - 1);
  const rulesMarkdown = sliceSection(lines, hRules.line, hSkills.line - 1);
  const skillsMarkdown = sliceSection(lines, hSkills.line, lines.length);

  const rules = parseSubsections(rulesMarkdown, filePath, "Rules").map((r) => ({ id: r.normalizedId, text: r.body }));
  const skills = parseSubsections(skillsMarkdown, filePath, "Skills").map((s) => ({ id: s.normalizedId, description: s.body }));
  if (skills.length === 0) mdxFail(filePath, '## Skills must contain at least one "### <skill-id>" subsection');

  /** @type {Record<string, unknown>} */
  const extensions = {};
  if (String(sysPrompt ?? "").trim().length > 0) extensions.systemPrompt = sysPrompt;

  const agent = {
    id,
    name,
    version,
    description: desc,
    skills,
    ...(rules.length > 0 ? { rules } : {}),
    ...(mcp ? { mcp } : {}),
    ...(auth ? { auth } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {})
  };

  return { agent, runtime: fm.runtime };
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
  const files = flags.files;
  const json = strFlag(flags, "json");
  const fileList =
    Array.isArray(files) ? files.filter((f) => typeof f === "string") : typeof files === "string" ? [files] : [];

  if (fileList.length === 0 && file) fileList.push(file);

  const hasFiles = fileList.length > 0;
  if (!hasFiles && !json) fail(`Missing --files or --json\n\n${usage()}`);
  if (hasFiles && json) fail(`Use only one of --files/--file or --json\n\n${usage()}`);

  /** @type {any[]} */
  const configs = [];
  if (json) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      fail(`Failed to parse JSON: ${err?.message ?? String(err)}`);
    }
    try {
      configs.push(validateAgentConfig(parsed));
    } catch (err) {
      fail(err?.message ?? String(err));
    }
  } else {
    for (const p of fileList) {
      try {
        const raw = await readFile(p, "utf-8");
        const parsed = p.toLowerCase().endsWith(".agent.mdx")
          ? parseAgentMdx(raw, p)
          : JSON.parse(raw);
        configs.push(validateAgentConfig(parsed));
      } catch (err) {
        fail(`Failed to register "${p}": ${err?.message ?? String(err)}`);
      }
    }
  }

  // Persist non-secret auth references (env var names) if provided.
  const bearerEnv = strFlag(flags, "bearer-env");
  const apiKeyEnv = strFlag(flags, "api-key-env");
  const headerEnv = parseHeaderEnv(flags);
  for (const config of configs) {
    if (bearerEnv || apiKeyEnv || Object.keys(headerEnv).length > 0) {
      config.authRef = {
        ...(config.authRef ?? {}),
        ...(bearerEnv ? { bearerEnv } : {}),
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
        ...(Object.keys(headerEnv).length > 0
          ? { headerEnv: { ...(config.authRef?.headerEnv ?? {}), ...headerEnv } }
          : {})
      };
    }
  }

  const registry = await readAgentsRegistry();
  let next = registry.agents;
  /** @type {string[]} */
  const agentIds = [];
  for (const config of configs) {
    next = next.filter((a) => a?.agent?.id !== config.agent.id);
    next.push(config);
    agentIds.push(config.agent.id);
  }
  await writeAgentsRegistry(next);

  if (agentIds.length === 1) {
    process.stdout.write(JSON.stringify({ ok: true, agentId: agentIds[0] }, null, 2) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ ok: true, agentIds }, null, 2) + "\n");
  }
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

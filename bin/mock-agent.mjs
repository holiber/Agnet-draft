#!/usr/bin/env node
/**
 * mock-agent
 *
 * A deterministic, stdio-driven mock agent that speaks length-prefixed JSON.
 *
 * Frame format: [uint32be byteLength][utf8 JSON bytes]
 */

import process from "node:process";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

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
  buffer = new Uint8Array(0);
  offset = 0;

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

function parseArgs(argv) {
  const out = {
    chunks: 5,
    emitToolCalls: false
  };

  for (const arg of argv.slice(2)) {
    if (arg === "--emitToolCalls") out.emitToolCalls = true;
    if (arg.startsWith("--chunks=")) {
      const n = Number(arg.slice("--chunks=".length));
      if (Number.isFinite(n) && n >= 1) out.chunks = Math.floor(n);
    }
  }
  return out;
}

function chunkString(text, parts) {
  if (parts <= 1) return [text];
  const size = Math.ceil(text.length / parts);
  const chunks = [];
  for (let i = 0; i < parts; i++) {
    const start = i * size;
    const end = Math.min(text.length, (i + 1) * size);
    if (start >= text.length) break;
    chunks.push(text.slice(start, end));
  }
  return chunks.length > 0 ? chunks : [""];
}

async function writeMessage(msg) {
  const frame = encodeFrame(msg);
  const ok = process.stdout.write(frame);
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
        process.stdout.off("drain", onDrain);
        process.stdout.off("error", onError);
      };
      process.stdout.on("drain", onDrain);
      process.stdout.on("error", onError);
    });
  }
}

const config = parseArgs(process.argv);
const decoder = new FrameDecoder();

const sessions = new Map(); // sessionId -> { history: Array<{role, content}>, turns: number }
let sessionCounter = 0;

function getOrCreateSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = { history: [], turns: 0 };
  sessions.set(sessionId, created);
  return created;
}

await writeMessage({ type: "ready", pid: process.pid, version: 1 });

async function handleChunk(chunk) {
  const messages = decoder.push(
    new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  );

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") continue;

    if (msg.type === "session/start") {
      const requested = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
      const sessionId = requested ?? `session-${++sessionCounter}`;
      getOrCreateSession(sessionId);
      await writeMessage({ type: "session/started", sessionId });
      continue;
    }

    if (msg.type === "session/send") {
      const sessionId =
        typeof msg.sessionId === "string" ? msg.sessionId : `session-${++sessionCounter}`;
      const content = typeof msg.content === "string" ? msg.content : "";
      const session = getOrCreateSession(sessionId);

      session.history.push({ role: "user", content });
      session.turns += 1;

      const assistantContent = `MockAgent response #${session.turns}: ${content}`;
      const deltas = chunkString(assistantContent, config.chunks);

      if (config.emitToolCalls) {
        await writeMessage({
          type: "tool/call",
          sessionId,
          name: "mock.tool",
          args: { turn: session.turns, inputLength: content.length }
        });
      }

      for (let i = 0; i < deltas.length; i++) {
        await writeMessage({
          type: "session/stream",
          sessionId,
          index: i,
          delta: deltas[i]
        });
        // Deterministic async boundary without timers.
        await Promise.resolve();
      }

      const assistantMessage = { role: "assistant", content: assistantContent };
      session.history.push(assistantMessage);
      await writeMessage({
        type: "session/complete",
        sessionId,
        message: assistantMessage,
        history: session.history.slice()
      });
    }
  }
}

let processing = Promise.resolve();
process.stdin.on("data", (chunk) => {
  processing = processing.then(() => handleChunk(chunk)).catch(() => {});
});

process.stdin.on("end", () => {
  process.exit(0);
});


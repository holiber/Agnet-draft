import type {
  AgentToClientMessage,
  SessionCompleteMessage,
  SessionStreamMessage
} from "../protocol.js";
import type { StdioJsonTransport } from "../stdio-transport.js";

export function randomId(prefix: string, nowMs = Date.now(), randomHex = Math.random().toString(16).slice(2, 10)): string {
  return `${prefix}-${nowMs}-${randomHex}`;
}

export async function nextMessage(
  iter: AsyncIterator<unknown>,
  label: string,
  timeoutMs = 2000
): Promise<unknown> {
  const t = setTimeout(() => {
    throw new Error(`Timeout waiting for ${label}`);
  }, timeoutMs);
  // Avoid keeping the event loop alive on Node versions that support it.
  (t as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await iter.next();
    if (res.done) throw new Error(`Unexpected end of stream while waiting for ${label}`);
    return res.value;
  } finally {
    clearTimeout(t);
  }
}

export async function waitForType<T extends AgentToClientMessage["type"]>(
  iter: AsyncIterator<unknown>,
  type: T
): Promise<Extract<AgentToClientMessage, { type: T }>> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msg = await nextMessage(iter, `message type "${type}"`);
    if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === type) {
      return msg as Extract<AgentToClientMessage, { type: T }>;
    }
  }
}

export async function sendAndWaitComplete(params: {
  iter: AsyncIterator<unknown>;
  transport: StdioJsonTransport;
  sessionId: string;
  content: string;
  onDelta?: (delta: string) => void;
}): Promise<{ msg: SessionCompleteMessage; combined: string }> {
  await params.transport.send({
    type: "session/send",
    sessionId: params.sessionId,
    content: params.content
  });

  const deltasByIndex = new Map<number, string>();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const msg = await nextMessage(params.iter, `stream/complete for session "${params.sessionId}"`);
    if (!msg || typeof msg !== "object") continue;

    const type = (msg as { type?: unknown }).type;
    if (type === "session/stream" && (msg as SessionStreamMessage).sessionId === params.sessionId) {
      const stream = msg as SessionStreamMessage;
      const idx = typeof stream.index === "number" ? stream.index : deltasByIndex.size;
      const delta = typeof stream.delta === "string" ? stream.delta : "";
      deltasByIndex.set(idx, delta);
      params.onDelta?.(delta);
      continue;
    }

    if (type === "session/complete" && (msg as SessionCompleteMessage).sessionId === params.sessionId) {
      const complete = msg as SessionCompleteMessage;
      const combined = [...deltasByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, d]) => d)
        .join("");
      return { msg: complete, combined };
    }
  }
}


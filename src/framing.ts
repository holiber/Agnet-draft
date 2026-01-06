import { TextDecoder, TextEncoder } from "node:util";

/**
 * Length-prefixed JSON framing.
 *
 * Frame format: [uint32be byteLength][utf8 JSON bytes]
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export class FramingError extends Error {
  override name = "FramingError";
}

export function encodeFrame(message: unknown): Uint8Array {
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

export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private offset = 0;

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];

    // Compact existing buffer before appending new data.
    if (this.offset > 0) {
      this.buffer = this.buffer.slice(this.offset);
      this.offset = 0;
    }

    const next = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.byteLength);
    this.buffer = next;

    const out: unknown[] = [];
    while (true) {
      const remaining = this.buffer.byteLength - this.offset;
      if (remaining < 4) break;

      const view = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + this.offset,
        4
      );
      const length = view.getUint32(0, false);
      if (length > 100 * 1024 * 1024) {
        throw new FramingError(`Frame too large: ${length} bytes`);
      }

      if (remaining < 4 + length) break;

      const start = this.offset + 4;
      const end = start + length;
      const payload = this.buffer.slice(start, end);
      this.offset = end;

      const json = textDecoder.decode(payload);
      try {
        out.push(JSON.parse(json) as unknown);
      } catch (err) {
        throw new FramingError(
          `Invalid JSON payload (${length} bytes): ${(err as Error).message}`
        );
      }
    }

    // If we've consumed everything, reset to avoid unbounded growth.
    if (this.offset === this.buffer.byteLength) {
      this.buffer = new Uint8Array(0);
      this.offset = 0;
    }

    return out;
  }
}


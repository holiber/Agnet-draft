import { describe, expect, it } from "vitest";

import { encodeFrame, FrameDecoder } from "../src/framing.js";

describe("length-prefixed JSON framing", () => {
  it("decodes a single frame", () => {
    const decoder = new FrameDecoder();
    const msg = { hello: "world", n: 1 };
    const frame = encodeFrame(msg);
    const out = decoder.push(frame);
    expect(out).toEqual([msg]);
  });

  it("decodes frames split across chunks", () => {
    const decoder = new FrameDecoder();
    const msg = { type: "split", ok: true };
    const frame = encodeFrame(msg);

    const partA = frame.slice(0, 2);
    const partB = frame.slice(2, 7);
    const partC = frame.slice(7);

    expect(decoder.push(partA)).toEqual([]);
    expect(decoder.push(partB)).toEqual([]);
    expect(decoder.push(partC)).toEqual([msg]);
  });

  it("decodes multiple frames from a single chunk", () => {
    const decoder = new FrameDecoder();
    const a = { a: 1 };
    const b = { b: 2 };
    const combined = new Uint8Array(encodeFrame(a).byteLength + encodeFrame(b).byteLength);
    combined.set(encodeFrame(a), 0);
    combined.set(encodeFrame(b), encodeFrame(a).byteLength);

    expect(decoder.push(combined)).toEqual([a, b]);
  });
});


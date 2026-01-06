import type { Readable, Writable } from "node:stream";

import { encodeFrame, FrameDecoder } from "./framing.js";

type Resolver<T> = (value: T | PromiseLike<T>) => void;

export class StdioJsonTransport {
  private readonly decoder = new FrameDecoder();
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<Resolver<IteratorResult<unknown>>> = [];
  private ended = false;
  private readonly onDataBound: (chunk: Buffer) => void;
  private readonly onEndBound: () => void;
  private readonly onErrorBound: (err: Error) => void;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable
  ) {
    this.onDataBound = (chunk) => this.onData(chunk);
    this.onEndBound = () => this.onEnd();
    this.onErrorBound = (err) => this.onError(err);

    this.readable.on("data", this.onDataBound);
    this.readable.on("end", this.onEndBound);
    this.readable.on("error", this.onErrorBound);
  }

  async send(message: unknown): Promise<void> {
    if (this.ended) throw new Error("Transport is closed");

    const frame = encodeFrame(message);
    const ok = this.writable.write(frame);
    if (!ok) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
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

  close(): void {
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

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => this.next()
    };
  }

  private next(): Promise<IteratorResult<unknown>> {
    if (this.queue.length > 0) {
      const value = this.queue.shift();
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private onData(chunk: Buffer): void {
    try {
      const messages = this.decoder.push(chunk);
      for (const msg of messages) this.enqueue(msg);
    } catch (err) {
      this.onError(err as Error);
    }
  }

  private onEnd(): void {
    this.close();
  }

  private onError(_err: Error): void {
    // For now: fail closed and let consumers stop cleanly.
    this.close();
  }

  private enqueue(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }
}


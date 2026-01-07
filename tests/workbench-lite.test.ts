import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import { module, mutate, query, stream } from "../src/workbench-lite.js";

describe("workbench-lite", () => {
  it("builds a schema tree that includes nested submodules and metadata", () => {
    const issueTracker = module({
      getTasks: query(
        z.object({ q: z.string().optional() }).optional(),
        z.array(z.object({ id: z.string(), title: z.string() })),
        async (input) => [{ id: "1", title: input?.q ?? "Task" }],
        { grade: "IssueTrackerG1" }
      )
    });

    const app = module({
      appMethod2: query(z.undefined(), z.number().int(), async () => 42),
      issueTracker
    });

    const schema = app.getApiSchema() as any;

    expect(schema.appMethod2.kind).toBe("query");
    expect(schema.issueTracker.getTasks.kind).toBe("query");
    expect(schema.issueTracker.getTasks.meta).toEqual({ grade: "IssueTrackerG1" });
    expect(schema.issueTracker.getTasks.output.safeParse([{ id: "1", title: "x" }]).success).toBe(true);
  });

  it("validates input and output at runtime", async () => {
    const api = module({
      ok: query(z.object({ n: z.number().int() }), z.number().int(), async (input) => input.n + 1),
      badOutput: query(z.undefined(), z.number().int(), async () => "nope" as any)
    });

    await expect(api.ok({ n: 1 })).resolves.toBe(2);
    await expect(api.ok({ n: 1.1 } as any)).rejects.toBeInstanceOf(ZodError);
    await expect(api.badOutput(undefined)).rejects.toBeInstanceOf(ZodError);
  });

  it("reuses an already-built module instance as a submodule", async () => {
    const issueTracker = module({
      getTasks: query(z.undefined(), z.array(z.string()), async () => ["a", "b"])
    });
    const app = module({ issueTracker });

    expect(app.issueTracker).toBe(issueTracker);
    await expect(app.issueTracker.getTasks(undefined)).resolves.toEqual(["a", "b"]);
  });

  it("does not enumerate getApiSchema in module keys", () => {
    const api = module({
      ping: query(z.undefined(), z.literal("pong"), () => "pong" as const)
    });

    expect(Object.keys(api)).toContain("ping");
    expect(Object.keys(api)).not.toContain("getApiSchema");
  });

  it("supports stream() ops, validates chunks, and exposes stream schema", async () => {
    const collect = async <T,>(iter: AsyncIterable<T>): Promise<T[]> => {
      const out: T[] = [];
      for await (const x of iter) out.push(x);
      return out;
    };

    const api = module({
      send: stream(
        z.object({ prompt: z.string() }),
        z.object({ type: z.literal("token"), text: z.string() }),
        async function* ({ prompt }) {
          for (const t of prompt.split(/\s+/)) {
            yield { type: "token" as const, text: t };
          }
        },
        { transport: "serverStream" }
      )
    });

    const schema = api.getApiSchema() as any;
    expect(schema.send.kind).toBe("stream");
    expect(schema.send.meta).toEqual({ transport: "serverStream" });
    expect(schema.send.chunk.safeParse({ type: "token", text: "x" }).success).toBe(true);

    const chunks = await collect(api.send({ prompt: "hello world" }));
    expect(chunks.map((c) => c.text)).toEqual(["hello", "world"]);

    const bad = module({
      bad: stream(
        z.undefined(),
        z.object({ n: z.number().int() }),
        async function* () {
          yield { n: "nope" as any };
        }
      )
    });

    await expect(collect(bad.bad(undefined))).rejects.toBeInstanceOf(ZodError);
  });

  it("supports mutate() ops and marks them as mutation", () => {
    const op = mutate(z.object({ x: z.string() }), z.literal("ok"), () => "ok" as const);
    expect(op.kind).toBe("mutation");
  });
});


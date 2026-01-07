import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { Agnet, resolveAuthHeaders } from "../src/agnet.js";

describe("Agnet.providers.register", () => {
  it("registers from a parsed config object", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-register-"));
    const ai = new Agnet({ cwd });
    const ref = ai.providers.register({
      agent: {
        id: "a1",
        name: "Agent One",
        version: "1.0.0",
        skills: [{ id: "chat" }]
      },
      runtime: { transport: "cli", command: "node", args: ["agent.js"] }
    });
    expect(ref.id).toBe("a1");
    expect(ai.providers.get("a1")?.card.name).toBe("Agent One");
  });

  it("registers from { card, adapter }", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-register-"));
    const ai = new Agnet({ cwd });
    const ref = ai.providers.register({
      card: { id: "adapter-agent", name: "Adapter Agent", version: "1.0.0", skills: [{ id: "chat" }] },
      adapter: { kind: "unit-test" }
    });
    expect(ref.id).toBe("adapter-agent");
    expect(ref.adapter?.kind).toBe("unit-test");
  });

  it("registers from a JSON file path string", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agnet-test-"));
    const jsonPath = path.join(dir, "agent.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        agent: { id: "from-file", name: "From File", version: "1.0.0", skills: [{ id: "chat" }] },
        runtime: { transport: "http", baseUrl: "https://example.com" }
      }),
      "utf-8"
    );

    const ai = new Agnet({ cwd: dir });
    const ref = ai.providers.register(jsonPath);
    expect(ref.id).toBe("from-file");
    expect(ref.runtime?.transport).toBe("http");
  });

  it("throws a clear field-path error on invalid config", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-register-"));
    const ai = new Agnet({ cwd });
    expect(() =>
      ai.providers.register({
        agent: { name: "x", version: "1.0.0", skills: [{ id: "chat" }] },
        runtime: { transport: "cli", command: "node" }
      } as any)
    ).toThrowError(/agent\.id/);
  });
});

describe("auth resolution", () => {
  it("resolves bearer token from env var reference", () => {
    const headers = resolveAuthHeaders({
      card: { id: "a", name: "A", version: "1", skills: [{ id: "chat" }], auth: { kind: "bearer" } },
      authFromEnv: { bearerEnv: "OPENAI_API_KEY" },
      env: { OPENAI_API_KEY: "secret" }
    });
    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("overrides env-derived headers with explicit auth", () => {
    const headers = resolveAuthHeaders({
      card: {
        id: "a",
        name: "A",
        version: "1",
        skills: [{ id: "chat" }],
        auth: { kind: "apiKey", header: "X-Api-Key" }
      },
      authFromEnv: { apiKeyEnv: "KEY1" },
      auth: { apiKey: "explicit" },
      env: { KEY1: "env" }
    });
    expect(headers["X-Api-Key"]).toBe("explicit");
  });
});


import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";

type RunResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  const cliPath = path.join(process.cwd(), "bin", "agentinterop.mjs");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: opts?.cwd ?? process.cwd(),
      env: { ...process.env, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("agents list returns built-in mock-agent", async () => {
  const res = await runCli(["agents", "list", "--json"]);
  expect(res.code).toBe(0);

  const parsed = JSON.parse(res.stdout) as { agents: Array<{ id: string }> };
  expect(parsed.agents.map((a) => a.id)).toContain("mock-agent");
});

test("agents describe mock-agent exposes chat skill", async () => {
  const res = await runCli(["agents", "describe", "mock-agent", "--json"]);
  expect(res.code).toBe(0);

  const parsed = JSON.parse(res.stdout) as { agent: { id: string; skills: Array<{ id: string }> } };
  expect(parsed.agent.id).toBe("mock-agent");
  expect(parsed.agent.skills.map((s) => s.id)).toContain("chat");
});

test("agents invoke streams and prints final output", async () => {
  const res = await runCli(["agents", "invoke", "--skill", "chat", "--prompt", "hello"]);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe("MockAgent response #1: hello\n");
});

test("agents session open/send/close replays history across commands", async () => {
  const opened = await runCli(["agents", "session", "open"]);
  expect(opened.code).toBe(0);
  const sessionId = opened.stdout.trim();
  expect(sessionId).toMatch(/^session-\d+-[a-f0-9]+$/);

  try {
    const send1 = await runCli([
      "agents",
      "session",
      "send",
      "--session",
      sessionId,
      "--prompt",
      "hello"
    ]);
    expect(send1.code).toBe(0);
    expect(send1.stdout).toBe("MockAgent response #1: hello\n");

    const send2 = await runCli([
      "agents",
      "session",
      "send",
      "--session",
      sessionId,
      "--prompt",
      "world"
    ]);
    expect(send2.code).toBe(0);
    expect(send2.stdout).toBe("MockAgent response #2: world\n");
  } finally {
    const closed = await runCli(["agents", "session", "close", "--session", sessionId]);
    expect(closed.code).toBe(0);
    expect(closed.stdout.trim()).toBe("ok");
  }
});

test("agents invoke errors on unknown skill", async () => {
  const res = await runCli(["agents", "invoke", "--skill", "nope", "--prompt", "x"]);
  expect(res.code).toBeGreaterThan(0);
  expect(res.stderr).toContain("Unknown skill");
});

test("agents register supports inline JSON and persists per-cwd", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentinterop-e2e-"));
  const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

  const config = {
    agent: {
      id: "registered-foo",
      name: "Registered Foo",
      version: "1.0.0",
      skills: [{ id: "chat" }],
      auth: { kind: "bearer", header: "Authorization" }
    },
    runtime: {
      transport: "cli",
      command: process.execPath,
      args: [mockAgentPath]
    }
  };

  const reg = await runCli(
    [
      "agents",
      "register",
      "--json",
      JSON.stringify(config),
      "--bearer-env",
      "OPENAI_API_KEY"
    ],
    { cwd, env: { OPENAI_API_KEY: "dont-store-me" } }
  );
  expect(reg.code).toBe(0);
  expect(JSON.parse(reg.stdout)).toEqual({ ok: true, agentId: "registered-foo" });

  const listed = await runCli(["agents", "list", "--json"], { cwd });
  expect(listed.code).toBe(0);
  const parsed = JSON.parse(listed.stdout) as { agents: Array<{ id: string }> };
  expect(parsed.agents.map((a) => a.id)).toContain("registered-foo");

  const described = await runCli(["agents", "describe", "registered-foo", "--json"], { cwd });
  expect(described.code).toBe(0);
  const desc = JSON.parse(described.stdout) as { agent: { id: string; name: string } };
  expect(desc.agent.id).toBe("registered-foo");
  expect(desc.agent.name).toBe("Registered Foo");

  const invoked = await runCli(
    ["agents", "invoke", "--agent", "registered-foo", "--skill", "chat", "--prompt", "hello"],
    { cwd }
  );
  expect(invoked.code).toBe(0);
  expect(invoked.stdout).toBe("MockAgent response #1: hello\n");
});

test("agents register supports --file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agentinterop-e2e-"));
  const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

  const configPath = path.join(cwd, "agent.json");
  await writeFile(
    configPath,
    JSON.stringify({
      agent: { id: "from-file", name: "From File", version: "1.0.0", skills: [{ id: "chat" }] },
      runtime: { transport: "cli", command: process.execPath, args: [mockAgentPath] }
    }),
    "utf-8"
  );

  const reg = await runCli(["agents", "register", "--file", configPath], { cwd });
  expect(reg.code).toBe(0);
  expect(JSON.parse(reg.stdout)).toEqual({ ok: true, agentId: "from-file" });
});


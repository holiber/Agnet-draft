import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";

type RunResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  const cliPath = path.join(process.cwd(), "bin", "agnet.mjs");

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

test("providers list returns built-in mock-agent", async () => {
  const res = await runCli(["providers", "list", "--json"]);
  expect(res.code).toBe(0);

  const parsed = JSON.parse(res.stdout) as { providers: Array<{ id: string }> };
  expect(parsed.providers.map((a) => a.id)).toContain("mock-agent");
});

test("providers describe mock-agent exposes chat skill", async () => {
  const res = await runCli(["providers", "describe", "mock-agent", "--json"]);
  expect(res.code).toBe(0);

  const parsed = JSON.parse(res.stdout) as { provider: { id: string; skills: Array<{ id: string }> } };
  expect(parsed.provider.id).toBe("mock-agent");
  expect(parsed.provider.skills.map((s) => s.id)).toContain("chat");
});

test("chats create/send streams and prints final output", async () => {
  const opened = await runCli(["chats", "create"]);
  expect(opened.code).toBe(0);
  const chatId = opened.stdout.trim();
  expect(chatId).toMatch(/^chat-\d+-[a-f0-9]+$/);

  const res = await runCli(["chats", "send", "--chat", chatId, "--prompt", "hello"]);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe("MockAgent response #1: hello\n");
});

test("ask (root command) runs one-shot and prints final output", async () => {
  const res = await runCli(["ask", "hello"]);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe("MockAgent response #1: hello\n");
});

test("prompt (root command) runs one-shot and prints JSON result", async () => {
  const res = await runCli(["prompt", "hello"]);
  expect(res.code).toBe(0);

  const parsed = JSON.parse(res.stdout) as { text: string; providerId: string; chatId: string };
  expect(parsed.text).toBe("MockAgent response #1: hello");
  expect(parsed.providerId).toBe("mock-agent");
  expect(parsed.chatId).toMatch(/^chat-\d+-[a-f0-9]+$/);
});

test("chats create/send/close replays history across commands", async () => {
  const opened = await runCli(["chats", "create"]);
  expect(opened.code).toBe(0);
  const chatId = opened.stdout.trim();
  expect(chatId).toMatch(/^chat-\d+-[a-f0-9]+$/);

  try {
    const send1 = await runCli([
      "chats",
      "send",
      "--chat",
      chatId,
      "--prompt",
      "hello"
    ]);
    expect(send1.code).toBe(0);
    expect(send1.stdout).toBe("MockAgent response #1: hello\n");

    const send2 = await runCli([
      "chats",
      "send",
      "--chat",
      chatId,
      "--prompt",
      "world"
    ]);
    expect(send2.code).toBe(0);
    expect(send2.stdout).toBe("MockAgent response #2: world\n");
  } finally {
    const closed = await runCli(["chats", "close", "--chat", chatId]);
    expect(closed.code).toBe(0);
    expect(closed.stdout.trim()).toBe("ok");
  }
});

test("chats send errors on missing prompt", async () => {
  const opened = await runCli(["chats", "create"]);
  expect(opened.code).toBe(0);
  const chatId = opened.stdout.trim();

  const res = await runCli(["chats", "send", "--chat", chatId]);
  expect(res.code).toBeGreaterThan(0);
  expect(res.stderr).toContain("Missing required argument");
});

test("providers register supports inline JSON and persists per-cwd", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-e2e-"));
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
      "providers",
      "register",
      "--json",
      JSON.stringify(config),
      "--bearer-env",
      "OPENAI_API_KEY"
    ],
    { cwd, env: { OPENAI_API_KEY: "dont-store-me" } }
  );
  expect(reg.code).toBe(0);
  expect(JSON.parse(reg.stdout)).toEqual({ ok: true, providerId: "registered-foo" });

  const listed = await runCli(["providers", "list", "--json"], { cwd });
  expect(listed.code).toBe(0);
  const parsed = JSON.parse(listed.stdout) as { providers: Array<{ id: string }> };
  expect(parsed.providers.map((a) => a.id)).toContain("registered-foo");

  const described = await runCli(["providers", "describe", "registered-foo", "--json"], { cwd });
  expect(described.code).toBe(0);
  const desc = JSON.parse(described.stdout) as { provider: { id: string; name: string } };
  expect(desc.provider.id).toBe("registered-foo");
  expect(desc.provider.name).toBe("Registered Foo");

  const chat = await runCli(["chats", "create", "--provider", "registered-foo"], { cwd });
  expect(chat.code).toBe(0);
  const chatId = chat.stdout.trim();
  const sent = await runCli(["chats", "send", "--chat", chatId, "--prompt", "hello"], { cwd });
  expect(sent.code).toBe(0);
  expect(sent.stdout).toBe("MockAgent response #1: hello\n");
});

test("providers register supports --file", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-e2e-"));
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

  const reg = await runCli(["providers", "register", "--file", configPath], { cwd });
  expect(reg.code).toBe(0);
  expect(JSON.parse(reg.stdout)).toEqual({ ok: true, providerId: "from-file" });
});

test("providers register supports --files with multiple .agent.mdx files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "agnet-e2e-"));
  const mockAgentPath = path.join(process.cwd(), "bin", "mock-agent.mjs");

  const aPath = path.join(cwd, "a.agent.mdx");
  const bPath = path.join(cwd, "b.agent.mdx");

  await writeFile(
    aPath,
    `---
id: mdx-a
name: MDX A
version: 0.1.0
runtime:
  transport: cli
  command: ${process.execPath}
  args: ["${mockAgentPath}"]
---
# Description
Agent A.

## System Prompt
System A.

## Rules
### minimal-files
Prefer fewer files.

## Skills
### chat
Chat.
`,
    "utf-8"
  );

  await writeFile(
    bPath,
    `---
id: mdx-b
name: MDX B
version: 0.1.0
runtime:
  transport: cli
  command: ${process.execPath}
  args: ["${mockAgentPath}"]
---
# Description
Agent B.

## System Prompt
System B.

## Rules
### minimal-files
Prefer fewer files.

## Skills
### chat
Chat.
`,
    "utf-8"
  );

  const reg = await runCli(["providers", "register", "--files", aPath, bPath], { cwd });
  expect(reg.code).toBe(0);
  expect(JSON.parse(reg.stdout)).toEqual({ ok: true, providerIds: ["mdx-a", "mdx-b"] });

  const listed = await runCli(["providers", "list", "--json"], { cwd });
  expect(listed.code).toBe(0);
  const parsed = JSON.parse(listed.stdout) as { providers: Array<{ id: string }> };
  expect(parsed.providers.map((a) => a.id)).toContain("mdx-a");
  expect(parsed.providers.map((a) => a.id)).toContain("mdx-b");
});


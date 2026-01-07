import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { captureTerminalScreenshot } from "./terminal-screenshot.js";

type RunResult = { code: number; stdout: string; stderr: string };

function runShellCommand(command: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("terminal hello world", async ({ browser }, testInfo) => {
  const cmd = `echo "hello world"`;

  // Screenshot must be taken before executing the command.
  await captureTerminalScreenshot(browser, testInfo, {
    title: "hello world terminal",
    filenameHint: "hello-world-terminal",
    lines: [`$ ${cmd}`]
  });

  const res = await runShellCommand(cmd);
  expect(res.code).toBe(0);
  expect(res.stdout).toBe("hello world\n");
  expect(res.stderr).toBe("");
});


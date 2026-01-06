import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { StdioJsonTransport } from "./stdio-transport.js";

export interface SpawnLocalAgentOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LocalAgentConnection {
  child: ChildProcessWithoutNullStreams;
  transport: StdioJsonTransport;
  close: () => Promise<void>;
}

export function spawnLocalAgent(
  options: SpawnLocalAgentOptions
): LocalAgentConnection {
  const child = spawn(options.command, options.args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env
  });

  const transport = new StdioJsonTransport(child.stdout, child.stdin);

  const close = async () => {
    transport.close();
    if (!child.killed) child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
    });
  };

  return { child, transport, close };
}


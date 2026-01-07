import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";

import { createWorkbenchContext } from "./workbench-light.js";
import { root } from "./modules/root.js";

export type AppContext = ReturnType<typeof createWorkbenchContext> & {
  cwd: string;
  env: NodeJS.ProcessEnv;
  mockAgentPath: string;
};

function resolveDefaultMockAgentPath(cwd: string): string {
  // Prefer local checkout path (useful for tests and local dev).
  const local = path.resolve(cwd, "bin", "mock-agent.mjs");
  if (existsSync(local)) return local;
  // Fallback: current process CWD.
  const fromProc = path.resolve(process.cwd(), "bin", "mock-agent.mjs");
  return fromProc;
}

export function createAppContext(opts?: { cwd?: string; env?: NodeJS.ProcessEnv; mockAgentPath?: string }): AppContext {
  const cwd = opts?.cwd ?? process.cwd();
  const env = opts?.env ?? process.env;
  const mockAgentPath = opts?.mockAgentPath ?? resolveDefaultMockAgentPath(cwd);
  return Object.assign(createWorkbenchContext(), { cwd, env, mockAgentPath });
}

export function createApp(ctx?: AppContext) {
  return root.activate(ctx ?? createAppContext());
}

// Convenience singletons (ok for CLI/tools; tests should prefer createApp()).
export const app = createApp();
export const apiSchema = app.getApiSchema();


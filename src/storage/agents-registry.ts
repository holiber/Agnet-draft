import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig } from "../agent-interop.js";

export function agentsRegistryPath(cwd: string): string {
  return path.join(cwd, ".cache", "agentinterop", "agents.json");
}

export async function readAgentsRegistry(cwd: string): Promise<{ version: 1; agents: AgentConfig[] }> {
  try {
    const raw = await readFile(agentsRegistryPath(cwd), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const agents = Array.isArray((parsed as { agents?: unknown }).agents)
      ? ((parsed as { agents: unknown[] }).agents as AgentConfig[])
      : [];
    return { version: 1, agents };
  } catch {
    return { version: 1, agents: [] };
  }
}

export async function writeAgentsRegistry(cwd: string, agents: AgentConfig[]): Promise<void> {
  const p = agentsRegistryPath(cwd);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ version: 1 as const, agents }, null, 2) + "\n", "utf-8");
}


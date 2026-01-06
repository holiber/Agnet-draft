import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "../protocol.js";

export interface PersistedTaskV1 {
  version: 1;
  taskId: string;
  agentId: string;
  skill: string;
  history: ChatMessage[];
}

export function tasksDir(cwd: string): string {
  return path.join(cwd, ".cache", "agnet", "tasks");
}

export function taskPath(cwd: string, taskId: string): string {
  return path.join(tasksDir(cwd), `${taskId}.json`);
}

export async function readTask(cwd: string, taskId: string): Promise<PersistedTaskV1> {
  try {
    const raw = await readFile(taskPath(cwd, taskId), "utf-8");
    return JSON.parse(raw) as PersistedTaskV1;
  } catch {
    throw new Error(`Task not found: ${taskId}`);
  }
}

export async function writeTask(cwd: string, taskId: string, data: PersistedTaskV1): Promise<void> {
  await mkdir(tasksDir(cwd), { recursive: true });
  await writeFile(taskPath(cwd, taskId), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export async function deleteTask(cwd: string, taskId: string): Promise<void> {
  await rm(taskPath(cwd, taskId), { force: true });
}


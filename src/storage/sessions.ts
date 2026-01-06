import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatMessage } from "../protocol.js";

export interface PersistedSessionV1 {
  version: 1;
  sessionId: string;
  agentId: string;
  skill: string;
  history: ChatMessage[];
}

export function sessionsDir(cwd: string): string {
  return path.join(cwd, ".cache", "agentinterop", "sessions");
}

export function sessionPath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

export async function readSession(cwd: string, sessionId: string): Promise<PersistedSessionV1> {
  try {
    const raw = await readFile(sessionPath(cwd, sessionId), "utf-8");
    return JSON.parse(raw) as PersistedSessionV1;
  } catch {
    throw new Error(`Session not found: ${sessionId}`);
  }
}

export async function writeSession(cwd: string, sessionId: string, data: PersistedSessionV1): Promise<void> {
  await mkdir(sessionsDir(cwd), { recursive: true });
  await writeFile(sessionPath(cwd, sessionId), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export async function deleteSession(cwd: string, sessionId: string): Promise<void> {
  await rm(sessionPath(cwd, sessionId), { force: true });
}


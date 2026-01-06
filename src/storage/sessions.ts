/**
 * Backwards-compatible session storage wrapper.
 *
 * "Session" is not a user-facing concept; new code should use task storage.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { PersistedTaskV1 } from "./tasks.js";
import { deleteTask, readTask, taskPath, writeTask } from "./tasks.js";

export interface PersistedSessionV1 {
  version: 1;
  sessionId: string;
  agentId: string;
  skill: string;
  history: PersistedTaskV1["history"];
}

export function sessionsDir(cwd: string): string {
  // Legacy location used by `agents.session.*` commands.
  return path.join(cwd, ".cache", "agnet", "sessions");
}

export function sessionPath(cwd: string, sessionId: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

export async function readSession(cwd: string, sessionId: string): Promise<PersistedSessionV1> {
  // 1) Prefer legacy session files if present.
  try {
    const raw = await readFile(sessionPath(cwd, sessionId), "utf-8");
    return JSON.parse(raw) as PersistedSessionV1;
  } catch {
    // 2) Fall back to task storage mapping.
    try {
      const t = await readTask(cwd, sessionId);
      return {
        version: 1,
        sessionId,
        agentId: t.agentId,
        skill: t.skill,
        history: t.history
      };
    } catch {
      throw new Error(`Session not found: ${sessionId}`);
    }
  }
}

export async function writeSession(cwd: string, sessionId: string, data: PersistedSessionV1): Promise<void> {
  // Write both:
  // - task storage (preferred)
  // - legacy session storage (for older tooling that reads `.cache/agnet/sessions`)
  await writeTask(cwd, sessionId, {
    version: 1,
    taskId: sessionId,
    agentId: data.agentId,
    skill: data.skill,
    history: data.history
  });

  await mkdir(sessionsDir(cwd), { recursive: true });
  await writeFile(sessionPath(cwd, sessionId), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export async function deleteSession(cwd: string, sessionId: string): Promise<void> {
  await deleteTask(cwd, sessionId);
  await rm(sessionPath(cwd, sessionId), { force: true });
}


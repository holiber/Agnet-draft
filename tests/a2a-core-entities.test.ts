import { describe, expect, expectTypeOf, it } from "vitest";

import type { AgentEvent, Artifact, Message, Part, Task, TaskEvent } from "../src/protocol.js";

describe("A2A core entities (Tier1)", () => {
  it("can model Task -> Message -> Part and Artifact", () => {
    const now = new Date().toISOString();

    const task = {
      id: "t1",
      agentId: "agent-1",
      status: "created",
      createdAt: now
    } satisfies Task;

    const parts = [{ kind: "text", text: "hello" }] satisfies Part[];

    const msg = {
      id: "m1",
      taskId: task.id,
      role: "user",
      parts,
      timestamp: now
    } satisfies Message;

    const artifact = {
      id: "a1",
      taskId: task.id,
      type: "text/plain",
      parts: [{ kind: "text", text: "result" }]
    } satisfies Artifact;

    expect(task.status).toBe("created");
    expect(msg.taskId).toBe("t1");
    expect(msg.parts[0]).toEqual({ kind: "text", text: "hello" });
    expect(artifact.type).toBe("text/plain");
  });

  it("exposes a discriminated TaskEvent / AgentEvent union", () => {
    const now = new Date().toISOString();

    const e1 = { type: "task_started", taskId: "t1", timestamp: now } satisfies TaskEvent;
    const e2 = {
      type: "message_delta",
      taskId: "t1",
      timestamp: now,
      messageId: "m1",
      delta: "hel",
      index: 0
    } satisfies TaskEvent;
    const e3 = {
      type: "task_failed",
      taskId: "t1",
      timestamp: now,
      error: "boom"
    } satisfies TaskEvent;

    const asAgentEvent: AgentEvent = e1;
    expect(asAgentEvent.type).toBe("task_started");

    const all: TaskEvent[] = [e1, e2, e3];
    for (const e of all) {
      if (e.type === "message_delta") {
        expectTypeOf(e.delta).toEqualTypeOf<string>();
        expect(e.delta.length).toBeGreaterThan(0);
      }
    }
  });
});


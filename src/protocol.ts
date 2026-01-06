export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * === A2A-aligned core entities (Tier1) ===
 *
 * AgentInterop aims to use the A2A (Agent2Agent) standard as the canonical internal model.
 * These types are transport-agnostic and JSON-serializable (suitable for CLI/IPC/HTTP/WS).
 *
 * Notes:
 * - A2A often represents timestamps as RFC3339/ISO-8601 strings. We model timestamps as
 *   ISO strings to keep payloads portable across transports and languages.
 * - Tier1 scope is types + minimal semantics only (no persistence, no remote APIs).
 */

/** RFC3339/ISO-8601 timestamp string (e.g. `new Date().toISOString()`). */
export type Timestamp = string;

export type TaskStatus = "created" | "running" | "completed" | "failed" | "cancelled";

/**
 * Task is the main execution container.
 *
 * Tier1 usage:
 * - `invoke()` => one Task
 * - `session`  => long-lived Task containing many Messages
 */
export interface Task {
  id: string;
  agentId: string;
  status: TaskStatus;
  createdAt: Timestamp;
  completedAt?: Timestamp;
  sessionId?: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * Message is a unit of interaction inside a Task.
 * Messages form a session history and are the basis for future trajectories.
 */
export interface Message {
  id: string;
  taskId: string;
  role: MessageRole;
  parts: Part[];
  timestamp: Timestamp;
}

export type TextPart = { kind: "text"; text: string };
export type JsonPart = { kind: "json"; value: unknown }; // placeholder for structured content

/**
 * Part is a typed content container.
 *
 * Tier1 minimum:
 * - text: streaming-friendly text chunks
 * - json: placeholder for structured/multimodal content without breaking API
 */
export type Part = TextPart | JsonPart;

/**
 * Artifact is a produced result associated with a Task (not a Message).
 *
 * - `type` is a MIME-like string (e.g. "text/plain", "application/json", "image/png").
 * - `metadata` is optional, JSON-serializable extra data.
 */
export interface Artifact {
  id: string;
  taskId: string;
  type: string;
  parts: Part[];
  metadata?: JsonObject;
}

interface TaskEventBase {
  taskId: string;
  timestamp: Timestamp;
}

/**
 * Streaming & lifecycle events aligned with A2A semantics.
 *
 * Minimum Tier1 events:
 * - task_started
 * - message_delta (streaming text)
 * - message_completed
 * - artifact_created
 * - task_completed
 * - task_failed
 */
export type TaskEvent =
  | (TaskEventBase & { type: "task_started" })
  | (TaskEventBase & {
      type: "message_delta";
      messageId: string;
      /** Streaming delta for a text part. */
      delta: string;
      /** Optional index for ordering deltas when needed. */
      index?: number;
    })
  | (TaskEventBase & { type: "message_completed"; message: Message })
  | (TaskEventBase & { type: "artifact_created"; artifact: Artifact })
  | (TaskEventBase & { type: "task_completed"; task: Task })
  | (TaskEventBase & { type: "task_failed"; error: string });

/**
 * AgentEvent is a unified event stream type.
 * For Tier1 it's equivalent to TaskEvent, but may expand in future tiers.
 */
export type AgentEvent = TaskEvent;

export interface ReadyMessage {
  type: "ready";
  pid: number;
  version: 1;
}

export interface SessionStartMessage {
  type: "session/start";
  sessionId?: string;
}

export interface SessionStartedMessage {
  type: "session/started";
  sessionId: string;
}

export interface SessionSendMessage {
  type: "session/send";
  sessionId: string;
  content: string;
}

export interface SessionStreamMessage {
  type: "session/stream";
  sessionId: string;
  index: number;
  delta: string;
}

export interface ToolCallPlaceholderMessage {
  type: "tool/call";
  sessionId: string;
  name: string;
  args: JsonObject;
}

export interface SessionCompleteMessage {
  type: "session/complete";
  sessionId: string;
  message: ChatMessage;
  history: ChatMessage[];
}

export type ClientToAgentMessage = SessionStartMessage | SessionSendMessage;

export type AgentToClientMessage =
  | ReadyMessage
  | SessionStartedMessage
  | SessionStreamMessage
  | ToolCallPlaceholderMessage
  | SessionCompleteMessage;


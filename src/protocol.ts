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
 * Agnet aims to use the A2A (Agent2Agent) standard as the canonical internal model.
 * These types are transport-agnostic and JSON-serializable (suitable for CLI/IPC/HTTP/WS).
 *
 * Notes:
 * - A2A often represents timestamps as RFC3339/ISO-8601 strings. We model timestamps as
 *   ISO strings to keep payloads portable across transports and languages.
 * - Tier1 scope is types + minimal semantics only (no persistence, no remote APIs).
 */

/** RFC3339/ISO-8601 timestamp string (e.g. `new Date().toISOString()`). */
export type Timestamp = string;

export type TaskStatus = "created" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type ExecutionLocation = "local" | "remote" | "unknown";
export type Durability = "ephemeral" | "durable" | "unknown";

/**
 * Execution hints for UX and safety.
 * Not part of A2A core, but compatible as an extension.
 */
export interface TaskExecution {
  location: ExecutionLocation;
  durability: Durability;
  providerId?: string; // e.g. "cursor" | "openhands" | "local"
  hint?: string; // optional human-readable warning/help text
  _rawData?: unknown; // passthrough provider fields
}

export interface TaskRef {
  id: string;
  agentId: string; // logical agent type in AgentInterop
  status: TaskStatus;

  title?: string; // "chat name" or derived summary (optional)
  createdAt?: Timestamp;
  updatedAt?: Timestamp;

  // Optional metadata commonly shown in UIs:
  repo?: { url?: string; ref?: string };
  pr?: { url?: string; number?: number };

  execution: TaskExecution;

  _rawData?: unknown; // provider payload passthrough
}

/**
 * Task is the main execution container.
 *
 * Tier1 usage:
 * - `agents.invoke` => ephemeral execution (streams text)
 * - `agents.task.*` => durable local Task with persisted message history
 */
export type Task = TaskRef;

export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * Message is a unit of interaction inside a Task.
 * Messages form a task history and are the basis for future trajectories.
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
 * - task.started
 * - message.delta (streaming text)
 * - message.completed
 * - artifact.created
 * - task.completed
 * - task.failed
 */
export type TaskEvent =
  | (TaskEventBase & { type: "task.started" })
  | (TaskEventBase & {
      type: "message.delta";
      messageId: string;
      /** Streaming delta for a text part. */
      delta: string;
      /** Optional index for ordering deltas when needed. */
      index?: number;
    })
  | (TaskEventBase & { type: "message.completed"; message: Message })
  | (TaskEventBase & { type: "artifact.created"; artifact: Artifact })
  | (TaskEventBase & { type: "task.completed"; task: TaskRef })
  | (TaskEventBase & { type: "task.cancelled"; task: TaskRef })
  | (TaskEventBase & { type: "task.failed"; error: string });

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

/**
 * @internal
 *
 * Legacy stdio protocol for the built-in mock agent and local CLI runtime.
 * This is not a user-facing "Session" abstraction; Tier1 public APIs are task-first.
 */
export interface SessionStartMessage {
  type: "session/start";
  sessionId?: string;
}

/** @internal */
export interface SessionStartedMessage {
  type: "session/started";
  sessionId: string;
}

/** @internal */
export interface SessionSendMessage {
  type: "session/send";
  sessionId: string;
  content: string;
}

/** @internal */
export interface SessionStreamMessage {
  type: "session/stream";
  sessionId: string;
  index: number;
  delta: string;
}

/** @internal */
export interface ToolCallPlaceholderMessage {
  type: "tool/call";
  sessionId: string;
  name: string;
  args: JsonObject;
}

/** @internal */
export interface SessionCompleteMessage {
  type: "session/complete";
  sessionId: string;
  message: ChatMessage;
  history: ChatMessage[];
}

export interface TasksCreateMessage {
  type: "tasks/create";
  taskId?: string;
  agentId?: string;
  title?: string;
  prompt?: string;
}

export interface TasksCreatedMessage {
  type: "tasks/created";
  task: TaskRef;
}

export interface TasksListMessage {
  type: "tasks/list";
  providerId?: string;
  status?: TaskStatus;
  cursor?: string;
  limit?: string;
}

export interface TasksListResultMessage {
  type: "tasks/listResult";
  tasks: TaskRef[];
  nextCursor?: string;
}

export interface TasksGetMessage {
  type: "tasks/get";
  taskId: string;
}

export interface TasksGetResultMessage {
  type: "tasks/getResult";
  task: TaskRef;
}

export interface TasksCancelMessage {
  type: "tasks/cancel";
  taskId: string;
}

export interface TasksCancelResultMessage {
  type: "tasks/cancelResult";
  ok: true;
}

export interface TasksSubscribeMessage {
  type: "tasks/subscribe";
  taskId: string;
}

export interface TasksErrorMessage {
  type: "tasks/error";
  taskId?: string;
  error: string;
}

export type ClientToAgentMessage =
  | SessionStartMessage
  | SessionSendMessage
  | TasksCreateMessage
  | TasksListMessage
  | TasksGetMessage
  | TasksCancelMessage
  | TasksSubscribeMessage;

export type AgentToClientMessage =
  | ReadyMessage
  | SessionStartedMessage
  | SessionStreamMessage
  | ToolCallPlaceholderMessage
  | SessionCompleteMessage
  | TasksCreatedMessage
  | TasksListResultMessage
  | TasksGetResultMessage
  | TasksCancelResultMessage
  | TasksErrorMessage
  | TaskEvent;


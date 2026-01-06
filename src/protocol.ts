export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type ChatRole = "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

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


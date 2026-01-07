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

/**
 * TChat is a vendor-agnostic description of a chat-like communication space.
 *
 * Notes:
 * - This is a *flat* record type (no tier concepts).
 * - Many fields may be unknown for some providers; adapters can fill what they can.
 * - Use `extra` for experimental/provider-specific additions.
 * - Use `_rawRest` / `_rawAll` as escape hatches for raw payloads.
 */
export type TChat = {
  // -----------------------------
  // Identity / Linking
  // -----------------------------

  /** Internal unique id within Agnet (SSOT). */
  id: string;

  /**
   * External identifier or composite key within the native system.
   * Examples:
   * - "123456"
   * - { owner: "org", repo: "app", number: 42 }  // GitHub issue/PR
   * - { workspaceId: "...", threadId: "..." }    // SaaS chat systems
   */
  externalId?: string | Record<string, unknown>;

  /**
   * Canonical link/URI to open this chat in the native UI when available.
   * Examples: https://..., slack://..., file://...
   */
  source?: string;

  /** Human-friendly name/title of the chat. */
  title?: string;

  /** Human-friendly description/topic/purpose if available. */
  description?: string;

  // -----------------------------
  // Lifecycle / Storage
  // -----------------------------

  /**
   * Where the chat is hosted.
   * - local: exists in the current environment (process/runtime) and may disappear when it stops
   * - remote: backed by an external service
   */
  location: "local" | "remote";

  /**
   * Persistence model (normalized).
   * - ephemeral: intended to disappear (in-memory / one-off)
   * - session: tied to a runtime/session lifecycle
   * - durable: stored externally (cloud service, filesystem, database)
   */
  persistence: "ephemeral" | "session" | "durable";

  /**
   * Time-to-live in milliseconds if the chat is temporary / self-destructing.
   * Not all providers expose this value.
   */
  ttlMs?: number;

  // -----------------------------
  // Access / Participation (for the *current* agent/provider identity)
  // -----------------------------

  /**
   * Whether the current identity can read messages from this chat.
   * This is an *effective permission hint*, not a full auth model.
   */
  canRead: boolean;

  /**
   * Whether the current identity can post messages into this chat.
   * This is an *effective permission hint*, not a full auth model.
   */
  canPost: boolean;

  /**
   * Whether joining/participation requires an approval flow (invite/request).
   * For many providers this may be unknown.
   */
  requiresApprovalToJoin?: boolean;

  /**
   * Whether an explicit agreement/terms acceptance is required to read/post.
   * For many providers this may be unknown.
   */
  agreementRequired?: boolean;

  /**
   * Visibility scope (may be unknown).
   * - public: broadly accessible/discoverable
   * - unlisted: accessible by link, not broadly discoverable
   * - org/team: restricted to an organization/team boundary
   * - private: restricted to explicit members
   */
  visibility?: "public" | "unlisted" | "org" | "team" | "private";

  // -----------------------------
  // Classification (vendor-agnostic)
  // -----------------------------

  /**
   * How messages are structured in this chat.
   *
   * - chat: real-time (or near real-time) conversational chat room style
   * - comments: ordered comments attached to an entity (task/PR/review/post/etc).
   *             Replies/threads are represented at the *message level* (e.g., parentId),
   *             not by a separate channel type.
   * - dm: direct messages between participants
   * - email: mailbox-style threaded communication
   * - call: audio/video call session (may have chat or not)
   * - feed: broadcast-style posts with optional comments (social feed)
   * - forum: forum-style discussions with categories/topics
   * - other: anything else
   */
  channelType: "chat" | "comments" | "dm" | "email" | "call" | "feed" | "forum" | "other";

  /**
   * What this chat is "about" (its primary context).
   *
   * - task: work item / issue-tracker item / to-do (GitHub issue, Linear issue, local task)
   * - pr: pull request / merge request discussion
   * - epic: higher-level tracker item grouping tasks
   * - runtime: tool/runtime session (Cursor/OpenHands/IDE agent session)
   * - support: customer support / helpdesk conversation
   * - messenger: general-purpose messaging app (WhatsApp/Telegram/Slack/etc)
   * - doc_review: review thread for documents/specs/contracts
   * - incident: incident/ops war-room style discussion
   * - social: social/community discussion (Reddit/YouTube comments/etc)
   * - other: none of the above / unknown
   *
   * Note: If omitted, treat as unknown.
   */
  contextType?:
    | "task"
    | "pr"
    | "epic"
    | "runtime"
    | "support"
    | "messenger"
    | "doc_review"
    | "incident"
    | "social"
    | "other";

  /**
   * Pointer to the primary context entity that the chat is attached to.
   *
   * Avoid "*Ref" naming to not collide with "React refs" mental model.
   *
   * Examples:
   * - "https://github.com/org/repo/issues/123"
   * - { kind: "github.issue", owner: "org", repo: "repo", number: 123 }
   * - "file:///.../local-task.json"
   */
  contextLink?: string | Record<string, unknown>;

  // -----------------------------
  // People / Moderation (may be partial or huge)
  // -----------------------------

  /**
   * Known subscribers/watchers if available.
   * WARNING: can be huge or unknown; adapters may return partial data.
   */
  subscribers?: Array<{ id?: string; name?: string; externalId?: unknown }>;

  /**
   * Roles of the current identity inside this chat (member/moderator/bot/etc), if known.
   */
  roles?: string[];

  /** Known moderators/admins if available (often partial). */
  moderators?: Array<{ id?: string; name?: string; externalId?: unknown }>;

  /**
   * Reporting mechanisms available in this environment (if known).
   * Examples: abuse/fraud/bug.
   */
  reportKinds?: Array<"abuse" | "fraud" | "bug" | "other">;

  // -----------------------------
  // Limits / Policies (often provider-specific)
  // -----------------------------

  /**
   * Platform constraints and policies (if known).
   * Some of these may later be modeled as "capabilities".
   */
  limits?: {
    /** Max messages per time window (if known). */
    rateLimit?: { max?: number; perMs?: number };

    /** Max text length per message (if known). */
    maxTextChars?: number;

    /** Max attachment size in bytes (if known). */
    maxAttachmentBytes?: number;

    /** Allowed attachment types (if known). */
    allowedAttachmentKinds?: string[];
  };

  /** Free-form tags/labels (e.g., issue labels). */
  tags?: string[];

  /** Pinned messages or pinned references, if supported/available. */
  pinned?: Array<string | Record<string, unknown>>;

  /** Image/logo/icon reference (url or provider-specific structure). */
  image?: { url?: string; alt?: string } | string;

  /** External website for the chat/product/community if relevant. */
  website?: string;

  /**
   * API reference for the underlying system (docs/schema), if relevant.
   * Example: { type: "openapi", url: "...", meta: {...} }
   */
  apiReference?: { type: string; url?: string; meta?: Record<string, unknown> };

  // -----------------------------
  // Attachments (loose, optional)
  // -----------------------------

  /**
   * Links to attachments posted by the current identity or detected in the chat.
   * Many providers expose attachments as separate resources; keep it loose.
   */
  attachments?: Array<{ url?: string; kind?: string; meta?: Record<string, unknown> }>;

  // -----------------------------
  // Extension points
  // -----------------------------

  /**
   * Experimental/provider-specific fields that don't fit the normalized model yet.
   * Intentionally `any` to allow fast iteration.
   */
  extra?: any;

  /** Extra raw fields not mapped into the normalized shape. */
  _rawRest?: Record<string, unknown>;

  /**
   * Full raw payload as returned by the underlying adapter.
   * Potentially huge; avoid enabling by default in production.
   */
  _rawAll?: unknown;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

/**
 * Message is a unit of interaction inside a Chat.
 * Messages form a chat history and are the basis for future trajectories.
 */
export interface Message {
  id: string;
  chatId: string;
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
 * Artifact is a produced result associated with a Chat (not a Message).
 *
 * - `type` is a MIME-like string (e.g. "text/plain", "application/json", "image/png").
 * - `metadata` is optional, JSON-serializable extra data.
 */
export interface Artifact {
  id: string;
  chatId: string;
  type: string;
  parts: Part[];
  metadata?: JsonObject;
}

interface ChatEventBase {
  chatId: string;
  timestamp: Timestamp;
}

/**
 * Streaming & lifecycle events aligned with A2A semantics.
 *
 * Minimum Tier1 events:
 * - chat.started
 * - message.delta (streaming text)
 * - message.completed
 * - artifact.created
 * - chat.completed
 * - chat.failed
 */
export type ChatEvent =
  | (ChatEventBase & { type: "chat.started" })
  | (ChatEventBase & {
      type: "message.delta";
      messageId: string;
      /** Streaming delta for a text part. */
      delta: string;
      /** Optional index for ordering deltas when needed. */
      index?: number;
    })
  | (ChatEventBase & { type: "message.completed"; message: Message })
  | (ChatEventBase & { type: "artifact.created"; artifact: Artifact })
  | (ChatEventBase & { type: "chat.completed"; chat: TChat })
  | (ChatEventBase & { type: "chat.cancelled"; chat: TChat })
  | (ChatEventBase & { type: "chat.failed"; error: string });

/**
 * AgentEvent is a unified event stream type.
 * For Tier1 it's equivalent to ChatEvent, but may expand in future tiers.
 */
export type AgentEvent = ChatEvent;

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

export interface ChatsCreateMessage {
  type: "chats/create";
  chatId?: string;
  providerId?: string;
  title?: string;
  prompt?: string;
}

export interface ChatsCreatedMessage {
  type: "chats/created";
  chat: TChat;
}

export interface ChatsListMessage {
  type: "chats/list";
  providerId?: string;
  cursor?: string;
  limit?: string;
}

export interface ChatsListResultMessage {
  type: "chats/listResult";
  chats: TChat[];
  nextCursor?: string;
}

export interface ChatsGetMessage {
  type: "chats/get";
  chatId: string;
}

export interface ChatsGetResultMessage {
  type: "chats/getResult";
  chat: TChat;
}

export interface ChatsCancelMessage {
  type: "chats/cancel";
  chatId: string;
}

export interface ChatsCancelResultMessage {
  type: "chats/cancelResult";
  ok: true;
}

export interface ChatsSubscribeMessage {
  type: "chats/subscribe";
  chatId: string;
}

export interface ChatsErrorMessage {
  type: "chats/error";
  chatId?: string;
  error: string;
}

export type ClientToAgentMessage =
  | SessionStartMessage
  | SessionSendMessage
  | ChatsCreateMessage
  | ChatsListMessage
  | ChatsGetMessage
  | ChatsCancelMessage
  | ChatsSubscribeMessage;

export type AgentToClientMessage =
  | ReadyMessage
  | SessionStartedMessage
  | SessionStreamMessage
  | ToolCallPlaceholderMessage
  | SessionCompleteMessage
  | ChatsCreatedMessage
  | ChatsListResultMessage
  | ChatsGetResultMessage
  | ChatsCancelResultMessage
  | ChatsErrorMessage
  | ChatEvent;


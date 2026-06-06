/**
 * Bridge system types for the IM thin bridge core.
 */

// Re-export bridge-local types from host.ts so consumers can import from one place
export type { FileAttachment } from './host.js';

// ── Channel Types ──────────────────────────────────────────────

/**
 * Channel type identifier.
 * Extensible — any string is valid so new adapters can register without
 * modifying this definition. This repo ships Telegram-first shared logic,
 * while host repos own the actual adapter implementation.
 */
export type ChannelType = string;
export type SessionSource = 'bridge' | 'local-codex';

/** Unique address of a user within a channel */
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  topicId?: string;
  userId?: string;
  displayName?: string;
}

/** Composite key for routing: channelType + chatId */
export interface SessionKey {
  channelType: ChannelType;
  chatId: string;
  topicId?: string;
}

// ── Messages ───────────────────────────────────────────────────

/** Inbound message from an IM channel */
export interface InboundMessage {
  /** Platform-specific message ID (for dedup and reference) */
  messageId: string;
  /** Address of the sender */
  address: ChannelAddress;
  /** Plain text content of the message */
  text: string;
  /** Timestamp of the message (ISO string or unix epoch ms) */
  timestamp: number;
  /** If this is a callback query (inline button press), the callback data */
  callbackData?: string;
  /** For callback queries: the message ID of the original message that triggered the callback */
  callbackMessageId?: string;
  /** Platform-specific raw update object (for adapter-specific handling) */
  raw?: unknown;
  /** Adapter-specific update ID for deferred offset acknowledgement */
  updateId?: number;
  /** File attachments (images, documents) from the IM channel */
  attachments?: import('./host.js').FileAttachment[];
}

/** Shared anchor/context for every event emitted during one streamed reply. */
export interface StreamContext {
  address: ChannelAddress;
  inboundMessageId: string;
  replyToMessageId: string;
  sessionId: string;
  bindingId: string;
  sdkSessionId?: string;
}

/** Outbound message to send to an IM channel */
export interface OutboundMessage {
  /** Target address */
  address: ChannelAddress;
  /** Message text */
  text: string;
  /** Parse mode for the text */
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  /** Inline keyboard buttons */
  inlineButtons?: InlineButton[][];
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** Outbound file to send to an IM channel. */
export interface OutboundFileMessage {
  /** Target address */
  address: ChannelAddress;
  /** Local filesystem path to send */
  filePath: string;
  /** Optional user-visible filename override */
  fileName?: string;
  /** Optional MIME type hint */
  mimeType?: string;
  /** Optional short caption */
  caption?: string;
  /** Hint for platforms that distinguish compressed files from photos */
  kind?: 'photo' | 'document';
  /** If replying to a specific message */
  replyToMessageId?: string;
}

/** Inline keyboard button for permission prompts */
export interface InlineButton {
  text: string;
  callbackData: string;
}

/** Result of sending a message via an adapter */
export interface SendResult {
  ok: boolean;
  /** Platform-specific message ID of the sent message */
  messageId?: string;
  error?: string;
  /** Optional platform HTTP status used by retry/fallback handling. */
  httpStatus?: number;
  /** Optional retry-after seconds used by rate-limit handling. */
  retryAfter?: number;
}

// ── Bindings ───────────────────────────────────────────────────

/** Links an IM chat to a CodePilot session */
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  topicId?: string;
  /** CodePilot session ID this chat is bound to */
  codepilotSessionId: string;
  /** SDK session ID for resume (cached from last conversation) */
  sdkSessionId: string;
  /** Working directory for this binding */
  workingDirectory: string;
  /** Model override for this binding */
  model: string;
  /** Chat mode */
  mode: 'code' | 'plan' | 'ask';
  /** Whether this binding points to a bridge session or a local Codex session. */
  sessionSource?: SessionSource;
  /** Whether this binding is currently active */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Bridge Status ──────────────────────────────────────────────

/** Overall bridge system status */
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

/** Status of a single channel adapter */
export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// ── Audit & Dedup ──────────────────────────────────────────────

/** Audit log entry */
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

/** Permission link: maps permissionRequestId to an IM message for callback handling */
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  createdAt: string;
}

// ── Streaming Preview ─────────────────────────────────────────

/** Capabilities of a channel adapter's streaming preview support */
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

/** Mutable state for an in-flight streaming preview */
export interface StreamingPreviewState {
  draftId: number;
  chatId: string;
  lastSentText: string;
  lastSentAt: number;
  degraded: boolean;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;
}

// ── Tool Call Info ─────────────────────────────────────────────

/** Tool call tracking for streaming progress display */
export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

// ── Config ─────────────────────────────────────────────────────

/** Platform-specific message length limits */
export const PLATFORM_LIMITS: Record<string, number> = {
  telegram: 4096,
};

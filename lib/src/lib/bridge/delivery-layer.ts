/**
 * Delivery Layer — reliable outbound message delivery with chunking,
 * dedup, retry, and audit/reference tracking.
 */

import type { ChannelAddress, OutboundMessage, SendResult } from './types.js';
import { PLATFORM_LIMITS as limits } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { getBridgeContext } from './context.js';
import { ChatRateLimiter } from './security/rate-limiter.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;
const INTER_CHUNK_DELAY_MS = 300;
const DEFAULT_LIMIT = 4000;

const rateLimiter = new ChatRateLimiter();
setInterval(() => { rateLimiter.cleanup(); }, 5 * 60_000).unref();

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}

function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error' | 'network';

function classifyError(result: SendResult): ErrorCategory {
  const status = (result as { httpStatus?: number }).httpStatus;
  const error = result.error ?? '';

  if (status === 429) return 'rate_limit';
  if (status && status >= 500) return 'server_error';
  if (status && status >= 400 && status < 500) return 'client_error';
  if (/too many requests|rate limit|retry.after/i.test(error)) return 'rate_limit';
  return 'network';
}

function shouldRetry(category: ErrorCategory): boolean {
  return category === 'rate_limit' || category === 'server_error' || category === 'network';
}

function retryDelay(result: SendResult, attempt: number): number {
  const retryAfter = (result as { retryAfter?: number }).retryAfter;
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000 + 200;
  }
  return backoffDelay(attempt);
}

export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
  opts?: {
    sessionId?: string;
    dedupKey?: string;
  },
): Promise<SendResult> {
  const { store } = getBridgeContext();

  if (opts?.dedupKey && store.checkDedup(opts.dedupKey)) {
    return { ok: true, messageId: undefined };
  }

  if (Math.random() < 0.01) {
    try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  const limit = limits[adapter.channelType] || limits.telegram || DEFAULT_LIMIT;
  const chunks = chunkText(message.text, limit);
  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i += 1) {
    await rateLimiter.acquire(message.address.chatId);

    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
    }

    const chunkMessage: OutboundMessage = {
      ...message,
      text: chunks[i],
      inlineButtons: i === chunks.length - 1 ? message.inlineButtons : undefined,
      replyToMessageId: message.replyToMessageId,
    };

    const result = await sendWithRetry(adapter, chunkMessage);
    if (!result.ok) {
      return lastMessageId ? { ...result, messageId: lastMessageId } : result;
    }

    lastMessageId = result.messageId;

    if (result.messageId && opts?.sessionId) {
      try {
        store.insertOutboundRef({
          channelType: adapter.channelType,
          chatId: message.address.chatId,
          codepilotSessionId: opts.sessionId,
          platformMessageId: result.messageId,
          purpose: message.inlineButtons ? 'permission' : 'response',
        });
      } catch {
        // best effort
      }
    }
  }

  if (opts?.dedupKey) {
    try { store.insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  try {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: message.address.chatId,
      topicId: message.address.topicId,
      direction: 'outbound',
      messageId: lastMessageId || '',
      summary: message.text.slice(0, 200),
      bridgeSessionId: opts?.sessionId,
    });
  } catch {
    // best effort
  }

  return { ok: true, messageId: lastMessageId };
}

type RenderedChunk = {
  text: string;
  parseMode?: OutboundMessage['parseMode'];
};

async function sendWithRetry(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
): Promise<SendResult> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const result = await adapter.send(message);
    if (result.ok) return result;

    lastError = result.error;
    const category = classifyError(result);
    if (!shouldRetry(category)) {
      return result;
    }

    if (attempt < MAX_RETRIES - 1) {
      await new Promise(resolve => setTimeout(resolve, retryDelay(result, attempt)));
    }
  }

  return { ok: false, error: lastError || 'Max retries exceeded' };
}

/**
 * Compatibility shim for older callers that still send pre-rendered chunks.
 * The shared library now treats them as plain-text chunks.
 */
export async function deliverRendered(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  chunks: RenderedChunk[],
  opts?: {
    sessionId?: string;
    dedupKey?: string;
    replyToMessageId?: string;
    summaryText?: string;
  },
): Promise<SendResult> {
  const { store } = getBridgeContext();

  if (opts?.dedupKey && store.checkDedup(opts.dedupKey)) {
    return { ok: true, messageId: undefined };
  }

  if (Math.random() < 0.01) {
    try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i += 1) {
    await rateLimiter.acquire(address.chatId);

    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
    }

    const chunk = chunks[i];
    const result = await sendWithRetry(adapter, {
      address,
      text: chunk.text,
      parseMode: chunk.parseMode ?? 'plain',
      replyToMessageId: opts?.replyToMessageId,
    });
    if (!result.ok) {
      return lastMessageId ? { ...result, messageId: lastMessageId } : result;
    }

    lastMessageId = result.messageId;

    if (result.messageId && opts?.sessionId) {
      try {
        store.insertOutboundRef({
          channelType: adapter.channelType,
          chatId: address.chatId,
          codepilotSessionId: opts.sessionId,
          platformMessageId: result.messageId,
          purpose: 'response',
        });
      } catch {
        // best effort
      }
    }
  }

  if (opts?.dedupKey) {
    try { store.insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  const summary = (opts?.summaryText || chunks.map(chunk => chunk.text).join('\n')).slice(0, 200);
  try {
    store.insertAuditLog({
      channelType: adapter.channelType,
      chatId: address.chatId,
      topicId: address.topicId,
      direction: 'outbound',
      messageId: lastMessageId || '',
      summary,
      bridgeSessionId: opts?.sessionId,
    });
  } catch {
    // best effort
  }

  return { ok: true, messageId: lastMessageId };
}

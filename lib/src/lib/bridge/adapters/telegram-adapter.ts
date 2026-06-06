/**
 * Telegram Adapter — implements BaseChannelAdapter for Telegram Bot API.
 *
 * Uses long polling to consume updates, persists offset watermark to DB,
 * and routes messages/callbacks through an internal async queue.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundFileMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
  StreamContext,
  ToolCallInfo,
} from '../types.js';
import { escapeHtml } from './telegram-utils.js';
import type { FileAttachment } from '../types.js';
import { BaseChannelAdapter, registerAdapterFactory } from '../channel-adapter.js';
import { getBridgeContext } from '../context.js';
import { callTelegramApi, sendMessageDraft } from './telegram-utils.js';
import {
  isImageEnabled,
  downloadPhoto,
  downloadDocumentImage,
  downloadDocumentFile,
  isSupportedImageMime,
  inferMimeType,
} from './telegram-media.js';
import type { TelegramPhotoSize, TelegramDocument, MediaDownloadResult } from './telegram-media.js';

const TELEGRAM_API = 'https://api.telegram.org';

/** Max number of recent update_ids to keep for idempotency dedup on restart. */
const DEDUP_SET_MAX = 1000;

/** Derive a short token-specific hash for per-bot offset isolation. */
function tokenShortHash(botToken: string): string {
  return crypto.createHash('sha256').update(botToken).digest('hex').slice(0, 8);
}

interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number; first_name?: string; title?: string; username?: string };
  from?: { id: number; first_name: string; username?: string };
  sender_chat?: { id: number; title?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  media_group_id?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: { message_id: number; message_thread_id?: number; chat: { id: number } };
    data?: string;
  };
}

/** Media group debounce buffer entry for album messages. */
interface MediaGroupBufferEntry {
  updates: TelegramUpdate[];
  updateIds: number[];
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
  topicId?: string;
  userId: string;
  displayName: string;
}

interface TelegramLiveProgressState {
  messageId?: string;
  replyToMessageId: string;
  lastSentText: string;
  lastSentAt: number;
  pendingText: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  latestNarrative: string;
  toolStates: Map<string, ToolCallInfo>;
  closed: boolean;
  operationChain: Promise<void>;
}

/** Debounce window for media group messages (ms). */
const MEDIA_GROUP_DEBOUNCE_MS = 500;
const LIVE_PROGRESS_EDIT_INTERVAL_MS = 2500;
const LIVE_PROGRESS_HEARTBEAT_MS = 30000;
const LIVE_PROGRESS_MAX_CHARS = 3800;

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'telegram';

  private running = false;
  private abortController: AbortController | null = null;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private mediaGroupBuffers = new Map<string, MediaGroupBufferEntry>();
  /** Chat IDs where sendMessageDraft has permanently failed (method not found / 400 / 404). */
  private previewDegraded = new Set<string>();
  private liveProgress = new Map<string, TelegramLiveProgressState>();

  /** Committed offset — the highest update_id that has been safely enqueued or skipped. */
  private committedOffset = 0;
  /** In-memory set of recently processed update_ids for idempotency on restart. */
  private recentUpdateIds = new Set<number>();
  /** Stable bot user ID from Telegram's getMe, used for offset key identity. */
  private botUserId: string | null = null;

  get botToken(): string {
    return getBridgeContext().store.getSetting('telegram_bot_token') || '';
  }

  async preflight(): Promise<void> {
    const configError = this.validateConfig();
    if (configError) {
      throw new Error(configError);
    }
    await this.resolveBotIdentity();
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.preflight();

    this.running = true;
    this.abortController = new AbortController();

    // Register bot commands menu with Telegram
    this.registerCommands().catch(() => {});

    // Start polling in background (no await — runs until stop())
    this.pollLoop().catch(err => {
      console.error('[telegram-adapter] Poll loop error:', err);
    });

    console.log('[telegram-adapter] Started (botUserId:', this.botUserId, ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    // Persist committed offset before shutdown
    this.persistCommittedOffset();

    // Reject all waiting consumers
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    // Stop all typing indicators
    for (const [, interval] of this.typingIntervals) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Clear media group debounce timers
    for (const [, entry] of this.mediaGroupBuffers) {
      clearTimeout(entry.timer);
    }
    this.mediaGroupBuffers.clear();

    // Reset preview degradation state
    this.previewDegraded.clear();

    for (const [, progress] of this.liveProgress) {
      if (progress.flushTimer) clearTimeout(progress.flushTimer);
      if (progress.heartbeatTimer) clearInterval(progress.heartbeatTimer);
    }
    this.liveProgress.clear();

    console.log('[telegram-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    // If there's a queued message, return it immediately
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);

    // If not running, return null
    if (!this.running) return Promise.resolve(null);

    // Otherwise, wait for the poll loop to enqueue a message
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const token = this.botToken;
    if (!token) return { ok: false, error: 'No bot token configured' };

    const params: Record<string, unknown> = {
      chat_id: message.address.chatId,
      text: message.text,
      disable_web_page_preview: true,
    };
    if (message.address.topicId) {
      params.message_thread_id = message.address.topicId;
    }

    if (message.parseMode === 'HTML') {
      params.parse_mode = 'HTML';
    } else if (message.parseMode === 'Markdown') {
      params.parse_mode = 'Markdown';
    }

    if (message.replyToMessageId) {
      params.reply_to_message_id = message.replyToMessageId;
    }

    // Inline keyboard buttons
    if (message.inlineButtons && message.inlineButtons.length > 0) {
      params.reply_markup = {
        inline_keyboard: message.inlineButtons.map(row =>
          row.map(btn => ({
            text: btn.text,
            callback_data: btn.callbackData,
          }))
        ),
      };
    }

    return this.sendMessageWithReplyFallback(token, params);
  }

  async sendFile(message: OutboundFileMessage): Promise<SendResult> {
    const token = this.botToken;
    if (!token) return { ok: false, error: 'No bot token configured' };

    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(message.filePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'File read failed' };
    }

    const fileName = message.fileName || path.basename(message.filePath);
    const mimeType = message.mimeType || inferMimeType(fileName) || 'application/octet-stream';
    const isPhoto = message.kind === 'photo' || (message.kind !== 'document' && isSupportedImageMime(mimeType));
    const method = isPhoto ? 'sendPhoto' : 'sendDocument';
    const fieldName = isPhoto ? 'photo' : 'document';

    const params: Record<string, string> = {
      chat_id: message.address.chatId,
    };
    if (message.address.topicId) {
      params.message_thread_id = message.address.topicId;
    }
    if (message.replyToMessageId) {
      params.reply_to_message_id = message.replyToMessageId;
    }
    if (message.caption) {
      params.caption = message.caption.slice(0, 900);
    }

    return this.sendMultipartWithReplyFallback(token, method, params, fieldName, buffer, fileName, mimeType);
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || 'OK',
    });
  }

  validateConfig(): string | null {
    const token = getBridgeContext().store.getSetting('telegram_bot_token');
    if (!token) return 'telegram_bot_token not configured';

    const bridgeEnabled = getBridgeContext().store.getSetting('bridge_telegram_enabled');
    if (bridgeEnabled !== 'true') return 'bridge_telegram_enabled is not true';

    return null;
  }

  private resolveDisplayName(message: TelegramMessage): string {
    const chatId = String(message.chat.id);
    const isGroupLikeChat = chatId.startsWith('-');

    if (isGroupLikeChat) {
      return message.chat.title
        || message.chat.username
        || message.sender_chat?.title
        || message.sender_chat?.username
        || chatId;
    }

    return message.chat.first_name
      || message.chat.username
      || message.sender_chat?.title
      || message.sender_chat?.username
      || message.from?.username
      || message.from?.first_name
      || chatId;
  }

  isAuthorized(userId: string, chatId: string, senderChatId?: string): boolean {
    const ownerUserId = getBridgeContext().store.getSetting('telegram_bridge_owner_user_id') || '';
    const requirePrivateChat = getBridgeContext().store.getSetting('telegram_bridge_require_private_chat') !== 'false';
    const senderUsesBoundChatIdentity = !requirePrivateChat
      && senderChatId === chatId
      && this.hasTelegramBinding(chatId);

    if (ownerUserId) {
      if (userId !== ownerUserId && !senderUsesBoundChatIdentity) {
        return false;
      }
      if (requirePrivateChat && chatId !== ownerUserId) {
        return false;
      }
      if (senderUsesBoundChatIdentity) {
        return true;
      }
    }

    // Check bridge-specific allowed users first
    const allowedUsers = getBridgeContext().store.getSetting('telegram_bridge_allowed_users') || '';
    if (allowedUsers) {
      const allowed = allowedUsers.split(',').map(s => s.trim()).filter(Boolean);
      if (allowed.length > 0) {
        return allowed.includes(userId)
          || allowed.includes(chatId)
          || (senderChatId ? allowed.includes(senderChatId) : false);
      }
    }

    // Fallback: check notification bot's chat_id
    const notifyChatId = getBridgeContext().store.getSetting('telegram_chat_id') || '';
    if (notifyChatId) {
      return chatId === notifyChatId && userId === notifyChatId;
    }

    // No auth configured — deny by default
    return false;
  }

  private hasTelegramBinding(chatId: string): boolean {
    try {
      return getBridgeContext().store.listChannelBindings('telegram').some((binding) => binding.chatId === chatId);
    } catch {
      return false;
    }
  }

  /**
   * Start a typing indicator that fires every 5 seconds.
   */
  startTyping(chatId: string, topicId?: string): void {
    this.stopTyping(chatId, topicId); // Clear any existing
    const token = this.botToken;
    if (!token) return;
    const params = {
      chat_id: chatId,
      action: 'typing',
      ...(topicId ? { message_thread_id: topicId } : {}),
    };

    // Send immediately
    callTelegramApi(token, 'sendChatAction', params).catch(() => {});

    // Repeat every 5s
    const interval = setInterval(() => {
      callTelegramApi(token, 'sendChatAction', params).catch(() => {});
    }, 5000);
    this.typingIntervals.set(this.typingKey(chatId, topicId), interval);
  }

  /**
   * Stop the typing indicator for a chat.
   */
  stopTyping(chatId: string, topicId?: string): void {
    const key = this.typingKey(chatId, topicId);
    const interval = this.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(key);
    }
  }

  /**
   * Acknowledge that an update has been fully processed by the bridge-manager.
   * Only at this point do we advance the committed offset and persist it.
   * This ensures no message is lost if the process crashes between enqueue and processing.
   */
  acknowledgeUpdate(updateId: number): void {
    this.markUpdateProcessed(updateId);
    this.persistCommittedOffset();
  }

  // ── Streaming preview ────────────────────────────────────────

  getPreviewCapabilities(chatId: string): PreviewCapabilities | null {
    // Global kill switch
    if (getBridgeContext().store.getSetting('bridge_telegram_stream_enabled') === 'false') return null;

    // Private-only check: positive chatId = private, negative = group/channel
    const privateOnly = getBridgeContext().store.getSetting('bridge_telegram_stream_private_only') !== 'false';
    if (privateOnly && parseInt(chatId, 10) < 0) return null;

    // Already degraded for this chat
    if (this.previewDegraded.has(chatId)) return null;

    return { supported: true, privateOnly };
  }

  async sendPreview(chatId: string, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    const token = this.botToken;
    if (!token) return 'skip';

    const result = await sendMessageDraft(token, chatId, text, draftId);
    if (result.ok) return 'sent';

    // Classify failure
    const status = result.httpStatus;
    if (status === 400 || status === 404) {
      // Method not found or bad request — permanent degradation
      this.previewDegraded.add(chatId);
      return 'degrade';
    }
    // 429 (rate limit) or transient — skip this update but don't degrade
    return 'skip';
  }

  endPreview(_chatId: string, _draftId: number): void {
    // No-op: the final sendMessage naturally replaces the draft
  }

  // ── Lifecycle hooks (called generically by bridge-manager) ───

  onMessageStart(context: StreamContext): void {
    this.startTyping(context.address.chatId, context.address.topicId);
    if (!this.shouldShowLiveProgress(context.address)) return;
    void this.ensureLiveProgress(context, { narrative: '已收到，正在处理。', force: true });
  }

  onStreamText(context: StreamContext, fullText: string): void {
    if (!this.shouldShowLiveProgress(context.address)) return;
    void this.ensureLiveProgress(context, { narrative: fullText });
  }

  onToolEvent(context: StreamContext, tools: ToolCallInfo[]): void {
    if (!this.shouldShowLiveProgress(context.address)) return;
    void this.ensureLiveProgress(context, { tools });
  }

  onStreamHeartbeat(context: StreamContext, statusText: string): void {
    if (!this.shouldShowLiveProgress(context.address)) return;
    void this.ensureLiveProgress(context, { narrative: statusText, force: true });
  }

  async onStreamEnd(context: StreamContext, _status: 'completed' | 'interrupted' | 'error', _responseText: string): Promise<boolean> {
    await this.finishLiveProgress(context, true);
    return true;
  }

  onMessageEnd(context: StreamContext): void {
    void this.finishLiveProgress(context, false);
    this.stopTyping(context.address.chatId, context.address.topicId);
  }

  // ── Private ──────────────────────────────────────────────────

  private buildLiveProgressKey(context: StreamContext): string {
    return [
      context.address.channelType,
      context.address.chatId,
      context.address.topicId || '',
      context.replyToMessageId,
      context.sessionId,
    ].join(':');
  }

  private typingKey(chatId: string, topicId?: string): string {
    return topicId ? `${chatId}:topic:${topicId}` : chatId;
  }

  private shouldShowLiveProgress(address: ChannelAddress): boolean {
    const store = getBridgeContext().store;
    if (store.getSetting('bridge_telegram_stream_enabled') === 'false') return false;
    if (store.getSetting('bridge_telegram_live_progress_enabled') === 'false') return false;

    // Live progress is intentionally separate from draft streaming previews:
    // the owner uses group topics as first-class control rooms, so topics get a
    // small "processing" marker unless this newer switch explicitly limits it.
    const livePrivateOnly = store.getSetting('bridge_telegram_live_progress_private_only') === 'true';
    return !(livePrivateOnly && parseInt(address.chatId, 10) < 0);
  }

  private getOrCreateLiveProgressState(progressKey: string, context: StreamContext): TelegramLiveProgressState {
    let state = this.liveProgress.get(progressKey);
    if (!state) {
      state = {
        replyToMessageId: context.replyToMessageId,
        lastSentText: '',
        lastSentAt: 0,
        pendingText: '',
        flushTimer: null,
        heartbeatTimer: null,
        latestNarrative: '',
        toolStates: new Map<string, ToolCallInfo>(),
        closed: false,
        operationChain: Promise.resolve(),
      };
      this.liveProgress.set(progressKey, state);
    }
    return state;
  }

  private enqueueLiveProgressOperation(
    progressKey: string,
    task: (state: TelegramLiveProgressState) => Promise<void> | void,
  ): Promise<void> {
    const state = this.liveProgress.get(progressKey);
    if (!state) return Promise.resolve();

    const next = state.operationChain.then(async () => {
      const current = this.liveProgress.get(progressKey);
      if (!current || current !== state) return;
      await task(current);
    });
    state.operationChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async finishLiveProgress(context: StreamContext, flush: boolean): Promise<void> {
    const progressKey = this.buildLiveProgressKey(context);
    const state = this.liveProgress.get(progressKey);
    if (!state) return;

    await this.enqueueLiveProgressOperation(progressKey, async (current) => {
      if (current.closed) return;
      current.closed = true;
      if (current.flushTimer) {
        clearTimeout(current.flushTimer);
        current.flushTimer = null;
      }
      if (current.heartbeatTimer) {
        clearInterval(current.heartbeatTimer);
        current.heartbeatTimer = null;
      }

      if (flush && current.messageId) {
        const token = this.botToken;
        if (token) {
          await callTelegramApi(token, 'deleteMessage', {
            chat_id: context.address.chatId,
            message_id: Number(current.messageId),
          });
        }
      }

      this.liveProgress.delete(progressKey);
    });
  }

  private async ensureLiveProgress(
    context: StreamContext,
    update: { narrative?: string; tools?: ToolCallInfo[]; force?: boolean },
  ): Promise<void> {
    const progressKey = this.buildLiveProgressKey(context);
    const state = this.getOrCreateLiveProgressState(progressKey, context);
    if (!state.heartbeatTimer) {
      state.heartbeatTimer = setInterval(() => {
        const current = this.liveProgress.get(progressKey);
        if (!current || current.closed) return;
        const fallback = current.latestNarrative || 'Still working, task is still running.';
        void this.ensureLiveProgress(context, { narrative: fallback, force: true });
      }, LIVE_PROGRESS_HEARTBEAT_MS);
    }
    if (state.closed) return;

    if (update.narrative) {
      const normalizedNarrative = update.narrative.trim();
      if (normalizedNarrative) {
        state.latestNarrative = normalizedNarrative;
      }
    }
    for (const tool of update.tools ?? []) {
      const previous = state.toolStates.get(tool.id);
      state.toolStates.set(tool.id, {
        id: tool.id,
        name: tool.name || previous?.name || 'Tool',
        status: tool.status,
      });
    }

    const normalized = this.normalizeLiveProgressText(state.latestNarrative, Array.from(state.toolStates.values()));
    if (!normalized) return;
    state.pendingText = normalized;
    const elapsed = Date.now() - state.lastSentAt;
    const shouldFlushNow = update.force || !state.messageId || elapsed >= LIVE_PROGRESS_EDIT_INTERVAL_MS;
    if (shouldFlushNow) {
      await this.enqueueLiveProgressOperation(progressKey, async () => {
        await this.flushLiveProgress(progressKey, context.address, !!update.force);
      });
      return;
    }

    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      const queued = this.liveProgress.get(progressKey);
      if (!queued || queued.closed) return;
      queued.flushTimer = null;
      void this.enqueueLiveProgressOperation(progressKey, async () => {
        await this.flushLiveProgress(progressKey, context.address, false);
      });
    }, Math.max(0, LIVE_PROGRESS_EDIT_INTERVAL_MS - elapsed));
  }

  private normalizeLiveProgressText(narrative: string, tools: ToolCallInfo[]): string {
    const sections: string[] = [];
    const trimmedNarrative = narrative.trim();
    if (trimmedNarrative) {
      sections.push(escapeHtml(
        trimmedNarrative.length > LIVE_PROGRESS_MAX_CHARS
          ? trimmedNarrative.slice(0, LIVE_PROGRESS_MAX_CHARS)
          : trimmedNarrative,
      ));
    }

    if (tools.length > 0) {
      const toolLines = tools
        .slice(-6)
        .map((tool) => `${escapeHtml(tool.name || 'Tool')}: ${escapeHtml(tool.status)}`);
      sections.push(`<b>Tools</b>\n${toolLines.join('\n')}`);
    }

    if (sections.length === 0) return '';
    return `<b>处理中...</b>\n\n${sections.join('\n\n')}`;
  }

  private async flushLiveProgress(progressKey: string, address: ChannelAddress, force: boolean): Promise<void> {
    const state = this.liveProgress.get(progressKey);
    if (!state || (state.closed && !force)) return;
    const text = state.pendingText.trim();
    if (!text) return;
    if (text === state.lastSentText && state.messageId) return;

    const token = this.botToken;
    if (!token) return;

    if (!state.messageId) {
      const sendResult = await this.sendMessageWithReplyFallback(token, {
        chat_id: address.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_to_message_id: state.replyToMessageId,
        ...(address.topicId ? { message_thread_id: address.topicId } : {}),
      });
      if (sendResult.ok) {
        state.messageId = sendResult.messageId;
        state.lastSentText = text;
        state.lastSentAt = Date.now();
      }
      return;
    }

    const editResult = await callTelegramApi(token, 'editMessageText', {
      chat_id: address.chatId,
      message_id: Number(state.messageId),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (editResult.ok || /message is not modified/i.test(editResult.error || '')) {
      state.lastSentText = text;
      state.lastSentAt = Date.now();
    }
  }

  private async sendMessageWithReplyFallback(
    token: string,
    params: Record<string, unknown>,
  ): Promise<SendResult> {
    const result = await callTelegramApi(token, 'sendMessage', params);
    if (result.ok || !params.reply_to_message_id || !this.isReplyAnchorMissing(result)) {
      return result;
    }

    const fallbackParams = { ...params };
    delete fallbackParams.reply_to_message_id;
    return callTelegramApi(token, 'sendMessage', fallbackParams);
  }

  private async sendMultipartWithReplyFallback(
    token: string,
    method: string,
    params: Record<string, string>,
    fileField: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<SendResult> {
    const result = await this.callTelegramMultipart(token, method, params, fileField, buffer, fileName, mimeType);
    if (result.ok || !params.reply_to_message_id || !this.isReplyAnchorMissing(result)) {
      return result;
    }

    const fallbackParams = { ...params };
    delete fallbackParams.reply_to_message_id;
    return this.callTelegramMultipart(token, method, fallbackParams, fileField, buffer, fileName, mimeType);
  }

  private async callTelegramMultipart(
    token: string,
    method: string,
    params: Record<string, string>,
    fileField: string,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<SendResult> {
    try {
      const form = new FormData();
      for (const [key, value] of Object.entries(params)) {
        form.append(key, value);
      }
      const bytes = new Uint8Array(buffer);
      form.append(fileField, new Blob([bytes], { type: mimeType }), fileName);

      const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: 'POST',
        body: form,
      });
      const httpStatus = res.status;
      const data: any = await res.json();
      if (!data.ok) {
        return {
          ok: false,
          error: data.description || 'Unknown Telegram API error',
          httpStatus,
          retryAfter: data.parameters?.retry_after,
        };
      }
      return {
        ok: true,
        messageId: data.result?.message_id != null ? String(data.result.message_id) : undefined,
        httpStatus,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  private isReplyAnchorMissing(result: SendResult): boolean {
    const status = (result as { httpStatus?: number }).httpStatus;
    if (status !== 400) return false;
    return /reply|replied|message to be replied|not found/i.test(result.error || '');
  }

  /**
   * Register slash commands with Telegram Bot API so they appear in the menu.
   */
  private async registerCommands(): Promise<void> {
    const token = this.botToken;
    if (!token) return;

    await callTelegramApi(token, 'setMyCommands', {
      commands: [
        { command: 'new', description: 'Start new session (optionally specify path)' },
        { command: 'bind', description: 'Bind to bridge or local Codex session' },
        { command: 'cwd', description: 'Change working directory' },
        { command: 'mode', description: 'Switch mode: plan / code / ask' },
        { command: 'status', description: 'Show current session status' },
        { command: 'sessions', description: 'List recent bridge and local Codex sessions' },
        { command: 'stop', description: 'Stop current task' },
        { command: 'help', description: 'Show available commands' },
      ],
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Return the DB key used to store the offset, scoped to the bot's stable identity.
   * Uses the bot user ID (from getMe) which survives token rotation.
   * Falls back to the token hash if getMe was not successful.
   */
  private offsetKey(): string {
    if (this.botUserId) {
      return 'telegram:bot' + this.botUserId;
    }
    const token = this.botToken;
    if (!token) return 'telegram';
    return 'telegram:' + tokenShortHash(token);
  }

  /**
   * Resolve the bot's stable user ID via Telegram's getMe API.
   * On first startup with bot-ID-based key, migrates the offset from the
   * old token-hash-based key so no messages are re-fetched.
   */
  private async resolveBotIdentity(): Promise<void> {
    const token = this.botToken;
    if (!token) throw new Error('No Telegram bot token configured');
    if (this.botUserId) return;

    try {
      const url = `${TELEGRAM_API}/bot${token}/getMe`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      const data: any = await res.json();
      if (data.ok && data.result?.id) {
        this.botUserId = String(data.result.id);

        // Migrate offset from old token-hash key to new bot-ID key
        const newKey = 'telegram:bot' + this.botUserId;
        const oldKey = 'telegram:' + tokenShortHash(token);
        const existingNew = getBridgeContext().store.getChannelOffset(newKey);
        if (!existingNew || existingNew === '0') {
          const existingOld = getBridgeContext().store.getChannelOffset(oldKey);
          if (existingOld && existingOld !== '0') {
            getBridgeContext().store.setChannelOffset(newKey, existingOld);
            console.log(`[telegram-adapter] Migrated offset from ${oldKey} to ${newKey}: ${existingOld}`);
          }
        }
      } else {
        throw new Error('Telegram getMe did not return a valid bot identity');
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Mark an update as safely processed (enqueued or intentionally skipped).
   *
   * Uses contiguous watermark advancement: committedOffset only advances when
   * there are no gaps (e.g., media-group updates still buffered) below it.
   * This prevents offset from jumping past un-flushed album messages.
   */
  private markUpdateProcessed(updateId: number): void {
    if (this.committedOffset === 0 || updateId < this.committedOffset) {
      this.committedOffset = updateId;
    }

    this.recentUpdateIds.add(updateId);

    // Walk committedOffset forward contiguously — only advance while
    // the current position has been confirmed as processed.
    while (this.recentUpdateIds.has(this.committedOffset)) {
      this.committedOffset++;
    }

    // Prune dedup set when it exceeds capacity
    if (this.recentUpdateIds.size > DEDUP_SET_MAX) {
      const excess = this.recentUpdateIds.size - DEDUP_SET_MAX;
      let removed = 0;
      for (const id of this.recentUpdateIds) {
        if (removed >= excess) break;
        this.recentUpdateIds.delete(id);
        removed++;
      }
    }
  }

  /**
   * Persist the committed offset to DB. Safe to call at any time.
   */
  private persistCommittedOffset(): void {
    if (this.committedOffset <= 0) return;
    try {
      getBridgeContext().store.setChannelOffset(this.offsetKey(), String(this.committedOffset));
    } catch { /* best effort */ }
  }

  private async pollLoop(): Promise<void> {
    const key = this.offsetKey();

    // Load persisted committed offset
    this.committedOffset = parseInt(getBridgeContext().store.getChannelOffset(key), 10) || 0;

    // fetchOffset is used for the getUpdates API call; starts at committed offset
    let fetchOffset = this.committedOffset;

    while (this.running) {
      try {
        const token = this.botToken;
        if (!token) {
          console.warn('[telegram-adapter] No bot token, waiting...');
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const url = `${TELEGRAM_API}/bot${token}/getUpdates`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: fetchOffset,
            timeout: 30,
            allowed_updates: [
              'message',
              'edited_message',
              'channel_post',
              'edited_channel_post',
              'callback_query',
            ],
          }),
          signal: this.abortController?.signal,
        });

        if (!this.running) break;

        const data: any = await res.json();
        if (!data.ok || !Array.isArray(data.result)) {
          const fatalErrorCode = data?.error_code;
          const message = `getUpdates failed: ${JSON.stringify(data).slice(0, 200)}`;
          if (res.status >= 400 || fatalErrorCode === 401 || fatalErrorCode === 403) {
            this.running = false;
            throw new Error(message);
          }
          console.warn('[telegram-adapter] getUpdates failed:', JSON.stringify(data).slice(0, 200));
          continue;
        }
        const updates: TelegramUpdate[] = data.result;
        for (const update of updates) {
          // Advance fetchOffset so the next getUpdates call skips this update
          if (update.update_id >= fetchOffset) {
            fetchOffset = update.update_id + 1;
          }

          // Idempotency: skip updates already processed (dedup on restart)
          if (this.recentUpdateIds.has(update.update_id)) {
            this.markUpdateProcessed(update.update_id);
            continue;
          }

          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message?.chat.id ? String(cb.message.chat.id) : '';
            const topicId = cb.message?.message_thread_id ? String(cb.message.message_thread_id) : undefined;
            const userId = String(cb.from.id);

            if (!this.isAuthorized(userId, chatId)) {
              console.warn('[telegram-adapter] Unauthorized callback from userId:', userId, 'chatId:', chatId);
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const msg: InboundMessage = {
              messageId: cb.id,
              address: {
                channelType: 'telegram',
                chatId,
                topicId,
                userId,
                displayName: cb.from.username || cb.from.first_name,
              },
              text: '',
              timestamp: Date.now(),
              callbackData: cb.data,
              callbackMessageId: cb.message?.message_id ? String(cb.message.message_id) : undefined,
              raw: update,
              updateId: update.update_id,
            };

            this.enqueue(msg);
          } else {
            const m = this.extractTelegramMessage(update);
            if (!m) {
              console.warn(
                '[telegram-adapter] Ignoring unsupported update type:',
                this.describeUpdate(update),
              );
              this.markUpdateProcessed(update.update_id);
              continue;
            }
            const chatId = String(m.chat.id);
            const topicId = m.message_thread_id ? String(m.message_thread_id) : undefined;
            const senderChatId = m.sender_chat ? String(m.sender_chat.id) : undefined;
            const userId = senderChatId ?? (m.from ? String(m.from.id) : chatId);
            const displayName = this.resolveDisplayName(m);

            if (!this.isAuthorized(userId, chatId, senderChatId)) {
              console.warn(
                '[telegram-adapter] Unauthorized message from userId:',
                userId,
                'chatId:',
                chatId,
                'senderChatId:',
                senderChatId ?? '-',
              );
              this.markUpdateProcessed(update.update_id);
              continue;
            }

            const hasPhoto = m.photo && m.photo.length > 0;
            const hasDocument = !!m.document;
            const hasMedia = hasPhoto || hasDocument;

            // Unified text extraction: text for regular messages, caption for media messages
            const messageText = m.text ?? m.caption ?? '';

            if (hasMedia && (hasDocument || isImageEnabled())) {
              if (m.media_group_id) {
                // Album message — buffer for debounce, advance fetchOffset immediately
                this.bufferMediaGroup(m.media_group_id, update, chatId, topicId, userId, displayName);
                // Don't markUpdateProcessed yet — offset will be committed on flush
              } else {
                // Single file/image message — process immediately
                await this.processSingleFileMessage(update.update_id, m, chatId, userId, displayName);
              }
            } else if (messageText) {
              // Text/caption message (covers: pure text, image_enabled=false + caption,
              // unsupported document + caption)
              const msg: InboundMessage = {
                messageId: String(m.message_id),
                address: {
                  channelType: 'telegram',
                  chatId,
                  topicId,
                  userId,
                  displayName,
                },
                text: messageText,
                timestamp: m.date * 1000,
                raw: update,
                updateId: update.update_id,
              };

              // Audit log
              try {
                getBridgeContext().store.insertAuditLog({
                  channelType: 'telegram',
                  chatId,
                  topicId,
                  direction: 'inbound',
                  messageId: String(m.message_id),
                  summary: messageText.slice(0, 200),
                });
              } catch { /* best effort */ }

              this.enqueue(msg);
            } else {
              // Unhandled message payload (sticker, voice, etc.) — skip
              this.markUpdateProcessed(update.update_id);
            }
          }
        }

        // Persist committed offset after processing the batch
        this.persistCommittedOffset();
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') break;
        console.warn('[telegram-adapter] Polling error:', err instanceof Error ? err.message : err);
        // Persist whatever we've safely committed before backing off
        this.persistCommittedOffset();
        if (this.running) {
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
  }

  /**
   * Check if a Telegram document is a supported image type.
   */
  private isDocumentImage(doc: TelegramDocument): boolean {
    if (doc.mime_type && isSupportedImageMime(doc.mime_type)) return true;
    if (doc.file_name) {
      const mime = inferMimeType(doc.file_name);
      if (mime && isSupportedImageMime(mime)) return true;
    }
    return false;
  }

  /**
   * Process a single file or image message (no media_group_id).
   * Downloads the file and enqueues a message with attachments.
   * Sends rejection notifications directly to Telegram on failure.
   */
  private async processSingleFileMessage(
    updateId: number,
    m: TelegramMessage,
    chatId: string,
    userId: string,
    displayName: string,
  ): Promise<void> {
    const token = this.botToken;
    const topicId = m.message_thread_id ? String(m.message_thread_id) : undefined;
    const address = { channelType: 'telegram' as const, chatId, topicId, userId, displayName };

    if (!token) {
      this.markUpdateProcessed(updateId);
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];

    const imageEnabled = isImageEnabled();

    if (imageEnabled && m.photo && m.photo.length > 0) {
      const result = await downloadPhoto(token, m.photo, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    } else if (m.document) {
      const result = this.isDocumentImage(m.document)
        ? await downloadDocumentImage(token, m.document, String(m.message_id))
        : await downloadDocumentFile(token, m.document, String(m.message_id));
      if (result.attachment) {
        attachments.push(result.attachment);
      } else if (result.rejected && result.rejected !== 'unsupported_type') {
        rejections.push(result);
      }
    }

    // Send rejection notification directly to user
    if (rejections.length > 0) {
      const notice = rejections.map(r => r.rejectedMessage || 'File processing failed').join('\n');
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = m.caption || m.text || '';
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // Nothing usable (all files failed, no text) — mark processed
      this.markUpdateProcessed(updateId);
      return;
    }

    const summary = attachments.length > 0
      ? `[${attachments.length} file(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    // Audit log
    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'telegram',
        chatId,
        topicId,
        direction: 'inbound',
        messageId: String(m.message_id),
        summary,
      });
    } catch { /* best effort */ }

    const msg: InboundMessage = {
      messageId: String(m.message_id),
      address,
      text,
      timestamp: m.date * 1000,
      raw: { update_id: updateId, message: m },
      updateId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }

  private extractTelegramMessage(update: TelegramUpdate): TelegramMessage | null {
    return update.message
      || update.edited_message
      || update.channel_post
      || update.edited_channel_post
      || null;
  }

  private describeUpdate(update: TelegramUpdate): string {
    const keys = Object.keys(update).filter((key) => key !== 'update_id');
    return keys.join(', ') || 'unknown';
  }

  /**
   * Buffer a media group update for debounced processing.
   * Resets the 500ms timer on each new update in the same group.
   */
  private bufferMediaGroup(
    mediaGroupId: string,
    update: TelegramUpdate,
    chatId: string,
    topicId: string | undefined,
    userId: string,
    displayName: string,
  ): void {
    const existing = this.mediaGroupBuffers.get(mediaGroupId);

    if (existing) {
      // Add to existing buffer, reset timer
      clearTimeout(existing.timer);
      existing.updates.push(update);
      existing.updateIds.push(update.update_id);
      existing.timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
    } else {
      // New buffer
      const timer = setTimeout(() => this.flushMediaGroup(mediaGroupId), MEDIA_GROUP_DEBOUNCE_MS);
      this.mediaGroupBuffers.set(mediaGroupId, {
        updates: [update],
        updateIds: [update.update_id],
        timer,
        chatId,
        topicId,
        userId,
        displayName,
      });
    }
  }

  /**
   * Flush a media group buffer — download all files/images and enqueue a single message.
   */
  private async flushMediaGroup(mediaGroupId: string): Promise<void> {
    const entry = this.mediaGroupBuffers.get(mediaGroupId);
    if (!entry) return;
    this.mediaGroupBuffers.delete(mediaGroupId);

    const address = {
      channelType: 'telegram' as const,
      chatId: entry.chatId,
      topicId: entry.topicId,
      userId: entry.userId,
      displayName: entry.displayName,
    };

    const token = this.botToken;
    if (!token) {
      // Can't download — mark all as processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const attachments: FileAttachment[] = [];
    const rejections: MediaDownloadResult[] = [];
    let caption = '';
    let firstMessageId = '';
    let firstDate = 0;

    // Download all files/images in the group
    for (const update of entry.updates) {
      const m = update.message!;
      if (!firstMessageId) {
        firstMessageId = String(m.message_id);
        firstDate = m.date;
      }
      // Use caption from whichever update has it (Telegram only sends caption on one)
      if (m.caption && !caption) {
        caption = m.caption;
      }

      const imageEnabled = isImageEnabled();

      if (imageEnabled && m.photo && m.photo.length > 0) {
        const result = await downloadPhoto(token, m.photo, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      } else if (m.document) {
        const result = this.isDocumentImage(m.document)
          ? await downloadDocumentImage(token, m.document, String(m.message_id))
          : await downloadDocumentFile(token, m.document, String(m.message_id));
        if (result.attachment) {
          attachments.push(result.attachment);
        } else if (result.rejected && result.rejected !== 'unsupported_type') {
          rejections.push(result);
        }
      }
    }

    // Send rejection notification if any files failed
    if (rejections.length > 0) {
      const reasons = rejections.map(r => r.rejectedMessage || 'File processing failed').join('\n');
      const notice = rejections.length === 1
        ? reasons
        : `${rejections.length} file(s) failed:\n${reasons}`;
      this.send({ address, text: notice, parseMode: 'plain' }).catch(() => {});
    }

    const text = caption;
    const hasContent = attachments.length > 0 || text.trim();

    if (!hasContent) {
      // All downloads failed and no caption — mark all processed
      for (const uid of entry.updateIds) {
        this.markUpdateProcessed(uid);
      }
      this.persistCommittedOffset();
      return;
    }

    const summary = attachments.length > 0
      ? `[Album: ${attachments.length} file(s)] ${text.slice(0, 150)}`
      : text.slice(0, 200);

    try {
      getBridgeContext().store.insertAuditLog({
        channelType: 'telegram',
        chatId: entry.chatId,
        topicId: entry.topicId,
        direction: 'inbound',
        messageId: firstMessageId,
        summary,
      });
    } catch { /* best effort */ }

    // Use the max updateId so acknowledgeUpdate advances offset past all buffered updates
    const maxUpdateId = Math.max(...entry.updateIds);

    // Pre-register all buffered IDs in recentUpdateIds so the contiguous
    // watermark walk can advance past them when bridge-manager acks maxUpdateId.
    for (const uid of entry.updateIds) {
      this.recentUpdateIds.add(uid);
    }

    const msg: InboundMessage = {
      messageId: firstMessageId,
      address,
      text,
      timestamp: firstDate * 1000,
      updateId: maxUpdateId,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    this.enqueue(msg);
  }
}

// Self-register so bridge-manager can create TelegramAdapter via the registry.
registerAdapterFactory('telegram', () => new TelegramAdapter());

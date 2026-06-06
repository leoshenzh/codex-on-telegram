/**
 * Bridge Manager — singleton orchestrator for the IM thin bridge.
 *
 * The shared library keeps only generic bridge behavior here. Platform
 * transport details stay in the consuming host repository.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  BridgeStatus,
  ChannelBinding,
  InboundMessage,
  OutboundFileMessage,
  SendResult,
  StreamContext,
} from './types.js';
import { createAdapter, getRegisteredTypes } from './channel-adapter.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import './adapters/index.js';
import * as router from './channel-router.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver, deliverRendered } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import {
  findLocalCodexSessionsByPrefix,
  listLocalCodexSessions,
} from './local-codex-sessions.js';
import { markdownToTelegramChunks } from './markdown/telegram.js';
import { getAddressRouteId } from './addressing.js';
import {
  validateWorkingDirectory,
  isDangerousInput,
  sanitizeInput,
  validateMode,
} from './security/validators.js';
import {
  startOutboxPushWatcher,
  stopOutboxPushWatcher,
} from './outbox-push-watcher.js';

const GLOBAL_KEY = '__bridge_manager__';
const SESSION_LOOKUP_PATTERN = /^[0-9a-f-]{6,64}$/i;
const SESSION_ID_DISPLAY_LENGTH = 13;

interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}

const STREAM_DEFAULTS: Record<string, StreamConfig> = {
  telegram: { intervalMs: 1200, minDeltaChars: 40, maxChars: 3800 },
};

const OUTBOUND_FILE_MARKER = /<!--\s*cti-send-file:\s*([^>]+?)\s*-->|\[cti-send-file:\s*([^\]]+?)\s*\]/gi;
const DEFAULT_OUTBOUND_FILE_LIMIT = 50 * 1024 * 1024;
const MAX_OUTBOUND_FILES = 5;
const SENSITIVE_FILE_PATTERN = /(^|[._-])(env|npmrc|pypirc|netrc|pgpass|secret|token|credentials?|auth|config|database|db|backup|dump|private[_-]?key|id_rsa|id_ed25519|kubeconfig|passwd|passwords?)([._-]|$)|\.(key|pem|p12|pfx|sqlite|sqlite3|db|sql|bak|dump)$/i;
const DEFAULT_SESSION_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

function getSessionLockTimeoutMs(): number {
  const raw = process.env.CTI_SESSION_LOCK_TIMEOUT_MS;
  if (!raw) return DEFAULT_SESSION_LOCK_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_LOCK_TIMEOUT_MS;
}

interface AdapterMeta {
  lastMessageAt: string | null;
  lastError: string | null;
}

interface OutboundFileRequest {
  filePath: string;
  fileName: string;
  mimeType: string;
  kind: 'photo' | 'document';
}

interface OutboundFileExtraction {
  cleanText: string;
  files: OutboundFileRequest[];
  notices: string[];
}

interface BridgeManagerState {
  running: boolean;
  startedAt: string | null;
  adapters: BaseChannelAdapter[];
  adapterMeta: Map<string, AdapterMeta>;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  sessionLocks: Map<string, Promise<void>>;
}

function getState(): BridgeManagerState {
  const globalState = globalThis as Record<string, unknown>;
  if (!globalState[GLOBAL_KEY]) {
    globalState[GLOBAL_KEY] = {
      running: false,
      startedAt: null,
      adapters: [],
      adapterMeta: new Map<string, AdapterMeta>(),
      loopAborts: new Map<string, AbortController>(),
      activeTasks: new Map<string, AbortController>(),
      sessionLocks: new Map<string, Promise<void>>(),
    } satisfies BridgeManagerState;
  }
  return globalState[GLOBAL_KEY] as BridgeManagerState;
}

function processWithSessionLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  const state = getState();
  const previous = state.sessionLocks.get(sessionId) || Promise.resolve();
  // Wall-clock cap on any single turn so a wedged provider call can't block
  // the per-session queue forever. Underlying fn() may keep running in the
  // background; the lock advances so the next queued message can proceed.
  // The optional onTimeout callback lets the caller release outer-scope
  // resources (heartbeat timers, AbortControllers, activeTasks entries) that
  // would otherwise leak because fn()'s own `finally` never runs while it
  // is hung.
  const wrapped = (): Promise<T> => {
    const timeoutMs = getSessionLockTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        console.warn(
          `[bridge-manager] session-lock timeout after ${timeoutMs}ms for session ${sessionId}; advancing queue`,
        );
        if (onTimeout) {
          try {
            onTimeout();
          } catch (err) {
            console.warn(
              '[bridge-manager] session-lock onTimeout callback failed:',
              err instanceof Error ? err.message : err,
            );
          }
        }
        reject(new Error(`session-lock timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const task = fn();
    return Promise.race([task, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
  const current = previous.then(wrapped, wrapped);
  const cleanup = current.then(() => undefined, () => undefined);
  state.sessionLocks.set(sessionId, cleanup);
  cleanup.finally(() => {
    if (state.sessionLocks.get(sessionId) === cleanup) {
      state.sessionLocks.delete(sessionId);
    }
  }).catch(() => {});
  return current;
}

function buildStreamContext(msg: InboundMessage, binding: ChannelBinding): StreamContext {
  return {
    address: msg.address,
    inboundMessageId: msg.messageId,
    replyToMessageId: msg.messageId,
    bindingId: binding.id,
    sessionId: binding.codepilotSessionId,
    sdkSessionId: binding.sdkSessionId || undefined,
  };
}

function syncBridgeSessionTitle(msg: InboundMessage, binding: ChannelBinding): void {
  if (binding.sessionSource === 'local-codex') return;

  const { store } = getBridgeContext();
  const session = store.getSession(binding.codepilotSessionId);
  if (!session || session.source === 'local-codex') return;

  const desiredTitle = router.buildBridgeSessionTitle(msg.address);
  if (!desiredTitle || session.display_name === desiredTitle) return;

  store.upsertSession({
    ...session,
    display_name: desiredTitle,
    updated_at: session.updated_at || new Date().toISOString(),
    source: session.source || 'bridge',
  });

}

function validateSessionLookupKey(id: string): boolean {
  return SESSION_LOOKUP_PATTERN.test(id.trim());
}

function formatSessionSourceLabel(source?: string): string {
  return source === 'local-codex' ? 'This Mac Codex' : 'Bridge';
}

function formatSessionShortId(id: string): string {
  return id.slice(0, SESSION_ID_DISPLAY_LENGTH);
}

function listSessionChoices(): import('./host.js').BridgeSession[] {
  const { store } = getBridgeContext();
  const bridgeSessions = store.listSessions({ limit: 100 });
  const knownIds = new Set<string>();
  for (const session of bridgeSessions) {
    knownIds.add(session.id);
    if (session.sdk_session_id) {
      knownIds.add(session.sdk_session_id);
    }
  }
  const localSessions = listLocalCodexSessions(100)
    .filter(session => !knownIds.has(session.id))
    .map(session => ({
      id: session.id,
      working_directory: session.workingDirectory,
      model: '',
      sdk_session_id: session.id,
      display_name: session.displayName || `Local Codex (${session.source})`,
      updated_at: session.updatedAt,
      source: 'local-codex',
    }));

  return [...bridgeSessions, ...localSessions].sort((a, b) => {
    const aTime = Date.parse(a.updated_at || '') || 0;
    const bTime = Date.parse(b.updated_at || '') || 0;
    return bTime - aTime;
  });
}

function resolveSessionLookup(input: string): {
  session: import('./host.js').BridgeSession | null;
  ambiguousMatches: import('./host.js').BridgeSession[];
} {
  const trimmed = input.trim().toLowerCase();
  const sessions = listSessionChoices();
  const seenIds = new Set<string>();
  for (const session of sessions) {
    seenIds.add(session.id);
    if (session.sdk_session_id) {
      seenIds.add(session.sdk_session_id);
    }
  }
  const exact = sessions.find((session) => {
    const primaryId = session.id.toLowerCase();
    const sdkId = session.sdk_session_id?.toLowerCase();
    return primaryId === trimmed || sdkId === trimmed;
  });
  if (exact) {
    return { session: exact, ambiguousMatches: [] };
  }

  const prefixMatches = sessions.filter((session) => {
    const primaryId = session.id.toLowerCase();
    const sdkId = session.sdk_session_id?.toLowerCase();
    return primaryId.startsWith(trimmed) || Boolean(sdkId && sdkId.startsWith(trimmed));
  });
  if (prefixMatches.length === 1) {
    return { session: prefixMatches[0], ambiguousMatches: [] };
  }

  const fallbackLocalMatches = findLocalCodexSessionsByPrefix(trimmed, 20)
    .filter(session => !seenIds.has(session.id))
    .map(session => ({
      id: session.id,
      working_directory: session.workingDirectory,
      model: '',
      sdk_session_id: session.id,
      display_name: session.displayName || `Local Codex (${session.source})`,
      updated_at: session.updatedAt,
      source: 'local-codex' as const,
    }));

  const mergedMatches = [...prefixMatches];
  for (const session of fallbackLocalMatches) {
    if (mergedMatches.some(match => match.id === session.id || match.sdk_session_id === session.sdk_session_id)) {
      continue;
    }
    mergedMatches.push(session);
  }

  if (mergedMatches.length === 1) {
    return { session: mergedMatches[0], ambiguousMatches: [] };
  }

  return { session: null, ambiguousMatches: mergedMatches };
}

function formatSessionEntry(
  session: import('./host.js').BridgeSession,
  index: number,
  opts?: { workingDirectory?: string },
): string {
  return [
    `${index}. ${session.display_name || session.working_directory || '~'}`,
    `Source: ${formatSessionSourceLabel(session.source)}`,
    `Project: ${opts?.workingDirectory || session.working_directory || '~'}`,
    `ID: ${formatSessionShortId(session.id)}`,
  ].join('\n');
}

function getCurrentSessionSnapshot(channelType: string, chatId: string, topicId?: string): {
  binding: ChannelBinding;
  session: import('./host.js').BridgeSession | null;
} | null {
  const binding = router.getBinding({ channelType, chatId, topicId });
  if (!binding) return null;
  return {
    binding,
    session: router.getSessionMetadata(binding.codepilotSessionId),
  };
}

function getStreamConfig(channelType = 'telegram'): StreamConfig {
  const { store } = getBridgeContext();
  const defaults = STREAM_DEFAULTS[channelType] || STREAM_DEFAULTS.telegram;
  const prefix = `bridge_${channelType}_stream_`;
  const intervalMs = parseInt(store.getSetting(`${prefix}interval_ms`) || '', 10) || defaults.intervalMs;
  const minDeltaChars = parseInt(store.getSetting(`${prefix}min_delta_chars`) || '', 10) || defaults.minDeltaChars;
  const maxChars = parseInt(store.getSetting(`${prefix}max_chars`) || '', 10) || defaults.maxChars;
  return { intervalMs, minDeltaChars, maxChars };
}

function isNumericPermissionShortcut(channelType: string, rawText: string, chatRouteId: string): boolean {
  if (channelType !== 'telegram') return false;
  const normalized = rawText.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
  if (!/^[123]$/.test(normalized)) return false;
  const { store } = getBridgeContext();
  return store.listPendingPermissionLinksByChat(chatRouteId).length === 1;
}

function getOutboundDirs(binding: ChannelBinding): string[] {
  const dirs: string[] = [];
  if (binding.workingDirectory) {
    dirs.push(path.join(binding.workingDirectory, '.codepilot-outbox'));
  }
  const ctiHome = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
  dirs.push(path.join(ctiHome, 'outbox'));
  return Array.from(new Set(dirs.map(dir => path.resolve(dir))));
}

function getOutboundFileLimit(): number {
  const raw = getBridgeContext().store.getSetting('bridge_telegram_outbound_max_file_size');
  const parsed = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OUTBOUND_FILE_LIMIT;
}

function cleanMarkerValue(value: string): string {
  return value.trim().replace(/^['\"]|['\"]$/g, '');
}

function redactOutboundFileMarkers(text: string): string {
  OUTBOUND_FILE_MARKER.lastIndex = 0;
  return text.replace(OUTBOUND_FILE_MARKER, '[cti-send-file redacted]');
}

function isInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function inferMimeType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.zip': return 'application/zip';
    default: return 'application/octet-stream';
  }
}

function resolveOutboundFile(rawPath: string, binding: ChannelBinding): OutboundFileRequest | string {
  const markerValue = cleanMarkerValue(rawPath);
  if (!markerValue || /[\0\r\n]/.test(markerValue)) {
    return 'invalid file marker';
  }

  const allowedDirs = getOutboundDirs(binding);
  const candidates = path.isAbsolute(markerValue)
    ? [markerValue]
    : allowedDirs.map(dir => path.join(dir, markerValue));
  const limit = getOutboundFileLimit();

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) continue;

    const realPath = fs.realpathSync(resolved);
    const allowed = allowedDirs.some((dir) => {
      const allowedReal = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
      return isInsideDir(allowedReal, realPath);
    });
    if (!allowed) {
      return 'blocked outside outbox';
    }

    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return 'not a file';
    }
    const fileName = path.basename(realPath);
    if (fileName.startsWith('.') || SENSITIVE_FILE_PATTERN.test(fileName)) {
      return `blocked sensitive filename: ${fileName}`;
    }
    if (stat.size > limit) {
      return `file too large: ${fileName}`;
    }

    const mimeType = inferMimeType(fileName);
    return {
      filePath: realPath,
      fileName,
      mimeType,
      kind: mimeType.startsWith('image/') ? 'photo' : 'document',
    };
  }

  return 'file not found in outbox';
}

export function extractOutboundFileRequests(responseText: string, binding: ChannelBinding): OutboundFileExtraction {
  const files: OutboundFileRequest[] = [];
  const notices: string[] = [];
  OUTBOUND_FILE_MARKER.lastIndex = 0;
  const cleanText = responseText.replace(OUTBOUND_FILE_MARKER, (_match, htmlPath, bracketPath) => {
    if (files.length >= MAX_OUTBOUND_FILES) {
      notices.push(`file not sent: max ${MAX_OUTBOUND_FILES} files per reply`);
      return '';
    }
    const resolved = resolveOutboundFile(String(htmlPath || bracketPath || ''), binding);
    if (typeof resolved === 'string') {
      notices.push(`file not sent: ${resolved}`);
    } else {
      files.push(resolved);
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, files, notices };
}

async function deliverOutboundFiles(
  adapter: BaseChannelAdapter,
  address: InboundMessage['address'],
  files: OutboundFileRequest[],
  replyToMessageId?: string,
): Promise<SendResult> {
  let last: SendResult = { ok: true };
  for (const file of files) {
    const result = await adapter.sendFile({
      address,
      filePath: file.filePath,
      fileName: file.fileName,
      mimeType: file.mimeType,
      kind: file.kind,
      replyToMessageId,
    } satisfies OutboundFileMessage);
    if (!result.ok) {
      const fallbackText = [
        `File send failed: ${file.fileName}`,
        `Reason: ${result.error || 'unknown error'}`,
      ].join('\n');
      const fallbackResult = await deliver(adapter, {
        address,
        text: fallbackText,
        parseMode: 'plain',
        replyToMessageId,
      });
      // If the fallback text reached the user, the delivery as a whole
      // is degraded-but-successful: the user has the error context, and
      // the caller still needs to run onStreamEnd to delete the live
      // progress placeholder ("处理中…"). Returning ok:false here
      // strands that placeholder forever. Only signal failure if even
      // the fallback text could not be delivered.
      if (fallbackResult.ok) {
        return {
          ok: true,
          messageId: fallbackResult.messageId,
        };
      }
      return {
        ok: false,
        messageId: fallbackResult.messageId,
        error: result.error || fallbackResult.error || 'file send failed',
        httpStatus: result.httpStatus || fallbackResult.httpStatus,
        retryAfter: result.retryAfter || fallbackResult.retryAfter,
      };
    }
    last = result;
  }
  return last;
}

async function deliverResponse(
  adapter: BaseChannelAdapter,
  address: InboundMessage['address'],
  responseText: string,
  binding: ChannelBinding,
  replyToMessageId?: string,
): Promise<SendResult> {
  const outbound = extractOutboundFileRequests(responseText, binding);
  const displayText = [outbound.cleanText, ...outbound.notices.map(notice => `(${notice})`)]
    .filter(part => part.trim())
    .join('\n\n');
  let textResult: SendResult = { ok: true };

  if (displayText.trim()) {
    if (adapter.channelType === 'telegram') {
      const renderedChunks = markdownToTelegramChunks(displayText, STREAM_DEFAULTS.telegram.maxChars)
        .map((chunk) => ({
          text: chunk.html,
          parseMode: 'HTML' as const,
        }));
      textResult = await deliverRendered(adapter, address, renderedChunks, {
        sessionId: binding.codepilotSessionId,
        replyToMessageId,
        summaryText: displayText,
      });
    } else {
      textResult = await deliver(adapter, {
        address,
        text: displayText,
        parseMode: 'plain',
        replyToMessageId,
      }, {
        sessionId: binding.codepilotSessionId,
      });
    }

    if (!textResult.ok) return textResult;
  }

  const fileResult = await deliverOutboundFiles(adapter, address, outbound.files, replyToMessageId);
  if (!fileResult.ok) return textResult.messageId ? { ...fileResult, messageId: textResult.messageId } : fileResult;
  return fileResult.messageId ? fileResult : textResult;
}

function buildNoSessionMessage(): string {
  return 'No active session. Use /new to start one or /bind SESSION_ID to attach to an existing session.';
}

async function sendText(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  text: string,
  opts?: { sessionId?: string; replyToMessageId?: string },
): Promise<boolean> {
  const result = await deliver(adapter, {
    address: msg.address,
    text,
    parseMode: 'plain',
    replyToMessageId: opts?.replyToMessageId ?? msg.messageId,
  }, {
    sessionId: opts?.sessionId,
  });
  return result.ok || !!result.messageId;
}

function buildSessionsText(msg: InboundMessage): string {
  const snapshot = getCurrentSessionSnapshot(msg.address.channelType, msg.address.chatId, msg.address.topicId);
  const allSessions = listSessionChoices();
  const lines: string[] = [];

  if (snapshot?.session) {
    lines.push('Current session');
    lines.push(formatSessionEntry(snapshot.session, 1, {
      workingDirectory: snapshot.binding.workingDirectory,
    }));
    lines.push('');
  }

  const remaining = allSessions.filter(session => session.id !== snapshot?.session?.id).slice(0, 8);
  if (remaining.length > 0) {
    lines.push('Other recent sessions');
    remaining.forEach((session, index) => {
      lines.push(formatSessionEntry(session, index + 1));
      if (index !== remaining.length - 1) {
        lines.push('');
      }
    });
  }

  if (lines.length === 0) {
    return 'No sessions found.';
  }

  return [
    'Use /bind SESSION_ID with the full ID or a unique prefix.',
    '',
    ...lines,
  ].join('\n');
}

function buildStatusText(binding: ChannelBinding | null): string {
  if (!binding) {
    return 'No active session.';
  }

  const session = router.getSessionMetadata(binding.codepilotSessionId);
  const runtimeStatus = getBridgeContext().store.getSessionRuntimeStatus?.(binding.codepilotSessionId);
  const lines = [
    'Current session',
    `Title: ${session?.display_name || binding.codepilotSessionId}`,
    `Project: ${binding.workingDirectory}`,
    `Mode: ${binding.mode}`,
    `Session ID: ${binding.codepilotSessionId}`,
  ];
  if (runtimeStatus) {
    lines.push(`Runtime: ${runtimeStatus.status} at ${runtimeStatus.updatedAt}`);
  }
  return lines.join('\n');
}

function buildEmptyResponseError(binding: ChannelBinding, sdkSessionId: string | null): string {
  const sdk = sdkSessionId || binding.sdkSessionId || '';
  const sessionText = sdk
    ? `bridge session ${binding.codepilotSessionId} / runtime session ${sdk}`
    : `bridge session ${binding.codepilotSessionId}`;
  return `Runtime returned no assistant output for ${sessionText}. Treating this as a failed turn instead of sending an empty reply.`;
}

function insertConversationAudit(
  msg: InboundMessage,
  binding: ChannelBinding,
  result: engine.ConversationResult,
  responseText: string,
  status: string,
  errorType?: string,
  platformMessageId?: string,
): void {
  try {
    const auditText = redactOutboundFileMarkers(responseText);
    getBridgeContext().store.insertAuditLog({
      channelType: msg.address.channelType,
      chatId: msg.address.chatId,
      topicId: msg.address.topicId,
      direction: 'outbound',
      messageId: platformMessageId || '',
      inboundMessageId: msg.messageId,
      summary: `[conversation:${status}] ${auditText.slice(0, 180)}`,
      bridgeSessionId: binding.codepilotSessionId,
      sdkSessionId: result.sdkSessionId || binding.sdkSessionId || undefined,
      workingDirectory: binding.workingDirectory,
      status,
      errorType,
    });
  } catch {
    // best effort
  }
}

async function handleCommand(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  bindingSnapshot: ChannelBinding | null,
  sanitizedText: string,
): Promise<{ shouldAcknowledge: boolean }> {
  const { store } = getBridgeContext();
  const routeId = getAddressRouteId(msg.address);
  const [rawCommand, ...rest] = sanitizedText.trim().split(/\s+/);
  const command = rawCommand.startsWith('/')
    ? rawCommand.replace(/@[^@\s]+$/u, '')
    : rawCommand;
  const argText = rest.join(' ').trim();

  switch (command) {
    case '/status': {
      const delivered = await sendText(adapter, msg, buildStatusText(bindingSnapshot));
      return { shouldAcknowledge: delivered };
    }

    case '/sessions': {
      const delivered = await sendText(adapter, msg, buildSessionsText(msg));
      return { shouldAcknowledge: delivered };
    }

    case '/new': {
      const requestedCwd = argText ? validateWorkingDirectory(argText) : null;
      if (argText && !requestedCwd) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'Invalid working directory. Use an absolute path.') };
      }

      const workingDirectory = requestedCwd
        || store.getSetting('bridge_default_work_dir')
        || process.env.HOME
        || '';
      const model = store.getSetting('bridge_default_model') || '';
      const preview = [
        'Starting a new session.',
        `Project: ${workingDirectory}`,
        `Model: ${model || '(default)'}`,
      ].join('\n');

      const delivered = await sendText(adapter, msg, preview);
      if (!delivered) {
        return { shouldAcknowledge: false };
      }

      const session = store.createSession(
        router.buildBridgeSessionTitle(msg.address),
        model,
        undefined,
        workingDirectory,
        'code',
      );
      const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';
      if (defaultProviderId) {
        store.updateSessionProviderId(session.id, defaultProviderId);
      }
      store.upsertChannelBinding({
        channelType: msg.address.channelType,
        chatId: msg.address.chatId,
        topicId: msg.address.topicId,
        codepilotSessionId: session.id,
        sdkSessionId: '',
        workingDirectory,
        model,
        mode: 'code',
      });
      return { shouldAcknowledge: true };
    }

    case '/bind': {
      if (!argText || !validateSessionLookupKey(argText)) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'Usage: /bind SESSION_ID with the full ID or a unique prefix.') };
      }

      const { session, ambiguousMatches } = resolveSessionLookup(argText);
      if (!session) {
        if (ambiguousMatches.length > 1) {
          const body = ambiguousMatches
            .slice(0, 5)
            .map(match => `- ${match.id} ${match.display_name ? `(${match.display_name})` : ''}`.trim())
            .join('\n');
          return { shouldAcknowledge: await sendText(adapter, msg, `That prefix matches multiple sessions:\n${body}`) };
        }
        return { shouldAcknowledge: await sendText(adapter, msg, 'Session not found.') };
      }

      const previousBinding = bindingSnapshot;
      const previousSessionId = previousBinding?.codepilotSessionId;
      const displayWorkingDirectory = previousSessionId === session.id && previousBinding?.workingDirectory
        ? previousBinding.workingDirectory
        : session.working_directory || '~';
      const delivered = await sendText(
        adapter,
        msg,
        `Bound to session ${session.id}\nProject: ${displayWorkingDirectory}`,
      );
      if (!delivered) {
        return { shouldAcknowledge: false };
      }

      router.bindToSession(msg.address, session.id);
      if (previousSessionId && previousSessionId !== session.id) {
        const activeAbort = getState().activeTasks.get(previousSessionId);
        activeAbort?.abort();
      }
      return { shouldAcknowledge: true };
    }

    case '/cwd': {
      if (!bindingSnapshot) {
        return { shouldAcknowledge: await sendText(adapter, msg, buildNoSessionMessage()) };
      }
      const workingDirectory = validateWorkingDirectory(argText);
      if (!workingDirectory) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'Usage: /cwd /absolute/path') };
      }
      const delivered = await sendText(adapter, msg, `Working directory set to ${workingDirectory}`);
      if (!delivered) {
        return { shouldAcknowledge: false };
      }
      router.updateBinding(bindingSnapshot.id, { workingDirectory });
      return { shouldAcknowledge: true };
    }

    case '/mode': {
      if (!bindingSnapshot) {
        return { shouldAcknowledge: await sendText(adapter, msg, buildNoSessionMessage()) };
      }
      if (!validateMode(argText)) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'Usage: /mode plan|code|ask') };
      }
      const delivered = await sendText(adapter, msg, `Mode set to ${argText}`);
      if (!delivered) {
        return { shouldAcknowledge: false };
      }
      router.updateBinding(bindingSnapshot.id, { mode: argText });
      return { shouldAcknowledge: true };
    }

    case '/stop': {
      if (!bindingSnapshot) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'No active session to stop.') };
      }
      const abortController = getState().activeTasks.get(bindingSnapshot.codepilotSessionId);
      abortController?.abort();
      const delivered = await sendText(adapter, msg, 'Stop requested for the current session.');
      return { shouldAcknowledge: delivered };
    }

    case '/perm': {
      const [permAction, ...permRest] = argText.split(/\s+/);
      const permId = permRest.join(' ').trim();
      if (!permAction || !permId || !['allow', 'allow_session', 'deny'].includes(permAction)) {
        return { shouldAcknowledge: await sendText(adapter, msg, 'Usage: /perm allow|allow_session|deny <permission_id>') };
      }
      const result = broker.handlePermissionCallback(`perm:${permAction}:${permId}`, routeId);
      const delivered = await sendText(adapter, msg, result.callbackText);
      return { shouldAcknowledge: delivered };
    }

    case '/help': {
      const helpText = [
        'Bridge commands',
        '',
        '/new [path] - Start a new session',
        '/bind <session_id_or_prefix> - Bind to an existing session',
        '/cwd /path - Change working directory',
        '/mode plan|code|ask - Change mode',
        '/status - Show current session',
        '/sessions - List recent bridge and local Codex sessions',
        '/stop - Stop the current task',
        '/perm allow|allow_session|deny <id> - Respond to a permission request',
        '1/2/3 - Quick permission reply (single pending)',
        '/help - Show this help',
      ].join('\n');
      return { shouldAcknowledge: await sendText(adapter, msg, helpText) };
    }

    default: {
      const delivered = await sendText(adapter, msg, `Unknown command: ${command}\nType /help for available commands.`);
      return { shouldAcknowledge: delivered };
    }
  }
}

async function handleConversation(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  bindingSnapshot: ChannelBinding,
  sanitizedText: string,
): Promise<{ shouldAcknowledge: boolean }> {
  const sessionId = bindingSnapshot.codepilotSessionId;
  // Hoisted out of the inner fn so the wall-clock onTimeout callback below
  // can release these resources when the turn wedges (the inner `finally`
  // would otherwise never run while fn is hung). Idempotent: safe to invoke
  // from both onTimeout and the normal finally path.
  const abortController = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const releaseTurnResources = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    const state = getState();
    if (state.activeTasks.get(sessionId) === abortController) {
      state.activeTasks.delete(sessionId);
    }
  };

  return processWithSessionLock(sessionId, async () => {
    const state = getState();
    state.activeTasks.set(sessionId, abortController);

    const streamConfig = getStreamConfig(adapter.channelType);
    let lastPreviewLength = 0;
    const HEARTBEAT_INTERVAL_MS = 30000;
    const streamContext = buildStreamContext(msg, bindingSnapshot);
    // Wall-clock heartbeat: fires independently of upstream text events so the
    // adapter can keep the user informed when the LLM subprocess is silent
    // (e.g., stalled tool call, hung background subprocess).
    const heartbeatStartedAt = Date.now();
    heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - heartbeatStartedAt) / 1000);
      const minutes = Math.floor(elapsedSec / 60);
      const seconds = elapsedSec % 60;
      const elapsedLabel = minutes > 0
        ? `${minutes}m ${seconds.toString().padStart(2, '0')}s`
        : `${seconds}s`;
      const statusText = `Still working… (running ${elapsedLabel})`;
      try {
        adapter.onStreamHeartbeat?.(streamContext, statusText);
      } catch (error) {
        console.warn('[bridge-manager] onStreamHeartbeat hook failed:', error instanceof Error ? error.message : error);
      }
    }, HEARTBEAT_INTERVAL_MS);

    try {
      adapter.onMessageStart?.(streamContext);

      const result = await engine.processMessage(
        bindingSnapshot,
        sanitizedText,
        async (permission) => {
          await broker.forwardPermissionRequest(
            adapter,
            msg.address,
            permission.permissionRequestId,
            permission.toolName,
            permission.toolInput,
            bindingSnapshot.codepilotSessionId,
            permission.suggestions,
            msg.messageId,
          );
        },
        abortController.signal,
	        msg.attachments,
	        (fullText) => {
	          if (fullText.length < lastPreviewLength) {
	            lastPreviewLength = 0;
	          }
		          if (lastPreviewLength === 0 || fullText.length - lastPreviewLength >= streamConfig.minDeltaChars || fullText.length >= streamConfig.maxChars) {
		            lastPreviewLength = fullText.length;
		            adapter.onStreamText?.(streamContext, fullText.slice(0, streamConfig.maxChars));
		          }
        },
        (toolId, toolName, status) => {
          adapter.onToolEvent?.(streamContext, [{ id: toolId, name: toolName, status }]);
        },
      );

      const emptyResponse = !result.hasError && !result.responseText.trim();
      const errorType = result.hasError
        ? (result.errorType || 'runtime_error')
        : emptyResponse
          ? 'empty_response'
          : undefined;
      const responseText = result.hasError
        ? (result.errorMessage || 'The session failed before it could reply.')
        : emptyResponse
          ? buildEmptyResponseError(bindingSnapshot, result.sdkSessionId)
          : result.responseText;

      const nextSdkSessionId = computeSdkSessionUpdate(result.sdkSessionId, result.hasError);
      if (nextSdkSessionId !== null) {
        streamContext.sdkSessionId = nextSdkSessionId || undefined;
        const currentBinding = router.getBinding(msg.address);
        if (
          currentBinding?.id === bindingSnapshot.id
          && currentBinding.codepilotSessionId === bindingSnapshot.codepilotSessionId
        ) {
          router.updateBinding(bindingSnapshot.id, { sdkSessionId: nextSdkSessionId });
        }
        getBridgeContext().store.updateSdkSessionId(bindingSnapshot.codepilotSessionId, nextSdkSessionId);
      }

      const delivered = await deliverResponse(
        adapter,
        msg.address,
        responseText,
        bindingSnapshot,
        msg.messageId,
      );

      const terminalStatus = errorType
        ? 'error'
        : (abortController.signal.aborted ? 'interrupted' : 'completed');
      const success = delivered.ok;
      insertConversationAudit(
        msg,
        bindingSnapshot,
        result,
        responseText,
        success ? terminalStatus : 'delivery_failed',
        success ? errorType : 'delivery_failed',
        delivered.messageId,
      );
      if (!success) {
        return { shouldAcknowledge: false };
      }

      try {
        await adapter.onStreamEnd?.(
          streamContext,
          errorType ? 'error' : (abortController.signal.aborted ? 'interrupted' : 'completed'),
          responseText,
        );
      } catch (error) {
        console.warn('[bridge-manager] onStreamEnd hook failed:', error instanceof Error ? error.message : error);
      }

      return { shouldAcknowledge: true };
    } finally {
      releaseTurnResources();
      adapter.onMessageEnd?.(streamContext);
    }
  }, () => {
    // Wall-clock wedge recovery: abort the controller so any abort-aware
    // operation in the hung fn can bail; release the heartbeat + activeTasks
    // entry so the user stops seeing "Still working…" updates for a turn the
    // bridge has already given up on, and so /stop on subsequent turns
    // operates on the correct AbortController.
    try {
      abortController.abort();
    } catch (err) {
      console.warn(
        '[bridge-manager] session-lock onTimeout abort failed:',
        err instanceof Error ? err.message : err,
      );
    }
    releaseTurnResources();
  });
}

async function handleMessage(
  adapter: BaseChannelAdapter,
  msg: InboundMessage,
  routedBinding?: ChannelBinding,
): Promise<{ shouldAcknowledge: boolean }> {
  const state = getState();
  const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
  meta.lastMessageAt = new Date().toISOString();
  meta.lastError = null;
  state.adapterMeta.set(adapter.channelType, meta);

  const dangerous = isDangerousInput(msg.text);
  if (dangerous.dangerous) {
    const delivered = await sendText(adapter, msg, `Input rejected for safety: ${dangerous.reason || 'unknown reason'}`);
    if (delivered && typeof msg.updateId === 'number') {
      adapter.acknowledgeUpdate?.(msg.updateId);
    }
    return { shouldAcknowledge: delivered };
  }

  const { text: sanitizedText } = sanitizeInput(msg.text);
  const routeId = getAddressRouteId(msg.address);
  const bindingSnapshot = routedBinding || router.getBinding(msg.address);
  if (bindingSnapshot) {
    syncBridgeSessionTitle(msg, bindingSnapshot);
  }

  if (msg.callbackData) {
    const result = broker.handlePermissionCallback(
      msg.callbackData,
      routeId,
      msg.callbackMessageId,
    );
    try {
      await adapter.answerCallback?.(msg.messageId, result.callbackText);
    } catch (error) {
      console.warn('[bridge-manager] Failed to answer callback:', error instanceof Error ? error.message : error);
    }
    if (result.handled && typeof msg.updateId === 'number') {
      adapter.acknowledgeUpdate?.(msg.updateId);
    }
    return { shouldAcknowledge: result.handled };
  }

  if (isNumericPermissionShortcut(adapter.channelType, sanitizedText, routeId)) {
    const { store } = getBridgeContext();
    const pendingLinks = store.listPendingPermissionLinksByChat(routeId);
    if (pendingLinks.length === 1) {
      const firstPending = pendingLinks[0]!;
      const action = sanitizedText.trim() === '1'
        ? 'allow'
        : sanitizedText.trim() === '2'
          ? 'allow_session'
          : 'deny';
      const result = broker.handlePermissionCallback(`perm:${action}:${firstPending.permissionRequestId}`, routeId);
      const delivered = await sendText(adapter, msg, result.callbackText);
      if (delivered && typeof msg.updateId === 'number') {
        adapter.acknowledgeUpdate?.(msg.updateId);
      }
      return { shouldAcknowledge: delivered };
    }
  }

  if (sanitizedText.trim().startsWith('/')) {
    const result = await handleCommand(adapter, msg, bindingSnapshot, sanitizedText);
    if (result.shouldAcknowledge && typeof msg.updateId === 'number') {
      adapter.acknowledgeUpdate?.(msg.updateId);
    }
    return result;
  }

  if (!bindingSnapshot) {
    if (msg.address.topicId || msg.address.channelType === 'telegram') {
      const autoBinding = router.createBinding(msg.address);
      const autoResult = await handleConversation(adapter, msg, autoBinding, sanitizedText);
      if (autoResult.shouldAcknowledge && typeof msg.updateId === 'number') {
        adapter.acknowledgeUpdate?.(msg.updateId);
      }
      return autoResult;
    }
    const delivered = await sendText(adapter, msg, buildNoSessionMessage());
    if (delivered && typeof msg.updateId === 'number') {
      adapter.acknowledgeUpdate?.(msg.updateId);
    }
    return { shouldAcknowledge: delivered };
  }

  const result = await handleConversation(adapter, msg, bindingSnapshot, sanitizedText);
  if (result.shouldAcknowledge && typeof msg.updateId === 'number') {
    adapter.acknowledgeUpdate?.(msg.updateId);
  }
  return result;
}

function runAdapterLoop(adapter: BaseChannelAdapter): void {
  const state = getState();
  const abort = new AbortController();
  state.loopAborts.set(adapter.channelType, abort);

  (async () => {
    while (state.running && adapter.isRunning()) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg) continue;

        if (
          msg.callbackData
          || msg.text.trim().startsWith('/')
          || isNumericPermissionShortcut(adapter.channelType, msg.text.trim(), getAddressRouteId(msg.address))
        ) {
          await handleMessage(adapter, msg);
          continue;
        }

        const binding = router.getBinding(msg.address);
        if (!binding && !msg.address.topicId) {
          await handleMessage(adapter, msg);
          continue;
        }

        handleMessage(adapter, msg, binding ?? undefined).catch((err) => {
          const sessionLabel = binding?.codepilotSessionId
            ? `Session ${binding.codepilotSessionId.slice(0, 8)}`
            : `Route ${getAddressRouteId(msg.address)}`;
          console.error(`[bridge-manager] ${sessionLabel} error:`, err);
        });
      } catch (err) {
        if (abort.signal.aborted) break;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[bridge-manager] Error in ${adapter.channelType} loop:`, err);
        const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
        meta.lastError = errMsg;
        state.adapterMeta.set(adapter.channelType, meta);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  })().catch((err) => {
    if (abort.signal.aborted) return;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge-manager] ${adapter.channelType} loop crashed:`, err);
    const meta = state.adapterMeta.get(adapter.channelType) || { lastMessageAt: null, lastError: null };
    meta.lastError = errMsg;
    state.adapterMeta.set(adapter.channelType, meta);
  });
}

export async function start(): Promise<void> {
  const state = getState();
  if (state.running) return;

  const adapters: BaseChannelAdapter[] = [];
  for (const channelType of getRegisteredTypes()) {
    const adapter = createAdapter(channelType);
    if (!adapter) continue;
    const configError = adapter.validateConfig();
    if (configError) {
      console.warn(`[bridge-manager] ${channelType} adapter not valid: ${configError}`);
      continue;
    }
    try {
      await adapter.preflight?.();
      await adapter.start();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[bridge-manager] ${channelType} adapter failed to start:`, error);
      state.adapterMeta.set(channelType, {
        lastMessageAt: null,
        lastError: errMsg,
      });
      continue;
    }
    if (!adapter.isRunning()) {
      console.warn(`[bridge-manager] ${channelType} adapter did not enter running state`);
      state.adapterMeta.set(channelType, {
        lastMessageAt: null,
        lastError: 'adapter did not enter running state',
      });
      continue;
    }
    adapters.push(adapter);
    console.log(`[bridge-manager] Started adapter: ${channelType}`);
  }

  if (adapters.length === 0) {
    console.warn('[bridge-manager] No adapters started successfully, bridge not activated');
    state.adapters = [];
    state.running = false;
    state.startedAt = null;
    return;
  }

  state.adapters = adapters;
  state.running = true;
  state.startedAt = new Date().toISOString();
  getBridgeContext().lifecycle.onBridgeStart?.();

  for (const adapter of adapters) {
    runAdapterLoop(adapter);
  }

  startOutboxPushWatcher({ getAdapters: () => getState().adapters });

  console.log(`[bridge-manager] Bridge started with ${adapters.length} adapter(s)`);
}

export async function stop(): Promise<void> {
  const state = getState();
  state.running = false;

  stopOutboxPushWatcher();

  for (const abort of state.loopAborts.values()) {
    abort.abort();
  }
  state.loopAborts.clear();

  for (const adapter of state.adapters) {
    await adapter.stop();
  }
  state.adapters = [];
  state.adapterMeta.clear();
  state.startedAt = null;
  getBridgeContext().lifecycle.onBridgeStop?.();
}

export function tryAutoStart(): void {
  const enabled = getBridgeContext().store.getSetting('remote_bridge_enabled');
  if (enabled === 'true') {
    void start();
  }
}

export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: state.adapters.map(adapter => ({
      channelType: adapter.channelType,
      running: adapter.isRunning(),
      connectedAt: state.startedAt,
      lastMessageAt: state.adapterMeta.get(adapter.channelType)?.lastMessageAt ?? null,
      error: state.adapterMeta.get(adapter.channelType)?.lastError ?? null,
    })),
  };
}

export function registerAdapter(adapter: BaseChannelAdapter): void {
  const state = getState();
  const existingIndex = state.adapters.findIndex(existing => existing.channelType === adapter.channelType);
  if (existingIndex >= 0) {
    state.adapters[existingIndex] = adapter;
    return;
  }
  state.adapters.push(adapter);
}

/**
 * Compute the sdkSessionId value to persist after a conversation result.
 * Returns the new value to write, or null if no update is needed.
 */
export function computeSdkSessionUpdate(
  sdkSessionId: string | null | undefined,
  hasError: boolean,
): string | null {
  if (sdkSessionId) {
    return sdkSessionId;
  }
  return null;
}

/** @internal */
export const _testOnly = { handleMessage, getState, getSessionLockTimeoutMs };

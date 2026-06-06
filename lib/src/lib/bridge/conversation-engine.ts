/**
 * Conversation Engine — processes inbound IM messages through Claude.
 *
 * Takes a ChannelBinding + inbound message, calls the LLM provider,
 * consumes the SSE stream server-side, saves messages to DB,
 * and returns the response text for delivery.
 */

import fs from 'fs';
import path from 'path';
import type { ChannelBinding } from './types.js';
import type {
  BridgeStore,
  FileAttachment,
  SSEEvent,
  TokenUsage,
  MessageContentBlock,
} from './host.js';
import { getBridgeContext } from './context.js';
import crypto from 'crypto';
import { updateLocalCodexSessionTitle } from './local-codex-sessions.js';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

/**
 * Callback invoked immediately when a permission_request SSE event arrives.
 * This breaks the deadlock: the stream blocks until the permission is resolved,
 * so we must forward the request to the IM *during* stream consumption,
 * not after it returns.
 */
export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;

/**
 * Callback invoked on each `text` SSE event with the full accumulated text so far.
 * Must return synchronously — the bridge-manager handles throttling and fire-and-forget.
 */
export type OnPartialText = (fullText: string) => void;

/**
 * Callback invoked when tool_use or tool_result SSE events arrive.
 * Used by bridge-manager to forward tool progress to adapters for real-time display.
 */
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;

export interface ConversationResult {
  responseText: string;
  tokenUsage: TokenUsage | null;
  hasError: boolean;
  errorMessage: string;
  /** Structured reason tag from the provider (e.g. 'mid_stream_timeout'); undefined for plain-text errors. */
  errorType?: string;
  /** Permission request events that were forwarded during streaming */
  permissionRequests: PermissionRequestInfo[];
  /** SDK session ID captured from status/result events, for session resume */
  sdkSessionId: string | null;
}

function isIgnorablePostTextTransportError(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('stream disconnected before completion:')
    && (
      text.includes('websocket closed by server before response.completed')
      || text.includes('failed to send websocket request: io error: broken pipe')
    );
}

/**
 * Safety fence: once a final answer is committed upstream, bound how long we
 * keep waiting for the stream to close on its own. When the underlying CLI
 * hangs on an unrelated child (e.g., an unresolved background Bash), the
 * reader would otherwise stall forever and the buffered reply would never
 * reach the IM. Configurable via CTI_POST_END_TURN_TIMEOUT_MS.
 */
function getPostEndTurnTimeoutMs(): number {
  const raw = process.env.CTI_POST_END_TURN_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
}

const POST_END_TURN_TIMEOUT_SENTINEL = Symbol('cti-post-end-turn-timeout');

interface SavedFileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  filePath: string;
}

function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function safeSetRuntimeStatus(store: BridgeStore, sessionId: string, status: string): void {
  try {
    store.setSessionRuntimeStatus(sessionId, status);
  } catch (err) {
    console.warn('[conversation-engine] Failed to persist runtime status:', err instanceof Error ? err.message : err);
  }
}

function shouldIncludeOutboxHint(text: string, files: SavedFileMeta[]): boolean {
  if (files.length > 0) return true;
  return /发|发送|传|文件|附件|图片|图|报告|导出|下载|send|file|attachment|image|photo|pdf|docx?|xlsx?|pptx?|zip|download|export/i.test(text);
}

function getModelVisibleFiles(files?: FileAttachment[]): FileAttachment[] | undefined {
  const imageFiles = files?.filter(file => file.type.toLowerCase().startsWith('image/'));
  return imageFiles && imageFiles.length > 0 ? imageFiles : undefined;
}

function ensureEphemeralDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: some mounted filesystems ignore chmod.
  }

  const ignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, '*\n!.gitignore\n', { encoding: 'utf-8', mode: 0o600 });
  }
}

function buildRuntimePrompt(text: string, files: SavedFileMeta[], outboxDir: string, includeOutboxHint = shouldIncludeOutboxHint(text, files)): string {
  const blocks = [text];

  if (files.length > 0) {
    blocks.push([
      'Bridge attachment note:',
      'The Telegram attachment(s) are saved locally. Use these paths when you need to inspect the files:',
      ...files.map((file, index) => `- ${index + 1}. ${file.name} (${file.type || 'application/octet-stream'}, ${formatBytes(file.size)}): ${file.filePath}`),
    ].join('\n'));
  }

  if (outboxDir && includeOutboxHint) {
    blocks.push([
      'Bridge outbound file note:',
      `To send a generated file back to Telegram, write it under: ${outboxDir}`,
      'Then include one hidden marker line in the final answer:',
      '<!--cti-send-file:<absolute path or filename inside the outbox>-->',
      'Do not use the marker for files outside the outbox.',
    ].join('\n'));
  }

  return blocks.filter(block => block.trim()).join('\n\n');
}

/**
 * Process an inbound message: send to Claude, consume the response stream,
 * save to DB, and return the result.
 */
export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.codepilotSessionId;

  // Acquire session lock
  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  // Lock renewal interval
  let renewalInterval: ReturnType<typeof setInterval> | undefined;

  try {
    safeSetRuntimeStatus(store, sessionId, 'running');
    renewalInterval = setInterval(() => {
      try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
    }, 60_000);

    // Resolve session early — needed for workingDirectory and provider resolution
    const session = store.getSession(sessionId);

    // Save user message — persist file attachments to disk using the same
    // <!--files:JSON--> format as the desktop chat route, so the UI can render them.
    let savedContent = text;
    let runtimePrompt = text;
    let savedFiles: SavedFileMeta[] = [];
    const workDir = binding.workingDirectory || session?.working_directory || '';
    const outboxDir = workDir ? path.join(workDir, '.codepilot-outbox') : '';
    if (files && files.length > 0) {
      if (workDir) {
        try {
          const uploadDir = path.join(workDir, '.codepilot-uploads');
          ensureEphemeralDirectory(uploadDir);
          savedFiles = files.map((f, index) => {
            const safeName = path.basename(f.name).replace(/[^a-zA-Z0-9._-]/g, '_') || `attachment-${index + 1}`;
            const filePath = path.join(uploadDir, `${Date.now()}-${index}-${safeName}`);
            const buffer = Buffer.from(f.data, 'base64');
            fs.writeFileSync(filePath, buffer);
            return { id: f.id, name: f.name, type: f.type, size: buffer.length, filePath };
          });
          savedContent = `<!--files:${JSON.stringify(savedFiles)}-->${text}`;
        } catch (err) {
          console.warn('[conversation-engine] Failed to persist file attachments:', err instanceof Error ? err.message : err);
          savedContent = `[${files.length} file(s) attached but not saved] ${text}`;
        }
      } else {
        savedContent = `[${files.length} file(s) attached but no working directory was available] ${text}`;
      }
    }
    let includeOutboxHint = Boolean(outboxDir && shouldIncludeOutboxHint(text, savedFiles));
    if (includeOutboxHint) {
      try {
        ensureEphemeralDirectory(outboxDir);
      } catch (err) {
        includeOutboxHint = false;
        console.warn('[conversation-engine] Failed to prepare outbox directory:', err instanceof Error ? err.message : err);
      }
    }
    runtimePrompt = buildRuntimePrompt(text, savedFiles, outboxDir, includeOutboxHint);
    store.addMessage(sessionId, 'user', savedContent);

    // Resolve provider
    let resolvedProvider: import('./host.js').BridgeApiProvider | undefined;
    const providerId = session?.provider_id || '';
    if (providerId && providerId !== 'env') {
      resolvedProvider = store.getProvider(providerId);
    }
    if (!resolvedProvider) {
      const defaultId = store.getDefaultProviderId();
      if (defaultId) resolvedProvider = store.getProvider(defaultId);
    }

    // Effective model
    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;

    // Permission mode from binding mode
    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    // Load conversation history for context
    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const stream = llm.streamChat({
      prompt: runtimePrompt,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      provider: resolvedProvider,
      conversationHistory: historyMsgs,
      files: getModelVisibleFiles(files),
      onRuntimeStatusChange: (status: string) => {
        safeSetRuntimeStatus(store, sessionId, status);
      },
    });

    // Consume the stream server-side (replicate collectStreamResponse pattern).
    // Permission requests are forwarded immediately via the callback during streaming
    // because the stream blocks until permission is resolved — we can't wait until after.
    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    if (renewalInterval) clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    safeSetRuntimeStatus(store, sessionId, 'idle');
  }
}

/**
 * Consume an SSE stream and extract response data.
 * Mirrors the collectStreamResponse() logic from chat/route.ts.
 */
async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();
  const contentBlocks: MessageContentBlock[] = [];
  let currentText = '';
  /** Monotonically accumulated text for streaming preview — never resets on tool_use. */
  let previewText = '';
  let tokenUsage: TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  let errorType: string | undefined;
  const seenToolResultIds = new Set<string>();
  const permissionRequests: PermissionRequestInfo[] = [];
  let capturedSdkSessionId: string | null = null;
  let lastSyncedSdkSessionId: string | null = null;
  let finalAnswerCommitted = false;

  const syncSdkTitle = (sdkSessionId: string): void => {
    if (!sdkSessionId || sdkSessionId === lastSyncedSdkSessionId) return;
    const sessionTitle = store.getSession(sessionId)?.display_name?.trim();
    if (!sessionTitle) return;
    updateLocalCodexSessionTitle(sdkSessionId, sessionTitle);
    lastSyncedSdkSessionId = sdkSessionId;
  };

  const postEndTurnTimeoutMs = getPostEndTurnTimeoutMs();

  try {
    while (true) {
      type ReadResult = Awaited<ReturnType<typeof reader.read>>;
      let readOutcome: ReadResult;
      if (finalAnswerCommitted) {
        // After the final answer is committed upstream, bound the wait so a
        // hung subprocess can never block delivery of the buffered text.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<typeof POST_END_TURN_TIMEOUT_SENTINEL>((resolve) => {
          timer = setTimeout(() => resolve(POST_END_TURN_TIMEOUT_SENTINEL), postEndTurnTimeoutMs);
        });
        const raced = await Promise.race([reader.read(), timeoutPromise]);
        if (timer) clearTimeout(timer);
        if (raced === POST_END_TURN_TIMEOUT_SENTINEL) {
          try { await reader.cancel(); } catch { /* best effort */ }
          break;
        }
        readOutcome = raced as ReadResult;
      } else {
        readOutcome = await reader.read();
      }
      if (readOutcome.done) break;
      const value = readOutcome.value;

      const lines = value.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        let event: SSEEvent;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }

        switch (event.type) {
          case 'text':
            currentText += event.data;
            if (onPartialText) {
              previewText += event.data;
              try { onPartialText(previewText); } catch { /* non-critical */ }
            }
            break;

          case 'tool_use': {
            if (currentText.trim()) {
              contentBlocks.push({ type: 'text', text: currentText });
              currentText = '';
            }
            try {
              const toolData = JSON.parse(event.data);
              contentBlocks.push({
                type: 'tool_use',
                id: toolData.id,
                name: toolData.name,
                input: toolData.input,
              });
              if (onToolEvent) {
                try { onToolEvent(toolData.id, toolData.name, 'running'); } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'tool_result': {
            try {
              const resultData = JSON.parse(event.data);
              const newBlock = {
                type: 'tool_result' as const,
                tool_use_id: resultData.tool_use_id,
                content: resultData.content,
                is_error: resultData.is_error || false,
              };
              if (seenToolResultIds.has(resultData.tool_use_id)) {
                const idx = contentBlocks.findIndex(
                  (b) => b.type === 'tool_result' && 'tool_use_id' in b && b.tool_use_id === resultData.tool_use_id
                );
                if (idx >= 0) contentBlocks[idx] = newBlock;
              } else {
                seenToolResultIds.add(resultData.tool_use_id);
                contentBlocks.push(newBlock);
              }
              if (onToolEvent) {
                try {
                  onToolEvent(
                    resultData.tool_use_id,
                    '', // name not available in tool_result, adapter tracks by id
                    resultData.is_error ? 'error' : 'complete',
                  );
                } catch { /* non-critical */ }
              }
            } catch { /* skip */ }
            break;
          }

          case 'permission_request': {
            try {
              const permData = JSON.parse(event.data);
              const perm: PermissionRequestInfo = {
                permissionRequestId: permData.permissionRequestId,
                toolName: permData.toolName,
                toolInput: permData.toolInput,
                suggestions: permData.suggestions,
              };
              permissionRequests.push(perm);
              // Forward immediately — the stream blocks until the permission is
              // resolved, so we must send the IM prompt *now*, not after the stream ends.
              if (onPermissionRequest) {
                onPermissionRequest(perm).catch((err) => {
                  console.error('[conversation-engine] Failed to forward permission request:', err);
                });
              }
            } catch { /* skip */ }
            break;
          }

	          case 'status': {
	            try {
	              const statusData = JSON.parse(event.data);
	              const committedFinalAnswer = statusData.final_answer_committed === true;
	              if (committedFinalAnswer) {
	                finalAnswerCommitted = true;
	              }
	              if (statusData.session_id) {
	                capturedSdkSessionId = statusData.session_id;
                store.updateSdkSessionId(sessionId, statusData.session_id);
                syncSdkTitle(statusData.session_id);
              }
	              if (statusData.model) {
	                store.updateSessionModel(sessionId, statusData.model);
	              }
                const progressText =
                  statusData.progress_text
                  || statusData.reasoning
                  || statusData.commentary
                  || statusData.status_text
                  || statusData.message;
	              if (progressText && onPartialText && !finalAnswerCommitted) {
	                try { onPartialText(String(progressText)); } catch { /* non-critical */ }
	              }
	            } catch { /* skip */ }
	            break;
	          }

          case 'task_update': {
            try {
              const taskData = JSON.parse(event.data);
              if (taskData.session_id && taskData.todos) {
                store.syncSdkTasks(taskData.session_id, taskData.todos);
              }
            } catch { /* skip */ }
            break;
          }

          case 'error': {
            // Adapted: providers may send either a plain string or a
            // JSON-stringified structured payload ({ reason, ... }) — surface
            // the reason as errorType so downstream retry logic (Task 1.3)
            // can react without parsing the message again.
            const raw = event.data || 'Unknown error';
            let parsedReason: string | undefined;
            let displayMessage = raw;
            if (raw.startsWith('{')) {
              try {
                const payload = JSON.parse(raw) as Record<string, unknown>;
                if (typeof payload.reason === 'string') {
                  parsedReason = payload.reason;
                  displayMessage = payload.reason;
                }
              } catch { /* fall through to raw string */ }
            }
            if (!finalAnswerCommitted) {
              hasError = true;
              errorMessage = displayMessage;
              if (parsedReason) errorType = parsedReason;
            }
            break;
          }

          case 'result': {
            try {
              const resultData = JSON.parse(event.data);
              if (resultData.usage) tokenUsage = resultData.usage;
              if (resultData.is_error && !finalAnswerCommitted) hasError = true;
              if (resultData.session_id) {
                capturedSdkSessionId = resultData.session_id;
                store.updateSdkSessionId(sessionId, resultData.session_id);
                syncSdkTitle(resultData.session_id);
              }
            } catch { /* skip */ }
            break;
          }

          // tool_output, tool_timeout, mode_changed, done — ignored for bridge
        }
      }
    }

    // Flush remaining text
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }

    // Save assistant message
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();

      if (content) {
        store.addMessage(sessionId, 'assistant', content, tokenUsage ? JSON.stringify(tokenUsage) : null);
      }
    }

    // Extract text-only response for IM delivery
    const responseText = contentBlocks
      .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n')
      .trim();

    if (
      responseText
      && (
        finalAnswerCommitted
        || (hasError && isIgnorablePostTextTransportError(errorMessage))
      )
    ) {
      hasError = false;
      errorMessage = '';
      errorType = undefined;
    }

    return {
      responseText,
      tokenUsage,
      hasError,
      errorMessage,
      errorType,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  } catch (e) {
    // Best-effort save on stream error
    if (currentText.trim()) {
      contentBlocks.push({ type: 'text', text: currentText });
    }
    if (contentBlocks.length > 0) {
      const hasToolBlocks = contentBlocks.some(
        (b) => b.type === 'tool_use' || b.type === 'tool_result'
      );
      const content = hasToolBlocks
        ? JSON.stringify(contentBlocks)
        : contentBlocks
            .filter((b): b is Extract<MessageContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
            .trim();
      if (content) {
        store.addMessage(sessionId, 'assistant', content);
      }
    }

    const isAbort = e instanceof DOMException && e.name === 'AbortError'
      || e instanceof Error && e.name === 'AbortError';

    return {
      responseText: '',
      tokenUsage,
      hasError: true,
      errorMessage: isAbort ? 'Task stopped by user' : (e instanceof Error ? e.message : 'Stream consumption error'),
      errorType,
      permissionRequests,
      sdkSessionId: capturedSdkSessionId,
    };
  }
}

/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

const VALID_APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
const VALID_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);
const DEFAULT_STARTUP_IDLE_MS = 30000;
const DEFAULT_TERMINAL_IDLE_MS = 15000;
const DEFAULT_MID_STREAM_IDLE_MS = 60000;
const DEFAULT_TOOL_WALLCLOCK_MS = 1800000;
const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'turn.failed', 'error']);
const IN_FLIGHT_TOOL_TYPES = new Set([
  'command_execution',
  'mcp_tool_call',
  'web_search',
  'wait_agent',
  'subagent',
]);
const STARTUP_TIMEOUT = Symbol('codex-startup-timeout');
const TERMINAL_TIMEOUT = Symbol('codex-terminal-timeout');
const MID_STREAM_TIMEOUT = Symbol('codex-mid-stream-timeout');
const ABORT_MARKER = Symbol('codex-aborted');

type ProgressEventResult = {
  committedFinalAnswer: boolean;
  sawTerminalEvent: boolean;
};

type CompletedItemResult = {
  committedFinalAnswer: boolean;
};

type ProgressEventState = {
  lastFinalAnswerText: string | null;
};

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  const override = process.env.CTI_CODEX_APPROVAL_POLICY;
  if (override && VALID_APPROVAL_POLICIES.has(override)) {
    return override;
  }

  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

/** Allow Codex to run outside a trusted Git repository when explicitly enabled. */
function shouldSkipGitRepoCheck(): boolean {
  return process.env.CTI_CODEX_SKIP_GIT_REPO_CHECK === 'true';
}

function getReasoningEffort(): string | undefined {
  const value = process.env.CTI_CODEX_MODEL_REASONING_EFFORT;
  return value && VALID_REASONING_EFFORTS.has(value) ? value : undefined;
}

function getSandboxMode(): string | undefined {
  const value = process.env.CTI_CODEX_SANDBOX_MODE;
  return value && VALID_SANDBOX_MODES.has(value) ? value : undefined;
}

function getNetworkAccessEnabled(): boolean | undefined {
  const value = process.env.CTI_CODEX_NETWORK_ACCESS_ENABLED;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function getAdditionalDirectories(): string[] | undefined {
  const raw = process.env.CTI_CODEX_ADDITIONAL_DIRECTORIES;
  if (!raw) return undefined;

  const dirs = raw
    .split(',')
    .map(dir => dir.trim())
    .filter(Boolean);

  return dirs.length > 0 ? Array.from(new Set(dirs)) : undefined;
}

function getTerminalIdleMs(): number {
  const raw = process.env.CTI_CODEX_TERMINAL_IDLE_MS;
  if (!raw) return DEFAULT_TERMINAL_IDLE_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TERMINAL_IDLE_MS;
}

function getStartupIdleMs(): number {
  const raw = process.env.CTI_CODEX_STARTUP_IDLE_MS;
  if (!raw) return DEFAULT_STARTUP_IDLE_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STARTUP_IDLE_MS;
}

function getMidStreamIdleMs(): number {
  const raw = process.env.CTI_CODEX_MID_STREAM_IDLE_MS;
  if (!raw) return DEFAULT_MID_STREAM_IDLE_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MID_STREAM_IDLE_MS;
}

function getToolWallclockMs(): number {
  const raw = process.env.CTI_CODEX_TOOL_WALLCLOCK_MS;
  if (!raw) return DEFAULT_TOOL_WALLCLOCK_MS;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TOOL_WALLCLOCK_MS;
}

function isTerminalEvent(eventType: string): boolean {
  return TERMINAL_EVENT_TYPES.has(eventType);
}

async function readNextEventWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  timeoutMarker: symbol,
  abortSignal?: AbortSignal,
): Promise<IteratorResult<T> | symbol> {
  if (abortSignal?.aborted) {
    return ABORT_MARKER;
  }
  if (timeoutMs <= 0) {
    return timeoutMarker;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;
  try {
    const racers: Array<Promise<IteratorResult<T> | symbol>> = [
      iterator.next(),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
      }),
    ];
    if (abortSignal) {
      racers.push(new Promise<symbol>((resolve) => {
        abortListener = () => resolve(ABORT_MARKER);
        abortSignal.addEventListener('abort', abortListener, { once: true });
      }));
    }
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortSignal && abortListener) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }
}

async function resolveWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMarker: symbol,
): Promise<T | symbol> {
  if (timeoutMs <= 0) {
    return timeoutMarker;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();

  // Resume-specific failures: the saved thread id is unusable.
  if (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    lower.includes('session not found') ||
    lower.includes('thread not found') ||
    (lower.includes('resume') && lower.includes('session'))
  ) {
    return true;
  }

  // Transient / mid-stream failures that a fresh thread can recover from.
  // We are deliberately permissive here: the caller still gates on
  // `committedFinalAnswer` and the abort signal before retrying,
  // so a false positive will simply replay the turn from scratch.
  if (
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('premature close') ||
    lower.includes('unexpected end') ||
    lower.includes('stream closed') ||
    lower.includes('stream ended') ||
    lower.includes('stream error') ||
    lower.includes('network error') ||
    lower.includes('fetch failed') ||
    lower.includes('etimedout') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('upstream') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('mid_stream_timeout') ||
    lower.includes('timed out')
  ) {
    return true;
  }

  return false;
}

/** Heuristic: was this error caused by the caller aborting the request? */
function isAbortError(err: unknown): boolean {
  if (!err) return false;
  // DOMException / AbortError
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  if (anyErr?.name === 'AbortError') return true;
  if (anyErr?.code === 'ABORT_ERR') return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('aborted') || message.includes('abortsignal') || message.includes('user aborted');
}

function getCodexClientConfig(): { apiKey?: string; baseUrl?: string } {
  const apiKey = process.env.CTI_CODEX_API_KEY
    || process.env.CODEX_API_KEY
    || process.env.OPENAI_API_KEY
    || undefined;
  const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function getCodexPathOverride(): string | undefined {
  const appCodex = process.env.CTI_CODEX_PATH || '/Applications/Codex.app/Contents/Resources/codex';
  return fs.existsSync(appCodex) ? appCodex : undefined;
}

export async function preflightCodexProvider(): Promise<void> {
  try {
    const sdkModule = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    const CodexClass = sdkModule.Codex;
    const codexPathOverride = getCodexPathOverride();
    void new CodexClass({
      ...getCodexClientConfig(),
      ...(codexPathOverride ? { codexPathOverride } : {}),
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  async preflight(): Promise<void> {
    await preflightCodexProvider();
  }

  async preflightCheck(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.preflight();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const { apiKey, baseUrl } = getCodexClientConfig();
    const codexPathOverride = getCodexPathOverride();

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(codexPathOverride ? { codexPathOverride } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            const inMemoryThreadId = self.threadIds.get(params.sessionId);
            let savedThreadId = inMemoryThreadId || params.sdkSessionId || undefined;

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();
            const sandboxMode = getSandboxMode();
            const modelReasoningEffort = getReasoningEffort();
            const networkAccessEnabled = getNetworkAccessEnabled();
            const additionalDirectories = getAdditionalDirectories();

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              ...(shouldSkipGitRepoCheck() ? { skipGitRepoCheck: true } : {}),
              ...(sandboxMode ? { sandboxMode } : {}),
              ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
              ...(networkAccessEnabled !== undefined ? { networkAccessEnabled } : {}),
              ...(additionalDirectories ? { additionalDirectories } : {}),
              approvalPolicy,
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            const imageFiles = params.files?.filter(
              (file): file is NonNullable<typeof params.files>[number] => file.type.startsWith('image/')
            ) ?? [];

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: params.prompt },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = params.prompt;
            }

            let retriesRemaining = 1;
            // True once we have committed the final answer (agent_message
            // item, agent_message payload with phase === 'final_answer',
            // task_complete with last_agent_message, or turn.completed).
            // Retrying after this would deliver duplicate text to the user.
            let committedFinalAnswer = false;
            // Structured payload for a mid-stream timeout we have not yet
            // surfaced to the user. Stashed so the catch block can decide
            // whether to retry (discard payload) or emit it (no retry path).
            let pendingTimeoutErrorPayload: Record<string, unknown> | null = null;
            const startupIdleMs = getStartupIdleMs();
            const terminalIdleMs = getTerminalIdleMs();
            const midStreamIdleMs = getMidStreamIdleMs();
            const toolWallclockMs = getToolWallclockMs();
            const progressState: ProgressEventState = {
              lastFinalAnswerText: null,
            };

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const streamedResult = await resolveWithTimeout(
                  thread.runStreamed(input, { signal: params.abortController?.signal }),
                  startupIdleMs,
                  STARTUP_TIMEOUT,
                );
	                if (streamedResult === STARTUP_TIMEOUT) {
	                  throw new Error('Codex startup timed out before any events were received');
	                }

	                const { events } = streamedResult as { events: AsyncIterable<Record<string, unknown>> };
	                const iterator = events[Symbol.asyncIterator]();
                let sawTerminalEvent = false;
                const inFlightTools = new Set<string>();
                let lastEventType: string | undefined;
                let lastToolName: string | undefined;
                let lastEventAt = Date.now();

                while (true) {
                  const abortSignal = params.abortController?.signal;
                  const activeMidStreamIdleMs = inFlightTools.size > 0
                    ? Math.max(midStreamIdleMs, toolWallclockMs)
                    : midStreamIdleMs;
                  const nextResult = sawTerminalEvent
                    ? await readNextEventWithTimeout(iterator, terminalIdleMs, TERMINAL_TIMEOUT, abortSignal)
                    : !sawAnyEvent
                      ? await readNextEventWithTimeout(iterator, startupIdleMs, STARTUP_TIMEOUT, abortSignal)
                      : await readNextEventWithTimeout(iterator, activeMidStreamIdleMs, MID_STREAM_TIMEOUT, abortSignal);

                  if (nextResult === ABORT_MARKER) {
                    await iterator.return?.();
                    break;
                  }

                  if (nextResult === TERMINAL_TIMEOUT) {
                    console.warn(
                      '[codex-provider] Terminal event drain timed out; closing the stream early for session:',
                      params.sessionId,
                    );
                    await iterator.return?.();
                    break;
                  }

                  if (nextResult === MID_STREAM_TIMEOUT) {
                    console.warn(
                      '[codex-provider] Mid-stream event wait timed out after',
                      activeMidStreamIdleMs,
                      'ms for session:',
                      params.sessionId,
                      {
                        lastEventType,
                        lastToolName,
                        inFlightToolIds: Array.from(inFlightTools),
                      },
                    );
                    pendingTimeoutErrorPayload = {
                      reason: 'mid_stream_timeout',
                      midStreamIdleMs: activeMidStreamIdleMs,
                      lastEventType,
                      inFlightToolIds: Array.from(inFlightTools),
                      elapsedMs: Date.now() - lastEventAt,
                    };
                    await iterator.return?.();
                    throw new Error('mid_stream_timeout');
                  }

	                  if (nextResult === STARTUP_TIMEOUT) {
	                    console.warn(
	                      '[codex-provider] Startup timed out before the first event arrived for session:',
	                      params.sessionId,
                    );
                    await iterator.return?.();
                    throw new Error('Codex startup timed out before any events were received');
                  }

	                  const iteratorResult = nextResult as IteratorResult<Record<string, unknown>>;
	                  if (iteratorResult.done) {
	                    break;
	                  }

	                  const event = iteratorResult.value;
                  sawAnyEvent = true;
                  lastEventAt = Date.now();
                  if (typeof event.type === 'string') {
                    lastEventType = event.type;
                  }
                  if (event.type === 'item.started' || event.type === 'item.completed') {
                    const item = event.item as { id?: unknown; type?: unknown } | undefined;
                    const itemId = typeof item?.id === 'string' ? item.id : undefined;
                    const itemType = typeof item?.type === 'string' ? item.type : undefined;
                    if (itemId && itemType && IN_FLIGHT_TOOL_TYPES.has(itemType)) {
                      if (event.type === 'item.started') {
                        inFlightTools.add(itemId);
                        lastToolName = itemType;
                      } else {
                        inFlightTools.delete(itemId);
                      }
                    }
                  }
                  if (params.abortController?.signal.aborted) {
                    await iterator.return?.();
                    break;
                  }

	                  switch (event.type) {
	                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
	                      break;
	                    }

	                    case 'event_msg': {
	                      const result = self.handleProgressEvent(
	                        controller,
	                        (event as { payload?: Record<string, unknown> }).payload,
	                        progressState,
	                      );
	                      if (result.committedFinalAnswer) {
	                        committedFinalAnswer = true;
	                      }
	                      if (result.sawTerminalEvent) {
	                        sawTerminalEvent = true;
	                      }
	                      break;
	                    }

	                    case 'response_item': {
	                      const result = self.handleProgressEvent(
	                        controller,
	                        (event as { payload?: Record<string, unknown> }).payload,
	                        progressState,
	                      );
	                      if (result.committedFinalAnswer) {
	                        committedFinalAnswer = true;
	                      }
	                      if (result.sawTerminalEvent) {
	                        sawTerminalEvent = true;
	                      }
	                      break;
	                    }

	                    case 'item.completed': {
	                      const item = event.item as Record<string, unknown>;
	                      const result = self.handleCompletedItem(controller, item);
	                      if (result.committedFinalAnswer) {
	                        committedFinalAnswer = true;
	                      }
	                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);

                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      committedFinalAnswer = true;
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string }).message;
                      if (progressState.lastFinalAnswerText) {
                        console.warn(
                          '[codex-provider] Ignoring post-final turn.failed event for session:',
                          params.sessionId,
                          error || 'Turn failed',
                        );
                        break;
                      }
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      if (progressState.lastFinalAnswerText) {
                        console.warn(
                          '[codex-provider] Ignoring post-final error event for session:',
                          params.sessionId,
                          error || 'Thread error',
                        );
                        break;
                      }
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }

	                  if (typeof event.type === 'string' && isTerminalEvent(event.type)) {
	                    sawTerminalEvent = true;
	                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const aborted = params.abortController?.signal.aborted || isAbortError(err);

                if (progressState.lastFinalAnswerText) {
                  console.warn(
                    '[codex-provider] Ignoring post-final stream error for session:',
                    params.sessionId,
                    message,
                  );
                  break;
                }

                // Retry on a fresh thread when:
                //  1. We still have a saved thread id (the original attempt
                //     was a resume — fresh start might recover),
                //  2. The user has not aborted,
                //  3. We have not already committed the final answer
                //     (replaying would not produce duplicate final text;
                //     commentary/tool output alone no longer blocks retry),
                //  4. The error looks recoverable per shouldRetryFreshThread,
                //  5. We have retry budget left.
                //
                // We deliberately drop the `!sawAnyEvent` gate from the old
                // logic: Codex sometimes fails AFTER thread.started but BEFORE
                // any final answer, and that case used to deadlock sessions
                // until a manual /new. The committedFinalAnswer flag is the
                // right invariant — until the user has seen the final text,
                // a clean replay is visible only as a longer wait.
                if (
                  savedThreadId &&
                  retriesRemaining > 0 &&
                  !aborted &&
                  !committedFinalAnswer &&
                  shouldRetryFreshThread(message)
                ) {
                  console.warn(
                    '[codex-provider] Resume/stream failed before final answer, retrying with a fresh thread:',
                    message,
                  );
                  savedThreadId = undefined;
                  retriesRemaining -= 1;
                  // Drop the dead in-memory mapping so any concurrent reads
                  // do not pick up the broken thread id again.
                  self.threadIds.delete(params.sessionId);
                  // Discard any stashed timeout payload — the retry will
                  // either succeed (no user-facing error) or fail through
                  // a different path that will surface its own error.
                  pendingTimeoutErrorPayload = null;
                  // sawAnyEvent is scoped to the inner try; reset is implicit
                  // because the next iteration declares a fresh `let`.
                  continue;
                }

                // Retry not possible. If we stashed a structured timeout
                // payload, surface it now (preserves the structured shape
                // expected by downstream error handling) and close cleanly
                // — re-throwing here would route through the outer catch
                // and emit a bare 'mid_stream_timeout' string instead.
                if (pendingTimeoutErrorPayload) {
                  controller.enqueue(sseEvent('error', pendingTimeoutErrorPayload));
                  pendingTimeoutErrorPayload = null;
                  break;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map a completed Codex item to SSE events.
   */
	  private handleCompletedItem(
	    controller: ReadableStreamDefaultController<string>,
	    item: Record<string, unknown>,
	  ): CompletedItemResult {
    const itemType = item.type as string;
    const finalAnswer: CompletedItemResult = { committedFinalAnswer: true };
    const notFinalAnswer: CompletedItemResult = { committedFinalAnswer: false };

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('text', text));
          return finalAnswer;
        }
        return notFinalAnswer;
      }

      case 'command_execution': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Bash',
          input: { command },
        }));

        const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: resultContent,
          is_error: isError,
        }));
        return notFinalAnswer;
      }

      case 'file_change': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: 'Edit',
          input: { files: changes },
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: summary || 'File changes applied',
          is_error: false,
        }));
        return notFinalAnswer;
      }

      case 'mcp_tool_call': {
        const toolId = (item.id as string) || `tool-${Date.now()}`;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        controller.enqueue(sseEvent('tool_use', {
          id: toolId,
          name: `mcp__${server}__${tool}`,
          input: args,
        }));

        controller.enqueue(sseEvent('tool_result', {
          tool_use_id: toolId,
          content: error?.message || resultText || 'Done',
          is_error: !!error,
        }));
        return notFinalAnswer;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status. Status events are not
        // considered user-visible "committed" output for retry purposes.
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { progress_text: text, reasoning: text }));
        }
        return notFinalAnswer;
	      }
	    }
        return notFinalAnswer;
	  }

	  private handleProgressEvent(
	    controller: ReadableStreamDefaultController<string>,
	    payload: Record<string, unknown> | undefined,
	    state: ProgressEventState,
	  ): ProgressEventResult {
	    const noProgress: ProgressEventResult = {
	      committedFinalAnswer: false,
	      sawTerminalEvent: false,
	    };
	    if (!payload) return noProgress;

	    if (payload.type === 'task_complete') {
	      const lastAgentMessage = typeof payload.last_agent_message === 'string'
	        ? payload.last_agent_message.trim()
	        : '';
	      if (lastAgentMessage && lastAgentMessage !== state.lastFinalAnswerText) {
	        controller.enqueue(sseEvent('text', lastAgentMessage));
	        state.lastFinalAnswerText = lastAgentMessage;
	      }
	      if (lastAgentMessage || state.lastFinalAnswerText) {
	        controller.enqueue(sseEvent('status', { final_answer_committed: true }));
	      }
	      return {
	        committedFinalAnswer: Boolean(lastAgentMessage),
	        sawTerminalEvent: true,
	      };
	    }

	    if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
	      const message = payload.message.trim();
	      if (payload.phase === 'final_answer') {
	        if (message !== state.lastFinalAnswerText) {
	          controller.enqueue(sseEvent('text', message));
	          state.lastFinalAnswerText = message;
	        }
	        controller.enqueue(sseEvent('status', { final_answer_committed: true }));
	        return {
	          committedFinalAnswer: true,
	          sawTerminalEvent: true,
	        };
	      }
	      controller.enqueue(sseEvent('status', { progress_text: message }));
	      return noProgress;
	    }

	    if (payload.type !== 'message' || payload.role !== 'assistant') {
	      return noProgress;
	    }

	    const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
	    const assistantText = content
	      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
	      .map((part) => String(part.text).trim())
	      .filter(Boolean)
	      .join('\n\n');

	    if (!assistantText) {
	      return payload.phase === 'final_answer'
	        ? { committedFinalAnswer: false, sawTerminalEvent: true }
	        : noProgress;
	    }

	    if (payload.phase === 'final_answer') {
	      if (assistantText !== state.lastFinalAnswerText) {
	        controller.enqueue(sseEvent('text', assistantText));
	        state.lastFinalAnswerText = assistantText;
	      }
	      controller.enqueue(sseEvent('status', { final_answer_committed: true }));
	      return {
	        committedFinalAnswer: true,
	        sawTerminalEvent: true,
	      };
	    }

	    if (payload.phase === 'commentary') {
	      controller.enqueue(sseEvent('status', { progress_text: assistantText }));
	    }

	    return noProgress;
	  }
}

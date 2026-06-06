import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── SSE utils tests ─────────────────────────────────────────

import { sseEvent } from '../sse-utils.js';

describe('sseEvent', () => {
  it('formats a string data payload', () => {
    const result = sseEvent('text', 'hello');
    assert.equal(result, 'data: {"type":"text","data":"hello"}\n');
  });

  it('stringifies object data payload', () => {
    const result = sseEvent('result', { usage: { input_tokens: 10 } });
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.type, 'result');
    const inner = JSON.parse(parsed.data);
    assert.equal(inner.usage.input_tokens, 10);
  });

  it('handles newlines in data', () => {
    const result = sseEvent('text', 'line1\nline2');
    const parsed = JSON.parse(result.slice(6));
    assert.equal(parsed.data, 'line1\nline2');
  });
});

// ── CodexProvider tests ─────────────────────────────────────

async function collectStream(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

function parseSSEChunks(chunks: string[]): Array<{ type: string; data: string }> {
  return chunks
    .flatMap(chunk => chunk.split('\n'))
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

async function withEnv(
  env: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function expectStreamToFinishWithin(
  stream: ReadableStream<string>,
  timeoutMs: number,
): Promise<string[]> {
  return await Promise.race([
    collectStream(stream),
    new Promise<string[]>((_, reject) => {
      setTimeout(() => reject(new Error(`stream did not finish within ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

// CTI_CODEX_* env vars that govern Codex thread-option defaults. The host
// process may export these (e.g. a live bridge environment), which would leak
// into tests that assert default behavior. Snapshot and clear them before each
// test so every test starts from a clean default; tests that opt in still set
// their var via withEnv. Restored after each test.
const CODEX_OPTION_ENV_KEYS = [
  'CTI_CODEX_PASS_MODEL',
  'CTI_CODEX_SKIP_GIT_REPO_CHECK',
  'CTI_CODEX_SANDBOX_MODE',
  'CTI_CODEX_MODEL_REASONING_EFFORT',
  'CTI_CODEX_NETWORK_ACCESS_ENABLED',
  'CTI_CODEX_ADDITIONAL_DIRECTORIES',
  'CTI_CODEX_APPROVAL_POLICY',
] as const;

describe('CodexProvider', () => {
  const savedCodexEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of CODEX_OPTION_ENV_KEYS) {
      savedCodexEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedCodexEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    savedCodexEnv.clear();
  });

  it('fails preflight before startup when the Codex SDK cannot initialize', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());
    (provider as any).preflight = async () => {
      throw new Error('Codex SDK unavailable');
    };

    await assert.rejects(() => provider.preflight?.() as Promise<void>, /Codex SDK unavailable/);
  });

  it('emits error when SDK init fails', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Force ensureSDK to fail by setting sdk to a broken module
    (provider as any).sdk = { Codex: class { constructor() { throw new Error('Missing API key'); } } };
    (provider as any).codex = null;
    // Reset so ensureSDK re-runs the constructor
    (provider as any).sdk = null;
    // Override ensureSDK directly
    (provider as any).ensureSDK = async () => { throw new Error('SDK init failed: Missing API key'); };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'test-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.ok(errorEvent!.data.includes('Missing API key'), 'Error should contain the cause');
  });

  it('maps agent_message item to text SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-1',
      text: 'Hello from Codex!',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data, 'Hello from Codex!');
  });

  it('maps event_msg agent progress to status SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield {
            type: 'event_msg',
            payload: {
              type: 'agent_message',
              message: '正在检查 Docker 状态',
            },
          };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'progress-event-msg-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const statusEvent = events.find(e => e.type === 'status' && JSON.parse(e.data).progress_text);

    assert.ok(statusEvent, 'Should emit a status progress event');
    assert.equal(JSON.parse(statusEvent!.data).progress_text, '正在检查 Docker 状态');
  });

  it('maps response_item commentary progress to status SSE event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield {
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              content: [
                { type: 'output_text', text: '我先暂停自动任务。' },
                { type: 'output_text', text: '接着会重跑这份 PDF。' },
              ],
            },
          };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'progress-response-item-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const statusEvent = events.find(e => e.type === 'status' && JSON.parse(e.data).progress_text);

    assert.ok(statusEvent, 'Should emit a status progress event');
    assert.equal(JSON.parse(statusEvent!.data).progress_text, '我先暂停自动任务。\n\n接着会重跑这份 PDF。');
  });

  it('emits final-answer text from event_msg agent_message and closes after task_complete when the iterator hangs', async () => {
    await withEnv({ CTI_CODEX_TERMINAL_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let returnCalls = 0;
      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: {
                type: 'thread.started',
                thread_id: 'event-msg-final-thread',
              },
            };
          }
          if (nextCalls === 2) {
            return {
              done: false,
              value: {
                type: 'event_msg',
                payload: {
                  type: 'agent_message',
                  phase: 'final_answer',
                  message: '最终回复已经好了',
                },
              },
            };
          }
          if (nextCalls === 3) {
            return {
              done: false,
              value: {
                type: 'event_msg',
                payload: {
                  type: 'task_complete',
                  last_agent_message: '最终回复已经好了',
                },
              },
            };
          }
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'event-msg-final-answer-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);

      assert.ok(events.some(e => e.type === 'text' && e.data === '最终回复已经好了'));
      assert.equal(returnCalls, 1, 'Should stop the hanging iterator after task_complete');
    });
  });

  it('keeps the final answer when the Codex stream disconnects after task_complete', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let nextCalls = 0;
    const iterator: AsyncIterator<Record<string, unknown>> = {
      async next() {
        nextCalls += 1;
        if (nextCalls === 1) {
          return {
            done: false,
            value: {
              type: 'thread.started',
              thread_id: 'post-final-broken-pipe-thread',
            },
          };
        }
        if (nextCalls === 2) {
          return {
            done: false,
            value: {
              type: 'event_msg',
              payload: {
                type: 'agent_message',
                phase: 'final_answer',
                message: 'Demo 已经做好',
              },
            },
          };
        }
        if (nextCalls === 3) {
          return {
            done: false,
            value: {
              type: 'event_msg',
              payload: {
                type: 'task_complete',
                last_agent_message: 'Demo 已经做好',
              },
            },
          };
        }
        throw new Error('stream disconnected before completion: failed to send websocket request: IO error: Broken pipe (os error 32)');
      },
    };

    const mockThread = {
      runStreamed: () => ({
        events: {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        },
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'post-final-broken-pipe-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    assert.ok(events.some(e => e.type === 'text' && e.data === 'Demo 已经做好'));
    assert.equal(events.some(e => e.type === 'error'), false);
  });

  it('keeps the final answer when Codex emits an error event after task_complete', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let nextCalls = 0;
    const iterator: AsyncIterator<Record<string, unknown>> = {
      async next() {
        nextCalls += 1;
        if (nextCalls === 1) {
          return {
            done: false,
            value: {
              type: 'thread.started',
              thread_id: 'post-final-error-event-thread',
            },
          };
        }
        if (nextCalls === 2) {
          return {
            done: false,
            value: {
              type: 'event_msg',
              payload: {
                type: 'agent_message',
                phase: 'final_answer',
                message: 'Demo 链接：\n\nhttp://127.0.0.1:3000/',
              },
            },
          };
        }
        if (nextCalls === 3) {
          return {
            done: false,
            value: {
              type: 'event_msg',
              payload: {
                type: 'task_complete',
                last_agent_message: 'Demo 链接：\n\nhttp://127.0.0.1:3000/',
              },
            },
          };
        }
        if (nextCalls === 4) {
          return {
            done: false,
            value: {
              type: 'error',
              message: 'stream disconnected before completion: websocket closed by server before response.completed',
            },
          };
        }
        return { done: true, value: undefined };
      },
    };

    const mockThread = {
      runStreamed: () => ({
        events: {
          [Symbol.asyncIterator]() {
            return iterator;
          },
        },
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'post-final-error-event-session',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);

    assert.ok(events.some(e => e.type === 'text' && e.data === 'Demo 链接：\n\nhttp://127.0.0.1:3000/'));
    assert.equal(events.some(e => e.type === 'error'), false);
  });

  it('emits final-answer text from response_item and closes after terminal idle when no explicit turn.completed arrives', async () => {
    await withEnv({ CTI_CODEX_TERMINAL_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let returnCalls = 0;
      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: {
                type: 'thread.started',
                thread_id: 'response-item-final-thread',
              },
            };
          }
          if (nextCalls === 2) {
            return {
              done: false,
              value: {
                type: 'response_item',
                payload: {
                  type: 'message',
                  role: 'assistant',
                  phase: 'final_answer',
                  content: [
                    { type: 'output_text', text: '这是最终回答' },
                  ],
                },
              },
            };
          }
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'response-item-final-answer-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);

      assert.ok(events.some(e => e.type === 'text' && e.data === '这是最终回答'));
      assert.equal(returnCalls, 1, 'Should stop the hanging iterator after a final_answer response item');
    });
  });

  it('maps reasoning progress into the same status progress channel', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'reasoning',
      id: 'reasoning-1',
      text: '先确认当前的执行环境。',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'status');
    assert.equal(JSON.parse(events[0].data).progress_text, '先确认当前的执行环境。');
  });

  it('maps command_execution item to tool_use + tool_result', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1.txt\nfile2.txt',
      exit_code: 0,
      status: 'completed',
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);

    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Bash');
    assert.equal(toolUse.input.command, 'ls -la');

    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.tool_use_id, 'cmd-1');
    assert.equal(toolResult.is_error, false);
  });

  it('marks non-zero exit code as error', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'command_execution',
      id: 'cmd-2',
      command: 'false',
      aggregated_output: '',
      exit_code: 1,
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.is_error, true);
  });

  it('maps file_change item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'file_change',
      id: 'fc-1',
      changes: [
        { path: 'src/main.ts', kind: 'update' },
        { path: 'src/new.ts', kind: 'add' },
      ],
    });

    const events = parseSSEChunks(chunks);
    assert.equal(events.length, 2);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'Edit');
    const toolResult = JSON.parse(events[1].data);
    assert.ok(toolResult.content.includes('update: src/main.ts'));
  });

  it('maps mcp_tool_call item correctly', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-1',
      server: 'myserver',
      tool: 'search',
      arguments: { query: 'test' },
      result: { content: 'found 3 results' },
    });

    const events = parseSSEChunks(chunks);
    const toolUse = JSON.parse(events[0].data);
    assert.equal(toolUse.name, 'mcp__myserver__search');
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, 'found 3 results');
  });

  it('maps mcp_tool_call with structured_content', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'mcp_tool_call',
      id: 'mcp-2',
      server: 'myserver',
      tool: 'getData',
      arguments: {},
      result: { structured_content: { items: [1, 2, 3] } },
    });

    const events = parseSSEChunks(chunks);
    const toolResult = JSON.parse(events[1].data);
    assert.equal(toolResult.content, JSON.stringify({ items: [1, 2, 3] }));
  });

  it('skips empty agent_message', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const chunks: string[] = [];
    const mockController = {
      enqueue: (chunk: string) => chunks.push(chunk),
    } as unknown as ReadableStreamDefaultController<string>;

    (provider as any).handleCompletedItem(mockController, {
      type: 'agent_message',
      id: 'msg-2',
      text: '',
    });

    assert.equal(chunks.length, 0);
  });

  it('does not pass model by default and still attempts resume for persisted thread ids', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;
    let capturedResumeOptions: Record<string, unknown> | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string, options: Record<string, unknown>) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        capturedResumeOptions = options;
        return mockThread;
      },
      startThread: (_opts: Record<string, unknown>) => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'hello',
      sessionId: 'model-default-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should attempt resume for the persisted thread id');
    assert.equal(resumedThreadId, 'old-claude-session-id');
    assert.equal(startCalls, 0, 'Should not eagerly start a fresh thread when resume is available');
    assert.ok(capturedResumeOptions, 'resumeThread options should be captured');
    assert.ok(!Object.prototype.hasOwnProperty.call(capturedResumeOptions!, 'model'), 'Model should not be forwarded by default');
  });

  it('reuses the in-memory Codex thread even when the stored model is Claude-like', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    let resumedThreadId: string | undefined;

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).threadIds.set('sticky-codex-session', 'codex-thread-123');
    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: (threadId: string) => {
        resumeCalls += 1;
        resumedThreadId = threadId;
        return mockThread;
      },
      startThread: () => {
        startCalls += 1;
        return mockThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'continue previous thread',
      sessionId: 'sticky-codex-session',
      sdkSessionId: 'old-claude-session-id',
      model: 'claude-sonnet-4-20250514',
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should resume the in-memory Codex thread');
    assert.equal(resumedThreadId, 'codex-thread-123');
    assert.equal(startCalls, 0, 'Should not start a fresh thread when an in-memory Codex thread exists');
  });

  it('passes model only when CTI_CODEX_PASS_MODEL=true', async () => {
    await withEnv({ CTI_CODEX_PASS_MODEL: 'true' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'model-forward-session',
        model: 'gpt-5-codex',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.model, 'gpt-5-codex');
    });
  });

  it('passes skipGitRepoCheck only when CTI_CODEX_SKIP_GIT_REPO_CHECK=true', async () => {
    await withEnv({ CTI_CODEX_SKIP_GIT_REPO_CHECK: 'true' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'skip-git-check-session',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.skipGitRepoCheck, true);
    });
  });

  it('passes reasoning effort, sandbox, network access, and additional directories via env', async () => {
    await withEnv({
      CTI_CODEX_MODEL_REASONING_EFFORT: 'high',
      CTI_CODEX_SANDBOX_MODE: 'danger-full-access',
      CTI_CODEX_NETWORK_ACCESS_ENABLED: 'true',
      CTI_CODEX_ADDITIONAL_DIRECTORIES: '/,/Users/example,/tmp',
    }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'advanced-codex-options',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.modelReasoningEffort, 'high');
      assert.equal(capturedStartOptions?.sandboxMode, 'danger-full-access');
      assert.equal(capturedStartOptions?.networkAccessEnabled, true);
      assert.deepEqual(capturedStartOptions?.additionalDirectories, ['/', '/Users/example', '/tmp']);
    });
  });

  it('lets env approval policy override the default permission mapping', async () => {
    await withEnv({ CTI_CODEX_APPROVAL_POLICY: 'never' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let capturedStartOptions: Record<string, unknown> | undefined;
      const mockThread = {
        runStreamed: () => ({
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
          })(),
        }),
      };
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: (opts: Record<string, unknown>) => {
          capturedStartOptions = opts;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'approval-override-session',
        permissionMode: 'default',
      });
      await collectStream(stream);

      assert.equal(capturedStartOptions?.approvalPolicy, 'never');
    });
  });

  it('retries with fresh thread when resume fails before any events', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;
    const resumeThread = {
      runStreamed: async () => {
        throw new Error('resuming session with different model');
      },
    };
    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return freshThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'retry test',
      sessionId: 'resume-retry-session',
      sdkSessionId: 'codex-old-thread-id',
      model: 'gpt-5-codex',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    const resultEvent = events.find(e => e.type === 'result');

    assert.equal(resumeCalls, 1, 'Should attempt resume once');
    assert.equal(startCalls, 1, 'Should fall back to a fresh thread');
    assert.ok(!errorEvent, 'Retry success should not emit error');
    assert.ok(resultEvent, 'Retry success should emit result');
  });

  it('retries with fresh thread when stream fails after thread.started but before any user-visible output', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;

    // resumeThread emits thread.started + a reasoning status event, then
    // throws a transient mid-stream error (mimicking SDK/network drop).
    const resumeThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'old-thread-id' };
          yield {
            type: 'item.completed',
            item: { type: 'reasoning', id: 'r1', text: 'thinking…' },
          };
          throw new Error('socket hang up');
        })(),
      }),
    };

    const freshThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'fresh-thread-id' };
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', id: 'm1', text: 'Hello after retry' },
          };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } };
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return freshThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'mid-stream retry',
      sessionId: 'midstream-retry-session',
      sdkSessionId: 'codex-old-thread-id',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const textEvents = events.filter(e => e.type === 'text');
    const errorEvent = events.find(e => e.type === 'error');

    assert.equal(resumeCalls, 1, 'Should attempt resume once');
    assert.equal(startCalls, 1, 'Should fall back to a fresh thread on transient mid-stream error');
    assert.ok(!errorEvent, 'Retry success should not surface an error to the user');
    assert.equal(textEvents.length, 1, 'User should see exactly one assistant text from the fresh thread');
    assert.equal(textEvents[0].data, 'Hello after retry');
  });

  it('does NOT retry when stream fails after user-visible text has already been emitted', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;

    const resumeThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'committed-thread' };
          yield {
            type: 'item.completed',
            item: { type: 'agent_message', id: 'm1', text: 'partial answer' },
          };
          throw new Error('socket hang up');
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return resumeThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'no-retry test',
      sessionId: 'no-retry-after-text-session',
      sdkSessionId: 'committed-thread',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const textEvents = events.filter(e => e.type === 'text');
    const errorEvent = events.find(e => e.type === 'error');

    assert.equal(resumeCalls, 1, 'Should not retry once user-visible text has been committed');
    assert.equal(startCalls, 0, 'Should not start a fresh thread after committed output');
    assert.equal(textEvents.length, 1, 'User keeps the partial text');
    assert.ok(errorEvent, 'The transient error should surface so the user knows the turn failed');
  });

  it('does NOT retry on transient errors when the request was aborted by the user', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let resumeCalls = 0;
    let startCalls = 0;

    const abortController = new AbortController();

    const resumeThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'thread.started', thread_id: 'aborted-thread' };
          // User aborts mid-flight, then SDK throws an abort-shaped error.
          abortController.abort();
          throw new Error('The operation was aborted');
        })(),
      }),
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      resumeThread: () => {
        resumeCalls += 1;
        return resumeThread;
      },
      startThread: () => {
        startCalls += 1;
        return resumeThread;
      },
    };

    const stream = provider.streamChat({
      prompt: 'abort test',
      sessionId: 'abort-no-retry-session',
      sdkSessionId: 'aborted-thread',
      abortController,
    });

    await collectStream(stream);

    assert.equal(resumeCalls, 1, 'Should attempt the original resume');
    assert.equal(startCalls, 0, 'Must not retry after a user-initiated abort');
  });

  it('preflight succeeds after Codex runtime initialization without starting a thread', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let preflightCalls = 0;
    (provider as any).preflight = async () => {
      preflightCalls += 1;
    };

    const result = await (provider as any).preflightCheck();
    assert.deepEqual(result, { ok: true });
    assert.equal(preflightCalls, 1);
  });

  it('fails lightweight preflight when Codex SDK cannot initialize', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    (provider as any).preflight = async () => {
      throw new Error('SDK init failed: Missing API key');
    };

    const result = await (provider as any).preflightCheck();
    assert.equal(result.ok, false);
    assert.match(result.error || '', /missing api key/i);
  });

  it('times out when runStreamed never resolves before any events', async () => {
    await withEnv({ CTI_CODEX_STARTUP_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      const mockThread = {
        runStreamed: async () => await new Promise<never>(() => {}),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'startup-runstreamed-timeout-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);
      const errorEvent = events.find(e => e.type === 'error');

      assert.ok(errorEvent, 'Should emit an error event');
      assert.match(errorEvent!.data, /startup timed out/i);
    });
  });

  it('times out when the first streamed event never arrives', async () => {
    await withEnv({ CTI_CODEX_STARTUP_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let returnCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: async () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'startup-first-event-timeout-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);
      const errorEvent = events.find(e => e.type === 'error');

      assert.ok(errorEvent, 'Should emit an error event');
      assert.match(errorEvent!.data, /startup timed out/i);
      assert.equal(returnCalls, 1, 'Should close the hanging iterator when the first event never arrives');
    });
  });

  it('does not apply startup timeout after the first event has already arrived', async () => {
    await withEnv({ CTI_CODEX_STARTUP_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: {
                type: 'thread.started',
                thread_id: 'startup-safe-thread',
              },
            };
          }
          if (nextCalls === 2) {
            return await new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
              setTimeout(() => resolve({
                done: false,
                value: {
                  type: 'turn.completed',
                  usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
                },
              }), 40);
            });
          }
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: async () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'startup-timeout-safe-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);

      assert.ok(events.some(e => e.type === 'status'), 'Should emit the first event');
      assert.ok(events.some(e => e.type === 'result'), 'Should still finish successfully');
      assert.ok(!events.some(e => e.type === 'error'), 'Should not emit a startup timeout error after the first event');
    });
  });
});

// ── Image input building tests ──────────────────────────────

import fs from 'node:fs';

/** Helper: build a full FileAttachment object for tests. */
function makeFile(type: string, data: string, name = 'test-file') {
  return { id: `file-${Date.now()}`, name, type, size: data.length, data };
}

describe('CodexProvider image input', () => {
  it('builds local_image input array for text+image', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Mock the SDK so we can capture the input passed to runStreamed
    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    // Use valid base64 (1x1 red PNG pixel)
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const stream = provider.streamChat({
      prompt: 'Describe this image',
      sessionId: 'img-session',
      files: [makeFile('image/png', pngBase64, 'test.png')],
    });

    await collectStream(stream);

    assert.ok(Array.isArray(capturedInput), 'Input should be an array for image input');
    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 2);
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'Describe this image');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'), 'Temp file should have .png extension');
  });

  it('passes plain string when no images attached', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Hello',
      sessionId: 'no-img-session',
    });

    await collectStream(stream);

    assert.equal(typeof capturedInput, 'string', 'Input should be a plain string without images');
    assert.equal(capturedInput, 'Hello');
  });

  it('builds local_image input with multiple images, ignoring non-image files', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    let capturedInput: unknown;
    const mockThread = {
      runStreamed: (input: unknown) => {
        capturedInput = input;
        return {
          events: (async function* () {
            yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
          })(),
        };
      },
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'Compare these',
      sessionId: 'multi-img-session',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('image/jpeg', 'anBn', 'b.jpg'),
        makeFile('text/plain', 'dGV4dA==', 'c.txt'),
      ],
    });

    await collectStream(stream);

    const parts = capturedInput as Array<Record<string, string>>;
    assert.equal(parts.length, 3, 'Should have 1 text + 2 local_image parts (non-image file excluded)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'local_image');
    assert.ok(parts[1].path.endsWith('.png'));
    assert.equal(parts[2].type, 'local_image');
    assert.ok(parts[2].path.endsWith('.jpg'));
  });

  it('closes the stream after turn completion even if the iterator never ends cleanly', async () => {
    await withEnv({ CTI_CODEX_TERMINAL_IDLE_MS: '20' }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let returnCalls = 0;
      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: {
                type: 'thread.started',
                thread_id: 'thread-hang-test',
              },
            };
          }
          if (nextCalls === 2) {
            return {
              done: false,
              value: {
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  text: 'final reply',
                },
              },
            };
          }
          if (nextCalls === 3) {
            return {
              done: false,
              value: {
                type: 'turn.completed',
                usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
              },
            };
          }
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };
      (provider as any).sdk = {
        Codex: class { constructor() {} },
      };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'hello',
        sessionId: 'terminal-hang-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 250);
      const events = parseSSEChunks(chunks);

      assert.ok(events.some(e => e.type === 'text' && e.data === 'final reply'));
      assert.ok(events.some(e => e.type === 'result'));
      assert.equal(returnCalls, 1, 'Should stop the hanging iterator after the terminal event');
    });
  });
});

// ── Error event tests ───────────────────────────────────────

describe('CodexProvider error events', () => {
  it('reads message field from turn.failed event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed', message: 'Rate limit exceeded' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-1',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Rate limit exceeded');
  });

  it('reads message field from error event', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'error', message: 'Connection lost' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-2',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should emit an error event');
    assert.equal(errorEvent!.data, 'Connection lost');
  });

  it('falls back to default message when message field is absent', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    const mockThread = {
      runStreamed: () => ({
        events: (async function* () {
          yield { type: 'turn.failed' };
        })(),
      }),
    };
    (provider as any).sdk = {
      Codex: class { constructor() {} },
    };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const stream = provider.streamChat({
      prompt: 'test',
      sessionId: 'err-session-3',
    });

    const chunks = await collectStream(stream);
    const events = parseSSEChunks(chunks);
    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent);
    assert.equal(errorEvent!.data, 'Turn failed');
  });
});

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initBridgeContext } from '../../lib/bridge/context';
import { processMessage } from '../../lib/bridge/conversation-engine';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

function createMockStore() {
  const messages: Array<{ sessionId: string; role: string; content: string }> = [];
  const releasedLocks: Array<{ sessionId: string; lockId: string }> = [];
  const runtimeStatuses: string[] = [];
  const session: BridgeSession = {
    id: 'session-1',
    working_directory: '/Users/example/project',
    model: 'gpt-5.4',
    sdk_session_id: '',
    display_name: 'Session 1',
    updated_at: '2026-04-11T00:00:00.000Z',
    source: 'bridge',
  };

  const store = {
    messages,
    releasedLocks,
    runtimeStatuses,
    failRuntimeStatusWrites: false,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => session,
    createSession: () => session,
    updateSessionProviderId: () => {},
    addMessage: (sessionId: string, role: string, content: string) => {
      messages.push({ sessionId, role, content });
    },
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: (sessionId: string, lockId: string) => {
      releasedLocks.push({ sessionId, lockId });
    },
    setSessionRuntimeStatus: (_sessionId: string, status: string) => {
      runtimeStatuses.push(status);
      if (store.failRuntimeStatusWrites) {
        throw new Error('runtime status write failed');
      }
    },
    updateSdkSessionId: () => {},
    updateSessionModel: () => {},
    syncSdkTasks: () => {},
    getProvider: () => undefined,
    getDefaultProviderId: () => null,
    insertAuditLog: () => {},
    checkDedup: () => false,
    insertDedup: () => {},
    cleanupExpiredDedup: () => {},
    insertOutboundRef: () => {},
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
  return store;
}

type MockStore = ReturnType<typeof createMockStore>;

function setupContext(streamFactory: () => ReadableStream<string>, store: MockStore) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: streamFactory },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

describe('conversation-engine', () => {
  let store: MockStore;
  let binding: ChannelBinding;

  beforeEach(() => {
    store = createMockStore();
    binding = {
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: '/Users/example/project',
      model: 'gpt-5.4',
      mode: 'code',
      active: true,
      createdAt: '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
  });

  it('preserves spacing between text blocks split by tool events', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'First paragraph.' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'tool_use',
          data: JSON.stringify({ id: 'tool-1', name: 'search', input: { q: 'test' } }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Second paragraph.' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.responseText, 'First paragraph.\n\nSecond paragraph.');
  });

  it('keeps runtime status writes best-effort and releases the session lock', async () => {
    store.failRuntimeStatusWrites = true;
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'ok' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, false);
    assert.equal(result.responseText, 'ok');
    assert.deepEqual(store.runtimeStatuses, ['running', 'idle']);
    assert.equal(store.releasedLocks.length, 1);
    assert.equal(store.releasedLocks[0]?.sessionId, 'session-1');
  });

  it('forwards progress_text from status events without polluting the final response', async () => {
    const progressUpdates: string[] = [];

    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ progress_text: '正在检查 Docker 状态' }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '最终答复。' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(
      binding,
      'hello',
      undefined,
      undefined,
      undefined,
      (progressText) => {
        progressUpdates.push(progressText);
      },
    );

    assert.deepEqual(progressUpdates, ['正在检查 Docker 状态', '最终答复。']);
    assert.equal(result.responseText, '最终答复。');
  });

  it('does not let a known post-text transport error replace the captured response', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Demo 链接：\n\nhttp://127.0.0.1:3000/' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'error',
          data: 'stream disconnected before completion: websocket closed by server before response.completed',
        })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'demo 链接发我');

    assert.equal(result.hasError, false);
    assert.equal(result.errorMessage, '');
    assert.equal(result.responseText, 'Demo 链接：\n\nhttp://127.0.0.1:3000/');
  });

  it('does not let a known post-final transport error replace the final response', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Demo 链接：\n\nhttp://127.0.0.1:3000/' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ final_answer_committed: true }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'error',
          data: 'stream disconnected before completion: websocket closed by server before response.completed',
        })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'demo 链接发我');

    assert.equal(result.hasError, false);
    assert.equal(result.errorMessage, '');
    assert.equal(result.responseText, 'Demo 链接：\n\nhttp://127.0.0.1:3000/');
  });

  it('keeps ordinary errors after partial text visible', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'partial output' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'error',
          data: 'process exited with code 1',
        })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, true);
    assert.equal(result.errorMessage, 'process exited with code 1');
    assert.equal(result.responseText, 'partial output');
  });

  it('surfaces a structured mid_stream_timeout error event with hasError=true and errorType', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'partial output' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'error',
          data: JSON.stringify({
            reason: 'mid_stream_timeout',
            midStreamIdleMs: 60000,
            lastEventType: 'item.completed',
            inFlightToolIds: [],
            elapsedMs: 60100,
          }),
        })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, true, 'mid_stream_timeout must surface as a hard error');
    assert.equal(result.errorType, 'mid_stream_timeout', 'errorType must be captured for Task 1.3 retry');
    assert.equal(result.responseText, 'partial output');
  });

  it('ignores ordinary error events after a final answer marker', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'final answer' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ final_answer_committed: true }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'error', data: 'process exited with code 1' })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, false);
    assert.equal(result.errorMessage, '');
    assert.equal(result.responseText, 'final answer');
  });

  it('lets a later final answer override an earlier transient reconnect error', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'error',
          data: 'stream disconnected before completion: websocket closed by server before response.completed',
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Demo 链接：\n\nhttp://127.0.0.1:3000/' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ final_answer_committed: true }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'demo 链接发我');

    assert.equal(result.hasError, false);
    assert.equal(result.errorMessage, '');
    assert.equal(result.responseText, 'Demo 链接：\n\nhttp://127.0.0.1:3000/');
  });

  it('ignores result.is_error after a final answer marker', async () => {
    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'final answer' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ final_answer_committed: true }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({
          type: 'result',
          data: JSON.stringify({ is_error: true }),
        })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(binding, 'hello');

    assert.equal(result.hasError, false);
    assert.equal(result.responseText, 'final answer');
  });

  it('forwards reasoning status into the unified progress channel', async () => {
    const progressUpdates: string[] = [];

    setupContext(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({ reasoning: '先确认当前会话状态。' }),
        })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '最终答复。' })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
        controller.close();
      },
    }), store);

    const result = await processMessage(
      binding,
      'hello',
      undefined,
      undefined,
      undefined,
      (progressText) => {
        progressUpdates.push(progressText);
      },
    );

    assert.deepEqual(progressUpdates, ['先确认当前会话状态。', '最终答复。']);
    assert.equal(result.responseText, '最终答复。');
  });

  it('saves generic documents locally but only passes images to the model attachment channel', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-uploads-test-'));
    binding.workingDirectory = workDir;
    let capturedFiles: unknown;
    let capturedPrompt = '';

    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: (params) => {
          capturedFiles = params.files;
          capturedPrompt = params.prompt;
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'done' })}\n`);
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const result = await processMessage(binding, 'read these', undefined, undefined, [
      { id: 'pdf-1', name: 'brief.pdf', type: 'application/pdf', size: 3, data: Buffer.from('pdf').toString('base64') },
      { id: 'img-1', name: 'photo.png', type: 'image/png', size: 3, data: Buffer.from('png').toString('base64') },
    ]);

    assert.equal(result.responseText, 'done');
    assert.match(capturedPrompt, /brief\.pdf .*\.codepilot-uploads/);
    assert.match(capturedPrompt, /photo\.png .*\.codepilot-uploads/);
    assert.deepEqual((capturedFiles as Array<{ name: string }>).map(file => file.name), ['photo.png']);
    assert.equal(fs.existsSync(path.join(workDir, '.codepilot-uploads')), true);
    assert.equal(fs.readFileSync(path.join(workDir, '.codepilot-uploads', '.gitignore'), 'utf-8'), '*\n!.gitignore\n');
    assert.equal(fs.readFileSync(path.join(workDir, '.codepilot-outbox', '.gitignore'), 'utf-8'), '*\n!.gitignore\n');
  });

  it('prepares an ignored outbox directory when the user asks to send a file', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outbox-hint-test-'));
    binding.workingDirectory = workDir;
    let capturedPrompt = '';

    delete (globalThis as Record<string, unknown>).__bridge_context__;
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: (params) => {
          capturedPrompt = params.prompt;
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'done' })}\n`);
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const result = await processMessage(binding, 'send me a report file');

    assert.equal(result.responseText, 'done');
    assert.match(capturedPrompt, /\.codepilot-outbox/);
    assert.equal(fs.readFileSync(path.join(workDir, '.codepilot-outbox', '.gitignore'), 'utf-8'), '*\n!.gitignore\n');
  });

  it('force-closes the stream when no further events arrive after the final-answer marker', async () => {
    const originalTimeout = process.env.CTI_POST_END_TURN_TIMEOUT_MS;
    process.env.CTI_POST_END_TURN_TIMEOUT_MS = '120';
    try {
      setupContext(() => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '监控开了。' })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'status',
            data: JSON.stringify({ final_answer_committed: true }),
          })}\n`);
          // Intentionally never close — simulates the hung-subprocess scenario.
        },
      }), store);

      const startedAt = Date.now();
      const result = await processMessage(binding, 'check status');
      const elapsed = Date.now() - startedAt;

      assert.equal(result.responseText, '监控开了。');
      assert.equal(result.hasError, false);
      assert.ok(elapsed < 3000, `expected timeout-bounded return, took ${elapsed}ms`);
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.CTI_POST_END_TURN_TIMEOUT_MS;
      } else {
        process.env.CTI_POST_END_TURN_TIMEOUT_MS = originalTimeout;
      }
    }
  });

  it('returns normally when result arrives soon after the final-answer marker', async () => {
    const originalTimeout = process.env.CTI_POST_END_TURN_TIMEOUT_MS;
    process.env.CTI_POST_END_TURN_TIMEOUT_MS = '5000';
    try {
      setupContext(() => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'final answer' })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'status',
            data: JSON.stringify({ final_answer_committed: true }),
          })}\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
          controller.close();
        },
      }), store);

      const result = await processMessage(binding, 'hello');

      assert.equal(result.hasError, false);
      assert.equal(result.responseText, 'final answer');
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.CTI_POST_END_TURN_TIMEOUT_MS;
      } else {
        process.env.CTI_POST_END_TURN_TIMEOUT_MS = originalTimeout;
      }
    }
  });

  it('still drains trailing tool events after the final-answer marker without corruption', async () => {
    const originalTimeout = process.env.CTI_POST_END_TURN_TIMEOUT_MS;
    process.env.CTI_POST_END_TURN_TIMEOUT_MS = '5000';
    try {
      setupContext(() => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'final answer' })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'status',
            data: JSON.stringify({ final_answer_committed: true }),
          })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'tool_use',
            data: JSON.stringify({ id: 'tool-trailing', name: 'log', input: {} }),
          })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'tool_result',
            data: JSON.stringify({ tool_use_id: 'tool-trailing', content: 'ok' }),
          })}\n`);
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
          controller.close();
        },
      }), store);

      const result = await processMessage(binding, 'hello');

      assert.equal(result.hasError, false);
      assert.equal(result.responseText, 'final answer');
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.CTI_POST_END_TURN_TIMEOUT_MS;
      } else {
        process.env.CTI_POST_END_TURN_TIMEOUT_MS = originalTimeout;
      }
    }
  });
});

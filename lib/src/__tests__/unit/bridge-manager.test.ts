/**
 * Unit tests for bridge-manager.
 *
 * Tests cover:
 * - Session lock concurrency: same-session serialization
 * - Session lock concurrency: different-session parallelism
 * - Bridge start/stop lifecycle
 * - Auto-start idempotency
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initBridgeContext } from '../../lib/bridge/context';
import { BaseChannelAdapter, registerAdapterFactory } from '../../lib/bridge/channel-adapter';
import type { BridgeStore, LifecycleHooks } from '../../lib/bridge/host';
import type { ChannelBinding, InboundMessage, OutboundFileMessage, OutboundMessage, SendResult } from '../../lib/bridge/types';
import { _testOnly, computeSdkSessionUpdate, extractOutboundFileRequests } from '../../lib/bridge/bridge-manager';

// ── Test the session lock mechanism directly ────────────────
// We test the processWithSessionLock pattern by extracting its logic.

function createSessionLocks() {
  const locks = new Map<string, Promise<void>>();

  function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = locks.get(sessionId) || Promise.resolve();
    const current = prev.then(fn, fn);
    locks.set(sessionId, current);
    // Suppress unhandled rejection on the cleanup chain — callers handle the error on `current` directly
    current.finally(() => {
      if (locks.get(sessionId) === current) {
        locks.delete(sessionId);
      }
    }).catch(() => {});
    return current;
  }

  return { locks, processWithSessionLock };
}

describe('bridge-manager session locks', () => {
  it('serializes same-session operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push(1);
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    assert.deepStrictEqual(order, [1, 2], 'Same-session operations should be serialized');
  });

  it('allows different-session operations to run concurrently', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const started: string[] = [];
    const completed: string[] = [];

    const p1 = processWithSessionLock('session-A', async () => {
      started.push('A');
      await new Promise(r => setTimeout(r, 50));
      completed.push('A');
    });

    const p2 = processWithSessionLock('session-B', async () => {
      started.push('B');
      await new Promise(r => setTimeout(r, 10));
      completed.push('B');
    });

    await Promise.all([p1, p2]);
    // Both should start before either completes (concurrent)
    assert.equal(started.length, 2);
    // B should complete first since it has shorter delay
    assert.equal(completed[0], 'B');
    assert.equal(completed[1], 'A');
  });

  it('continues after errors in locked operations', async () => {
    const { processWithSessionLock } = createSessionLocks();
    const order: number[] = [];

    const p1 = processWithSessionLock('session-1', async () => {
      order.push(1);
      throw new Error('test error');
    });

    const p2 = processWithSessionLock('session-1', async () => {
      order.push(2);
    });

    await p1.catch(() => {});
    await p2;
    assert.deepStrictEqual(order, [1, 2], 'Should continue after error');
  });

  it('cleans up completed locks', async () => {
    const { locks, processWithSessionLock } = createSessionLocks();

    await processWithSessionLock('session-1', async () => {});

    // Allow microtask to complete for finally() cleanup
    await new Promise(r => setTimeout(r, 0));
    assert.equal(locks.size, 0, 'Lock should be cleaned up after completion');
  });
});

describe('bridge-manager session lock timeout config', () => {
  const originalTimeout = process.env.CTI_SESSION_LOCK_TIMEOUT_MS;

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.CTI_SESSION_LOCK_TIMEOUT_MS;
    } else {
      process.env.CTI_SESSION_LOCK_TIMEOUT_MS = originalTimeout;
    }
  });

  it('reads CTI_SESSION_LOCK_TIMEOUT_MS at call time', () => {
    delete process.env.CTI_SESSION_LOCK_TIMEOUT_MS;
    assert.equal(_testOnly.getSessionLockTimeoutMs(), 30 * 60 * 1000);

    process.env.CTI_SESSION_LOCK_TIMEOUT_MS = '10800000';
    assert.equal(_testOnly.getSessionLockTimeoutMs(), 10800000);

    process.env.CTI_SESSION_LOCK_TIMEOUT_MS = '0';
    assert.equal(_testOnly.getSessionLockTimeoutMs(), 30 * 60 * 1000);

    process.env.CTI_SESSION_LOCK_TIMEOUT_MS = 'not-a-number';
    assert.equal(_testOnly.getSessionLockTimeoutMs(), 30 * 60 * 1000);
  });
});

// ── Lifecycle tests ─────────────────────────────────────────

describe('bridge-manager lifecycle', () => {
  beforeEach(() => {
    // Clear bridge manager state
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('getStatus returns not running when bridge has not started', async () => {
    const store = createMinimalStore({ remote_bridge_enabled: 'false' });
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    // Import dynamically to get fresh module state
    const { getStatus } = await import('../../lib/bridge/bridge-manager');
    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  it('does not mark the bridge running when adapter preflight fails', async () => {
    const channelType = `test-preflight-${Date.now()}`;
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
    });
    registerAdapterFactory(channelType, () => new FailingPreflightAdapter(channelType));
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { start, getStatus } = await import('../../lib/bridge/bridge-manager');
    await start();

    const status = getStatus();
    assert.equal(status.running, false);
    assert.equal(status.adapters.length, 0);
  });

  it('processes queued telegram commands after start', async () => {
    const channelType = `test-loop-${Date.now()}`;
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
      bridge_default_work_dir: '/Users/example',
      bridge_default_model: 'gpt-5.4',
    });
    const adapter = new LoopTestAdapter(channelType, {
      messageId: 'msg-1',
      address: {
        channelType,
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Owner',
      },
      text: '/new',
      timestamp: Date.now(),
      updateId: 1,
    });

    registerAdapterFactory(channelType, () => adapter);
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { start, stop } = await import('../../lib/bridge/bridge-manager');
    await start();
    await waitFor(() => adapter.sentMessages.length > 0, 'bridge to deliver /new confirmation');

    assert.equal(store.createSessionCount, 1);
    assert.equal(store.bindings.size, 1);
    assert.match(adapter.sentMessages[0]?.text || '', /Starting a new session/i);
    assert.deepEqual(adapter.acknowledgedUpdateIds, [1]);

    await stop();
  });

  it('processes queued bound conversation messages after start', async () => {
    const channelType = `test-conversation-${Date.now()}`;
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
    });
    const session = {
      id: 'session-1',
      working_directory: '/Users/example/project',
      model: 'gpt-5.4',
      display_name: 'Bridge Session',
      sdk_session_id: '',
      source: 'bridge',
    };
    store.upsertSession(session);
    store.upsertChannelBinding({
      channelType,
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      sdkSessionId: '',
      workingDirectory: session.working_directory,
      model: session.model,
      mode: 'code',
    });

    const adapter = new LoopTestAdapter(channelType, {
      messageId: 'msg-2',
      address: {
        channelType,
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Owner',
      },
      text: 'hello after bind',
      timestamp: Date.now(),
      updateId: 2,
    });

    registerAdapterFactory(channelType, () => adapter);
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Bridge reply' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { start, stop } = await import('../../lib/bridge/bridge-manager');
    await start();
    await waitFor(() => adapter.sentMessages.length > 0, 'bridge to deliver bound conversation reply');

    assert.match(adapter.sentMessages[0]?.text || '', /Bridge reply/i);
    assert.deepEqual(adapter.acknowledgedUpdateIds, [2]);

    await stop();
  });

  it('reports Telegram file upload failure without exposing the local path', async () => {
    const channelType = `test-file-fallback-${Date.now()}`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-file-fallback-'));
    const outbox = path.join(workDir, '.codepilot-outbox');
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, 'report.pdf'), 'report');
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
    });
    const session = {
      id: 'session-file-fallback',
      working_directory: workDir,
      model: 'gpt-5.4',
      display_name: 'Bridge Session',
      sdk_session_id: '',
      source: 'bridge',
    };
    store.upsertSession(session);
    store.upsertChannelBinding({
      channelType,
      chatId: 'chat-1',
      codepilotSessionId: session.id,
      sdkSessionId: '',
      workingDirectory: session.working_directory,
      model: session.model,
      mode: 'code',
    });

    const adapter = new LoopTestAdapter(channelType, {
      messageId: 'msg-file-fallback',
      address: {
        channelType,
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Owner',
      },
      text: 'send file',
      timestamp: Date.now(),
      updateId: 20,
    });
    adapter.failFileSends = true;

    registerAdapterFactory(channelType, () => adapter);
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '<!--cti-send-file:report.pdf-->' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { start, stop } = await import('../../lib/bridge/bridge-manager');
    await start();
    await waitFor(() => adapter.sentMessages.some(message => /File send failed/i.test(message.text)), 'file-send fallback notice');
    // Acknowledgement should land — fallback-text-delivered counts as a
    // successful degraded delivery, so the caller proceeds through the
    // onStreamEnd path that ACKs and clears the live progress placeholder.
    await waitFor(() => adapter.acknowledgedUpdateIds.includes(20), 'fallback delivery acknowledgement');

    assert.equal(adapter.sentFiles.length, 1);
    assert.equal((adapter.sentMessages[0]?.text || '').includes(workDir), false);
    assert.equal((adapter.sentMessages[0]?.text || '').includes('Local path:'), false);
    assert.match(adapter.sentMessages[0]?.text || '', /simulated upload failure/);
    assert.deepEqual(adapter.acknowledgedUpdateIds, [20]);

    await stop();
  });

  it('does not block later control messages behind the first unbound topic conversation', async () => {
    const channelType = `test-topic-loop-${Date.now()}`;
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
    });
    let releaseTopicReply: (() => void) | null = null;

    const adapter = new LoopTestAdapter(
      channelType,
      {
        messageId: 'topic-msg-1',
        address: {
          channelType,
          chatId: 'group-1',
          topicId: '3305',
          userId: 'user-1',
          displayName: 'Owner',
        },
        text: 'continue from topic',
        timestamp: Date.now(),
        updateId: 11,
      },
      {
        messageId: 'status-msg-1',
        address: {
          channelType,
          chatId: 'chat-2',
          userId: 'user-2',
          displayName: 'Owner',
        },
        text: '/status',
        timestamp: Date.now(),
        updateId: 12,
      },
    );

    registerAdapterFactory(channelType, () => adapter);
    initBridgeContext({
      store,
      llm: {
        streamChat: () => new ReadableStream({
          start(controller) {
            releaseTopicReply = () => {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Topic reply' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
              controller.close();
            };
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { start, stop } = await import('../../lib/bridge/bridge-manager');
    await start();
    await waitFor(
      () => typeof releaseTopicReply === 'function',
      'topic stream to expose a release callback',
    );
    await waitFor(
      () => adapter.sentMessages.some((message) => /No active session/i.test(message.text)),
      'status response while the first topic turn is still pending',
    );

    assert.equal(adapter.sentMessages.some((message) => /Topic reply/i.test(message.text)), false);

    const releasePendingTopicReply = releaseTopicReply as (() => void) | null;
    if (!releasePendingTopicReply) {
      assert.fail('expected the topic stream to expose a release callback');
    }
    releasePendingTopicReply();
    await waitFor(
      () => adapter.sentMessages.some((message) => /Topic reply/i.test(message.text)),
      'topic reply after releasing the pending stream',
    );

    await stop();
  });

  it('acknowledges callback updates after handling permission buttons', async () => {
    const channelType = `test-callback-${Date.now()}`;
    const store = createLoopStore({
      remote_bridge_enabled: 'true',
    });
    store.permissionLinks.set('perm-1', {
      permissionRequestId: 'perm-1',
      channelType,
      chatId: 'chat-1',
      messageId: 'cb-msg-1',
      toolName: 'Bash',
      suggestions: '',
      resolved: false,
      createdAt: '2026-04-11T00:00:00.000Z',
    });

    const adapter = new LoopTestAdapter(channelType, {
      messageId: 'callback-1',
      address: {
        channelType,
        chatId: 'chat-1',
        userId: 'user-1',
        displayName: 'Owner',
      },
      text: '',
      timestamp: Date.now(),
      callbackData: 'perm:allow:perm-1',
      callbackMessageId: 'cb-msg-1',
      updateId: 9,
    });

    registerAdapterFactory(channelType, () => adapter);
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => true },
      lifecycle: {},
    });

    const { start, stop } = await import('../../lib/bridge/bridge-manager');
    await start();
    await waitFor(() => adapter.acknowledgedUpdateIds.includes(9), 'callback update acknowledgement');

    assert.deepEqual(adapter.acknowledgedUpdateIds, [9]);
    assert.deepEqual(adapter.answeredCallbacks, [{
      callbackQueryId: 'callback-1',
      text: 'Allowed once.',
    }]);

    await stop();
  });
});

describe('bridge-manager sdk session persistence', () => {
  it('keeps a known sdk session id even when the turn ends with an error', () => {
    assert.equal(
      computeSdkSessionUpdate('codex-thread-known', true),
      'codex-thread-known',
    );
  });
});

describe('bridge-manager outbound file markers', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('accepts only files inside the configured outbox', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outbox-test-'));
    const outbox = path.join(workDir, '.codepilot-outbox');
    fs.mkdirSync(outbox, { recursive: true });
    const reportPath = path.join(outbox, 'report.pdf');
    const outsidePath = path.join(workDir, 'outside.pdf');
    fs.writeFileSync(reportPath, 'report');
    fs.writeFileSync(outsidePath, 'outside');

    initBridgeContext({
      store: createMinimalStore({ bridge_telegram_outbound_max_file_size: String(1024 * 1024) }),
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = {
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: workDir,
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-05-17T00:00:00.000Z',
      updatedAt: '2026-05-17T00:00:00.000Z',
    } satisfies ChannelBinding;

    const extracted = extractOutboundFileRequests([
      'Ready.',
      `<!--cti-send-file:${reportPath}-->`,
      `<!--cti-send-file:${outsidePath}-->`,
    ].join('\n'), binding);

    assert.equal(extracted.cleanText, 'Ready.');
    assert.equal(extracted.files.length, 1);
    assert.equal(extracted.files[0]?.fileName, 'report.pdf');
    assert.equal(extracted.files[0]?.mimeType, 'application/pdf');
    assert.equal(extracted.notices.length, 1);
    assert.match(extracted.notices[0] || '', /outside outbox/i);
    assert.equal((extracted.notices[0] || '').includes(outsidePath), false);
  });

  it('blocks sensitive filenames even when they are inside the outbox', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-outbox-sensitive-'));
    const outbox = path.join(workDir, '.codepilot-outbox');
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(outbox, '.env'), 'TOKEN=secret');
    fs.writeFileSync(path.join(outbox, 'db.sqlite'), 'database');
    fs.writeFileSync(path.join(outbox, 'config.json'), '{}');

    initBridgeContext({
      store: createMinimalStore(),
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const binding = {
      id: 'binding-1',
      channelType: 'telegram',
      chatId: 'chat-1',
      codepilotSessionId: 'session-1',
      sdkSessionId: '',
      workingDirectory: workDir,
      model: '',
      mode: 'code',
      active: true,
      createdAt: '2026-05-17T00:00:00.000Z',
      updatedAt: '2026-05-17T00:00:00.000Z',
    } satisfies ChannelBinding;

    const extracted = extractOutboundFileRequests('<!--cti-send-file:.env-->', binding);

    assert.equal(extracted.files.length, 0);
    assert.match(extracted.notices[0] || '', /sensitive filename/i);

    const dbExtracted = extractOutboundFileRequests('<!--cti-send-file:db.sqlite-->', binding);
    assert.equal(dbExtracted.files.length, 0);
    assert.match(dbExtracted.notices[0] || '', /sensitive filename/i);

    const configExtracted = extractOutboundFileRequests('<!--cti-send-file:config.json-->', binding);
    assert.equal(configExtracted.files.length, 0);
    assert.match(configExtracted.notices[0] || '', /sensitive filename/i);
  });
});

function createMinimalStore(settings: Record<string, string> = {}): BridgeStore {
  return {
    getSetting: (key: string) => settings[key] ?? null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    listSessions: () => [],
    upsertSession: (session) => session,
    createSession: () => ({ id: '1', working_directory: '', model: '' }),
    updateSessionProviderId: () => {},
    addMessage: () => {},
    getMessages: () => ({ messages: [] }),
    acquireSessionLock: () => true,
    renewSessionLock: () => {},
    releaseSessionLock: () => {},
    setSessionRuntimeStatus: () => {},
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
}

class LoopStore implements BridgeStore {
  bindings = new Map<string, ChannelBinding>();
  sessions = new Map<string, { id: string; working_directory: string; model: string; display_name?: string; sdk_session_id?: string; source?: string }>();
  permissionLinks = new Map<string, {
    permissionRequestId: string;
    channelType: string;
    chatId: string;
    messageId: string;
    toolName: string;
    suggestions: string;
    resolved: boolean;
    createdAt: string;
  }>();
  createSessionCount = 0;

  constructor(private readonly settings: Record<string, string>) {}

  getSetting(key: string): string | null { return this.settings[key] ?? null; }
  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }
  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    codepilotSessionId: string;
    sdkSessionId?: string;
    workingDirectory: string;
    model: string;
    mode?: string;
    sessionSource?: 'bridge' | 'local-codex';
  }): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const binding: ChannelBinding = {
      id: existing?.id || key,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: data.mode === 'plan' || data.mode === 'ask' ? data.mode : 'code',
      sessionSource: data.sessionSource
        ?? existing?.sessionSource
        ?? ((data.sdkSessionId || '') === data.codepilotSessionId && data.codepilotSessionId ? 'local-codex' : 'bridge'),
      active: true,
      createdAt: existing?.createdAt || '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
    };
    this.bindings.set(key, binding);
    return binding;
  }
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates });
      }
    }
  }
  listChannelBindings(channelType?: string): ChannelBinding[] {
    const items = Array.from(this.bindings.values());
    return channelType ? items.filter(binding => binding.channelType === channelType) : items;
  }
  getSession(id: string) { return this.sessions.get(id) ?? null; }
  listSessions() { return Array.from(this.sessions.values()); }
  upsertSession(session: any) { this.sessions.set(session.id, session); return session; }
  createSession(name: string, model: string, _systemPrompt?: string, cwd?: string) {
    this.createSessionCount += 1;
    const session = {
      id: `session-${this.createSessionCount}`,
      working_directory: cwd || '/Users/example',
      model,
      display_name: name,
      sdk_session_id: '',
      source: 'bridge',
    };
    this.sessions.set(session.id, session);
    return session;
  }
  updateSessionProviderId(): void {}
  addMessage(): void {}
  getMessages() { return { messages: [] }; }
  acquireSessionLock(): boolean { return true; }
  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(): void {}
  updateSdkSessionId(): void {}
  updateSessionModel(): void {}
  syncSdkTasks(): void {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog(): void {}
  checkDedup(): boolean { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink(id: string) { return this.permissionLinks.get(id) ?? null; }
  markPermissionLinkResolved(id: string): boolean {
    const link = this.permissionLinks.get(id);
    if (!link || link.resolved) return false;
    link.resolved = true;
    return true;
  }
  listPendingPermissionLinksByChat(chatId: string): any[] {
    return Array.from(this.permissionLinks.values()).filter((link) => link.chatId === chatId && !link.resolved);
  }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

class LoopTestAdapter extends BaseChannelAdapter {
  sentMessages: OutboundMessage[] = [];
  sentFiles: OutboundFileMessage[] = [];
  failFileSends = false;
  acknowledgedUpdateIds: number[] = [];
  answeredCallbacks: Array<{ callbackQueryId: string; text?: string }> = [];
  private queue: Array<InboundMessage | null>;
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private running = false;

  constructor(
    readonly channelType: string,
    ...messages: InboundMessage[]
  ) {
    super();
    this.queue = [...messages];
  }

  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> {
    this.running = false;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
  isRunning(): boolean { return this.running; }
  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (!this.running) return null;
    return new Promise(resolve => {
      this.waiters.push(resolve);
    });
  }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: `sent-${this.sentMessages.length}` };
  }
  override async sendFile(message: OutboundFileMessage): Promise<SendResult> {
    this.sentFiles.push(message);
    if (this.failFileSends) return { ok: false, error: 'simulated upload failure' };
    return { ok: true, messageId: `file-${this.sentFiles.length}` };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    this.answeredCallbacks.push({ callbackQueryId, text });
  }
  acknowledgeUpdate(updateId: number): void {
    this.acknowledgedUpdateIds.push(updateId);
  }
}

class FailingPreflightAdapter extends LoopTestAdapter {
  async preflight(): Promise<void> {
    throw new Error('telegram preflight failed');
  }

  override async start(): Promise<void> {
    assert.fail('start should not run when preflight fails');
  }
}

function createLoopStore(settings: Record<string, string>): LoopStore {
  return new LoopStore(settings);
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

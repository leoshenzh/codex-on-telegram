import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type {
  AuditLogInput,
  BridgeMessage,
  BridgeSession,
  BridgeStore,
  PermissionGateway,
  RuntimeStatusRecord,
} from '../../lib/bridge/host';
import type {
  ChannelBinding,
  InboundMessage,
  OutboundMessage,
  SendResult,
} from '../../lib/bridge/types';

class FakeStore implements BridgeStore {
  settings = new Map<string, string>([
    ['bridge_default_work_dir', '/Users/example'],
    ['bridge_default_model', 'gpt-5.4'],
  ]);
  bindings = new Map<string, ChannelBinding>();
  sessions = new Map<string, BridgeSession>();
  messages: Array<{ sessionId: string; role: string; content: string }> = [];
  auditLogs: AuditLogInput[] = [];
  runtimeStatuses = new Map<string, RuntimeStatusRecord>();
  createSessionCount = 0;

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string, topicId?: string): ChannelBinding | null {
    const key = topicId ? `${channelType}:${chatId}:topic:${topicId}` : `${channelType}:${chatId}`;
    return this.bindings.get(key) ?? null;
  }

  upsertChannelBinding(data: {
    channelType: string;
    chatId: string;
    topicId?: string;
    codepilotSessionId: string;
    sdkSessionId?: string;
    workingDirectory: string;
    model: string;
    mode?: string;
    sessionSource?: 'bridge' | 'local-codex';
  }): ChannelBinding {
    const key = data.topicId ? `${data.channelType}:${data.chatId}:topic:${data.topicId}` : `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const binding: ChannelBinding = {
      id: existing?.id || key,
      channelType: data.channelType,
      chatId: data.chatId,
      topicId: data.topicId,
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
        return;
      }
    }
  }

  listChannelBindings(channelType?: string): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter(binding => binding.channelType === channelType) : all;
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(opts?: { limit?: number }): BridgeSession[] {
    const all = Array.from(this.sessions.values());
    return opts?.limit ? all.slice(0, opts.limit) : all;
  }

  upsertSession(session: BridgeSession): BridgeSession {
    this.sessions.set(session.id, session);
    return session;
  }

  createSession(
    name: string,
    model: string,
    _systemPrompt?: string,
    cwd?: string,
    mode?: string,
  ): BridgeSession {
    void mode;
    this.createSessionCount += 1;
    const id = `session-${this.createSessionCount}`;
    const session: BridgeSession = {
      id,
      working_directory: cwd || '/Users/example',
      model,
      display_name: name,
      updated_at: '2026-04-11T00:00:00.000Z',
      sdk_session_id: '',
      source: 'bridge',
      system_prompt: undefined,
      provider_id: undefined,
    };
    this.sessions.set(id, session);
    return session;
  }

  updateSessionProviderId(): void {}

  addMessage(sessionId: string, role: string, content: string): void {
    this.messages.push({ sessionId, role, content });
  }

  getMessages(): { messages: BridgeMessage[] } {
    return { messages: [] };
  }

  acquireSessionLock(): boolean {
    return true;
  }

  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(sessionId: string, status: string): void {
    this.runtimeStatuses.set(sessionId, {
      sessionId,
      status,
      updatedAt: '2026-04-11T00:00:00.000Z',
    });
  }
  getSessionRuntimeStatus(sessionId: string): RuntimeStatusRecord | null {
    return this.runtimeStatuses.get(sessionId) ?? null;
  }
  updateSdkSessionId(): void {}
  updateSessionModel(): void {}
  syncSdkTasks(): void {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog(entry: AuditLogInput): void {
    this.auditLogs.push(entry);
  }
  checkDedup(): boolean { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved(): boolean { return false; }
  listPendingPermissionLinksByChat(): any[] { return []; }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

function createStreamChat(responseText: string) {
  return () => new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: responseText })}\n`);
      controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
      controller.close();
    },
  });
}

function setupContext(
  store: FakeStore,
  overrides?: {
    permissions?: PermissionGateway;
    streamText?: string;
    streamFactory?: () => ReadableStream<string>;
  },
): void {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  initBridgeContext({
    store,
    llm: {
      streamChat: overrides?.streamFactory ?? createStreamChat(overrides?.streamText ?? 'Thin bridge reply'),
    },
    permissions: overrides?.permissions ?? {
      resolvePendingPermission: () => false,
    },
    lifecycle: {},
  });
}

function createAdapter(opts?: {
  sendResult?: SendResult;
  sendFn?: (message: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter & {
  sentMessages: OutboundMessage[];
  answeredCallbacks: Array<{ id: string; text?: string }>;
  acknowledgedUpdateIds: number[];
} {
  const sentMessages: OutboundMessage[] = [];
  const answeredCallbacks: Array<{ id: string; text?: string }> = [];
  const acknowledgedUpdateIds: number[] = [];
  const sendResult = opts?.sendResult ?? { ok: true, messageId: 'sent-1' };

  return {
    sentMessages,
    answeredCallbacks,
    acknowledgedUpdateIds,
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sentMessages.push(message);
      if (opts?.sendFn) {
        return opts.sendFn(message);
      }
      return sendResult;
    },
    answerCallback: async (id: string, text?: string) => {
      answeredCallbacks.push({ id, text });
    },
    acknowledgeUpdate: (updateId: number) => {
      acknowledgedUpdateIds.push(updateId);
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter & {
    sentMessages: OutboundMessage[];
    answeredCallbacks: Array<{ id: string; text?: string }>;
    acknowledgedUpdateIds: number[];
  };
}

function inbound(text: string, updateId?: number, chatId = '1000000001'): InboundMessage {
  return {
    messageId: 'msg-1',
    address: {
      channelType: 'telegram',
      chatId,
      userId: chatId,
      displayName: 'Owner',
    },
    text,
    timestamp: Date.now(),
    updateId,
  };
}

describe('bridge-manager thin bridge semantics', () => {
  let tempDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-thin-bridge-'));
    previousRoot = process.env.CTI_CODEX_SESSIONS_ROOT;
    process.env.CTI_CODEX_SESSIONS_ROOT = tempDir;
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.CTI_CODEX_SESSIONS_ROOT;
    } else {
      process.env.CTI_CODEX_SESSIONS_ROOT = previousRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
  });

  it('does not create a session for /status when nothing is bound', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('/status'));

    assert.equal(store.createSessionCount, 0);
    assert.match(adapter.sentMessages[0].text, /No active session/i);
  });

  it('shows runtime status on /status when the host store provides it', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000003',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    store.setSessionRuntimeStatus(binding.codepilotSessionId, 'running');
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('/status', undefined, '1000000003'), binding as unknown as never);

    assert.match(adapter.sentMessages[0].text, /Runtime: running at 2026-04-11T00:00:00\.000Z/);
  });

  it('auto-creates a session for the first plain message in a Telegram chat when nothing is active', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('hello from telegram'));

    assert.equal(store.createSessionCount, 1);
    assert.equal(store.bindings.size, 1);
    assert.match(adapter.sentMessages[0].text, /Thin bridge reply/i);
  });

  it('reports empty runtime output as a failed turn instead of No response', async () => {
    const store = new FakeStore();
    setupContext(store, {
      streamFactory: () => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
          controller.close();
        },
      }),
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('continue'));

    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0].text, /returned no assistant output/i);
    assert.equal(adapter.sentMessages[0].text.includes('No response'), false);
    const audit = store.auditLogs.find((entry) => entry.status === 'error');
    assert.equal(audit?.errorType, 'empty_response');
    assert.match(audit?.summary || '', /\[conversation:error\]/);
  });

  it('preserves the structured mid_stream_timeout errorType in the audit log instead of collapsing to runtime_error', async () => {
    const store = new FakeStore();
    setupContext(store, {
      streamFactory: () => new ReadableStream<string>({
        start(controller) {
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
      }),
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('trigger timeout'));

    const audit = store.auditLogs.find((entry) => entry.status === 'error');
    assert.ok(audit, 'expected an error audit row');
    assert.equal(audit?.errorType, 'mid_stream_timeout', 'audit must preserve the structured reason, not collapse to runtime_error');
  });

  it('redacts outbound file markers from conversation audit and user-visible notices', async () => {
    const store = new FakeStore();
    setupContext(store, {
      streamText: [
        'Done.',
        '<!--cti-send-file:/Users/example/secret/report.pdf-->',
      ].join('\n'),
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('send file', undefined, '1000000004'));

    assert.equal(adapter.sentMessages[0].text.includes('/Users/example/secret'), false);
    assert.match(adapter.sentMessages[0].text, /file not sent: file not found in outbox/i);
    const audit = store.auditLogs.find((entry) => entry.status === 'completed');
    assert.match(audit?.summary || '', /\[cti-send-file redacted\]/);
    assert.equal((audit?.summary || '').includes('/Users/example/secret'), false);
  });

  it('auto-creates a session for the first plain message inside a Telegram topic', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, {
      ...inbound('continue from topic'),
      address: {
        channelType: 'telegram',
        chatId: '-2000000002',
        topicId: '122',
        userId: '1000000001',
        displayName: 'Owner',
      },
    });

    assert.equal(store.createSessionCount, 1);
    assert.equal(store.bindings.size, 1);
  });

  it('names auto-created Telegram topic sessions from the group title instead of the sender', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, {
      ...inbound('continue from topic'),
      address: {
        channelType: 'telegram',
        chatId: '-1000000000001',
        topicId: '4402',
        userId: '1000000001',
        displayName: 'Team Codex',
      },
    });

    const session = Array.from(store.sessions.values())[0];
    assert.ok(session);
    assert.equal(session?.display_name, 'Telegram · Team Codex · Topic 4402');
  });

  it('falls back to a normal Telegram conversation when 1/2/3 quick replies are ambiguous', async () => {
    const store = new FakeStore();
    store.listPendingPermissionLinksByChat = (): any[] => [
      { permissionRequestId: 'perm-1' } as any,
      { permissionRequestId: 'perm-2' } as any,
    ];
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('1', 42));

    assert.equal(store.createSessionCount, 1);
    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0].text, /Thin bridge reply/i);
    assert.deepEqual(adapter.acknowledgedUpdateIds, [42]);
  });

  it('creates only one session for /new in a fresh chat', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('/new'));

    assert.equal(store.createSessionCount, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('names /new Telegram group sessions from the group title instead of the sender', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, {
      ...inbound('/new'),
      address: {
        channelType: 'telegram',
        chatId: '-1000000000001',
        userId: '1000000001',
        displayName: 'Team Codex',
      },
    });

    const session = Array.from(store.sessions.values())[0];
    assert.ok(session);
    assert.equal(session?.display_name, 'Telegram · Team Codex');
  });

  it('renames an existing bridge-backed Telegram session to the current group title', async () => {
    const store = new FakeStore();
    const existingSession = store.createSession('Bridge: owner', 'gpt-5.4', undefined, '/Users/example');
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '-1000000000001',
      codepilotSessionId: existingSession.id,
      sdkSessionId: '019d84a9-9ff4-7163-9fc5-ed8d73cc4bc8',
      workingDirectory: '/Users/example',
      model: 'gpt-5.4',
      mode: 'code',
    });
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, {
      ...inbound('/sessions'),
      address: {
        channelType: 'telegram',
        chatId: '-1000000000001',
        userId: '1000000001',
        displayName: 'Team Codex',
      },
    });

    assert.equal(store.getSession(existingSession.id)?.display_name, 'Telegram · Team Codex');
  });

  it('accepts Telegram group commands with @bot suffix', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, {
      ...inbound('/new@leo22120216bot'),
      address: {
        channelType: 'telegram',
        chatId: '-2000000002',
        topicId: '3305',
        userId: '1000000001',
        displayName: 'Owner',
      },
    });

    assert.equal(store.createSessionCount, 1);
    assert.equal(store.sessions.size, 1);
  });

  it('does not create a session for /new when the confirmation cannot be delivered', async () => {
    const store = new FakeStore();
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter({
      sendResult: { ok: false, error: 'send failed', httpStatus: 400 } as SendResult,
    });

    await _testOnly.handleMessage(adapter, inbound('/new', 71));

    assert.equal(store.createSessionCount, 0);
    assert.equal(store.sessions.size, 0);
    assert.equal(store.bindings.size, 0);
    assert.deepEqual(adapter.acknowledgedUpdateIds, []);
  });

  it('aborts the previously active task when /bind switches sessions', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/old',
      model: '',
      sdk_session_id: '',
      display_name: 'Old',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      working_directory: '/Users/example/new',
      model: '',
      sdk_session_id: '',
      display_name: 'New',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/old',
      model: '',
      mode: 'code',
    });
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const state = _testOnly.getState();
    const oldAbort = new AbortController();
    state.activeTasks.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', oldAbort);
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('/bind bbbbbbbb'));

    assert.equal(oldAbort.signal.aborted, true);
    assert.equal(
      store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
  });

  it('does not switch bindings for /bind when the confirmation cannot be delivered', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/old',
      model: '',
      sdk_session_id: '',
      display_name: 'Old',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      working_directory: '/Users/example/new',
      model: '',
      sdk_session_id: '',
      display_name: 'New',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/old',
      model: '',
      mode: 'code',
    });
    setupContext(store);

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const state = _testOnly.getState();
    const oldAbort = new AbortController();
    state.activeTasks.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', oldAbort);
    const adapter = createAdapter({
      sendResult: { ok: false, error: 'send failed', httpStatus: 400 } as SendResult,
    });

    await _testOnly.handleMessage(adapter, inbound('/bind bbbbbbbb', 72));

    assert.equal(oldAbort.signal.aborted, false);
    assert.equal(
      store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    assert.deepEqual(adapter.acknowledgedUpdateIds, []);
  });

  it('uses the locked binding snapshot for a normal message even if the live binding changed', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      working_directory: '/Users/example/b',
      model: '',
      sdk_session_id: '',
      display_name: 'Session B',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const bindingA = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, { streamText: 'reply from A' });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sdkSessionId: '',
      workingDirectory: '/Users/example/b',
      model: '',
      mode: 'code',
    });

    await _testOnly.handleMessage(adapter, inbound('hello world'), bindingA as unknown as never);

    assert.equal(store.messages[0]?.sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('does not let an old task write its sdk session id into a newly rebound chat', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertSession({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      working_directory: '/Users/example/b',
      model: '',
      sdk_session_id: '',
      display_name: 'Session B',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const bindingA = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, {
      streamFactory: () => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'reply from old task' })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'result',
            data: JSON.stringify({ session_id: 'codex-thread-old' }),
          })}\n`);
          controller.close();
        },
      }),
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sdkSessionId: '',
      workingDirectory: '/Users/example/b',
      model: '',
      mode: 'code',
    });

    await _testOnly.handleMessage(adapter, inbound('hello world'), bindingA as unknown as never);

    const liveBinding = store.getChannelBinding('telegram', '1000000001');
    assert.equal(liveBinding?.codepilotSessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    assert.equal(liveBinding?.sdkSessionId, '');
  });

  it('does not acknowledge an update when final delivery fails', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, { streamText: 'reply that will fail to send' });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter({
      sendResult: { ok: false, error: 'client error', httpStatus: 400 } as SendResult,
    });

    await _testOnly.handleMessage(adapter, inbound('hello', 55), binding as unknown as never);

    assert.deepEqual(adapter.acknowledgedUpdateIds, []);
    const audit = store.auditLogs.find((entry) => entry.status === 'delivery_failed');
    assert.equal(audit?.errorType, 'delivery_failed');
    assert.match(audit?.summary || '', /\[conversation:delivery_failed\]/);
  });

  it('treats partial multi-chunk delivery failure as not delivered even when an earlier chunk has a message id', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000005',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, { streamText: 'long reply '.repeat(900) });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    let sendCount = 0;
    const adapter = createAdapter({
      sendFn: async () => {
        sendCount += 1;
        return sendCount === 1
          ? { ok: true, messageId: 'sent-first' }
          : { ok: false, error: 'chunk upload failed', httpStatus: 400 };
      },
    });
    let streamEndCalls = 0;
    adapter.onStreamEnd = async () => {
      streamEndCalls += 1;
      return true;
    };

    await _testOnly.handleMessage(adapter, inbound('hello', 57, '1000000005'), binding as unknown as never);

    assert.equal(sendCount > 1, true);
    assert.equal(streamEndCalls, 0);
    assert.deepEqual(adapter.acknowledgedUpdateIds, []);
    const audit = store.auditLogs.find((entry) => entry.status === 'delivery_failed');
    assert.equal(audit?.messageId, 'sent-first');
    assert.equal(audit?.errorType, 'delivery_failed');
  });

  it('keeps stream-end cleanup until after final delivery succeeds', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, { streamText: 'reply that will fail to send' });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter({
      sendResult: { ok: false, error: 'client error', httpStatus: 400 } as SendResult,
    });
    let streamEndCalls = 0;
    let messageEndCalls = 0;
    adapter.onStreamEnd = async () => {
      streamEndCalls += 1;
      return true;
    };
    adapter.onMessageEnd = () => {
      messageEndCalls += 1;
    };

    await _testOnly.handleMessage(adapter, inbound('hello', 56), binding as unknown as never);

    assert.equal(streamEndCalls, 0);
    assert.equal(messageEndCalls, 1);
    assert.deepEqual(adapter.acknowledgedUpdateIds, []);
  });

  it('renders final assistant replies with Telegram HTML formatting', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: '',
      sdk_session_id: '',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    const binding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: '',
      workingDirectory: '/Users/example/a',
      model: '',
      mode: 'code',
    });
    setupContext(store, { streamText: '## Plan\n\n**Keep the spacing readable.**' });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const adapter = createAdapter();

    await _testOnly.handleMessage(adapter, inbound('format this'), binding as unknown as never);

    assert.equal(adapter.sentMessages.length, 1);
    assert.equal(adapter.sentMessages[0].parseMode, 'HTML');
    assert.match(adapter.sentMessages[0].text, /<b>Plan<\/b>/);
    assert.match(adapter.sentMessages[0].text, /<b>Keep the spacing readable\.<\/b>/);
  });

  it('passes one shared stream context through progress, tool, and final hooks', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/a',
      model: 'gpt-5.4',
      sdk_session_id: 'codex-thread-old',
      display_name: 'Session A',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: 'codex-thread-old',
      workingDirectory: '/Users/example/a',
      model: 'gpt-5.4',
      mode: 'code',
    });

    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: () => new ReadableStream<string>({
          start(controller) {
            controller.enqueue(`data: ${JSON.stringify({
              type: 'status',
              data: JSON.stringify({ progress_text: '正在处理上下文' }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'tool_use',
              data: JSON.stringify({ id: 'tool-1', name: 'Bash', input: { command: 'pwd' } }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'tool_result',
              data: JSON.stringify({ tool_use_id: 'tool-1', content: '/Users/example/a', is_error: false }),
            })}\n`);
            controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Thin bridge reply' })}\n`);
            controller.enqueue(`data: ${JSON.stringify({
              type: 'result',
              data: JSON.stringify({ session_id: 'codex-thread-new' }),
            })}\n`);
            controller.close();
          },
        }),
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const hookCalls: Array<{ kind: string; context: any; extra?: unknown }> = [];
    const adapter = {
      ...createAdapter(),
      onMessageStart(context: any) {
        hookCalls.push({ kind: 'start', context });
      },
      onStreamText(context: any, text: string) {
        hookCalls.push({ kind: 'text', context, extra: text });
      },
      onToolEvent(context: any, tools: unknown) {
        hookCalls.push({ kind: 'tool', context, extra: tools });
      },
      async onStreamEnd(context: any, status: string, responseText: string) {
        hookCalls.push({ kind: 'end', context, extra: { status, responseText } });
        return true;
      },
      onMessageEnd(context: any) {
        hookCalls.push({ kind: 'message-end', context });
      },
    } as unknown as BaseChannelAdapter & {
      sentMessages: OutboundMessage[];
      answeredCallbacks: Array<{ id: string; text?: string }>;
      acknowledgedUpdateIds: number[];
    };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, inbound('run it', 73));

    const progressKinds = hookCalls.map((call) => call.kind);
    assert.deepEqual(progressKinds, ['start', 'text', 'tool', 'tool', 'end', 'message-end']);

    const contexts = hookCalls.map((call) => call.context);
    for (const context of contexts) {
      assert.equal(context.address.chatId, '1000000001');
      assert.equal(context.replyToMessageId, 'msg-1');
      assert.equal(context.sessionId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      assert.equal(context.bindingId, 'telegram:1000000001');
    }

    assert.equal(contexts.every((context) => context === contexts[0]), true, 'expected one shared context object');
    assert.equal(adapter.sentMessages[0]?.replyToMessageId, 'msg-1');
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.sdkSessionId, 'codex-thread-new');
  });

  it('finishes stream hooks after sending the final reply', async () => {
    const store = new FakeStore();
    setupContext(store, { streamText: 'Ordered reply' });
    store.upsertSession({
      id: 'ordered-session',
      working_directory: '/Users/example/project',
      model: 'gpt-5.4',
      sdk_session_id: 'ordered-thread',
      display_name: 'Ordered Session',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'ordered-session',
      sdkSessionId: 'ordered-thread',
      workingDirectory: '/Users/example/project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    const order: string[] = [];
    const adapter = createAdapter({
      sendFn: async () => {
        order.push('send');
        return { ok: true, messageId: 'sent-ordered' };
      },
    });

    const hookedAdapter = {
      ...adapter,
      onMessageStart() {
        order.push('start');
      },
      async onStreamEnd() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('end');
        return true;
      },
      onMessageEnd() {
        order.push('message-end');
      },
    } as unknown as BaseChannelAdapter & {
      sentMessages: OutboundMessage[];
      answeredCallbacks: Array<{ id: string; text?: string }>;
      acknowledgedUpdateIds: number[];
    };

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(hookedAdapter, inbound('run it', 74));

    assert.deepEqual(order, ['start', 'send', 'end', 'message-end']);
  });

  it('sends the final answer when a transient reconnect error arrives before the final marker', async () => {
    const store = new FakeStore();
    setupContext(store, {
      streamFactory: () => new ReadableStream<string>({
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
      }),
    });
    store.upsertSession({
      id: 'reconnect-session',
      working_directory: '/Users/example/project',
      model: 'gpt-5.4',
      sdk_session_id: 'reconnect-thread',
      display_name: 'Reconnect Session',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'reconnect-session',
      sdkSessionId: 'reconnect-thread',
      workingDirectory: '/Users/example/project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    const adapter = createAdapter();

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, inbound('demo 链接发我', 75));

    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0].text, /Demo/);
    assert.match(adapter.sentMessages[0].text, /127\.0\.0\.1:3000/);
    assert.equal(adapter.sentMessages[0].text.includes('Reconnecting'), false);
  });

  it('sends captured text when a transient reconnect error arrives after text without a final marker', async () => {
    const store = new FakeStore();
    setupContext(store, {
      streamFactory: () => new ReadableStream<string>({
        start(controller) {
          controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'Demo 链接：\n\nhttp://127.0.0.1:3000/' })}\n`);
          controller.enqueue(`data: ${JSON.stringify({
            type: 'error',
            data: 'stream disconnected before completion: websocket closed by server before response.completed',
          })}\n`);
          controller.close();
        },
      }),
    });
    store.upsertSession({
      id: 'post-text-reconnect-session',
      working_directory: '/Users/example/project',
      model: 'gpt-5.4',
      sdk_session_id: 'post-text-reconnect-thread',
      display_name: 'Post Text Reconnect Session',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'post-text-reconnect-session',
      sdkSessionId: 'post-text-reconnect-thread',
      workingDirectory: '/Users/example/project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    const adapter = createAdapter();

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    await _testOnly.handleMessage(adapter, inbound('demo 链接发我', 76));

    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0].text, /Demo/);
    assert.match(adapter.sentMessages[0].text, /127\.0\.0\.1:3000/);
    assert.equal(adapter.sentMessages[0].text.includes('Reconnecting'), false);
  });

});

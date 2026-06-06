import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding, OutboundMessage, SendResult } from '../../lib/bridge/types';

class FakeStore {
  sessions = new Map<string, BridgeSession>();
  bindings = new Map<string, ChannelBinding>();

  getSetting(): string | null {
    return null;
  }

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
      id: key,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId || '',
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
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates });
        break;
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

  listSessions(): BridgeSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => {
      const aTime = Date.parse(a.updated_at || '') || 0;
      const bTime = Date.parse(b.updated_at || '') || 0;
      return bTime - aTime;
    });
  }

  upsertSession(session: BridgeSession): BridgeSession {
    this.sessions.set(session.id, session);
    return session;
  }

  createSession(): BridgeSession {
    throw new Error('createSession should not be used in these tests');
  }

  updateSessionProviderId(): void {}
  addMessage(): void {}
  getMessages() { return { messages: [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock(): void {}
  releaseSessionLock(): void {}
  setSessionRuntimeStatus(): void {}
  updateSdkSessionId(): void {}
  updateSessionModel(): void {}
  syncSdkTasks(): void {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog(): void {}
  checkDedup() { return false; }
  insertDedup(): void {}
  cleanupExpiredDedup(): void {}
  insertOutboundRef(): void {}
  insertPermissionLink(): void {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset(): void {}
}

function createMockTelegramAdapter(sentMessages: OutboundMessage[]): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: async (message: OutboundMessage): Promise<SendResult> => {
      sentMessages.push(message);
      return { ok: true, messageId: `sent-${sentMessages.length}` };
    },
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

function writeLocalSession(
  sessionsRoot: string,
  sessionId: string,
  cwd: string,
  title: string,
  updatedAt: string,
  source = 'cli',
): void {
  const dayDir = path.join(sessionsRoot, '2026', '04', '11');
  fs.mkdirSync(dayDir, { recursive: true });

  const sessionFile = path.join(dayDir, `${sessionId}.jsonl`);
  const sessionLines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: updatedAt,
        cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.114.0',
        source,
      },
    }),
  ];
  fs.writeFileSync(sessionFile, `${sessionLines.join('\n')}\n`, 'utf-8');

  const indexFile = path.join(path.dirname(sessionsRoot), 'session_index.jsonl');
  const indexLine = JSON.stringify({
    id: sessionId,
    thread_name: title,
    updated_at: updatedAt,
  });
  fs.appendFileSync(indexFile, `${indexLine}\n`, 'utf-8');
}

function appendLocalSessionRecord(
  sessionsRoot: string,
  sessionId: string,
  record: Record<string, unknown>,
): void {
  const dayDir = path.join(sessionsRoot, '2026', '04', '11');
  const sessionFile = path.join(dayDir, `${sessionId}.jsonl`);
  fs.appendFileSync(sessionFile, `${JSON.stringify(record)}\n`, 'utf-8');
}

describe('bridge-manager /sessions display', () => {
  let tempDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-bridge-manager-sessions-'));
    previousRoot = process.env.CTI_CODEX_SESSIONS_ROOT;
    process.env.CTI_CODEX_SESSIONS_ROOT = path.join(tempDir, 'sessions');
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.CTI_CODEX_SESSIONS_ROOT;
    } else {
      process.env.CTI_CODEX_SESSIONS_ROOT = previousRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>)['__bridge_manager__'];
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('shows the current session first and uses a clearer card layout', async () => {
    const currentSessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';
    const otherBridgeId = 'e15d7731-3e36-484d-9672-fa6eb254a965';
    const localOnlyId = '019d7a7d-e62f-7452-88d2-5e7cbc35ca12';

    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      localOnlyId,
      '/Users/example/project-b',
      'Unimported local task',
      '2026-04-11T03:00:00.000Z',
    );

    const store = new FakeStore();
    store.upsertSession({
      id: currentSessionId,
      sdk_session_id: currentSessionId,
      display_name: 'Review Sanity hardening',
      updated_at: '2026-04-11T01:00:00.000Z',
      working_directory: '/Users/example',
      model: 'gpt-5.4',
      source: 'local-codex',
    });
    store.upsertSession({
      id: otherBridgeId,
      display_name: 'Bridge: Owner',
      updated_at: '2026-04-11T02:00:00.000Z',
      working_directory: '/Users/example',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: currentSessionId,
      sdkSessionId: currentSessionId,
      workingDirectory: '/Users/example',
      model: 'gpt-5.4',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-1',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    const text = sentMessages[0].text;
    assert.ok(text.includes('Current session'));
    assert.ok(text.includes('Other recent sessions'));
    assert.ok(text.includes('1. Review Sanity hardening'));
    assert.ok(text.includes('Source: This Mac Codex'));
    assert.ok(text.includes('Project: /Users/example'));
    assert.ok(text.includes('ID: 019d7aa6-9798'));
    assert.ok(text.includes('Unimported local task'));
    assert.ok(
      text.indexOf('Current session\n1. Review Sanity hardening') < text.indexOf('Other recent sessions'),
      'current session block should render before the recent sessions section',
    );
  });

  it('still shows the current session even when it is older than the recent list cutoff', async () => {
    const currentSessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';
    const store = new FakeStore();

    store.upsertSession({
      id: currentSessionId,
      sdk_session_id: currentSessionId,
      display_name: 'Very old but current',
      updated_at: '2026-01-01T00:00:00.000Z',
      working_directory: '/Users/example/current-project',
      model: 'gpt-5.4',
      source: 'bridge',
    });

    for (let i = 0; i < 120; i += 1) {
      const suffix = String(i).padStart(12, '0');
      store.upsertSession({
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        display_name: `Recent ${i}`,
        updated_at: `2026-04-11T03:${String(i % 60).padStart(2, '0')}:00.000Z`,
        working_directory: `/Users/example/recent-${i}`,
        model: 'gpt-5.4',
        source: 'bridge',
      });
    }

    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: currentSessionId,
      sdkSessionId: currentSessionId,
      workingDirectory: '/Users/example/current-project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-current',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    const text = sentMessages[0].text;
    assert.ok(text.includes('1. Very old but current'));
    assert.ok(text.includes('Current session'));
  });

  it('deduplicates a local Codex session when a bridge session already stores the same sdk session id', async () => {
    const localSessionId = '019d7a7d-e62f-7452-88d2-5e7cbc35ca12';

    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      localSessionId,
      '/Users/example/project-b',
      'Unimported local task',
      '2026-04-11T03:00:00.000Z',
    );

    const store = new FakeStore();
    store.upsertSession({
      id: 'bridge-session-1',
      sdk_session_id: localSessionId,
      display_name: 'Imported local task',
      updated_at: '2026-04-11T03:30:00.000Z',
      working_directory: '/Users/example/project-b',
      model: 'gpt-5.4',
      source: 'bridge',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-dedup',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    const text = sentMessages[0].text;
    assert.ok(text.includes('Imported local task'));
    assert.equal((text.match(/Imported local task/g) || []).length, 1);
    assert.equal((text.match(/Unimported local task/g) || []).length, 0);
  });

  it('uses the binding cwd for the current session card', async () => {
    const currentSessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';
    const store = new FakeStore();

    store.upsertSession({
      id: currentSessionId,
      sdk_session_id: currentSessionId,
      display_name: 'Binding-owned current session',
      updated_at: '2026-04-11T01:00:00.000Z',
      working_directory: '/Users/example/old-project',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: currentSessionId,
      sdkSessionId: currentSessionId,
      workingDirectory: '/Users/example/new-project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-binding-cwd',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Project: /Users/example/new-project'));
  });

  it('does not create a session for /status when nothing is bound', async () => {
    const store = new FakeStore();

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-status',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/status',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('No active session.'));
    assert.equal(store.bindings.size, 0);
    assert.equal(store.sessions.size, 0);
  });

  it('uses the routed binding snapshot even if the chat is rebound before handling finishes', async () => {
    const oldSessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';
    const newSessionId = 'e15d7731-3e36-484d-9672-fa6eb254a965';
    const store = new FakeStore();
    const usedSessionIds: string[] = [];

    store.upsertSession({
      id: oldSessionId,
      sdk_session_id: oldSessionId,
      display_name: 'Old session',
      updated_at: '2026-04-11T01:00:00.000Z',
      working_directory: '/Users/example/old-project',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    store.upsertSession({
      id: newSessionId,
      sdk_session_id: newSessionId,
      display_name: 'New session',
      updated_at: '2026-04-11T02:00:00.000Z',
      working_directory: '/Users/example/new-project',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    const oldBinding = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: oldSessionId,
      sdkSessionId: oldSessionId,
      workingDirectory: '/Users/example/old-project',
      model: 'gpt-5.4',
      mode: 'code',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: newSessionId,
      sdkSessionId: newSessionId,
      workingDirectory: '/Users/example/new-project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: ({ sessionId }) => {
          usedSessionIds.push(sessionId);
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: 'stable route' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ session_id: 'sdk-stable' }) })}\n`);
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-routed-binding',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: 'hello from telegram',
      timestamp: Date.now(),
    }, oldBinding);

    assert.deepEqual(usedSessionIds, [oldSessionId]);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('stable route'));
  });

  it('accepts a short unique prefix when binding to a local Codex session', async () => {
    const sessionId = '019d7a7d-e62f-7452-88d2-5e7cbc35ca12';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example/project-c',
      'Prefix bind session',
      '2026-04-11T03:30:00.000Z',
    );

    const store = new FakeStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-2',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/bind 019d7a7d',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes(`Bound to session ${sessionId}`));
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId, sessionId);
  });

  it('accepts a short unique prefix when binding to an exec-backed local Codex session', async () => {
    const sessionId = '019d8022-9d87-7b82-9922-592349596b01';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example',
      'Exec-backed Codex session',
      '2026-04-12T05:20:45.511Z',
      'exec',
    );

    const store = new FakeStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-exec-bind',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/bind 019d8022',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes(`Bound to session ${sessionId}`));
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId, sessionId);
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.sessionSource, 'local-codex');
  });

  it('binds an older exec-backed local session even when it falls outside the recent /sessions list', async () => {
    const sessionId = '019d8022-9d87-7b82-9922-592349596b01';

    for (let i = 0; i < 130; i += 1) {
      writeLocalSession(
        process.env.CTI_CODEX_SESSIONS_ROOT!,
        `019d9000-aaaa-7e33-984d-${String(i).padStart(12, '0')}`,
        `/Users/example/recent-${i}`,
        `Recent ${i}`,
        `2026-04-11T${String(10 + Math.floor(i / 6)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      );
    }

    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example',
      'Older exec-backed Codex session',
      '2026-04-10T01:00:00.000Z',
      'exec',
    );

    const store = new FakeStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-exec-bind-older',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/bind 019d8022',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes(`Bound to session ${sessionId}`));
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId, sessionId);
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.sessionSource, 'local-codex');
  });

  it('matches a bridge session by sdk session id prefix during bind lookup', async () => {
    const bridgeSessionId = '7d65c9dd-b914-4790-8475-b27a42e75664';
    const sdkSessionId = '019d8022-9d87-7b82-9922-592349596b01';

    const store = new FakeStore();
    store.upsertSession({
      id: bridgeSessionId,
      sdk_session_id: sdkSessionId,
      display_name: 'Bridge-backed historical session',
      updated_at: '2026-04-12T05:21:00.000Z',
      working_directory: '/Users/example',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-sdk-bind',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/bind 019d8022',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes(`Bound to session ${bridgeSessionId}`));
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.codepilotSessionId, bridgeSessionId);
    assert.equal(store.getChannelBinding('telegram', '1000000001')?.sdkSessionId, sdkSessionId);
  });

  it('shows the title and source for a current local Codex session that is not stored in bridge state', async () => {
    const sessionId = '019d7aab-a6c0-7223-a7da-22d3684259ff';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example/project-local-current',
      'Named local current session',
      '2026-04-11T03:40:00.000Z',
    );

    const store = new FakeStore();
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: sessionId,
      sdkSessionId: sessionId,
      workingDirectory: '/Users/example/project-local-current',
      model: '',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-local-current',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('1. Named local current session'));
    assert.ok(sentMessages[0].text.includes('Source: This Mac Codex'));
    assert.equal(store.sessions.size, 0);
  });

  it('shows the current session project from the active binding, not stale session metadata', async () => {
    const currentSessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';

    const store = new FakeStore();
    store.upsertSession({
      id: currentSessionId,
      sdk_session_id: currentSessionId,
      display_name: 'Current session',
      updated_at: '2026-04-11T01:00:00.000Z',
      working_directory: '/Users/example/old-project',
      model: 'gpt-5.4',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: currentSessionId,
      sdkSessionId: currentSessionId,
      workingDirectory: '/Users/example/new-project',
      model: 'gpt-5.4',
      mode: 'code',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-4',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001', displayName: 'Owner' },
      text: '/sessions',
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('/Users/example/new-project'));
    assert.equal(sentMessages[0].text.includes('/Users/example/old-project'), false);
  });

  it('keeps the binding cwd when rebinding the current bridge session', async () => {
    const currentSessionId = '42db2147-e08c-4dc2-a6b7-977c3254cfbe';

    const store = new FakeStore();
    store.upsertSession({
      id: currentSessionId,
      sdk_session_id: 'stale-sdk-session',
      display_name: 'Telegram · Team Codex · Topic 38',
      updated_at: '2026-04-25T00:11:12.343Z',
      working_directory: '/Users/example',
      model: 'stale-model',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: currentSessionId,
      sdkSessionId: '019dc1fb-38b5-7ce2-a644-96b46a3546f1',
      workingDirectory: '/Users/example/projects/demo',
      model: 'current-model',
      mode: 'plan',
      sessionSource: 'bridge',
    });

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-rebind-current',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: `/bind ${currentSessionId}`,
      timestamp: Date.now(),
    });

    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Project: /Users/example/projects/demo'));
    const binding = store.getChannelBinding('telegram', '1000000001');
    assert.equal(binding?.workingDirectory, '/Users/example/projects/demo');
    assert.equal(binding?.sdkSessionId, '019dc1fb-38b5-7ce2-a644-96b46a3546f1');
    assert.equal(binding?.model, 'current-model');
    assert.equal(binding?.mode, 'plan');
  });

  it('forwards natural-language progress questions to the bound AI session', async () => {
    const sessionId = '019d7aab-a6c0-7223-a7da-22d3684259ff';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example/project-local-current',
      'Named local current session',
      new Date().toISOString(),
    );
    appendLocalSessionRecord(process.env.CTI_CODEX_SESSIONS_ROOT!, sessionId, {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '切分测试已经过了，现在正在看前十几条是不是已经干净。',
        phase: 'commentary',
      },
    });

    const store = new FakeStore();
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: sessionId,
      sdkSessionId: sessionId,
      workingDirectory: '/Users/example/project-local-current',
      model: '',
      mode: 'code',
    });

    let llmCalled = false;
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          llmCalled = true;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '我继续去看真实进度。' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-progress',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      text: '进度怎么样',
      timestamp: Date.now(),
    });

    assert.equal(llmCalled, true);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('我继续去看真实进度。'));
    assert.equal(sentMessages[0].text.includes('这个本地 Codex 会话还在继续跑'), false);
  });

  it('forwards new task requests even when they contain “最新的”', async () => {
    const sessionId = '019d7aab-a6c0-7223-a7da-22d3684259ff';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      sessionId,
      '/Users/example/project-local-current',
      'Named local current session',
      new Date().toISOString(),
    );
    appendLocalSessionRecord(process.env.CTI_CODEX_SESSIONS_ROOT!, sessionId, {
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: '这是上一轮的旧进度，不该覆盖新任务。',
        phase: 'commentary',
      },
    });

    const store = new FakeStore();
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: sessionId,
      sdkSessionId: sessionId,
      workingDirectory: '/Users/example/project-local-current',
      model: '',
      mode: 'code',
    });

    let llmCalled = false;
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: {
        streamChat: () => {
          llmCalled = true;
          return new ReadableStream({
            start(controller) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: '开始同步跑 guardian 最新 PDF' })}\n`);
              controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({}) })}\n`);
              controller.close();
            },
          });
        },
      },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const { _testOnly } = await import('../../lib/bridge/bridge-manager');
    const sentMessages: OutboundMessage[] = [];
    const adapter = createMockTelegramAdapter(sentMessages);

    await _testOnly.handleMessage(adapter, {
      messageId: 'msg-new-task-not-progress',
      address: { channelType: 'telegram', chatId: '1000000001', userId: '1000000001', displayName: 'Owner' },
      text: '同步跑多另一个pdf，guardian的，最新的',
      timestamp: Date.now(),
    });

    assert.equal(llmCalled, true);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('开始同步跑 guardian 最新 PDF'));
    assert.equal(sentMessages[0].text.includes('这个本地 Codex 会话还在继续跑'), false);
  });
});

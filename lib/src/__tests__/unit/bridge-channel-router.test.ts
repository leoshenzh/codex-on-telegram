import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeSession, BridgeStore } from '../../lib/bridge/host';
import type { ChannelBinding } from '../../lib/bridge/types';

class FakeStore {
  bindings = new Map<string, ChannelBinding>();
  sessions = new Map<string, BridgeSession>();

  getSetting(): string | null { return null; }

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
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: data.mode === 'plan' || data.mode === 'ask' ? data.mode : 'code',
      active: true,
      createdAt: existing?.createdAt || '2026-04-11T00:00:00.000Z',
      updatedAt: '2026-04-11T00:00:00.000Z',
      sessionSource: data.sessionSource ?? existing?.sessionSource ?? 'bridge',
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates });
        return;
      }
    }
  }

  listChannelBindings(channelType?: string): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter((binding) => binding.channelType === channelType) : all;
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(): BridgeSession[] {
    return Array.from(this.sessions.values());
  }

  upsertSession(session: BridgeSession): BridgeSession {
    this.sessions.set(session.id, session);
    return session;
  }

  createSession(): BridgeSession {
    throw new Error('createSession should not be called');
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

function writeLocalSession(
  sessionsRoot: string,
  sessionId: string,
  cwd: string,
  title: string,
  updatedAt: string,
): void {
  const dayDir = path.join(sessionsRoot, '2026', '04', '11');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: updatedAt,
      cwd,
      originator: 'codex_cli_rs',
      cli_version: '0.114.0',
      source: 'cli',
    },
  })}\n`, 'utf-8');
  fs.writeFileSync(path.join(path.dirname(sessionsRoot), 'session_index.jsonl'), `${JSON.stringify({
    id: sessionId,
    thread_name: title,
    updated_at: updatedAt,
  })}\n`, 'utf-8');
}

describe('channel-router local session bindings', () => {
  let tempDir: string;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-router-local-'));
    previousRoot = process.env.CTI_CODEX_SESSIONS_ROOT;
    process.env.CTI_CODEX_SESSIONS_ROOT = path.join(tempDir, 'sessions');
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.CTI_CODEX_SESSIONS_ROOT;
    } else {
      process.env.CTI_CODEX_SESSIONS_ROOT = previousRoot;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('keeps local binding semantics even after sdkSessionId changes to a fresh thread', async () => {
    const localSessionId = '11111111-2222-4333-8444-555555555555';
    writeLocalSession(
      process.env.CTI_CODEX_SESSIONS_ROOT!,
      localSessionId,
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

    const router = await import('../../lib/bridge/channel-router');
    const address = { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' };

    const binding = router.bindToSession(address, localSessionId);
    assert.ok(binding);
    assert.equal(binding?.sessionSource, 'local-codex');
    assert.equal(binding?.sdkSessionId, localSessionId);

    store.updateChannelBinding(binding!.id, { sdkSessionId: 'codex-thread-fresh-1' });

    const rebound = router.getBinding(address);
    assert.ok(rebound);
    assert.equal(rebound?.codepilotSessionId, localSessionId);
    assert.equal(rebound?.sdkSessionId, 'codex-thread-fresh-1');
    assert.equal(rebound?.sessionSource, 'local-codex');

    const listed = router.listBindableSessions('telegram');
    assert.equal(listed[0]?.source, 'local-codex');
    assert.equal(listed[0]?.sessionId, localSessionId);
  });

  it('does not clear a stored session model when rebinding the same session', async () => {
    const store = new FakeStore();
    store.upsertSession({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      working_directory: '/Users/example/project',
      model: 'gpt-current',
      sdk_session_id: 'codex-thread-1',
      display_name: 'Existing session',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'bridge',
    });
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '1000000001',
      codepilotSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sdkSessionId: 'codex-thread-1',
      workingDirectory: '/Users/example/project',
      model: '',
      mode: 'code',
    });
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const router = await import('../../lib/bridge/channel-router');
    const rebound = router.bindToSession(
      { channelType: 'telegram', chatId: '1000000001', userId: '1000000001' },
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    assert.ok(rebound);
    assert.equal(rebound?.model, 'gpt-current');
    assert.equal(store.getSession('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')?.model, 'gpt-current');
  });
});

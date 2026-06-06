/**
 * Unit tests for bridge permission-broker.
 *
 * Tests cover:
 * - handlePermissionCallback: action parsing, chat validation, dedup
 * - Permission resolution via PermissionGateway
 * - Callback data parsing with colons in permId
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initBridgeContext } from '../../lib/bridge/context';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import { forwardPermissionRequest, handlePermissionCallback } from '../../lib/bridge/permission-broker';
import type { BridgeStore, PermissionGateway, PermissionResolution } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

function createMockStore() {
  const links = new Map<string, { chatId: string; messageId: string; resolved: boolean; suggestions: string }>();

  return {
    links,
    getSetting: () => null,
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
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
    getPermissionLink: (id: string) => {
      return links.get(id) ?? null;
    },
    markPermissionLinkResolved: (id: string) => {
      const link = links.get(id);
      if (!link || link.resolved) return false;
      link.resolved = true;
      return true;
    },
    listPendingPermissionLinksByChat: (chatId: string) => {
      return [...links.values()].filter(l => l.chatId === chatId && !l.resolved);
    },
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

function createMockGateway() {
  const resolved: Array<{ id: string; resolution: PermissionResolution }> = [];
  let allowResolutions = true;
  return {
    resolved,
    setAllowResolutions(value: boolean) {
      allowResolutions = value;
    },
    resolvePendingPermission(id: string, resolution: PermissionResolution) {
      if (!allowResolutions) return false;
      resolved.push({ id, resolution });
      return true;
    },
  };
}

type MockStore = ReturnType<typeof createMockStore>;
type MockGateway = ReturnType<typeof createMockGateway>;

function setupContext(store: MockStore, gateway: MockGateway) {
  delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: gateway,
    lifecycle: {},
  });
}

function createMockAdapter(sendFn: (message: OutboundMessage) => Promise<SendResult>): BaseChannelAdapter {
  return {
    channelType: 'telegram',
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    consumeOne: async () => null,
    send: sendFn,
    validateConfig: () => null,
    isAuthorized: () => true,
  } as unknown as BaseChannelAdapter;
}

describe('permission-broker', () => {
  let store: MockStore;
  let gateway: MockGateway;

  beforeEach(() => {
    store = createMockStore();
    gateway = createMockGateway();
    setupContext(store, gateway);
  });

  it('returns false for non-perm callback data', () => {
    assert.equal(handlePermissionCallback('other:data', '123').handled, false);
  });

  it('returns false when permission link not found', () => {
    const result = handlePermissionCallback('perm:allow:unknown-id', '123');
    assert.equal(result.handled, false);
    assert.match(result.callbackText, /no longer active/i);
  });

  it('returns false when chatId does not match', () => {
    store.links.set('perm-1', {
      chatId: '999',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123');
    assert.equal(result.handled, false);
  });

  it('returns false when messageId does not match', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123', 'wrong-msg');
    assert.equal(result.handled, false);
  });

  it('resolves allow action correctly', () => {
    store.links.set('perm-1', {
      chatId: '123',
      messageId: 'msg-1',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm-1', '123');
    assert.equal(result.handled, true);
    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
  });

  it('resolves deny action correctly', () => {
    store.links.set('perm-2', {
      chatId: '456',
      messageId: 'msg-2',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:deny:perm-2', '456');
    assert.equal(result.handled, true);
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.equal(gateway.resolved[0].resolution.message, 'Denied via IM bridge');
  });

  it('prevents duplicate resolution', () => {
    store.links.set('perm-3', {
      chatId: '123',
      messageId: 'msg-3',
      resolved: false,
      suggestions: '',
    });

    const first = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(first.handled, true);

    const second = handlePermissionCallback('perm:allow:perm-3', '123');
    assert.equal(second.handled, false);
    assert.equal(gateway.resolved.length, 1);
  });

  it('handles permId with colons', () => {
    store.links.set('perm:with:colons', {
      chatId: '123',
      messageId: 'msg-4',
      resolved: false,
      suggestions: '',
    });

    const result = handlePermissionCallback('perm:allow:perm:with:colons', '123');
    assert.equal(result.handled, true);
    assert.equal(gateway.resolved[0].id, 'perm:with:colons');
  });

  it('does not burn the stored button when the live permission is already gone', () => {
    store.links.set('perm-stale', {
      chatId: '123',
      messageId: 'msg-stale',
      resolved: false,
      suggestions: '',
    });
    gateway.setAllowResolutions(false);

    const result = handlePermissionCallback('perm:allow:perm-stale', '123');

    assert.equal(result.handled, false);
    assert.match(result.callbackText, /expired|no longer active/i);
    assert.equal(store.links.get('perm-stale')?.resolved, false);
    assert.equal(gateway.resolved.length, 0);
  });

  it('allow_session passes suggestions as updatedPermissions', () => {
    const suggestions = JSON.stringify([{ type: 'allow', toolName: 'Bash' }]);
    store.links.set('perm-4', {
      chatId: '123',
      messageId: 'msg-5',
      resolved: false,
      suggestions,
    });

    const result = handlePermissionCallback('perm:allow_session:perm-4', '123');
    assert.equal(result.handled, true);
    assert.equal(gateway.resolved[0].resolution.behavior, 'allow');
    assert.ok((gateway.resolved[0].resolution as any).updatedPermissions);
  });

  it('allows a permission prompt to be retried after a send failure', async () => {
    let sendCount = 0;
    const adapter = createMockAdapter(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return { ok: false, error: 'bad request', httpStatus: 400 } as SendResult;
      }
      return { ok: true, messageId: `msg-${sendCount}` };
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'telegram', chatId: '123', userId: '123' },
      'perm-forward-retry',
      'Bash',
      { command: 'pwd' },
      'session-1',
    );
    await forwardPermissionRequest(
      adapter,
      { channelType: 'telegram', chatId: '123', userId: '123' },
      'perm-forward-retry',
      'Bash',
      { command: 'pwd' },
      'session-1',
    );

    assert.equal(sendCount, 2);
  });

  it('immediately denies the live permission when the prompt cannot be delivered', async () => {
    const adapter = createMockAdapter(async () => (
      { ok: false, error: 'send failed' } as SendResult
    ));

    await forwardPermissionRequest(
      adapter,
      { channelType: 'telegram', chatId: '123', userId: '123' },
      'perm-delivery-failed',
      'Bash',
      { command: 'pwd' },
      'session-1',
    );

    assert.equal(gateway.resolved.length, 1);
    assert.equal(gateway.resolved[0].id, 'perm-delivery-failed');
    assert.equal(gateway.resolved[0].resolution.behavior, 'deny');
    assert.match(gateway.resolved[0].resolution.message || '', /could not be delivered/i);
  });

  it('redacts sensitive tool input before forwarding to chat', async () => {
    let forwardedText = '';
    const adapter = createMockAdapter(async (message) => {
      forwardedText = message.text;
      return { ok: true, messageId: 'msg-safe' };
    });

    await forwardPermissionRequest(
      adapter,
      { channelType: 'telegram', chatId: '123', userId: '123' },
      'perm-redacted',
      'Bash',
      {
        command: 'deploy --token super-secret-token-value',
        apiKey: 'sk-live-1234567890',
        headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
        workdir: '/Users/example/My Project',
      },
      'session-1',
    );

    assert.match(forwardedText, /Input summary:/);
    assert.match(forwardedText, /command: \[redacted\]/);
    assert.match(forwardedText, /apiKey: \[redacted\]/);
    assert.match(forwardedText, /headers: \{object:Authorization\}/);
    assert.match(forwardedText, /workdir: \/Users\/example\/My Project/);
    assert.doesNotMatch(forwardedText, /super-secret-token-value/);
    assert.doesNotMatch(forwardedText, /Bearer abcdefghijklmnopqrstuvwxyz/);
  });
});

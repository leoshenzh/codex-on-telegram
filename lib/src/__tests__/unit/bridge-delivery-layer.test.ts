import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import { deliver, deliverRendered } from '../../lib/bridge/delivery-layer';
import type { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type { OutboundMessage, SendResult } from '../../lib/bridge/types';

function createMockAdapter(opts?: {
  sendFn?: (msg: OutboundMessage) => Promise<SendResult>;
}): BaseChannelAdapter {
  const sendFn = opts?.sendFn ?? (async () => ({ ok: true, messageId: 'msg-1' }));
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

function createMockStore() {
  const auditLogs: Array<{ chatId: string; direction: string; summary: string }> = [];
  const outboundRefs: Array<{ platformMessageId: string; purpose: string }> = [];
  const dedupKeys = new Set<string>();

  return {
    auditLogs,
    outboundRefs,
    dedupKeys,
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
    insertAuditLog: (entry: any) => { auditLogs.push(entry); },
    checkDedup: (key: string) => dedupKeys.has(key),
    insertDedup: (key: string) => { dedupKeys.add(key); },
    cleanupExpiredDedup: () => {},
    insertOutboundRef: (ref: any) => { outboundRefs.push(ref); },
    insertPermissionLink: () => {},
    getPermissionLink: () => null,
    markPermissionLinkResolved: () => false,
    listPendingPermissionLinksByChat: () => [],
    getChannelOffset: () => '0',
    setChannelOffset: () => {},
  };
}

type MockStore = ReturnType<typeof createMockStore>;

function setupContext(store: MockStore) {
  delete (globalThis as Record<string, unknown>).__bridge_context__;
  initBridgeContext({
    store: store as unknown as BridgeStore,
    llm: { streamChat: () => new ReadableStream() },
    permissions: { resolvePendingPermission: () => false },
    lifecycle: {},
  });
}

describe('delivery-layer', () => {
  let store: MockStore;

  beforeEach(() => {
    store = createMockStore();
    setupContext(store);
  });

  it('delivers a short Telegram message in one chunk', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: 'msg-1' };
      },
    });

    const result = await deliver(adapter, {
      address: { channelType: 'telegram', chatId: 'tg-1' },
      text: 'Hello from Telegram!',
      parseMode: 'plain',
    });

    assert.ok(result.ok);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0], 'Hello from Telegram!');
  });

  it('chunks long messages at the Telegram limit', async () => {
    const sentMessages: string[] = [];
    const adapter = createMockAdapter({
      sendFn: async (msg) => {
        sentMessages.push(msg.text);
        return { ok: true, messageId: `msg-${sentMessages.length}` };
      },
    });

    const longText = 'Line\n'.repeat(2000);
    const result = await deliver(adapter, {
      address: { channelType: 'telegram', chatId: 'tg-1' },
      text: longText,
      parseMode: 'plain',
    });

    assert.ok(result.ok);
    assert.ok(sentMessages.length > 1);
    for (const chunk of sentMessages) {
      assert.ok(chunk.length <= 4096, `Chunk exceeded Telegram limit: ${chunk.length}`);
    }
  });

  it('returns the last delivered message id when a later rendered chunk fails', async () => {
    let sends = 0;
    const adapter = createMockAdapter({
      sendFn: async () => {
        sends += 1;
        if (sends === 1) return { ok: true, messageId: 'msg-1' };
        return { ok: false, error: 'send failed', httpStatus: 500 } as SendResult;
      },
    });

    const result = await deliverRendered(adapter, { channelType: 'telegram', chatId: 'tg-1' }, [
      { text: 'first chunk', parseMode: 'HTML' },
      { text: 'second chunk', parseMode: 'HTML' },
    ], { sessionId: 'session-1' });

    assert.equal(result.ok, false);
    assert.equal(result.messageId, 'msg-1');
    assert.equal(sends, 4);
  });

  it('skips delivery when dedup key already exists', async () => {
    store.dedupKeys.add('dedup-1');
    const adapter = createMockAdapter();

    const result = await deliver(adapter, {
      address: { channelType: 'telegram', chatId: 'tg-1' },
      text: 'Duplicate',
      parseMode: 'plain',
    }, { dedupKey: 'dedup-1' });

    assert.ok(result.ok);
    assert.equal(store.auditLogs.length, 0);
  });

  it('records outbound refs when sessionId is present', async () => {
    const adapter = createMockAdapter();

    await deliver(adapter, {
      address: { channelType: 'telegram', chatId: 'tg-1' },
      text: 'Tracked',
      parseMode: 'plain',
    }, { sessionId: 'session-1' });

    assert.equal(store.outboundRefs.length, 1);
    assert.equal(store.outboundRefs[0].purpose, 'response');
  });
});

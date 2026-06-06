import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initBridgeContext } from '../../lib/bridge/context';
import type { BridgeStore } from '../../lib/bridge/host';
import { TelegramAdapter } from '../../lib/bridge/adapters/telegram-adapter';

function createMockStore() {
  let storedOffset = '0';

  const store = {
    getSetting: (key: string) => {
      if (key === 'telegram_bot_token') return '';
      if (key === 'bridge_telegram_enabled') return 'true';
      return null;
    },
    getChannelBinding: () => null,
    upsertChannelBinding: () => ({} as any),
    updateChannelBinding: () => {},
    listChannelBindings: () => [],
    getSession: () => null,
    listSessions: () => [],
    upsertSession: (session: any) => session,
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
    getChannelOffset: () => storedOffset,
    setChannelOffset: (_key: string, offset: string) => {
      storedOffset = offset;
    },
  };

  return { store, getStoredOffset: () => storedOffset };
}

describe('telegram adapter offset commits', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('advances the stored offset from zero on the first acknowledged update', () => {
    const { store, getStoredOffset } = createMockStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    adapter.acknowledgeUpdate(123456);

    assert.equal(getStoredOffset(), '123457');
  });
});

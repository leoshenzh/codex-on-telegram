import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initBridgeContext } from '../../lib/bridge/context';
import { TelegramAdapter } from '../../lib/bridge/adapters/telegram-adapter';
import type { BridgeStore } from '../../lib/bridge/host';

class FakeStore {
  settings = new Map<string, string>([
    ['telegram_bot_token', 'token-123'],
    ['bridge_telegram_enabled', 'true'],
    ['telegram_chat_id', '123'],
  ]);

  offsets = new Map<string, string>();

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding() { return null; }
  upsertChannelBinding() { return {} as any; }
  updateChannelBinding() {}
  listChannelBindings() { return []; }
  getSession() { return null; }
  listSessions() { return []; }
  upsertSession(session: any) { return session; }
  createSession() { return { id: '1', working_directory: '', model: '' }; }
  updateSessionProviderId() {}
  addMessage() {}
  getMessages() { return { messages: [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId() {}
  updateSessionModel() {}
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset(key: string): string {
    return this.offsets.get(key) || '0';
  }
  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
  }
}

describe('telegram-adapter offsets', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete (globalThis as Record<string, unknown>).__bridge_context__;
  });

  it('advances the persisted offset from the first observed update id', async () => {
    const store = new FakeStore();
    let getUpdatesCalls = 0;

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 101,
                  message: {
                    message_id: 55,
                    chat: { id: 123 },
                    from: { id: 123, first_name: 'Owner' },
                    text: 'hello',
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    assert.ok(inbound, 'expected one inbound Telegram message');
    assert.equal(inbound?.updateId, 101);

    adapter.acknowledgeUpdate?.(101);
    await adapter.stop();

    assert.equal(store.getChannelOffset('telegram:bot999'), '102');
  });

  it('only trusts telegram_chat_id fallback for a private chat with the owner user', () => {
    const store = new FakeStore();
    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();

    assert.equal(adapter.isAuthorized('123', '123'), true);
    assert.equal(adapter.isAuthorized('999', '123'), false);
    assert.equal(adapter.isAuthorized('999', '-100123'), false);
  });

  it('fails startup when getMe is unavailable instead of pretending to run', async () => {
    const store = new FakeStore();

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/getMe')) {
        throw new Error('telegram auth failed');
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await assert.rejects(() => adapter.start(), /telegram auth failed/i);
    assert.equal(adapter.isRunning(), false);
  });

  it('anchors live progress to the inbound message instead of guessing from the queue', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9001 } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    adapter.onStreamText?.({
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-1',
      bindingId: 'binding-1',
    } as any, 'still working');

    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.onStreamEnd?.({
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-1',
      bindingId: 'binding-1',
    } as any, 'completed', 'still working');

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.reply_to_message_id, '456');
    assert.equal(sendCalls[0]?.chat_id, '123');
  });

  it('shows an immediate live progress placeholder when a task starts', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9003 } }),
        } as Response;
      }
      if (url.endsWith('/deleteMessage')) {
        deleteCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-start-progress',
      bindingId: 'binding-start-progress',
    } as any;
    adapter.onMessageStart?.(context);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.reply_to_message_id, '456');
    assert.equal(sendCalls[0]?.chat_id, '123');
    assert.match(String(sendCalls[0]?.text || ''), /处理中/);
    assert.match(String(sendCalls[0]?.text || ''), /已收到/);

    await adapter.onStreamEnd?.(context, 'completed', 'Done');
    adapter.onMessageEnd?.(context);
    assert.equal(deleteCalls.length, 1);
  });

  it('does not show live progress when Telegram streaming is disabled', async () => {
    const store = new FakeStore();
    store.settings.set('bridge_telegram_stream_enabled', 'false');
    const sendCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9004 } }),
        } as Response;
      }
      return {
        status: 200,
        json: async () => ({ ok: true, result: true }),
      } as Response;
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-stream-disabled',
      bindingId: 'binding-stream-disabled',
    } as any;
    adapter.onMessageStart?.(context);
    adapter.onStreamText?.(context, 'still working');
    adapter.onMessageEnd?.(context);

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sendCalls.length, 0);
  });

  it('shows live progress in authorized group topics by default', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const actionCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9005 } }),
        } as Response;
      }
      if (url.endsWith('/sendChatAction')) {
        actionCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '-2000000002', topicId: '3305' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-topic-progress',
      bindingId: 'binding-topic-progress',
    } as any;
    adapter.onMessageStart?.(context);

    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.onMessageEnd?.(context);

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.chat_id, '-2000000002');
    assert.equal(sendCalls[0]?.message_thread_id, '3305');
    assert.equal(actionCalls[0]?.message_thread_id, '3305');
  });

  it('falls back without a reply anchor when Telegram says the reply target is gone', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        if (sendCalls.length === 1) {
          return {
            status: 400,
            json: async () => ({
              ok: false,
              description: 'Bad Request: replied message not found',
            }),
          } as Response;
        }
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9006 } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const result = await adapter.send({
      address: { channelType: 'telegram', chatId: '-2000000002', topicId: '3305' },
      text: 'final reply',
      replyToMessageId: '456',
    });

    assert.equal(result.ok, true);
    assert.equal(sendCalls.length, 2);
    assert.equal(sendCalls[0]?.reply_to_message_id, '456');
    assert.equal(sendCalls[1]?.reply_to_message_id, undefined);
    assert.equal(sendCalls[1]?.message_thread_id, '3305');
  });

  it('serializes progress updates and closes late progress at stream end', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const editCalls: Array<Record<string, unknown>> = [];
    let resolveSend: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        await sendStarted;
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9001 } }),
        } as Response;
      }
      if (url.endsWith('/editMessageText')) {
        editCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9001 } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-serial',
      bindingId: 'binding-serial',
    } as any;

    adapter.onStreamText?.(context, 'still working');
    adapter.onToolEvent?.(context, [{ id: 'tool-1', name: 'Bash', status: 'running' }]);
    const endPromise = adapter.onStreamEnd?.(context, 'completed', 'All done') ?? Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sendCalls.length, 1);

    if (resolveSend) resolveSend();
    await endPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.reply_to_message_id, '456');
    assert.equal(editCalls.length <= 1, true);
    const finalProgressText = String(editCalls[0]?.text || sendCalls[0]?.text || '');
    assert.match(finalProgressText, /Tools/i);
  });

  it('deletes the live progress placeholder when the stream ends', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9002 } }),
        } as Response;
      }
      if (url.endsWith('/deleteMessage')) {
        deleteCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-delete-progress',
      bindingId: 'binding-delete-progress',
    } as any;

    adapter.onStreamText?.(context, 'still working');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.onStreamEnd?.(context, 'completed', 'All done');

    assert.equal(sendCalls.length, 1);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]?.chat_id, '123');
    assert.equal(deleteCalls[0]?.message_id, 9002);
  });

  it('sends the first heartbeat as a new placeholder message', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9100 } }),
        } as Response;
      }
      if (url.endsWith('/deleteMessage')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-heartbeat-first',
      bindingId: 'binding-heartbeat-first',
    } as any;

    adapter.onStreamHeartbeat?.(context, 'Still working… (running 30s)');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.chat_id, '123');
    assert.equal(sendCalls[0]?.reply_to_message_id, '456');
    assert.match(String(sendCalls[0]?.text || ''), /Still working/);

    // Drain the live-progress heartbeat interval so the test process can exit.
    await adapter.onStreamEnd?.(context, 'completed', 'done');
  });

  it('edits the same placeholder message on subsequent heartbeats', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const editCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9101 } }),
        } as Response;
      }
      if (url.endsWith('/editMessageText')) {
        editCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9101 } }),
        } as Response;
      }
      if (url.endsWith('/deleteMessage')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-heartbeat-edit',
      bindingId: 'binding-heartbeat-edit',
    } as any;

    adapter.onStreamHeartbeat?.(context, 'Still working… (running 30s)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.onStreamHeartbeat?.(context, 'Still working… (running 1m 00s)');
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sendCalls.length, 1);
    assert.equal(editCalls.length, 1);
    assert.equal(editCalls[0]?.chat_id, '123');
    assert.equal(editCalls[0]?.message_id, 9101);
    assert.match(String(editCalls[0]?.text || ''), /1m 00s/);

    // Drain the live-progress heartbeat interval so the test process can exit.
    await adapter.onStreamEnd?.(context, 'completed', 'done');
  });

  it('deletes the heartbeat placeholder when the stream ends', async () => {
    const store = new FakeStore();
    const sendCalls: Array<Record<string, unknown>> = [];
    const deleteCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9102 } }),
        } as Response;
      }
      if (url.endsWith('/deleteMessage')) {
        deleteCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    const context = {
      address: { channelType: 'telegram', chatId: '123' },
      inboundMessageId: '456',
      replyToMessageId: '456',
      sessionId: 'session-heartbeat-delete',
      bindingId: 'binding-heartbeat-delete',
    } as any;

    adapter.onStreamHeartbeat?.(context, 'Still working… (running 30s)');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await adapter.onStreamEnd?.(context, 'completed', 'final reply');

    assert.equal(sendCalls.length, 1);
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0]?.chat_id, '123');
    assert.equal(deleteCalls[0]?.message_id, 9102);
  });

  it('preserves Telegram topic ids on inbound messages and outbound sends', async () => {
    const store = new FakeStore();
    store.settings.set('telegram_bridge_require_private_chat', 'false');
    store.settings.set('telegram_bridge_allowed_users', '123');
    let getUpdatesCalls = 0;
    const sendCalls: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 301,
                  message: {
                    message_id: 88,
                    message_thread_id: 3305,
                    chat: { id: -2000000002, title: 'Test Control Room' },
                    from: { id: 123, first_name: 'Owner' },
                    text: 'topic hello',
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      if (url.endsWith('/sendMessage')) {
        sendCalls.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return {
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 9901 } }),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    assert.ok(inbound, 'expected one inbound Telegram topic message');
    assert.equal(inbound?.address.chatId, '-2000000002');
    assert.equal((inbound?.address as any).topicId, '3305');

    await adapter.send({
      address: {
        channelType: 'telegram',
        chatId: '-2000000002',
        topicId: '3305',
      } as any,
      text: 'topic reply',
      parseMode: 'plain',
    });

    await adapter.stop();

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.chat_id, '-2000000002');
    assert.equal(sendCalls[0]?.message_thread_id, '3305');
  });

  it('accepts channel_post updates and subscribes to broader Telegram update types', async () => {
    const store = new FakeStore();
    store.settings.set('telegram_bridge_require_private_chat', 'false');
    store.settings.set('telegram_bridge_allowed_users', '123');
    let getUpdatesCalls = 0;
    let allowedUpdates: unknown;

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        allowedUpdates = JSON.parse(String(init?.body ?? '{}')).allowed_updates;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 401,
                  channel_post: {
                    message_id: 90,
                    message_thread_id: 4401,
                    chat: { id: -2000000002, title: 'Test Control Room' },
                    from: { id: 123, first_name: 'Owner' },
                    text: 'channel hello',
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    await adapter.stop();

    assert.deepEqual(allowedUpdates, [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'callback_query',
    ]);
    assert.ok(inbound, 'expected one inbound Telegram channel_post message');
    assert.equal(inbound?.text, 'channel hello');
    assert.equal(inbound?.address.chatId, '-2000000002');
    assert.equal((inbound?.address as any).topicId, '4401');
  });

  it('accepts topic messages sent on behalf of a bound chat identity', async () => {
    const store = new FakeStore();
    store.settings.set('telegram_bridge_require_private_chat', 'false');
    store.settings.set('telegram_bridge_allowed_users', '123');
    store.settings.set('telegram_bridge_owner_user_id', '123');
    store.listChannelBindings = () => [{
      id: 'binding-1',
      channelType: 'telegram',
      chatId: '-2000000002',
      codepilotSessionId: 'session-1',
      createdAt: '2026-04-13T00:00:00.000Z',
      updatedAt: '2026-04-13T00:00:00.000Z',
    }] as any;
    let getUpdatesCalls = 0;

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 501,
                  message: {
                    message_id: 91,
                    message_thread_id: 4402,
                    chat: { id: -2000000002, title: 'Test Control Room' },
                    from: { id: 1087968824, first_name: 'Group' },
                    sender_chat: { id: -2000000002, title: 'Test Control Room' },
                    text: 'anonymous topic hello',
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    await adapter.stop();

    assert.ok(inbound, 'expected one inbound anonymous Telegram topic message');
    assert.equal(inbound?.text, 'anonymous topic hello');
    assert.equal(inbound?.address.chatId, '-2000000002');
    assert.equal((inbound?.address as any).topicId, '4402');
    assert.equal(inbound?.address.displayName, 'Test Control Room');
  });

  it('uses the Telegram group title as the peer display name for normal group messages', async () => {
    const store = new FakeStore();
    store.settings.set('telegram_bridge_allowed_users', '-2000000002,1000000001');
    let getUpdatesCalls = 0;

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 601,
                  message: {
                    message_id: 92,
                    chat: { id: -2000000002, title: 'Team Codex' },
                    from: { id: 1000000001, first_name: 'Owner' },
                    text: 'hello group',
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    await adapter.stop();

    assert.ok(inbound, 'expected one inbound Telegram group message');
    assert.equal(inbound?.address.displayName, 'Team Codex');
  });

  it('downloads non-image Telegram documents as file attachments', async () => {
    const store = new FakeStore();
    let getUpdatesCalls = 0;

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 701,
                  message: {
                    message_id: 93,
                    chat: { id: 123 },
                    from: { id: 123, first_name: 'Owner' },
                    document: {
                      file_id: 'doc-file-id',
                      file_unique_id: 'doc-unique-id',
                      file_name: 'brief.pdf',
                      mime_type: 'application/pdf',
                      file_size: 11,
                    },
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      if (url.endsWith('/getFile')) {
        assert.equal(JSON.parse(String(init?.body ?? '{}')).file_id, 'doc-file-id');
        return {
          status: 200,
          json: async () => ({ ok: true, result: { file_path: 'documents/brief.pdf', file_size: 11 } }),
        } as Response;
      }

      if (url.includes('/file/bot')) {
        return new Response(Buffer.from('pdf-content'));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    await adapter.stop();

    assert.ok(inbound, 'expected one inbound Telegram document');
    assert.equal(inbound?.attachments?.length, 1);
    assert.equal(inbound?.attachments?.[0]?.name, 'brief.pdf');
    assert.equal(inbound?.attachments?.[0]?.type, 'application/pdf');
    assert.equal(Buffer.from(inbound?.attachments?.[0]?.data || '', 'base64').toString('utf-8'), 'pdf-content');
  });

  it('still downloads generic documents when image input is disabled', async () => {
    const store = new FakeStore();
    store.settings.set('bridge_telegram_image_enabled', 'false');
    let getUpdatesCalls = 0;

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith('/getMe')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: { id: 999 } }),
        } as Response;
      }

      if (url.endsWith('/setMyCommands')) {
        return {
          status: 200,
          json: async () => ({ ok: true, result: true }),
        } as Response;
      }

      if (url.endsWith('/getUpdates')) {
        getUpdatesCalls += 1;
        return {
          status: 200,
          json: async () => ({
            ok: true,
            result: getUpdatesCalls === 1
              ? [{
                  update_id: 702,
                  message: {
                    message_id: 94,
                    chat: { id: 123 },
                    from: { id: 123, first_name: 'Owner' },
                    document: {
                      file_id: 'doc-disabled-image-id',
                      file_unique_id: 'doc-disabled-image-unique',
                      file_name: 'sheet.xlsx',
                      mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                      file_size: 12,
                    },
                    date: Math.floor(Date.now() / 1000),
                  },
                }]
              : [],
          }),
        } as Response;
      }

      if (url.endsWith('/getFile')) {
        assert.equal(JSON.parse(String(init?.body ?? '{}')).file_id, 'doc-disabled-image-id');
        return {
          status: 200,
          json: async () => ({ ok: true, result: { file_path: 'documents/sheet.xlsx', file_size: 12 } }),
        } as Response;
      }

      if (url.includes('/file/bot')) {
        return new Response(Buffer.from('xlsx-content'));
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.start();

    const inbound = await Promise.race([
      adapter.consumeOne(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);

    await adapter.stop();

    assert.ok(inbound, 'expected one inbound Telegram document');
    assert.equal(inbound?.attachments?.[0]?.name, 'sheet.xlsx');
    assert.equal(Buffer.from(inbound?.attachments?.[0]?.data || '', 'base64').toString('utf-8'), 'xlsx-content');
  });

  it('sends image files through sendPhoto and documents through sendDocument', async () => {
    const store = new FakeStore();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-send-file-test-'));
    const imagePath = path.join(tmpDir, 'image.png');
    const docPath = path.join(tmpDir, 'report.pdf');
    fs.writeFileSync(imagePath, Buffer.from('png'));
    fs.writeFileSync(docPath, Buffer.from('pdf'));
    const methods: string[] = [];
    const fields: Array<{ chatId: unknown; threadId: unknown; replyTo: unknown }> = [];

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(url.split('/').pop() || '');
      const body = init?.body as FormData;
      fields.push({
        chatId: body.get('chat_id'),
        threadId: body.get('message_thread_id'),
        replyTo: body.get('reply_to_message_id'),
      });
      return {
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 42 + methods.length } }),
      } as Response;
    }) as typeof fetch;

    initBridgeContext({
      store: store as unknown as BridgeStore,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });

    const adapter = new TelegramAdapter();
    await adapter.sendFile({
      address: { channelType: 'telegram', chatId: '-1001', topicId: '3305' },
      filePath: imagePath,
      mimeType: 'image/png',
      replyToMessageId: '93',
    });
    await adapter.sendFile({
      address: { channelType: 'telegram', chatId: '-1001', topicId: '3305' },
      filePath: docPath,
      mimeType: 'application/pdf',
      replyToMessageId: '93',
    });

    assert.deepEqual(methods, ['sendPhoto', 'sendDocument']);
    assert.equal(fields[0]?.chatId, '-1001');
    assert.equal(fields[0]?.threadId, '3305');
    assert.equal(fields[0]?.replyTo, '93');
    assert.equal(fields[1]?.chatId, '-1001');
  });
});

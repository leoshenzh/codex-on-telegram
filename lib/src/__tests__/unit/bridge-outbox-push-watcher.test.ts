/**
 * Unit tests for the outbox push watcher (Fix #3).
 *
 * Covers: text dispatch, binary dispatch, mtime stability gating,
 * failure backoff to .failed/, fan-out across multiple bindings sharing
 * a workDir, the no-binding case, and the env-disabled case.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initBridgeContext } from '../../lib/bridge/context';
import { BaseChannelAdapter } from '../../lib/bridge/channel-adapter';
import type { BridgeStore } from '../../lib/bridge/host';
import type {
  ChannelBinding,
  InboundMessage,
  OutboundFileMessage,
  OutboundMessage,
  SendResult,
} from '../../lib/bridge/types';
import {
  _testOnly_scanOnce,
  isOutboxPushWatcherEnabled,
  getOutboxPushPollMs,
  startOutboxPushWatcher,
  stopOutboxPushWatcher,
} from '../../lib/bridge/outbox-push-watcher';

class StubStore implements BridgeStore {
  bindings: ChannelBinding[] = [];
  getSetting(): string | null { return null; }
  getChannelBinding(): ChannelBinding | null { return null; }
  upsertChannelBinding(): ChannelBinding { return {} as ChannelBinding; }
  updateChannelBinding(): void {}
  listChannelBindings(channelType?: string): ChannelBinding[] {
    return channelType
      ? this.bindings.filter(b => b.channelType === channelType)
      : this.bindings.slice();
  }
  getSession(): null { return null; }
  listSessions(): never[] { return []; }
  upsertSession(s: any) { return s; }
  createSession() { return { id: 's', working_directory: '', model: '' }; }
  updateSessionProviderId(): void {}
  addMessage(): void {}
  getMessages() { return { messages: [] as any[] }; }
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
  getPermissionLink() { return null; }
  markPermissionLinkResolved(): boolean { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset(): string { return '0'; }
  setChannelOffset(): void {}
}

class StubAdapter extends BaseChannelAdapter {
  readonly channelType: string;
  sentMessages: OutboundMessage[] = [];
  sentFiles: OutboundFileMessage[] = [];
  failTextSends = false;
  failFileSends = false;
  textErrorMessage = 'simulated text failure';
  fileErrorMessage = 'simulated file failure';

  constructor(channelType: string) {
    super();
    this.channelType = channelType;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    if (this.failTextSends) {
      // Use a 400-class status so the delivery layer treats it as a
      // non-retryable client error and bubbles up immediately. This
      // keeps tests deterministic and fast.
      return { ok: false, error: this.textErrorMessage, httpStatus: 400 };
    }
    return { ok: true, messageId: `msg-${this.sentMessages.length}` };
  }
  override async sendFile(message: OutboundFileMessage): Promise<SendResult> {
    this.sentFiles.push(message);
    if (this.failFileSends) {
      return { ok: false, error: this.fileErrorMessage, httpStatus: 400 };
    }
    return { ok: true, messageId: `file-${this.sentFiles.length}` };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

function makeBinding(overrides: Partial<ChannelBinding> & { workingDirectory: string; chatId: string }): ChannelBinding {
  return {
    id: overrides.id || `bind-${overrides.chatId}`,
    channelType: overrides.channelType || 'telegram',
    chatId: overrides.chatId,
    topicId: overrides.topicId,
    codepilotSessionId: overrides.codepilotSessionId || `session-${overrides.chatId}`,
    sdkSessionId: overrides.sdkSessionId || '',
    workingDirectory: overrides.workingDirectory,
    model: overrides.model || '',
    mode: overrides.mode || 'code',
    sessionSource: overrides.sessionSource || 'bridge',
    active: overrides.active !== false,
    createdAt: overrides.createdAt || '2026-05-18T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-05-18T00:00:00.000Z',
  };
}

function makeWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cti-push-watcher-'));
}

function pushDir(workDir: string): string {
  return path.join(workDir, '.codepilot-outbox', 'push');
}

function writePushFile(workDir: string, name: string, body: Buffer | string): string {
  const dir = pushDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, name);
  fs.writeFileSync(absPath, body);
  return absPath;
}

function listBucket(workDir: string, bucket: string): string[] {
  const dir = path.join(pushDir(workDir), bucket);
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function clearWatcherSingleton(): void {
  // The watcher module keeps an internal `activeHandle`. Stopping is a
  // no-op when no handle is set, so calling this between tests is safe.
  stopOutboxPushWatcher();
}

describe('outbox-push-watcher env toggles', () => {
  const originalEnabled = process.env.CTI_OUTBOX_PUSH_ENABLED;
  const originalPollMs = process.env.CTI_OUTBOX_PUSH_POLL_MS;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.CTI_OUTBOX_PUSH_ENABLED;
    else process.env.CTI_OUTBOX_PUSH_ENABLED = originalEnabled;
    if (originalPollMs === undefined) delete process.env.CTI_OUTBOX_PUSH_POLL_MS;
    else process.env.CTI_OUTBOX_PUSH_POLL_MS = originalPollMs;
    clearWatcherSingleton();
  });

  it('defaults to enabled when CTI_OUTBOX_PUSH_ENABLED is unset', () => {
    delete process.env.CTI_OUTBOX_PUSH_ENABLED;
    assert.equal(isOutboxPushWatcherEnabled(), true);
  });

  it('treats "0" as disabled', () => {
    process.env.CTI_OUTBOX_PUSH_ENABLED = '0';
    assert.equal(isOutboxPushWatcherEnabled(), false);
  });

  it('treats "false" (any case) as disabled', () => {
    process.env.CTI_OUTBOX_PUSH_ENABLED = 'False';
    assert.equal(isOutboxPushWatcherEnabled(), false);
  });

  it('defaults poll interval to 5000ms', () => {
    delete process.env.CTI_OUTBOX_PUSH_POLL_MS;
    assert.equal(getOutboxPushPollMs(), 5000);
  });

  it('respects CTI_OUTBOX_PUSH_POLL_MS when set to a positive number', () => {
    process.env.CTI_OUTBOX_PUSH_POLL_MS = '250';
    assert.equal(getOutboxPushPollMs(), 250);
  });

  it('startOutboxPushWatcher returns null when disabled', () => {
    process.env.CTI_OUTBOX_PUSH_ENABLED = '0';
    const handle = startOutboxPushWatcher({ getAdapters: () => [] });
    assert.equal(handle, null);
  });
});

describe('outbox-push-watcher dispatch', () => {
  let workDir: string;
  let store: StubStore;
  let adapter: StubAdapter;
  let adapters: BaseChannelAdapter[];

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
    workDir = makeWorkDir();
    store = new StubStore();
    adapter = new StubAdapter('telegram');
    adapters = [adapter];
    initBridgeContext({
      store,
      llm: { streamChat: () => new ReadableStream() },
      permissions: { resolvePendingPermission: () => false },
      lifecycle: {},
    });
  });

  afterEach(() => {
    clearWatcherSingleton();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    delete (globalThis as Record<string, unknown>)['__bridge_context__'];
  });

  it('sends a stable .txt file as a text message and moves it to .sent/', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    writePushFile(workDir, 'note.txt', 'Hello from background task\nLine two');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    // First scan registers the file but does not dispatch (stability check).
    await _testOnly_scanOnce(adapters, seen, failures);
    assert.equal(adapter.sentMessages.length, 0);
    assert.equal(adapter.sentFiles.length, 0);

    // Second scan sees the same mtime -> dispatches.
    await _testOnly_scanOnce(adapters, seen, failures);
    assert.equal(adapter.sentMessages.length, 1);
    assert.match(adapter.sentMessages[0]?.text || '', /Hello from background task/);
    assert.equal(adapter.sentMessages[0]?.address.chatId, 'chat-A');

    const sent = listBucket(workDir, '.sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0] || '', /note\.txt$/);
    // The original file is gone.
    assert.equal(fs.existsSync(path.join(pushDir(workDir), 'note.txt')), false);
  });

  it('truncates text bodies over 4000 chars with an ellipsis', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    const body = 'x'.repeat(5000);
    writePushFile(workDir, 'big.md', body);
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    await _testOnly_scanOnce(adapters, seen, failures);

    assert.equal(adapter.sentMessages.length, 1);
    const sentText = adapter.sentMessages[0]?.text || '';
    assert.equal(sentText.length, 4000);
    assert.equal(sentText.endsWith('…'), true);
  });

  it('sends non-text extensions as file attachments and moves to .sent/', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    writePushFile(workDir, 'report.pdf', Buffer.from('%PDF-1.4 fake'));
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    await _testOnly_scanOnce(adapters, seen, failures);

    assert.equal(adapter.sentMessages.length, 0);
    assert.equal(adapter.sentFiles.length, 1);
    assert.equal(adapter.sentFiles[0]?.fileName, 'report.pdf');
    assert.equal(adapter.sentFiles[0]?.caption, 'report.pdf');
    assert.equal(adapter.sentFiles[0]?.address.chatId, 'chat-A');

    const sent = listBucket(workDir, '.sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0] || '', /report\.pdf$/);
  });

  it('waits until mtime is stable before sending', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    const abs = writePushFile(workDir, 'streaming.txt', 'partial');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    assert.equal(adapter.sentMessages.length, 0);

    // Touch the file with a new mtime to simulate a still-writing producer.
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(abs, future, future);
    await _testOnly_scanOnce(adapters, seen, failures);
    assert.equal(adapter.sentMessages.length, 0, 'must not send while mtime keeps changing');

    // Now leave it alone — next scan should send.
    await _testOnly_scanOnce(adapters, seen, failures);
    assert.equal(adapter.sentMessages.length, 1, 'sends once mtime is stable');
  });

  it('moves a file to .failed/ after 3 consecutive send failures', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    adapter.failTextSends = true;
    writePushFile(workDir, 'broken.txt', 'still trying');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    // Pair of scans = 1 dispatch attempt (stability check + dispatch).
    for (let i = 0; i < 3; i += 1) {
      await _testOnly_scanOnce(adapters, seen, failures); // mark stable
      await _testOnly_scanOnce(adapters, seen, failures); // dispatch -> fail
    }

    // Watcher-level policy: 3 dispatch attempts → moved to .failed/.
    // Adapter sees one send per attempt because httpStatus: 400 is a
    // non-retryable client error in the delivery layer.
    assert.equal(adapter.sentMessages.length, 3);
    const failed = listBucket(workDir, '.failed');
    assert.equal(failed.length, 1, 'file must be moved to .failed/');
    assert.match(failed[0] || '', /broken\.txt$/);
    assert.equal(fs.existsSync(path.join(pushDir(workDir), 'broken.txt')), false);
  });

  it('delivers to every binding that shares a workDir', async () => {
    store.bindings.push(
      makeBinding({ workingDirectory: workDir, chatId: 'chat-A', id: 'bind-A' }),
      makeBinding({ workingDirectory: workDir, chatId: 'chat-B', id: 'bind-B' }),
    );
    writePushFile(workDir, 'broadcast.txt', 'fan-out');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    await _testOnly_scanOnce(adapters, seen, failures);

    assert.equal(adapter.sentMessages.length, 2);
    const chatIds = adapter.sentMessages.map(m => m.address.chatId).sort();
    assert.deepEqual(chatIds, ['chat-A', 'chat-B']);
    assert.equal(listBucket(workDir, '.sent').length, 1);
  });

  it('leaves files in place and warns when no binding matches the workDir', async () => {
    // No bindings registered for workDir at all.
    writePushFile(workDir, 'orphan.txt', 'no home');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    await _testOnly_scanOnce(adapters, seen, failures);

    // With zero bindings the watcher does not even discover the dir, so
    // the file stays put and nothing is sent. To exercise the
    // "binding exists but for a different workDir" path, add a binding
    // pointing elsewhere.
    const otherDir = makeWorkDir();
    try {
      store.bindings.push(makeBinding({ workingDirectory: otherDir, chatId: 'chat-elsewhere' }));
      // Force-rewrite mtime so the next stability cycle is fresh.
      const orphan = path.join(pushDir(workDir), 'orphan.txt');
      const now = new Date();
      fs.utimesSync(orphan, now, now);
      await _testOnly_scanOnce(adapters, seen, failures);
      await _testOnly_scanOnce(adapters, seen, failures);

      assert.equal(adapter.sentMessages.length, 0);
      assert.equal(adapter.sentFiles.length, 0);
      assert.equal(fs.existsSync(orphan), true, 'orphan must stay put');
      assert.equal(listBucket(workDir, '.sent').length, 0);
      assert.equal(listBucket(workDir, '.failed').length, 0);
    } finally {
      try { fs.rmSync(otherDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('does not start when CTI_OUTBOX_PUSH_ENABLED=0', () => {
    const original = process.env.CTI_OUTBOX_PUSH_ENABLED;
    process.env.CTI_OUTBOX_PUSH_ENABLED = '0';
    try {
      const handle = startOutboxPushWatcher({ getAdapters: () => adapters });
      assert.equal(handle, null);
    } finally {
      if (original === undefined) delete process.env.CTI_OUTBOX_PUSH_ENABLED;
      else process.env.CTI_OUTBOX_PUSH_ENABLED = original;
    }
  });

  it('skips empty files with a warn instead of sending', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    writePushFile(workDir, 'empty.txt', '');
    const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
    const failures = new Map<string, number>();

    await _testOnly_scanOnce(adapters, seen, failures);
    await _testOnly_scanOnce(adapters, seen, failures);

    assert.equal(adapter.sentMessages.length, 0);
    assert.equal(adapter.sentFiles.length, 0);
    assert.equal(listBucket(workDir, '.sent').length, 0);
    assert.equal(listBucket(workDir, '.failed').length, 0);
    // File remains in push/ (empty) — operator can investigate.
    assert.equal(fs.existsSync(path.join(pushDir(workDir), 'empty.txt')), true);
  });

  it('refuses to follow a symlinked file entry (exfil guard)', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    // Plant a "secret" outside the push dir that a malicious symlink
    // would try to surface to Telegram.
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-push-secret-'));
    const secretPath = path.join(secretDir, 'id_rsa');
    fs.writeFileSync(secretPath, 'SECRET-PRIVATE-KEY');
    try {
      const dir = pushDir(workDir);
      fs.mkdirSync(dir, { recursive: true });
      const linkPath = path.join(dir, 'innocent.txt');
      fs.symlinkSync(secretPath, linkPath);
      const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
      const failures = new Map<string, number>();

      await _testOnly_scanOnce(adapters, seen, failures);
      await _testOnly_scanOnce(adapters, seen, failures);

      assert.equal(adapter.sentMessages.length, 0, 'symlink must not be dispatched');
      assert.equal(adapter.sentFiles.length, 0);
      assert.equal(listBucket(workDir, '.sent').length, 0);
      assert.equal(listBucket(workDir, '.failed').length, 0);
      // The symlink itself stays in place — we refuse to touch it.
      assert.equal(fs.existsSync(linkPath), true);
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
    } finally {
      try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('refuses to scan a push/ that is itself a symlink', async () => {
    store.bindings.push(makeBinding({ workingDirectory: workDir, chatId: 'chat-A' }));
    // Build a "real" directory full of files we don't want exfiltrated,
    // then point push/ at it via a symlink. The watcher must walk away.
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-push-decoy-'));
    fs.writeFileSync(path.join(decoyDir, 'leak.txt'), 'should not be sent');
    try {
      const outboxDir = path.join(workDir, '.codepilot-outbox');
      fs.mkdirSync(outboxDir, { recursive: true });
      const pushPath = path.join(outboxDir, 'push');
      fs.symlinkSync(decoyDir, pushPath);

      const seen = new Map<string, { firstSeenAt: number; lastMtimeMs: number }>();
      const failures = new Map<string, number>();
      await _testOnly_scanOnce(adapters, seen, failures);
      await _testOnly_scanOnce(adapters, seen, failures);

      assert.equal(adapter.sentMessages.length, 0, 'symlinked push/ must be skipped');
      assert.equal(adapter.sentFiles.length, 0);
      // The decoy stays untouched.
      assert.equal(fs.existsSync(path.join(decoyDir, 'leak.txt')), true);
    } finally {
      try { fs.rmSync(decoyDir, { recursive: true, force: true }); } catch {}
    }
  });
});

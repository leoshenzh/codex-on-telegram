import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCtiHome = process.env.CTI_HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-store-test-'));
process.env.CTI_HOME = testHome;

const { JsonFileStore } = await import('../store.js');
const { CTI_HOME } = await import('../config.js');

const DATA_DIR = path.join(CTI_HOME, 'data');

if (!CTI_HOME.startsWith(os.tmpdir())) {
  throw new Error(`Refusing to run store tests against non-temporary CTI_HOME: ${CTI_HOME}`);
}

after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
  if (originalCtiHome === undefined) {
    delete process.env.CTI_HOME;
  } else {
    process.env.CTI_HOME = originalCtiHome;
  }
});

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_telegram_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

describe('JsonFileStore', () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('getSetting returns values from settings map', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.getSetting('remote_bridge_enabled'), 'true');
    assert.equal(store.getSetting('bridge_default_model'), 'test-model');
    assert.equal(store.getSetting('nonexistent'), null);
  });

  it('createSession and getSession', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model-1', 'system prompt', '/tmp');
    assert.ok(session.id);
    assert.equal(session.model, 'model-1');
    assert.equal(session.working_directory, '/tmp');
    assert.equal(session.system_prompt, 'system prompt');
    assert.deepEqual(store.getSession(session.id), session);
  });

  it('upsertSession stores imported session metadata and listSessions sorts newest first', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertSession({
      id: 'sess-old',
      sdk_session_id: 'sess-old',
      working_directory: '/tmp/old',
      model: 'gpt-old',
      display_name: 'Old session',
      updated_at: '2026-04-10T00:00:00.000Z',
      source: 'local-codex',
    });
    store.upsertSession({
      id: 'sess-new',
      sdk_session_id: 'sess-new',
      working_directory: '/tmp/new',
      model: 'gpt-new',
      display_name: 'New session',
      updated_at: '2026-04-11T00:00:00.000Z',
      source: 'local-codex',
    });

    const sessions = store.listSessions({ limit: 2 });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, 'sess-new');
    assert.equal(sessions[1].id, 'sess-old');
  });

  it('upsertChannelBinding creates and updates for Telegram chats', () => {
    const store = new JsonFileStore(makeSettings());
    const b1 = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: 'tg-chat-1',
      codepilotSessionId: 'sess-1',
      sdkSessionId: 'sdk-1',
      workingDirectory: '/tmp',
      model: 'model-1',
    });
    assert.equal(b1.channelType, 'telegram');
    assert.equal(b1.sdkSessionId, 'sdk-1');

    const b2 = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: 'tg-chat-1',
      codepilotSessionId: 'sess-2',
      sdkSessionId: 'sdk-2',
      workingDirectory: '/tmp/new',
      model: 'model-2',
    });
    assert.equal(b2.id, b1.id);
    assert.equal(b2.codepilotSessionId, 'sess-2');
    assert.equal(b2.sdkSessionId, 'sdk-2');
  });

  it('keeps different Telegram topics as separate bindings inside the same group', () => {
    const store = new JsonFileStore(makeSettings());
    const topicA = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '-2000000002',
      topicId: '122',
      codepilotSessionId: 'sess-topic-a',
      workingDirectory: '/tmp/a',
      model: 'model-a',
    });
    const topicB = store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: '-2000000002',
      topicId: '3305',
      codepilotSessionId: 'sess-topic-b',
      workingDirectory: '/tmp/b',
      model: 'model-b',
    });

    assert.notEqual(topicA.id, topicB.id);
    assert.equal(store.getChannelBinding('telegram', '-2000000002', '122')?.codepilotSessionId, 'sess-topic-a');
    assert.equal(store.getChannelBinding('telegram', '-2000000002', '3305')?.codepilotSessionId, 'sess-topic-b');
  });

  it('listChannelBindings filters by type', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: 'tg-1',
      codepilotSessionId: 's1',
      workingDirectory: '/tmp',
      model: 'm',
    });
    store.upsertChannelBinding({
      channelType: 'other',
      chatId: 'other-1',
      codepilotSessionId: 's2',
      workingDirectory: '/tmp',
      model: 'm',
    });
    assert.equal(store.listChannelBindings('telegram').length, 1);
    assert.equal(store.listChannelBindings('other').length, 1);
    assert.equal(store.listChannelBindings().length, 2);
  });

  it('permission links round-trip and unresolved filter works', () => {
    const store = new JsonFileStore(makeSettings());
    store.insertPermissionLink({
      permissionRequestId: 'pr-a',
      channelType: 'telegram',
      chatId: 'tg-1',
      messageId: 'msg-a',
      toolName: 'Bash',
      suggestions: '',
    });
    store.insertPermissionLink({
      permissionRequestId: 'pr-b',
      channelType: 'telegram',
      chatId: 'tg-1',
      messageId: 'msg-b',
      toolName: 'Read',
      suggestions: '',
    });
    store.markPermissionLinkResolved('pr-a');
    const pending = store.listPendingPermissionLinksByChat('tg-1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].permissionRequestId, 'pr-b');
  });

  it('dedup insert and check within window', () => {
    const store = new JsonFileStore(makeSettings());
    assert.equal(store.checkDedup('key1'), false);
    store.insertDedup('key1');
    assert.equal(store.checkDedup('key1'), true);
  });

  it('insertAuditLog keeps bounded history without crashing', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 1010; i++) {
      store.insertAuditLog({
        channelType: 'telegram',
        chatId: 'tg-1',
        direction: 'inbound',
        messageId: `msg-${i}`,
        summary: `msg ${i}`,
      });
    }
  });

  it('addMessage appends to JSONL and getMessages reads them back consistently', () => {
    const store = new JsonFileStore(makeSettings());
    const sessionId = 'jsonl-session-1';
    store.addMessage(sessionId, 'user', 'hello');
    store.addMessage(sessionId, 'assistant', 'hi there');
    store.addMessage(sessionId, 'user', 'how are you?');

    const { messages } = store.getMessages(sessionId);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0], { role: 'user', content: 'hello' });
    assert.deepEqual(messages[2], { role: 'user', content: 'how are you?' });

    const jsonlPath = path.join(DATA_DIR, 'messages', `${sessionId}.jsonl`);
    assert.ok(fs.existsSync(jsonlPath), 'jsonl file should exist');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[1]), { role: 'assistant', content: 'hi there' });

    // A fresh store instance must read the same messages back via JSONL parsing.
    const store2 = new JsonFileStore(makeSettings());
    const reread = store2.getMessages(sessionId).messages;
    assert.equal(reread.length, 3);
    assert.deepEqual(reread[2], { role: 'user', content: 'how are you?' });
  });

  it('lazily migrates legacy .json messages array to .jsonl on first read', () => {
    const sessionId = 'legacy-session-1';
    const messagesDir = path.join(DATA_DIR, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const legacyPath = path.join(messagesDir, `${sessionId}.json`);
    const jsonlPath = path.join(messagesDir, `${sessionId}.jsonl`);
    const legacy = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ];
    fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2), 'utf-8');

    const store = new JsonFileStore(makeSettings());
    const { messages } = store.getMessages(sessionId);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0], { role: 'user', content: 'one' });
    assert.deepEqual(messages[1], { role: 'assistant', content: 'two' });

    // After migration: jsonl exists, legacy renamed (not deleted).
    assert.ok(fs.existsSync(jsonlPath), 'jsonl should exist after migration');
    assert.ok(!fs.existsSync(legacyPath), 'legacy .json should have been renamed');
    const dirEntries = fs.readdirSync(messagesDir);
    const safetyNet = dirEntries.find(
      (n) => n.startsWith(`${sessionId}.json.migrated-`),
    );
    assert.ok(safetyNet, 'safety-net renamed legacy file should exist');

    // New appends go to the jsonl too.
    store.addMessage(sessionId, 'user', 'three');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[2]), { role: 'user', content: 'three' });
  });

  it('tolerates corrupt JSONL lines by skipping them', () => {
    const sessionId = 'corrupt-session-1';
    const messagesDir = path.join(DATA_DIR, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const jsonlPath = path.join(messagesDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ role: 'user', content: 'good-1' }),
      '{not valid json',
      JSON.stringify({ role: 'assistant', content: 'good-2' }),
      '',
      JSON.stringify({ role: 'user', content: 'good-3' }),
    ];
    fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '));
    };
    try {
      const store = new JsonFileStore(makeSettings());
      const { messages } = store.getMessages(sessionId);
      assert.equal(messages.length, 3);
      assert.deepEqual(messages.map((m) => m.content), ['good-1', 'good-2', 'good-3']);
      assert.ok(
        warnings.some((w) => w.includes('corrupt JSONL line')),
        'should warn about the corrupt line',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('persists runtime status for session diagnostics', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertSession({
      id: 's1',
      working_directory: '/tmp/test-cwd',
      model: 'test-model',
      updated_at: '2026-05-17T00:00:00.000Z',
      source: 'bridge',
    });
    store.setSessionRuntimeStatus('s1', 'running');

    const status = store.getSessionRuntimeStatus('s1');
    assert.equal(status?.sessionId, 's1');
    assert.equal(status?.status, 'running');
    assert.ok(status?.updatedAt);

    const reloaded = new JsonFileStore(makeSettings());
    assert.equal(reloaded.getSessionRuntimeStatus('s1')?.status, 'running');
  });

  it('prunes runtime status records that no longer have a session', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertSession({
      id: 'active-session',
      working_directory: '/tmp/test-cwd',
      model: 'test-model',
      updated_at: '2026-05-17T00:00:00.000Z',
      source: 'bridge',
    });

    store.setSessionRuntimeStatus('active-session', 'running');
    store.setSessionRuntimeStatus('stale-session', 'running');

    assert.equal(store.getSessionRuntimeStatus('active-session')?.status, 'running');
    assert.equal(store.getSessionRuntimeStatus('stale-session'), null);
  });

  it('keeps a larger audit ring buffer for bridge incident diagnosis', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 5005; i += 1) {
      store.insertAuditLog({
        channelType: 'telegram',
        chatId: 'tg-1',
        direction: 'outbound',
        messageId: `m-${i}`,
        summary: `audit-${i}`,
      });
    }

    const auditPath = path.join(DATA_DIR, 'audit.json');
    const entries = JSON.parse(fs.readFileSync(auditPath, 'utf-8')) as Array<{ summary: string }>;
    assert.equal(entries.length, 5000);
    assert.equal(entries[0]?.summary, 'audit-5');
    assert.equal(entries.at(-1)?.summary, 'audit-5004');
  });

  it('persists sdk tasks per session and prunes when session is removed', () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertSession({
      id: 'active',
      working_directory: '/tmp/test-cwd',
      model: 'test-model',
      updated_at: '2026-05-17T00:00:00.000Z',
      source: 'bridge',
    });
    store.syncSdkTasks('active', [{ id: 'todo-1', text: 'do thing' }]);
    store.syncSdkTasks('stale', [{ id: 'todo-2' }]);

    const tasksPath = path.join(DATA_DIR, 'sdk-tasks.json');
    const onDisk = JSON.parse(fs.readFileSync(tasksPath, 'utf-8')) as Record<string, unknown>;
    assert.ok(onDisk['active'], 'active session tasks should be persisted');
    assert.equal(onDisk['stale'], undefined, 'stale-session tasks pruned at write time');
  });

  it('persists outbound refs and caps at 5000', () => {
    const store = new JsonFileStore(makeSettings());
    for (let i = 0; i < 5005; i += 1) {
      store.insertOutboundRef({
        channelType: 'telegram',
        chatId: 'tg-1',
        codepilotSessionId: 's1',
        platformMessageId: `m-${i}`,
        purpose: 'reply',
      });
    }

    const refsPath = path.join(DATA_DIR, 'outbound-refs.json');
    const entries = JSON.parse(fs.readFileSync(refsPath, 'utf-8')) as Array<{ platformMessageId: string }>;
    assert.equal(entries.length, 5000);
    assert.equal(entries[0]?.platformMessageId, 'm-5');
    assert.equal(entries.at(-1)?.platformMessageId, 'm-5004');
  });

  it('updateSdkSessionId updates session and bindings', () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'model', undefined, '/tmp');
    store.upsertChannelBinding({
      channelType: 'telegram',
      chatId: 'tg-1',
      codepilotSessionId: session.id,
      workingDirectory: '/tmp',
      model: 'model',
    });
    store.updateSdkSessionId(session.id, 'sdk-123');
    const binding = store.getChannelBinding('telegram', 'tg-1');
    assert.equal(binding?.sdkSessionId, 'sdk-123');
  });
});

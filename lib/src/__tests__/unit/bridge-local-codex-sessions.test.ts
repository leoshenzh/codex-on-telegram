import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  listLocalCodexSessions,
  updateLocalCodexSessionTitle,
} from '../../lib/bridge/local-codex-sessions.js';

describe('local Codex session title sync', () => {
  let tempDir: string;
  let sessionsRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-codex-title-'));
    sessionsRoot = path.join(tempDir, 'sessions');
    fs.mkdirSync(path.join(sessionsRoot, '2026', '04', '13'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSessionFile(sessionId: string): void {
    fs.writeFileSync(
      path.join(sessionsRoot, '2026', '04', '13', `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          id: sessionId,
          cwd: '/Users/example',
          source: 'cli',
          originator: 'codex_cli_rs',
          cli_version: '0.114.0',
        },
      })}\n`,
      'utf-8',
    );
  }

  it('updates the local Codex index title for an existing session', () => {
    const sessionId = '019d84a9-9ff4-7163-9fc5-ed8d73cc4bc8';
    writeSessionFile(sessionId);
    fs.writeFileSync(
      path.join(tempDir, 'session_index.jsonl'),
      `${JSON.stringify({
        id: sessionId,
        thread_name: 'Old title',
        updated_at: '2026-04-13T02:27:58.064Z',
      })}\n`,
      'utf-8',
    );

    const changed = updateLocalCodexSessionTitle(sessionId, 'Telegram · Team Codex', sessionsRoot);

    assert.equal(changed, true);
    const sessions = listLocalCodexSessions(5, sessionsRoot);
    assert.equal(sessions[0]?.displayName, 'Telegram · Team Codex');
  });

  it('creates a local Codex index entry when the session exists but has no title yet', () => {
    const sessionId = '019d84a5-9bd9-7223-9c0c-2b4bc39f1ccf';
    writeSessionFile(sessionId);

    const changed = updateLocalCodexSessionTitle(
      sessionId,
      'Telegram · Team Codex · Topic 4402',
      sessionsRoot,
    );

    assert.equal(changed, true);
    const sessions = listLocalCodexSessions(5, sessionsRoot);
    assert.equal(sessions[0]?.displayName, 'Telegram · Team Codex · Topic 4402');
  });

  it('appends a new title entry instead of rewriting the full recent-task index', () => {
    const sessionId = '019d84af-bdcd-7cd0-8a4a-fa512faed9fe';
    writeSessionFile(sessionId);

    const indexPath = path.join(tempDir, 'session_index.jsonl');
    fs.writeFileSync(
      indexPath,
      [
        JSON.stringify({
          id: sessionId,
          thread_name: 'Old title',
          updated_at: '2026-04-13T02:27:58.064Z',
        }),
        JSON.stringify({
          id: '019d84a9-9ff4-7163-9fc5-ed8d73cc4bc8',
          thread_name: 'Another task',
          updated_at: '2026-04-13T02:28:10.000Z',
        }),
      ].join('\n') + '\n',
      'utf-8',
    );

    const changed = updateLocalCodexSessionTitle(sessionId, 'Telegram · Team Codex', sessionsRoot);

    assert.equal(changed, true);
    const lines = fs.readFileSync(indexPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);
    const appended = JSON.parse(lines[2]!);
    assert.equal(appended.id, sessionId);
    assert.equal(appended.thread_name, 'Telegram · Team Codex');
    const sessions = listLocalCodexSessions(5, sessionsRoot);
    assert.equal(sessions.find(session => session.id === sessionId)?.displayName, 'Telegram · Team Codex');
  });
});

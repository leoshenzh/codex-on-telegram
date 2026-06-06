import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findLocalCodexSession,
  listLocalCodexSessions,
} from 'claude-to-im/src/lib/bridge/local-codex-sessions.js';

function writeSessionFile(rootDir: string, fileName: string, payload: Record<string, unknown>): string {
  const dayDir = path.join(rootDir, '2026', '04', '11');
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, fileName);
  const line = JSON.stringify({ type: 'session_meta', payload });
  fs.writeFileSync(filePath, `${line}\n`, 'utf-8');
  return filePath;
}

describe('local Codex session discovery', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('lists recent top-level local Codex sessions and filters subagents while keeping resumable exec runs', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-sessions-'));

    const primaryA = writeSessionFile(tempDir, 'rollout-a.jsonl', {
      id: '019d7a7d-e62f-7452-88d2-5e7cbc35ca12',
      timestamp: '2026-04-11T03:02:44.553Z',
      cwd: '/Users/example/project-a',
      originator: 'codex_cli_rs',
      cli_version: '0.114.0',
      source: 'cli',
    });
    const primaryB = writeSessionFile(tempDir, 'rollout-b.jsonl', {
      id: '019d7acb-aaaa-7e33-984d-1e25dc0e74ba',
      timestamp: '2026-04-11T04:30:00.000Z',
      cwd: '/Users/example/project-b',
      originator: 'Codex Desktop',
      cli_version: '0.114.0',
      source: 'vscode',
    });
    writeSessionFile(tempDir, 'rollout-subagent.jsonl', {
      id: '019d7aad-8ebc-7871-83a4-05de07b20370',
      timestamp: '2026-04-11T03:54:47.873Z',
      cwd: '/Users/example',
      originator: 'codex_cli_rs',
      cli_version: '0.114.0',
      source: { subagent: { thread_spawn: { depth: 1 } } },
      agent_role: 'explorer',
    });
    const execRun = writeSessionFile(tempDir, 'rollout-exec.jsonl', {
      id: '019d7ac2-001b-77a0-841f-7cbabffcc58d',
      timestamp: '2026-04-11T04:17:07.636Z',
      cwd: '/Users/example',
      originator: 'codex_exec',
      cli_version: '0.114.0',
      source: 'exec',
    });

    fs.utimesSync(primaryA, new Date('2026-04-11T04:01:00.000Z'), new Date('2026-04-11T04:01:00.000Z'));
    fs.utimesSync(primaryB, new Date('2026-04-11T04:31:00.000Z'), new Date('2026-04-11T04:31:00.000Z'));
    fs.utimesSync(execRun, new Date('2026-04-11T04:20:00.000Z'), new Date('2026-04-11T04:20:00.000Z'));

    const sessions = listLocalCodexSessions(10, tempDir);

    assert.deepEqual(
      sessions.map(session => session.id),
      [
        '019d7acb-aaaa-7e33-984d-1e25dc0e74ba',
        '019d7ac2-001b-77a0-841f-7cbabffcc58d',
        '019d7a7d-e62f-7452-88d2-5e7cbc35ca12',
      ],
    );
    assert.equal(sessions[0].workingDirectory, '/Users/example/project-b');
    assert.equal(sessions[0].source, 'vscode');
    assert.equal(sessions[1].source, 'exec');
    assert.equal(findLocalCodexSession('019d7a7d-e62f-7452-88d2-5e7cbc35ca12', tempDir)?.workingDirectory, '/Users/example/project-a');
  });

  it('uses session_index updated_at as the final recent-order source', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-local-sessions-order-'));

    const olderFile = writeSessionFile(tempDir, '019d7a7d-e62f-7452-88d2-5e7cbc35ca12.jsonl', {
      id: '019d7a7d-e62f-7452-88d2-5e7cbc35ca12',
      timestamp: '2026-04-11T01:00:00.000Z',
      cwd: '/Users/example/project-a',
      originator: 'codex_cli_rs',
      cli_version: '0.114.0',
      source: 'cli',
    });
    const newerFile = writeSessionFile(tempDir, '019d7acb-aaaa-7e33-984d-1e25dc0e74ba.jsonl', {
      id: '019d7acb-aaaa-7e33-984d-1e25dc0e74ba',
      timestamp: '2026-04-11T02:00:00.000Z',
      cwd: '/Users/example/project-b',
      originator: 'codex_cli_rs',
      cli_version: '0.114.0',
      source: 'cli',
    });

    fs.utimesSync(olderFile, new Date('2026-04-11T05:00:00.000Z'), new Date('2026-04-11T05:00:00.000Z'));
    fs.utimesSync(newerFile, new Date('2026-04-11T04:00:00.000Z'), new Date('2026-04-11T04:00:00.000Z'));

    const indexPath = path.join(tempDir, 'session_index.jsonl');
    fs.writeFileSync(indexPath, [
      JSON.stringify({
        id: '019d7a7d-e62f-7452-88d2-5e7cbc35ca12',
        thread_name: 'Actually newer by index',
        updated_at: '2026-04-11T06:00:00.000Z',
      }),
      JSON.stringify({
        id: '019d7acb-aaaa-7e33-984d-1e25dc0e74ba',
        thread_name: 'Actually older by index',
        updated_at: '2026-04-11T03:00:00.000Z',
      }),
    ].join('\n') + '\n', 'utf-8');

    const sessions = listLocalCodexSessions(10, tempDir);

    assert.deepEqual(
      sessions.map(session => session.id),
      ['019d7a7d-e62f-7452-88d2-5e7cbc35ca12', '019d7acb-aaaa-7e33-984d-1e25dc0e74ba'],
    );
    assert.equal(sessions[0].displayName, 'Actually newer by index');
    assert.equal(sessions[0].updatedAt, '2026-04-11T06:00:00.000Z');
  });
});

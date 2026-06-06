import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function withTempCodexHome(fn: (home: string) => Promise<void>): Promise<void> {
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const tempHome = path.join(tempParent, '.codex');
  fs.mkdirSync(tempHome, { recursive: true });
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tempHome;
  try {
    await fn(tempHome);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previous;
    }
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}

describe('local Codex session discovery', () => {
  it('reads recent sessions from the local Codex index and session files', async () => {
    await withTempCodexHome(async (home) => {
      const sessionsDir = path.join(home, 'sessions', '2026', '04', '11');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const sessionId = '019d7aa6-9798-75b3-a3cc-51c4c3fc5146';
      fs.writeFileSync(
        path.join(home, 'session_index.jsonl'),
        `${JSON.stringify({
          id: sessionId,
          thread_name: 'Review Sanity hardening',
          updated_at: '2026-04-11T03:47:35.551573Z',
        })}\n`,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(sessionsDir, `rollout-2026-04-11T03-47-35-${sessionId}.jsonl`),
        [
          JSON.stringify({
            type: 'session_meta',
            payload: { id: sessionId, cwd: '/Users/example/project-x' },
          }),
          JSON.stringify({
            type: 'turn_context',
            payload: { model: 'gpt-5.4' },
          }),
        ].join('\n'),
        'utf-8',
      );

      const { listLocalCodexSessions } = await import('../codex-local-sessions.js');
      const sessions = listLocalCodexSessions(5);

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, sessionId);
      assert.equal(sessions[0].sdk_session_id, sessionId);
      assert.equal(sessions[0].display_name, 'Review Sanity hardening');
      assert.equal(sessions[0].working_directory, '/Users/example/project-x');
      assert.equal(sessions[0].model, 'gpt-5.4');
      assert.equal(sessions[0].source, 'local-codex');
    });
  });
});

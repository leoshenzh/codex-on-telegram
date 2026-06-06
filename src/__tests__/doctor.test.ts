import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

describe('doctor.sh', () => {
  const tempHomes: string[] = [];

  afterEach(() => {
    for (const tempHome of tempHomes.splice(0)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('uses Codex runtime preflight instead of requiring a codex CLI on PATH', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-doctor-'));
    tempHomes.push(tempHome);
    fs.mkdirSync(path.join(tempHome, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, 'runtime'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'config.env'),
      [
        'export CTI_RUNTIME=codex',
        'export CTI_ENABLED_CHANNELS=telegram',
        'export CTI_TG_BOT_TOKEN=123456:telegram-token',
      ].join('\n'),
      'utf-8',
    );

    const nodeDir = path.dirname(process.execPath);
    const result = spawnSync('/bin/bash', ['scripts/doctor.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CTI_HOME: tempHome,
        PATH: `${nodeDir}:/usr/bin:/bin`,
      },
      encoding: 'utf-8',
    });

    assert.notEqual(result.status, null, result.stderr);
    assert.match(result.stdout, /\[OK\]\s+Codex runtime preflight/);
    assert.doesNotMatch(result.stdout, /Codex CLI available/);
  });

  it('fails when runtime data contains store-test fixture markers', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-doctor-contaminated-'));
    tempHomes.push(tempHome);
    fs.mkdirSync(path.join(tempHome, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tempHome, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'config.env'),
      [
        'export CTI_RUNTIME=codex',
        'export CTI_ENABLED_CHANNELS=telegram',
        'export CTI_TG_BOT_TOKEN=123456:telegram-token',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tempHome, 'data', 'sessions.json'),
      JSON.stringify({
        'd567d2b4-cbb4-4e2f-b0a2-6f8b0297a1e7': {
          id: 'd567d2b4-cbb4-4e2f-b0a2-6f8b0297a1e7',
          display_name: 'test',
          sdk_session_id: 'sdk-123',
        },
      }),
      'utf-8',
    );

    const nodeDir = path.dirname(process.execPath);
    const result = spawnSync('/bin/bash', ['scripts/doctor.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CTI_HOME: tempHome,
        PATH: `${nodeDir}:/usr/bin:/bin`,
      },
      encoding: 'utf-8',
    });

    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /\[FAIL\]\s+Runtime data not test-contaminated/);
  });
});

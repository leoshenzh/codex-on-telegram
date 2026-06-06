import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function runSupervisorPlistFixture(env: Record<string, string | undefined>) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-supervisor-'));
  const homeDir = path.join(tempDir, 'home');
  const ctiHome = path.join(tempDir, 'cti-home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(ctiHome, { recursive: true });
  fs.mkdirSync(path.join(ctiHome, 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(ctiHome, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(ctiHome, 'config.env'),
    [
      'export CTI_RUNTIME=claude',
      'export CTI_ENABLED_CHANNELS=telegram',
    ].join('\n'),
    'utf-8',
  );

  const result = spawnSync('/bin/bash', ['-lc', `
    set -euo pipefail
    export SKILL_DIR=${JSON.stringify(repoRoot)}
    export CTI_HOME=${JSON.stringify(ctiHome)}
    export HOME=${JSON.stringify(homeDir)}
    export PID_FILE=${JSON.stringify(path.join(ctiHome, 'runtime', 'bridge.pid'))}
    export STATUS_FILE=${JSON.stringify(path.join(ctiHome, 'runtime', 'status.json'))}
    export LOG_FILE=${JSON.stringify(path.join(ctiHome, 'logs', 'bridge.log'))}
    source "$SKILL_DIR/scripts/config-env.sh"
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    generate_plist
    cat "$PLIST_FILE"
  `], {
    env: {
      ...process.env,
      HOME: homeDir,
      CTI_HOME: ctiHome,
      ...env,
    },
    encoding: 'utf-8',
  });

  return { result, tempDir, homeDir, ctiHome };
}

describe('supervisor-macos.sh', () => {
  it('escapes XML-sensitive characters in forwarded environment values', () => {
    // USER is in the forward whitelist and is not re-exported by the test
    // harness's bash wrapper (HOME is, so we cannot use HOME here).
    const { result, tempDir } = runSupervisorPlistFixture({ USER: `a&b<c>d"e'f` });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        result.stdout,
        /<key>USER<\/key>\s*<string>a&amp;b&lt;c&gt;d&quot;e&apos;f<\/string>/,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not forward secrets (CTI_*, ANTHROPIC_*, OPENAI_API_KEY) into the plist', () => {
    const { result, tempDir } = runSupervisorPlistFixture({
      CTI_TG_BOT_TOKEN: '123:secret-bot-token-value',
      CTI_CODEX_API_KEY: 'sk-codex-secret',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-oai-secret',
    });
    try {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /CTI_TG_BOT_TOKEN/);
      assert.doesNotMatch(result.stdout, /CTI_CODEX_API_KEY/);
      assert.doesNotMatch(result.stdout, /ANTHROPIC_API_KEY/);
      assert.doesNotMatch(result.stdout, /OPENAI_API_KEY/);
      assert.doesNotMatch(result.stdout, /secret-bot-token-value/);
      assert.doesNotMatch(result.stdout, /sk-codex-secret/);
      assert.doesNotMatch(result.stdout, /sk-ant-secret/);
      assert.doesNotMatch(result.stdout, /sk-oai-secret/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('writes the generated plist with mode 0600', () => {
    const { result, tempDir, ctiHome } = runSupervisorPlistFixture({});
    try {
      assert.equal(result.status, 0, result.stderr);
      // Locate the generated plist via $HOME/Library/LaunchAgents pattern used by supervisor-macos.sh
      const plistDir = path.join(path.dirname(ctiHome), 'home', 'Library', 'LaunchAgents');
      const files = fs.existsSync(plistDir) ? fs.readdirSync(plistDir).filter((f) => f.endsWith('.plist')) : [];
      assert.ok(files.length > 0, 'expected at least one generated plist');
      const mode = fs.statSync(path.join(plistDir, files[0]!)).mode & 0o777;
      assert.equal(mode, 0o600, `expected plist mode 0600, got 0${mode.toString(8)}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BridgeSession, BridgeStore } from 'claude-to-im/src/lib/bridge/host.js';

type SessionIndexEntry = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

type SessionFileMeta = {
  cwd?: string;
  model?: string;
};

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function sessionIndexPath(): string {
  return path.join(codexHome(), 'session_index.jsonl');
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions');
}

function readRecentIndexEntries(limit: number): SessionIndexEntry[] {
  const indexFile = sessionIndexPath();
  if (!fs.existsSync(indexFile)) return [];

  const lines = fs.readFileSync(indexFile, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const entries: SessionIndexEntry[] = [];
  for (const line of lines.slice(-Math.max(limit * 3, limit))) {
    try {
      const parsed = JSON.parse(line) as SessionIndexEntry;
      if (parsed.id) entries.push(parsed);
    } catch {
      // Ignore malformed lines from a partially written index entry.
    }
  }

  const deduped = new Map<string, SessionIndexEntry>();
  for (const entry of entries) {
    deduped.set(entry.id, entry);
  }

  return Array.from(deduped.values())
    .sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0))
    .slice(0, limit);
}

function findSessionFile(sessionId: string): string | null {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;

  const stack = [root];
  const expectedSuffix = `${sessionId}.jsonl`;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(expectedSuffix)) {
        return entryPath;
      }
    }
  }

  return null;
}

function readSessionFileMeta(sessionFile: string): SessionFileMeta {
  const meta: SessionFileMeta = {};
  try {
    const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (record.type === 'session_meta') {
        const cwd = record.payload?.cwd;
        if (typeof cwd === 'string' && cwd) meta.cwd = cwd;
      }
      if (record.type === 'turn_context') {
        const model = record.payload?.model;
        if (typeof model === 'string' && model) meta.model = model;
      }
      if (meta.cwd && meta.model) break;
    }
  } catch {
    // Ignore unreadable or partially written sessions.
  }
  return meta;
}

export function listLocalCodexSessions(limit: number = 12): BridgeSession[] {
  const indexEntries = readRecentIndexEntries(limit);
  return indexEntries.map((entry) => {
    const sessionFile = findSessionFile(entry.id);
    const meta = sessionFile ? readSessionFileMeta(sessionFile) : {};
    return {
      id: entry.id,
      sdk_session_id: entry.id,
      display_name: entry.thread_name || `Codex session ${entry.id.slice(0, 8)}`,
      updated_at: entry.updated_at || new Date(0).toISOString(),
      working_directory: meta.cwd || '',
      model: meta.model || '',
      source: 'local-codex',
    };
  });
}

export function syncLocalCodexSessions(store: BridgeStore, limit: number = 40): BridgeSession[] {
  const sessions = listLocalCodexSessions(limit);
  for (const session of sessions) {
    store.upsertSession(session);
  }
  return sessions;
}

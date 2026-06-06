import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SCAN_FILES = 400;
const RECENT_PROGRESS_LINE_WINDOW = 400;
const ACTIVE_PROGRESS_WINDOW_MS = 10 * 60 * 1000;

type SessionIndexEntry = {
  id: string;
  thread_name?: string;
  updated_at?: string;
};

export interface LocalCodexSession {
  id: string;
  workingDirectory: string;
  updatedAt: string;
  source: string;
  originator: string;
  cliVersion: string;
  displayName?: string;
}

interface SessionFileInfo {
  filePath: string;
  mtimeMs: number;
}

export interface LocalCodexProgressSnapshot {
  sessionId: string;
  workingDirectory: string;
  updatedAt: string;
  displayName?: string;
  progressText: string;
  isActive: boolean;
}

function getSessionsRoot(rootDir?: string): string {
  return rootDir
    || process.env.CTI_CODEX_SESSIONS_ROOT
    || path.join(os.homedir(), '.codex', 'sessions');
}

function getSessionIndexPath(rootDir?: string): string {
  const sessionsRoot = getSessionsRoot(rootDir);
  const siblingIndex = path.join(path.dirname(sessionsRoot), 'session_index.jsonl');
  if (fs.existsSync(siblingIndex)) {
    return siblingIndex;
  }
  return path.join(sessionsRoot, 'session_index.jsonl');
}

function readSessionIndex(rootDir?: string): Map<string, SessionIndexEntry> {
  const indexPath = getSessionIndexPath(rootDir);
  if (!fs.existsSync(indexPath)) return new Map();

  let raw: string;
  try {
    raw = fs.readFileSync(indexPath, 'utf-8');
  } catch {
    return new Map();
  }

  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-MAX_SCAN_FILES * 4);

  const entries = new Map<string, SessionIndexEntry>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as SessionIndexEntry;
      if (typeof parsed.id === 'string' && parsed.id) {
        entries.set(parsed.id, parsed);
      }
    } catch {
      continue;
    }
  }

  return entries;
}

function appendSessionIndexEntry(entry: SessionIndexEntry, rootDir?: string): void {
  const indexPath = getSessionIndexPath(rootDir);
  const parentDir = path.dirname(indexPath);
  fs.mkdirSync(parentDir, { recursive: true });

  fs.appendFileSync(indexPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

function collectSessionFiles(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function sessionIdFromFilePath(filePath: string): string | null {
  const base = path.basename(filePath);
  if (!base.endsWith('.jsonl')) return null;
  return base.slice(0, -'.jsonl'.length) || null;
}

function findSessionFilePath(sessionId: string, rootDir?: string): string | null {
  const sessionsRoot = getSessionsRoot(rootDir);
  if (!fs.existsSync(sessionsRoot)) return null;

  const expectedSuffix = `${sessionId}.jsonl`;
  const stack = [sessionsRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(expectedSuffix)) {
        return fullPath;
      }
    }
  }

  return null;
}

function isPrimaryCodexSession(payload: Record<string, unknown>): boolean {
  if (!payload.id || !payload.cwd || typeof payload.id !== 'string' || typeof payload.cwd !== 'string') {
    return false;
  }

  const source = payload.source;
  if (source && typeof source === 'object' && 'subagent' in source) {
    return false;
  }

  if (typeof payload.agent_role === 'string' && payload.agent_role.trim() !== '') {
    return false;
  }

  return true;
}

function readSessionMeta(filePath: string): LocalCodexSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
      if (parsed.type !== 'session_meta' || !parsed.payload) continue;
      if (!isPrimaryCodexSession(parsed.payload)) return null;

      const stat = fs.statSync(filePath);
      return {
        id: parsed.payload.id as string,
        workingDirectory: parsed.payload.cwd as string,
        updatedAt: stat.mtime.toISOString(),
        source: typeof parsed.payload.source === 'string' ? parsed.payload.source : 'unknown',
        originator: typeof parsed.payload.originator === 'string' ? parsed.payload.originator : 'unknown',
        cliVersion: typeof parsed.payload.cli_version === 'string' ? parsed.payload.cli_version : '',
      };
    } catch {
      continue;
    }
  }

  return null;
}

function readRecentSessionRecords(filePath: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-RECENT_PROGRESS_LINE_WINDOW);

  const records: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

function extractCommentaryText(record: Record<string, unknown>): string {
  if (record.type === 'event_msg') {
    const payload = record.payload;
    if (
      payload
      && typeof payload === 'object'
      && (payload as Record<string, unknown>).type === 'agent_message'
      && typeof (payload as Record<string, unknown>).message === 'string'
    ) {
      return ((payload as Record<string, unknown>).message as string).trim();
    }
    return '';
  }

  if (record.type !== 'response_item') return '';
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return '';
  const payloadRecord = payload as Record<string, unknown>;
  if (
    payloadRecord.type !== 'message'
    || payloadRecord.role !== 'assistant'
    || payloadRecord.phase !== 'commentary'
    || !Array.isArray(payloadRecord.content)
  ) {
    return '';
  }

  const text = payloadRecord.content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const contentItem = item as Record<string, unknown>;
      return contentItem.type === 'output_text' && typeof contentItem.text === 'string'
        ? contentItem.text
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();

  return text;
}

function isTerminalRecord(record: Record<string, unknown>): boolean {
  if (record.type === 'turn.completed' || record.type === 'turn.failed' || record.type === 'error') {
    return true;
  }
  if (record.type !== 'event_msg') return false;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return false;
  const payloadType = (payload as Record<string, unknown>).type;
  return payloadType === 'turn.completed' || payloadType === 'turn.failed' || payloadType === 'error';
}

function scanLocalCodexSessions(rootDir?: string): LocalCodexSession[] {
  const sessionsRoot = getSessionsRoot(rootDir);
  const indexEntries = readSessionIndex(rootDir);
  const files = collectSessionFiles(sessionsRoot)
    .map(filePath => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const filesBySessionId = new Map<string, SessionFileInfo>();
  for (const file of files) {
    const sessionId = sessionIdFromFilePath(file.filePath);
    if (!sessionId || filesBySessionId.has(sessionId)) continue;
    filesBySessionId.set(sessionId, file);
  }

  const orderedIndexEntries = Array.from(indexEntries.values()).sort((a, b) => {
    const aTime = Date.parse(a.updated_at || '') || 0;
    const bTime = Date.parse(b.updated_at || '') || 0;
    return bTime - aTime;
  });

  const sessions: LocalCodexSession[] = [];
  const seen = new Set<string>();

  const pushSession = (meta: LocalCodexSession, indexEntry?: SessionIndexEntry): void => {
    if (seen.has(meta.id)) return;
    if (indexEntry?.thread_name) {
      meta.displayName = indexEntry.thread_name;
    }
    if (indexEntry?.updated_at) {
      meta.updatedAt = indexEntry.updated_at;
    }
    seen.add(meta.id);
    sessions.push(meta);
  };

  for (const indexEntry of orderedIndexEntries) {
    const file = filesBySessionId.get(indexEntry.id);
    if (!file) continue;
    const meta = readSessionMeta(file.filePath);
    if (!meta) continue;
    pushSession(meta, indexEntry);
    if (sessions.length >= MAX_SCAN_FILES) {
      return sessions;
    }
  }

  for (const { filePath } of files) {
    const meta = readSessionMeta(filePath);
    if (!meta) continue;
    pushSession(meta, indexEntries.get(meta.id));
    if (sessions.length >= MAX_SCAN_FILES) {
      return sessions;
    }
  }

  return sessions;
}

export function listLocalCodexSessions(limit = 10, rootDir?: string): LocalCodexSession[] {
  const sessions = scanLocalCodexSessions(rootDir).sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || '') || 0;
    const bTime = Date.parse(b.updatedAt || '') || 0;
    return bTime - aTime;
  });
  return sessions.slice(0, limit);
}

export function findLocalCodexSessionsByPrefix(
  prefix: string,
  limit = 20,
  rootDir?: string,
): LocalCodexSession[] {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!normalizedPrefix) return [];

  const sessionsRoot = getSessionsRoot(rootDir);
  const indexEntries = readSessionIndex(rootDir);
  const files = collectSessionFiles(sessionsRoot)
    .map(filePath => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const matches: LocalCodexSession[] = [];
  const seen = new Set<string>();

  for (const { filePath } of files) {
    const meta = readSessionMeta(filePath);
    if (!meta) continue;
    if (seen.has(meta.id) || !meta.id.toLowerCase().startsWith(normalizedPrefix)) continue;

    const indexEntry = indexEntries.get(meta.id);
    if (indexEntry?.thread_name) {
      meta.displayName = indexEntry.thread_name;
    }
    if (indexEntry?.updated_at) {
      meta.updatedAt = indexEntry.updated_at;
    }

    seen.add(meta.id);
    matches.push(meta);
    if (matches.length >= limit) break;
  }

  return matches.sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || '') || 0;
    const bTime = Date.parse(b.updatedAt || '') || 0;
    return bTime - aTime;
  });
}

export function findLocalCodexSession(sessionId: string, rootDir?: string): LocalCodexSession | null {
  const sessions = scanLocalCodexSessions(rootDir);
  return sessions.find(session => session.id === sessionId) || null;
}

export function updateLocalCodexSessionTitle(
  sessionId: string,
  title: string,
  rootDir?: string,
): boolean {
  const normalizedSessionId = sessionId.trim();
  const normalizedTitle = title.trim();
  if (!normalizedSessionId || !normalizedTitle) return false;

  const indexPath = getSessionIndexPath(rootDir);
  const existing = fs.existsSync(indexPath) ? readSessionIndex(rootDir) : new Map<string, SessionIndexEntry>();
  const current = existing.get(normalizedSessionId);

  if (current?.thread_name === normalizedTitle) {
    return false;
  }

  existing.set(normalizedSessionId, {
    id: normalizedSessionId,
    thread_name: normalizedTitle,
    updated_at: current?.updated_at || new Date().toISOString(),
  });

  appendSessionIndexEntry(existing.get(normalizedSessionId)!, rootDir);
  return true;
}

export function getLocalCodexProgressSnapshot(sessionId: string, rootDir?: string): LocalCodexProgressSnapshot | null {
  const filePath = findSessionFilePath(sessionId, rootDir);
  if (!filePath) return null;

  const meta = readSessionMeta(filePath);
  if (!meta) return null;

  const records = readRecentSessionRecords(filePath);
  let latestCommentary = '';
  let latestSignal: 'commentary' | 'terminal' | '' = '';

  for (let idx = records.length - 1; idx >= 0; idx -= 1) {
    const record = records[idx]!;
    const commentary = extractCommentaryText(record);
    if (!latestCommentary && commentary) {
      latestCommentary = commentary;
    }
    if (!latestSignal) {
      if (commentary) {
        latestSignal = 'commentary';
      } else if (isTerminalRecord(record)) {
        latestSignal = 'terminal';
      }
    }
    if (latestCommentary && latestSignal) break;
  }

  const stat = fs.statSync(filePath);
  const isRecentlyUpdated = Date.now() - stat.mtimeMs <= ACTIVE_PROGRESS_WINDOW_MS;

  return {
    sessionId: meta.id,
    workingDirectory: meta.workingDirectory,
    updatedAt: stat.mtime.toISOString(),
    displayName: meta.displayName,
    progressText: latestCommentary,
    isActive: isRecentlyUpdated && latestSignal !== 'terminal',
  };
}

/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  RuntimeStatusRecord,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import type { ChannelBinding, ChannelType } from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

type TopicAwareBindingInput = UpsertChannelBindingInput & { topicId?: string };
type TopicAwareBinding = ChannelBinding & { topicId?: string };

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const RUNTIME_STATUS_PATH = path.join(DATA_DIR, 'runtime-status.json');
const SDK_TASKS_PATH = path.join(DATA_DIR, 'sdk-tasks.json');
const OUTBOUND_REFS_PATH = path.join(DATA_DIR, 'outbound-refs.json');
const MAX_AUDIT_RECORDS = 5000;
const MAX_RUNTIME_STATUS_RECORDS = 1000;
const MAX_OUTBOUND_REFS = 5000;

// ── Helpers ──

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort: existing user-only runtime state should stay private.
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort.
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function bindingKey(channelType: string, chatId: string, topicId?: string): string {
  return topicId ? `${channelType}:${chatId}:topic:${topicId}` : `${channelType}:${chatId}`;
}

// ── Lock entry ──

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

// ── Store ──

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];
  private runtimeStatuses = new Map<string, RuntimeStatusRecord>();
  private sdkTasks = new Map<string, unknown>();
  private outboundRefs: Array<OutboundRefInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  // ── Persistence ──

  private loadAll(): void {
    // Sessions
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    // Bindings
    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [key, b] of Object.entries(bindings)) {
      this.bindings.set(key, b);
    }

    // Permission links
    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    // Offsets
    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    // Dedup
    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    // Audit
    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);

    // Runtime status
    const runtimeStatuses = readJson<Record<string, RuntimeStatusRecord>>(
      RUNTIME_STATUS_PATH,
      {},
    );
    for (const [sessionId, status] of Object.entries(runtimeStatuses)) {
      this.runtimeStatuses.set(sessionId, status);
    }
    this.pruneRuntimeStatuses();

    // SDK tasks
    const sdkTasks = readJson<Record<string, unknown>>(SDK_TASKS_PATH, {});
    for (const [sessionId, todos] of Object.entries(sdkTasks)) {
      this.sdkTasks.set(sessionId, todos);
    }
    this.pruneSdkTasks();

    // Outbound refs
    this.outboundRefs = readJson(OUTBOUND_REFS_PATH, []);
  }

  private persistSessions(): void {
    writeJson(
      path.join(DATA_DIR, 'sessions.json'),
      Object.fromEntries(this.sessions),
    );
  }

  private persistBindings(): void {
    writeJson(
      path.join(DATA_DIR, 'bindings.json'),
      Object.fromEntries(this.bindings),
    );
  }

  private persistPermissions(): void {
    writeJson(
      path.join(DATA_DIR, 'permissions.json'),
      Object.fromEntries(this.permissionLinks),
    );
  }

  private persistOffsets(): void {
    writeJson(
      path.join(DATA_DIR, 'offsets.json'),
      Object.fromEntries(this.offsets),
    );
  }

  private persistDedup(): void {
    writeJson(
      path.join(DATA_DIR, 'dedup.json'),
      Object.fromEntries(this.dedupKeys),
    );
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistRuntimeStatuses(): void {
    writeJson(RUNTIME_STATUS_PATH, Object.fromEntries(this.runtimeStatuses));
  }

  private pruneRuntimeStatuses(): void {
    if (this.sessions.size > 0) {
      for (const sessionId of this.runtimeStatuses.keys()) {
        if (!this.sessions.has(sessionId)) {
          this.runtimeStatuses.delete(sessionId);
        }
      }
    }

    if (this.runtimeStatuses.size <= MAX_RUNTIME_STATUS_RECORDS) return;

    const keep = new Set(
      Array.from(this.runtimeStatuses.values())
        .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))
        .slice(0, MAX_RUNTIME_STATUS_RECORDS)
        .map((status) => status.sessionId),
    );
    for (const sessionId of this.runtimeStatuses.keys()) {
      if (!keep.has(sessionId)) {
        this.runtimeStatuses.delete(sessionId);
      }
    }
  }

  private persistSdkTasks(): void {
    writeJson(SDK_TASKS_PATH, Object.fromEntries(this.sdkTasks));
  }

  private pruneSdkTasks(): void {
    if (this.sessions.size === 0) return;
    for (const sessionId of this.sdkTasks.keys()) {
      if (!this.sessions.has(sessionId)) {
        this.sdkTasks.delete(sessionId);
      }
    }
  }

  private persistOutboundRefs(): void {
    writeJson(OUTBOUND_REFS_PATH, this.outboundRefs);
  }

  private messagesJsonlPath(sessionId: string): string {
    return path.join(MESSAGES_DIR, `${sessionId}.jsonl`);
  }

  private messagesLegacyJsonPath(sessionId: string): string {
    return path.join(MESSAGES_DIR, `${sessionId}.json`);
  }

  /**
   * Append a single message to disk as one JSONL line.
   * Each call performs exactly one fs.appendFileSync, so the line either
   * lands in full or not at all (no partial-message truncation in practice).
   */
  private appendMessageToDisk(sessionId: string, msg: BridgeMessage): void {
    const line = JSON.stringify(msg) + '\n';
    fs.appendFileSync(this.messagesJsonlPath(sessionId), line, 'utf-8');
    try {
      fs.chmodSync(this.messagesJsonlPath(sessionId), 0o600);
    } catch {
      // Best effort.
    }
  }

  /**
   * Lazy migration: if the legacy `<sessionId>.json` array exists and the new
   * `.jsonl` does not, parse the array, write each entry as a JSONL line, and
   * rename the legacy file to `.json.migrated-<date>` as a safety net.
   *
   * Triggered on first loadMessages() for the session. Returns the migrated
   * messages so the caller can hydrate the in-memory cache.
   */
  private migrateLegacyMessagesIfNeeded(sessionId: string): BridgeMessage[] | null {
    const jsonlPath = this.messagesJsonlPath(sessionId);
    const legacyPath = this.messagesLegacyJsonPath(sessionId);
    if (fs.existsSync(jsonlPath)) return null;
    if (!fs.existsSync(legacyPath)) return null;

    let legacy: BridgeMessage[] = [];
    try {
      const raw = fs.readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) legacy = parsed as BridgeMessage[];
    } catch (err) {
      console.warn(
        `[store] failed to parse legacy messages file ${legacyPath}: ${(err as Error).message}`,
      );
      return null;
    }

    const body = legacy.map((m) => JSON.stringify(m)).join('\n') + (legacy.length ? '\n' : '');
    fs.writeFileSync(jsonlPath, body, 'utf-8');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.renameSync(legacyPath, `${legacyPath}.migrated-${stamp}`);
    } catch (err) {
      console.warn(
        `[store] migrated ${legacyPath} but failed to rename safety net: ${(err as Error).message}`,
      );
    }
    return legacy;
  }

  /**
   * Read all messages for a session from disk, tolerant of partial corruption:
   * a single bad line is logged and skipped rather than killing the whole load.
   */
  private readMessagesFromJsonl(sessionId: string): BridgeMessage[] {
    const jsonlPath = this.messagesJsonlPath(sessionId);
    let raw: string;
    try {
      raw = fs.readFileSync(jsonlPath, 'utf-8');
    } catch {
      return [];
    }
    const out: BridgeMessage[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as BridgeMessage);
      } catch {
        console.warn(
          `[store] skipping corrupt JSONL line ${i + 1} in ${jsonlPath}`,
        );
      }
    }
    return out;
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const migrated = this.migrateLegacyMessagesIfNeeded(sessionId);
    const msgs = migrated ?? this.readMessagesFromJsonl(sessionId);
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  // ── Settings ──

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  // ── Channel Bindings ──

  getChannelBinding(channelType: string, chatId: string, topicId?: string): ChannelBinding | null {
    return this.bindings.get(bindingKey(channelType, chatId, topicId)) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const input = data as TopicAwareBindingInput;
    const key = bindingKey(input.channelType, input.chatId, input.topicId);
    const existing = this.bindings.get(key);
    if (existing) {
      const updated: TopicAwareBinding = {
        ...existing,
        codepilotSessionId: input.codepilotSessionId,
        sessionSource: input.sessionSource ?? existing.sessionSource ?? 'bridge',
        sdkSessionId: input.sdkSessionId ?? existing.sdkSessionId,
        workingDirectory: input.workingDirectory,
        model: input.model,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }
    const binding: TopicAwareBinding = {
      id: uuid(),
      channelType: input.channelType,
      chatId: input.chatId,
      topicId: input.topicId,
      codepilotSessionId: input.codepilotSessionId,
      sessionSource: input.sessionSource || 'bridge',
      sdkSessionId: input.sdkSessionId || '',
      workingDirectory: input.workingDirectory,
      model: input.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, b] of this.bindings) {
      if (b.id === id) {
        this.bindings.set(key, { ...b, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((b) => b.channelType === channelType);
  }

  // ── Sessions ──

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  listSessions(opts?: { limit?: number }): BridgeSession[] {
    const sessions = Array.from(this.sessions.values()).sort((a, b) => {
      const aTime = Date.parse(a.updated_at || '') || 0;
      const bTime = Date.parse(b.updated_at || '') || 0;
      return bTime - aTime;
    });
    if (opts?.limit && opts.limit > 0) {
      return sessions.slice(0, opts.limit);
    }
    return sessions;
  }

  upsertSession(session: BridgeSession): BridgeSession {
    const existing = this.sessions.get(session.id);
    const nextSession: BridgeSession = {
      ...existing,
      ...session,
      updated_at: session.updated_at || existing?.updated_at || now(),
    };
    this.sessions.set(nextSession.id, nextSession);
    this.persistSessions();
    return nextSession;
  }

  createSession(
    name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session = this.upsertSession({
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
      display_name: name,
      updated_at: now(),
      source: 'bridge',
    });
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.provider_id = providerId;
      this.persistSessions();
    }
  }

  // ── Messages ──

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const msgs = this.loadMessages(sessionId);
    const msg: BridgeMessage = { role, content };
    msgs.push(msg);
    this.appendMessageToDisk(sessionId, msg);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: msgs.slice(-opts.limit) };
    }
    return { messages: [...msgs] };
  }

  // ── Session Locking ──

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      // Lock held by someone else
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(sessionId: string, status: string): void {
    this.runtimeStatuses.set(sessionId, {
      sessionId,
      status,
      updatedAt: now(),
    });
    this.pruneRuntimeStatuses();
    this.persistRuntimeStatuses();
  }

  getSessionRuntimeStatus(sessionId: string): RuntimeStatusRecord | null {
    return this.runtimeStatuses.get(sessionId) ?? null;
  }

  // ── SDK Session ──

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      // Store sdkSessionId on the session object
      (s as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    // Also update any bindings that reference this session
    for (const [key, b] of this.bindings) {
      if (b.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...b, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(sessionId: string, todos: unknown): void {
    this.sdkTasks.set(sessionId, todos);
    this.pruneSdkTasks();
    this.persistSdkTasks();
  }

  // ── Provider ──

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  // ── Audit & Dedup ──

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    // Ring buffer: keep enough history for multi-turn bridge incident diagnosis.
    if (this.auditLog.length > MAX_AUDIT_RECORDS) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_RECORDS);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const ts = this.dedupKeys.get(key);
    if (ts === undefined) return false;
    // 5 minute window
    if (Date.now() - ts > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, ts] of this.dedupKeys) {
      if (ts < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(ref: OutboundRefInput): void {
    this.outboundRefs.push({
      ...ref,
      id: uuid(),
      createdAt: now(),
    });
    if (this.outboundRefs.length > MAX_OUTBOUND_REFS) {
      this.outboundRefs = this.outboundRefs.slice(-MAX_OUTBOUND_REFS);
    }
    this.persistOutboundRefs();
  }

  // ── Permission Links ──

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  // ── Channel Offsets ──

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}

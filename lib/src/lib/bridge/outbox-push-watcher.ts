/**
 * Outbox Push Watcher — polls each bound working directory's
 * `.codepilot-outbox/push/` subdir and pushes new files back to the
 * matching Telegram (or other-channel) binding(s).
 *
 * This gives long-running background tasks an async channel to deliver
 * results back to the originating chat without going through the
 * conversation loop. Files are read once they look stable (two
 * consecutive polls with identical mtime), then dispatched per file
 * extension:
 *   - `.txt` / `.md` -> UTF-8 text body, truncated at 4000 chars
 *   - anything else  -> file attachment via the adapter's `sendFile`
 *
 * After a successful send, the file moves to `push/.sent/`. After three
 * consecutive failed sends, it moves to `push/.failed/`. Files in
 * working dirs that no binding currently points to are left untouched
 * and a warning is logged each scan so the operator can investigate.
 *
 * The watcher is purely polling-based (no `fs.watch` / `chokidar`) so
 * it stays predictable across mac filesystem quirks and remote mounts.
 */

import fs from 'fs';
import path from 'path';
import type { BaseChannelAdapter } from './channel-adapter.js';
import type { ChannelBinding } from './types.js';
import { getBridgeContext } from './context.js';
import { deliver } from './delivery-layer.js';

const PUSH_SUBDIR = '.codepilot-outbox/push';
const SENT_SUBDIR = '.sent';
const FAILED_SUBDIR = '.failed';
const MAX_TEXT_CHARS = 4000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_POLL_MS = 5000;
const TEXT_EXTENSIONS = new Set(['.txt', '.md']);

interface SeenFileState {
  firstSeenAt: number;
  lastMtimeMs: number;
}

interface OutboxPushWatcherDeps {
  /** Returns the adapters currently registered with the bridge manager. */
  getAdapters: () => BaseChannelAdapter[];
}

interface OutboxPushWatcherHandle {
  stop: () => void;
}

let activeHandle: OutboxPushWatcherHandle | null = null;

export function isOutboxPushWatcherEnabled(): boolean {
  const raw = process.env.CTI_OUTBOX_PUSH_ENABLED;
  if (raw === undefined || raw === null || raw === '') return true;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

export function getOutboxPushPollMs(): number {
  const raw = process.env.CTI_OUTBOX_PUSH_POLL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_POLL_MS;
}

/**
 * Start the watcher. Idempotent — if a watcher is already running it
 * returns the existing handle.
 */
export function startOutboxPushWatcher(deps: OutboxPushWatcherDeps): OutboxPushWatcherHandle | null {
  if (!isOutboxPushWatcherEnabled()) {
    console.log('[outbox-push-watcher] disabled via CTI_OUTBOX_PUSH_ENABLED');
    return null;
  }
  if (activeHandle) return activeHandle;

  const pollMs = getOutboxPushPollMs();
  const seen = new Map<string, SeenFileState>();
  const failures = new Map<string, number>();
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await scanOnce(deps.getAdapters(), seen, failures);
    } catch (error) {
      console.error('[outbox-push-watcher] tick failed:', error instanceof Error ? error.message : error);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref?.();

  // Kick off an immediate first scan so freshly dropped files don't have
  // to wait a full poll interval before stability tracking starts.
  setImmediate(() => { void tick(); });

  const handle: OutboxPushWatcherHandle = {
    stop: () => {
      clearInterval(timer);
      seen.clear();
      failures.clear();
      if (activeHandle === handle) {
        activeHandle = null;
      }
    },
  };
  activeHandle = handle;
  console.log(`[outbox-push-watcher] started (poll ${pollMs}ms)`);
  return handle;
}

export function stopOutboxPushWatcher(): void {
  activeHandle?.stop();
}

/** @internal — exposed for unit tests so they can drive deterministic ticks. */
export async function _testOnly_scanOnce(
  adapters: BaseChannelAdapter[],
  seen: Map<string, SeenFileState>,
  failures: Map<string, number>,
): Promise<void> {
  await scanOnce(adapters, seen, failures);
}

async function scanOnce(
  adapters: BaseChannelAdapter[],
  seen: Map<string, SeenFileState>,
  failures: Map<string, number>,
): Promise<void> {
  const { store } = getBridgeContext();
  const bindings = store.listChannelBindings();
  if (bindings.length === 0) return;

  const bindingsByDir = groupBindingsByWorkDir(bindings);

  for (const [workDir, dirBindings] of bindingsByDir) {
    const pushDir = path.join(workDir, PUSH_SUBDIR);
    // Refuse to follow symlinks at the push-dir level. A symlinked
    // push/ could point at any directory the daemon has read access to
    // and let a planted file there get exfiltrated to Telegram.
    try {
      const pushLstat = fs.lstatSync(pushDir);
      if (pushLstat.isSymbolicLink()) {
        console.warn(`[outbox-push-watcher] Skipping symlink: ${pushDir}`);
        continue;
      }
    } catch (error) {
      // ENOENT is normal — the working dir may simply not have started
      // emitting files yet. Anything else falls through to readdirSync
      // below which surfaces the real error.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[outbox-push-watcher] lstat failed for ${pushDir}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(pushDir);
    } catch (error) {
      // Directory does not exist yet — that's normal. Other errors get
      // logged so operators can spot permission issues.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `[outbox-push-watcher] readdir failed for ${pushDir}:`,
          error instanceof Error ? error.message : error,
        );
      }
      continue;
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const absPath = path.join(pushDir, name);
      // Reject symlink entries before any stat/read. fs.statSync follows
      // symlinks, so without this a malicious actor with write access to
      // push/ could plant `report.txt -> ~/.ssh/id_rsa` and the
      // watcher would dutifully send the secret over Telegram.
      try {
        const lstat = fs.lstatSync(absPath);
        if (lstat.isSymbolicLink()) {
          console.warn(`[outbox-push-watcher] Skipping symlink: ${absPath}`);
          seen.delete(absPath);
          continue;
        }
      } catch {
        seen.delete(absPath);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        seen.delete(absPath);
        continue;
      }
      if (!stat.isFile()) continue;

      const prior = seen.get(absPath);
      if (!prior || prior.lastMtimeMs !== stat.mtimeMs) {
        seen.set(absPath, { firstSeenAt: Date.now(), lastMtimeMs: stat.mtimeMs });
        continue;
      }

      // mtime stable across at least two polls — dispatch.
      await dispatchFile(absPath, name, stat, dirBindings, adapters, seen, failures);
    }
  }
}

function groupBindingsByWorkDir(bindings: ChannelBinding[]): Map<string, ChannelBinding[]> {
  const grouped = new Map<string, ChannelBinding[]>();
  for (const binding of bindings) {
    if (!binding.workingDirectory) continue;
    const key = path.resolve(binding.workingDirectory);
    const list = grouped.get(key) || [];
    list.push(binding);
    grouped.set(key, list);
  }
  return grouped;
}

async function dispatchFile(
  absPath: string,
  fileName: string,
  stat: fs.Stats,
  bindings: ChannelBinding[],
  adapters: BaseChannelAdapter[],
  seen: Map<string, SeenFileState>,
  failures: Map<string, number>,
): Promise<void> {
  if (bindings.length === 0) {
    console.warn(`[outbox-push-watcher] no binding for ${absPath}, leaving in place`);
    return;
  }

  if (stat.size === 0) {
    console.warn(`[outbox-push-watcher] empty file ${absPath}, skipping`);
    seen.delete(absPath);
    return;
  }

  const ext = path.extname(fileName).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(ext);

  let textBody: string | null = null;
  if (isText) {
    try {
      textBody = fs.readFileSync(absPath, 'utf-8');
    } catch (error) {
      console.warn(
        `[outbox-push-watcher] failed to read text file ${absPath}:`,
        error instanceof Error ? error.message : error,
      );
      recordFailure(absPath, fileName, seen, failures);
      return;
    }
    if (textBody.length > MAX_TEXT_CHARS) {
      textBody = textBody.slice(0, MAX_TEXT_CHARS - 1) + '…';
    }
    if (!textBody.trim()) {
      console.warn(`[outbox-push-watcher] empty text body ${absPath}, skipping`);
      seen.delete(absPath);
      return;
    }
  }

  let allOk = true;
  let anyDelivered = false;
  for (const binding of bindings) {
    const adapter = adapters.find(a => a.channelType === binding.channelType);
    if (!adapter) {
      console.warn(
        `[outbox-push-watcher] no adapter for channel ${binding.channelType} (binding ${binding.id})`,
      );
      allOk = false;
      continue;
    }
    try {
      const result = isText
        ? await deliver(adapter, {
            address: addressFromBinding(binding),
            text: textBody as string,
            parseMode: 'plain',
          }, { sessionId: binding.codepilotSessionId })
        : await adapter.sendFile({
            address: addressFromBinding(binding),
            filePath: absPath,
            fileName,
            caption: fileName,
            kind: undefined,
          });
      if (result.ok) {
        anyDelivered = true;
      } else {
        allOk = false;
        console.warn(
          `[outbox-push-watcher] send failed for ${fileName} -> ${binding.id}: ${result.error || 'unknown'}`,
        );
      }
    } catch (error) {
      allOk = false;
      console.warn(
        `[outbox-push-watcher] send threw for ${fileName} -> ${binding.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (allOk && anyDelivered) {
    moveToBucket(absPath, fileName, SENT_SUBDIR);
    seen.delete(absPath);
    failures.delete(absPath);
    return;
  }

  recordFailure(absPath, fileName, seen, failures);
}

function recordFailure(
  absPath: string,
  fileName: string,
  seen: Map<string, SeenFileState>,
  failures: Map<string, number>,
): void {
  const count = (failures.get(absPath) || 0) + 1;
  failures.set(absPath, count);
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    moveToBucket(absPath, fileName, FAILED_SUBDIR);
    seen.delete(absPath);
    failures.delete(absPath);
    return;
  }
  // Re-arm stability so the next poll will treat the file as freshly
  // seen and require one more idle cycle before retrying. This gives
  // the adapter time to recover from transient errors without
  // hot-looping.
  const stat = safeStat(absPath);
  if (!stat) {
    seen.delete(absPath);
    return;
  }
  seen.set(absPath, { firstSeenAt: Date.now(), lastMtimeMs: stat.mtimeMs });
}

function moveToBucket(absPath: string, fileName: string, bucket: string): void {
  const dir = path.dirname(absPath);
  const bucketDir = path.join(dir, bucket);
  try {
    fs.mkdirSync(bucketDir, { recursive: true });
  } catch (error) {
    console.warn(
      `[outbox-push-watcher] failed to create ${bucketDir}:`,
      error instanceof Error ? error.message : error,
    );
    return;
  }
  const target = path.join(bucketDir, `${new Date().toISOString().replace(/[:]/g, '-')}-${fileName}`);
  try {
    fs.renameSync(absPath, target);
  } catch (error) {
    console.warn(
      `[outbox-push-watcher] failed to move ${absPath} -> ${target}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

function safeStat(absPath: string): fs.Stats | null {
  try {
    return fs.statSync(absPath);
  } catch {
    return null;
  }
}

function addressFromBinding(binding: ChannelBinding) {
  return {
    channelType: binding.channelType,
    chatId: binding.chatId,
    topicId: binding.topicId,
  };
}

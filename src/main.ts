/**
 * Daemon entry point for claude-to-im-skill.
 *
 * This build keeps Telegram as the only active chat surface.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import "claude-to-im/src/lib/bridge/adapters/telegram-adapter.js";
import { initBridgeContext } from "claude-to-im/src/lib/bridge/context.js";
import * as bridgeManager from "claude-to-im/src/lib/bridge/bridge-manager.js";

import type { LLMProvider } from "claude-to-im/src/lib/bridge/host.js";
import { loadConfig, configToSettings, CTI_HOME } from "./config.js";
import type { Config } from "./config.js";
import { JsonFileStore } from "./store.js";
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from "./llm-provider.js";
import { PendingPermissions } from "./permission-gateway.js";
import { setupLogger } from "./logger.js";
import { evaluateRuntimeHealth } from "./runtime-health.js";

const RUNTIME_DIR = path.join(CTI_HOME, "runtime");
const STATUS_FILE = path.join(RUNTIME_DIR, "status.json");
const PID_FILE = path.join(RUNTIME_DIR, "bridge.pid");

async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === "codex") {
    const { CodexProvider } = await import("./codex-provider.js");
    const provider = new CodexProvider(pendingPerms);
    try {
      await provider.preflight();
    } catch (error) {
      console.error(
        `[claude-to-im] FATAL: Codex runtime preflight failed.\n  Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    console.log("[claude-to-im] Codex runtime preflight OK");
    return provider;
  }

  if (runtime === "auto") {
    const cliPath = resolveClaudeCliPath();
    if (cliPath) {
      const check = preflightCheck(cliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${cliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${cliPath} failed preflight: ${check.error}\n` +
        "  Falling back to Codex.",
      );
    } else {
      console.log("[claude-to-im] Auto: Claude CLI not found, falling back to Codex");
    }
    const { CodexProvider } = await import("./codex-provider.js");
    const provider = new CodexProvider(pendingPerms);
    try {
      await provider.preflight();
    } catch (error) {
      console.error(
        `[claude-to-im] FATAL: Codex runtime preflight failed.\n  Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
    console.log("[claude-to-im] Codex runtime preflight OK");
    return provider;
  }

  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      "[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n" +
      "  Fix: install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE.\n" +
      "  Or set CTI_RUNTIME=codex to use Codex instead.",
    );
    process.exit(1);
  }

  const check = preflightCheck(cliPath);
  if (!check.ok) {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}`,
    );
    process.exit(1);
  }
  console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(RUNTIME_DIR, 0o700);
  } catch {
    // Best effort.
  }
  const tmp = STATUS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, STATUS_FILE);
  try {
    fs.chmodSync(STATUS_FILE, 0o600);
  } catch {
    // Best effort.
  }
}

function writePidFile(): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(RUNTIME_DIR, 0o700);
  } catch {
    // Best effort.
  }
  fs.writeFileSync(PID_FILE, String(process.pid), { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(PID_FILE, 0o600);
  } catch {
    // Best effort.
  }
}

function clearPidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // ignore missing pid file
  }
}

async function main(): Promise<void> {
  let keepaliveInterval: NodeJS.Timeout | null = null;
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  const daemonStartedAt = new Date().toISOString();
  const unhealthyExitThreshold = Math.max(
    1,
    Number.parseInt(process.env.CTI_UNHEALTHY_EXIT_THRESHOLD || "3", 10) || 3,
  );
  let consecutiveUnhealthyTicks = 0;
  writeStatus({
    running: false,
    pid: process.pid,
    runId,
    startedAt: daemonStartedAt,
    channels: [],
    lastExitReason: 'starting',
  });
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: "allow" | "deny"; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        const activeChannels = bridgeManager
          .getStatus()
          .adapters
          .filter((adapter) => adapter.running)
          .map((adapter) => adapter.channelType);
        writePidFile();
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: daemonStartedAt,
          channels: activeChannels,
        });
        console.log(
          `[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${activeChannels.join(", ") || "(none)"})`,
        );
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        clearPidFile();
        console.log("[claude-to-im] Bridge stopped");
      },
    },
  });

  await bridgeManager.start();
  if (!bridgeManager.getStatus().running) {
    writeStatus({ running: false, lastExitReason: "no adapters started successfully" });
    console.error("[claude-to-im] No adapters started successfully. Exiting.");
    process.exit(1);
  }

  const dedupCleanupInterval = setInterval(() => {
    try {
      store.cleanupExpiredDedup();
    } catch (err) {
      console.error(
        "[claude-to-im] dedup cleanup failed:",
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }, 60_000);
  dedupCleanupInterval.unref();

  const statusSyncInterval = setInterval(() => {
    const evaluation = evaluateRuntimeHealth({
      status: bridgeManager.getStatus(),
      pid: process.pid,
      runId,
      previousConsecutiveUnhealthyTicks: consecutiveUnhealthyTicks,
      unhealthyExitThreshold,
      fallbackStartedAt: daemonStartedAt,
    });
    consecutiveUnhealthyTicks = evaluation.nextConsecutiveUnhealthyTicks;
    if (evaluation.statusInfo.running) {
      writePidFile();
    }
    writeStatus(evaluation.statusInfo);
    if (evaluation.shouldExit && !shuttingDown) {
      void shutdown("all adapters unhealthy", 1);
    }
  }, 5000);
  statusSyncInterval.unref();

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(statusSyncInterval);
    clearInterval(dedupCleanupInterval);
    if (keepaliveInterval) clearInterval(keepaliveInterval);
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    const forceExitTimer = setTimeout(() => {
      clearPidFile();
      writeStatus({ running: false, lastExitReason: `${reason} (forced exit after timeout)` });
      process.exit(exitCode);
    }, 5_000);
    forceExitTimer.unref();
    pendingPerms.denyAll();
    try {
      await bridgeManager.stop();
    } catch (error) {
      console.error(
        "[claude-to-im] Error while stopping bridge:",
        error instanceof Error ? error.stack || error.message : error,
      );
    } finally {
      clearTimeout(forceExitTimer);
      clearPidFile();
      writeStatus({ running: false, lastExitReason: reason });
      process.exit(exitCode);
    }
  };

  process.on("SIGTERM", () => { void shutdown("signal: SIGTERM", 0); });
  process.on("SIGINT", () => { void shutdown("signal: SIGINT", 0); });
  process.on("SIGHUP", () => { void shutdown("signal: SIGHUP", 0); });

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error("[claude-to-im] unhandledRejection:", detail);
    void shutdown(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`, 1);
  });
  process.on("uncaughtException", (err) => {
    console.error("[claude-to-im] uncaughtException:", err.stack || err.message);
    void shutdown(`uncaughtException: ${err.message}`, 1);
  });

  // Intentionally not unref'd: this is the fallback that keeps the event loop
  // alive during brief windows when the adapter poll loop has no pending I/O.
  // statusSyncInterval and dedupCleanupInterval are both unref'd so cannot
  // fill this role. Cleaned up inside shutdown() to allow graceful exit.
  keepaliveInterval = setInterval(() => { /* no-op */ }, 45_000);
}

main().catch((err) => {
  console.error("[claude-to-im] Fatal error:", err instanceof Error ? err.stack || err.message : err);
  try {
    clearPidFile();
    writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` });
  } catch {
    // ignore
  }
  process.exit(1);
});

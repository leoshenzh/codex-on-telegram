import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../config.js";

const originalCtiHome = process.env.CTI_HOME;

async function loadConfigModule(tempHome: string) {
  process.env.CTI_HOME = tempHome;
  const cacheBust = Date.now() + Math.random();
  return import(`../config.ts?test=${cacheBust}`);
}

describe("maskSecret", () => {
  it("masks short values entirely", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-mask-"));
    const { maskSecret } = await loadConfigModule(tempHome);
    assert.equal(maskSecret("abc"), "****");
    assert.equal(maskSecret("abcd"), "****");
    assert.equal(maskSecret(""), "****");
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("preserves last 4 chars for longer values", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-mask-"));
    const { maskSecret } = await loadConfigModule(tempHome);
    assert.equal(maskSecret("12345678"), "****5678");
    assert.equal(maskSecret("secret-token-abcd"), "*************abcd");
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});

describe("configToSettings", () => {
  it("maps Telegram settings plus defaults", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-map-"));
    const { configToSettings } = await loadConfigModule(tempHome);
    const config: Config = {
      runtime: "codex",
      enabledChannels: ["telegram"],
      defaultWorkDir: "/tmp/project",
      defaultMode: "plan",
      defaultModel: "gpt-5.4",
      tgBotToken: "123456:telegram-token",
      tgChatId: "1000000001",
      tgAllowedUsers: ["1000000001"],
      tgOwnerUserId: "1000000001",
      tgRequirePrivateChat: true,
      autoApprove: true,
    };

    const settings = configToSettings(config);
    assert.equal(settings.get("remote_bridge_enabled"), "true");
    assert.equal(settings.get("bridge_telegram_enabled"), "true");
    assert.equal(settings.get("telegram_bot_token"), "123456:telegram-token");
    assert.equal(settings.get("telegram_chat_id"), "1000000001");
    assert.equal(settings.get("telegram_bridge_allowed_users"), "1000000001");
    assert.equal(settings.get("telegram_bridge_owner_user_id"), "1000000001");
    assert.equal(settings.get("telegram_bridge_require_private_chat"), "true");
    assert.equal(settings.get("bridge_default_work_dir"), "/tmp/project");
    assert.equal(settings.get("bridge_default_mode"), "plan");
    assert.equal(settings.get("bridge_default_model"), "gpt-5.4");
    assert.equal(settings.get("default_model"), "gpt-5.4");
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("drops unknown channels from the exported settings", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-map-"));
    const { configToSettings } = await loadConfigModule(tempHome);
    const config: Config = {
      runtime: "claude",
      enabledChannels: ["legacy-a", "telegram", "weixin", "legacy-b"],
      defaultWorkDir: "/tmp/project",
      defaultMode: "code",
    };

    const settings = configToSettings(config);
    assert.equal(settings.get("bridge_telegram_enabled"), "true");
    assert.equal(Array.from(settings.keys()).some((key: string) => key.includes("legacy")), false);
    assert.equal(Array.from(settings.keys()).some((key: string) => key.includes("weixin")), false);
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});

describe("loadConfig/saveConfig", () => {
  it("round-trips Telegram config and ignores legacy channel values", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-io-"));
    const configModule = await loadConfigModule(tempHome);
    const { saveConfig, loadConfig, CONFIG_PATH } = configModule;

    const initial: Config = {
      runtime: "codex",
      enabledChannels: ["telegram"],
      defaultWorkDir: "/tmp/work",
      defaultMode: "ask",
      defaultModel: "gpt-5.4",
      codexApprovalPolicy: "never",
      codexSandboxMode: "danger-full-access",
      codexModelReasoningEffort: "high",
      codexAdditionalDirectories: ["/Users/example", "/tmp"],
      tgBotToken: "123456:telegram-token",
      tgAllowedUsers: ["1000000001"],
      tgOwnerUserId: "1000000001",
      tgRequirePrivateChat: true,
      autoApprove: true,
    };

    saveConfig(initial);
    let loaded = loadConfig();
    assert.deepEqual(loaded.enabledChannels, ["telegram"]);
    assert.equal(loaded.defaultMode, "ask");
    assert.equal(loaded.tgBotToken, "123456:telegram-token");
    assert.deepEqual(loaded.tgAllowedUsers, ["1000000001"]);
    assert.equal(loaded.tgOwnerUserId, "1000000001");
    assert.equal(loaded.tgRequirePrivateChat, true);
    assert.equal(loaded.autoApprove, true);

    fs.appendFileSync(
      CONFIG_PATH,
      "CTI_ENABLED_CHANNELS=legacy-a,telegram,weixin,legacy-b\nCTI_UNUSED_LEGACY=legacy\n",
      "utf-8",
    );

    loaded = loadConfig();
    assert.deepEqual(loaded.enabledChannels, ["telegram"]);
    assert.equal((loaded as Record<string, unknown>).unusedLegacy, undefined);

    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("loads export-prefixed entries with the same semantics as the shell scripts", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-export-"));
    const configModule = await loadConfigModule(tempHome);
    const { loadConfig, CONFIG_PATH } = configModule;

    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      CONFIG_PATH,
      [
        'export CTI_RUNTIME=codex',
        'export CTI_ENABLED_CHANNELS=telegram,legacy',
        'export CTI_DEFAULT_WORKDIR="/tmp/exported"',
        'export CTI_TG_BOT_TOKEN="123456:telegram-token"',
        'export CTI_TG_ALLOWED_USERS="1000000001, 12345"',
      ].join("\n"),
      "utf-8",
    );

    const loaded = loadConfig();
    assert.equal(loaded.runtime, "codex");
    assert.deepEqual(loaded.enabledChannels, ["telegram"]);
    assert.equal(loaded.defaultWorkDir, "/tmp/exported");
    assert.equal(loaded.tgBotToken, "123456:telegram-token");
    assert.deepEqual(loaded.tgAllowedUsers, ["1000000001", "12345"]);

    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("parses export-prefixed config lines and applies them to process.env", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cti-config-export-"));
    const configModule = await loadConfigModule(tempHome);
    const { loadConfig, CONFIG_PATH } = configModule;

    fs.writeFileSync(
      CONFIG_PATH,
      [
        'export CTI_RUNTIME=codex',
        'export CTI_ENABLED_CHANNELS="telegram"',
        'export CTI_DEFAULT_WORKDIR=/tmp/exported',
        'export CTI_CODEX_SANDBOX_MODE=danger-full-access',
      ].join("\n"),
      "utf-8",
    );

    delete process.env.CTI_RUNTIME;
    delete process.env.CTI_ENABLED_CHANNELS;
    delete process.env.CTI_DEFAULT_WORKDIR;
    delete process.env.CTI_CODEX_SANDBOX_MODE;

    const loaded = loadConfig();
    assert.equal(loaded.runtime, "codex");
    assert.deepEqual(loaded.enabledChannels, ["telegram"]);
    assert.equal(loaded.defaultWorkDir, "/tmp/exported");
    assert.equal(loaded.codexSandboxMode, "danger-full-access");
    assert.equal(process.env.CTI_RUNTIME, "codex");
    assert.equal(process.env.CTI_CODEX_SANDBOX_MODE, "danger-full-access");

    fs.rmSync(tempHome, { recursive: true, force: true });
  });
});

afterEach(() => {
  if (originalCtiHome === undefined) {
    delete process.env.CTI_HOME;
  } else {
    process.env.CTI_HOME = originalCtiHome;
  }
});

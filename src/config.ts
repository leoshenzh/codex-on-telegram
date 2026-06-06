import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  runtime: "claude" | "codex" | "auto";
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  codexPassModel?: boolean;
  codexSkipGitRepoCheck?: boolean;
  codexApprovalPolicy?: string;
  codexSandboxMode?: string;
  codexModelReasoningEffort?: string;
  codexNetworkAccessEnabled?: boolean;
  codexAdditionalDirectories?: string[];
  tgBotToken?: string;
  tgChatId?: string;
  tgAllowedUsers?: string[];
  tgOwnerUserId?: string;
  tgRequirePrivateChat?: boolean;
  autoApprove?: boolean;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), ".claude-to-im");
export const CONFIG_PATH = path.join(CTI_HOME, "config.env");

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eqIdx = normalized.indexOf("=");
    if (eqIdx === -1) continue;
    const key = normalized.slice(0, eqIdx).trim();
    let value = normalized.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

export function applyConfigEnv(entries: Map<string, string>, opts?: { override?: boolean }): void {
  const shouldOverride = opts?.override === true;
  for (const [key, value] of entries.entries()) {
    if (!shouldOverride && process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeChannels(value: string[] | undefined): string[] {
  if (!value) return [];
  const allowed = new Set(["telegram"]);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const channel of value) {
    if (!allowed.has(channel) || seen.has(channel)) continue;
    seen.add(channel);
    normalized.push(channel);
  }
  return normalized;
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    env = parseEnvFile(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    // Config file does not exist yet.
  }
  applyConfigEnv(env, { override: true });
  const envValue = (key: string): string | undefined => process.env[key] ?? env.get(key);

  const rawRuntime = envValue("CTI_RUNTIME") || "claude";
  const runtime = (["claude", "codex", "auto"].includes(rawRuntime) ? rawRuntime : "claude") as Config["runtime"];

  return {
    runtime,
    enabledChannels: normalizeChannels(splitCsv(envValue("CTI_ENABLED_CHANNELS") || "telegram")),
    defaultWorkDir: envValue("CTI_DEFAULT_WORKDIR") || process.cwd(),
    defaultModel: envValue("CTI_DEFAULT_MODEL") || undefined,
    defaultMode: envValue("CTI_DEFAULT_MODE") || "code",
    codexPassModel: envValue("CTI_CODEX_PASS_MODEL") !== undefined
      ? envValue("CTI_CODEX_PASS_MODEL") === "true"
      : undefined,
    codexSkipGitRepoCheck: envValue("CTI_CODEX_SKIP_GIT_REPO_CHECK") !== undefined
      ? envValue("CTI_CODEX_SKIP_GIT_REPO_CHECK") === "true"
      : undefined,
    codexApprovalPolicy: envValue("CTI_CODEX_APPROVAL_POLICY") || undefined,
    codexSandboxMode: envValue("CTI_CODEX_SANDBOX_MODE") || undefined,
    codexModelReasoningEffort: envValue("CTI_CODEX_MODEL_REASONING_EFFORT") || undefined,
    codexNetworkAccessEnabled: envValue("CTI_CODEX_NETWORK_ACCESS_ENABLED") !== undefined
      ? envValue("CTI_CODEX_NETWORK_ACCESS_ENABLED") === "true"
      : undefined,
    codexAdditionalDirectories: splitCsv(envValue("CTI_CODEX_ADDITIONAL_DIRECTORIES")),
    tgBotToken: envValue("CTI_TG_BOT_TOKEN") || undefined,
    tgChatId: envValue("CTI_TG_CHAT_ID") || undefined,
    tgAllowedUsers: splitCsv(envValue("CTI_TG_ALLOWED_USERS")),
    tgOwnerUserId: envValue("CTI_TG_OWNER_USER_ID") || undefined,
    tgRequirePrivateChat: envValue("CTI_TG_REQUIRE_PRIVATE_CHAT") !== undefined
      ? envValue("CTI_TG_REQUIRE_PRIVATE_CHAT") === "true"
      : undefined,
    autoApprove: envValue("CTI_AUTO_APPROVE") === "true",
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === "") return "";
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = "";
  out += formatEnvLine("CTI_RUNTIME", config.runtime);
  out += formatEnvLine("CTI_ENABLED_CHANNELS", normalizeChannels(config.enabledChannels).join(","));
  out += formatEnvLine("CTI_DEFAULT_WORKDIR", config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine("CTI_DEFAULT_MODEL", config.defaultModel);
  out += formatEnvLine("CTI_DEFAULT_MODE", config.defaultMode);
  if (config.codexPassModel !== undefined) {
    out += formatEnvLine("CTI_CODEX_PASS_MODEL", String(config.codexPassModel));
  }
  if (config.codexSkipGitRepoCheck !== undefined) {
    out += formatEnvLine("CTI_CODEX_SKIP_GIT_REPO_CHECK", String(config.codexSkipGitRepoCheck));
  }
  out += formatEnvLine("CTI_CODEX_APPROVAL_POLICY", config.codexApprovalPolicy);
  out += formatEnvLine("CTI_CODEX_SANDBOX_MODE", config.codexSandboxMode);
  out += formatEnvLine("CTI_CODEX_MODEL_REASONING_EFFORT", config.codexModelReasoningEffort);
  if (config.codexNetworkAccessEnabled !== undefined) {
    out += formatEnvLine("CTI_CODEX_NETWORK_ACCESS_ENABLED", String(config.codexNetworkAccessEnabled));
  }
  out += formatEnvLine("CTI_CODEX_ADDITIONAL_DIRECTORIES", config.codexAdditionalDirectories?.join(","));
  out += formatEnvLine("CTI_TG_BOT_TOKEN", config.tgBotToken);
  out += formatEnvLine("CTI_TG_CHAT_ID", config.tgChatId);
  out += formatEnvLine("CTI_TG_ALLOWED_USERS", config.tgAllowedUsers?.join(","));
  out += formatEnvLine("CTI_TG_OWNER_USER_ID", config.tgOwnerUserId);
  if (config.tgRequirePrivateChat !== undefined) {
    out += formatEnvLine("CTI_TG_REQUIRE_PRIVATE_CHAT", String(config.tgRequirePrivateChat));
  }
  if (config.autoApprove !== undefined) {
    out += formatEnvLine("CTI_AUTO_APPROVE", String(config.autoApprove));
  }

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return "*".repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const channels = normalizeChannels(config.enabledChannels);
  const settings = new Map<string, string>();
  settings.set("remote_bridge_enabled", "true");
  settings.set("bridge_telegram_enabled", channels.includes("telegram") ? "true" : "false");

  if (config.tgBotToken) settings.set("telegram_bot_token", config.tgBotToken);
  if (config.tgChatId) settings.set("telegram_chat_id", config.tgChatId);
  if (config.tgAllowedUsers?.length) {
    settings.set("telegram_bridge_allowed_users", config.tgAllowedUsers.join(","));
  }
  if (config.tgOwnerUserId) {
    settings.set("telegram_bridge_owner_user_id", config.tgOwnerUserId);
  }
  if (config.tgRequirePrivateChat !== undefined) {
    settings.set("telegram_bridge_require_private_chat", String(config.tgRequirePrivateChat));
  }
  settings.set("bridge_default_work_dir", config.defaultWorkDir);
  settings.set("bridge_default_mode", config.defaultMode);
  if (config.defaultModel) {
    settings.set("bridge_default_model", config.defaultModel);
    settings.set("default_model", config.defaultModel);
  }

  return settings;
}

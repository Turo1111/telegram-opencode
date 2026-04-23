import dotenv from "dotenv";
import {
  OPEN_CODE_ADAPTER_MODE,
  OpenCodeAdapterMode,
  parseOpenCodeAdapterMode,
} from "./infrastructure/opencode-adapter-mode";

dotenv.config();

export interface Config {
  telegramBotToken: string;
  allowedUserIds: readonly string[];
  openCodeUrl: string;
  openCodeToken: string;
  openCodeAdapter?: OpenCodeAdapterMode;
  openCodeTimeoutMs: number;
  openCodeControlTimeoutMs: number;
  openCodeExecTimeoutMs: number;
  pollingIntervalMs: number;
  locale: string;
  stateDriver: StateDriver;
  stateDbPath: string;
  stateJsonPath: string;
  compatLegacyTextBridge: boolean;
  compatRunCmdCommands: boolean;
  bootRemoteReconcile: boolean;
  chatLockEnabled: boolean;
  lockWarnWaitMs: number;
  watcherEnabled: boolean;
  watchdogEnabled: boolean;
  webhookHost: string;
  webhookPortStart: number;
  webhookPortEnd: number;
  watchdogIntervalMs: number;
  watchdogStaleAfterMs: number;
  watchdogMaxRetryCount: number;
  humanPromptsEnabled: boolean;
  humanPromptLocalTtlMs: number;
}

export const STATE_DRIVERS = {
  SQLITE: "sqlite",
  JSON: "json",
} as const;

export type StateDriver = (typeof STATE_DRIVERS)[keyof typeof STATE_DRIVERS];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function isPlaceholderAllowlistValue(value: string): boolean {
  return value.trim().toLowerCase() === "replace_me";
}

function parseAllowlistEntry(rawValue: string, source: string): string {
  const value = rawValue.trim();

  if (!value) {
    throw new Error(`Invalid ${source}: empty value`);
  }

  if (isPlaceholderAllowlistValue(value)) {
    throw new Error(`Invalid ${source}: placeholder value \"${rawValue}\" is not allowed`);
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${source}: \"${rawValue}\" must be a positive numeric Telegram from.id`);
  }

  if (BigInt(value) <= 0n) {
    throw new Error(`Invalid ${source}: \"${rawValue}\" must be greater than 0`);
  }

  return BigInt(value).toString();
}

function parseAllowedUserIds(): readonly string[] {
  const singleRaw = process.env.ALLOWED_USER_ID?.trim();

  if (!singleRaw) {
    throw new Error(
      "Missing required env var: ALLOWED_USER_ID. Set it to your numeric Telegram from.id (example: ALLOWED_USER_ID=123456789)"
    );
  }

  const parsedIds: string[] = [];
  const seen = new Set<string>();

  const pushUnique = (id: string) => {
    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    parsedIds.push(id);
  };

  const single = parseAllowlistEntry(singleRaw, "ALLOWED_USER_ID");
  pushUnique(single);

  const multiRaw = process.env.ALLOWED_USER_IDS;
  if (multiRaw) {
    for (const [index, rawId] of multiRaw.split(",").entries()) {
      const parsed = parseAllowlistEntry(rawId, `ALLOWED_USER_IDS entry #${index + 1}`);
      pushUnique(parsed);
    }
  }

  if (parsedIds.length === 0) {
    throw new Error(
      "Invalid allowlist configuration: provide at least one valid numeric Telegram from.id using ALLOWED_USER_ID or ALLOWED_USER_IDS"
    );
  }

  return parsedIds;
}

function parseNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid number for ${name}: ${raw}`);
  }
  return parsed;
}

function parseInteger(name: string, fallback: number): number {
  const value = parseNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }

  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;

  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;

  throw new Error(`Invalid boolean for ${name}: ${raw}`);
}

function parseStateDriver(): StateDriver {
  const raw = (process.env.STATE_DRIVER || STATE_DRIVERS.SQLITE).trim().toLowerCase();
  if (raw === STATE_DRIVERS.SQLITE || raw === STATE_DRIVERS.JSON) {
    return raw;
  }

  throw new Error(
    `Invalid value for STATE_DRIVER: ${raw}. Allowed: ${STATE_DRIVERS.SQLITE}, ${STATE_DRIVERS.JSON}`
  );
}

function parseLoopbackHost(name: string, fallback: string): string {
  const host = (process.env[name] || fallback).trim().toLowerCase();
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);

  if (!allowedHosts.has(host)) {
    throw new Error(`Invalid loopback host for ${name}: ${host}`);
  }

  return host;
}

function validatePortRange(start: number, end: number): void {
  if (start < 1 || start > 65535) {
    throw new Error(`Invalid WEBHOOK_PORT_START: ${start}`);
  }

  if (end < 1 || end > 65535) {
    throw new Error(`Invalid WEBHOOK_PORT_END: ${end}`);
  }

  if (start > end) {
    throw new Error(`Invalid webhook port range: ${start}-${end}`);
  }
}

export function loadConfig(): Config {
  const openCodeAdapter = parseOpenCodeAdapterMode(process.env.OPEN_CODE_ADAPTER);
  const allowedUserIds = parseAllowedUserIds();
  const openCodeTimeoutMs = parseNumber("OPEN_CODE_TIMEOUT_MS", 8000);
  const lockWarnWaitMs = parseNumber("LOCK_WARN_WAIT_MS", 1500);
  const webhookHost = parseLoopbackHost("WEBHOOK_HOST", "127.0.0.1");
  const webhookPortStart = parseInteger("WEBHOOK_PORT_START", 4040);
  const webhookPortEnd = parseInteger("WEBHOOK_PORT_END", 4045);
  const watchdogIntervalMs = parseInteger("WATCHDOG_INTERVAL_MS", 15000);
  const watchdogStaleAfterMs = parseInteger("WATCHDOG_STALE_AFTER_MS", 60000);
  const watchdogMaxRetryCount = parseInteger("WATCHDOG_MAX_RETRY_COUNT", 3);
  const humanPromptLocalTtlMs = parseInteger("HUMAN_PROMPT_LOCAL_TTL_MS", 300000);

  validatePortRange(webhookPortStart, webhookPortEnd);

  const usesLocalCliAdapter =
    openCodeAdapter === OPEN_CODE_ADAPTER_MODE.CLI ||
    openCodeAdapter === OPEN_CODE_ADAPTER_MODE.PTY;

  const openCodeUrl =
    usesLocalCliAdapter
      ? readOptionalEnv("OPEN_CODE_URL") ?? "http://localhost/opencode/query"
      : requireEnv("OPEN_CODE_URL");

  const openCodeToken =
    usesLocalCliAdapter
      ? readOptionalEnv("OPEN_CODE_TOKEN") ?? "cli-mode-not-used"
      : requireEnv("OPEN_CODE_TOKEN");

  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds,
    openCodeUrl,
    openCodeToken,
    openCodeAdapter,
    openCodeTimeoutMs,
    openCodeControlTimeoutMs: parseNumber("OPEN_CODE_CONTROL_TIMEOUT_MS", openCodeTimeoutMs),
    openCodeExecTimeoutMs: parseNumber("OPEN_CODE_EXEC_TIMEOUT_MS", openCodeTimeoutMs),
    pollingIntervalMs: parseNumber("POLLING_INTERVAL_MS", 1500),
    locale: process.env.LOCALE || "es",
    stateDriver: parseStateDriver(),
    stateDbPath: process.env.STATE_DB_PATH || "./data/telegram-opencode.sqlite",
    stateJsonPath: process.env.STATE_JSON_PATH || "./data/telegram-opencode-state.json",
    compatLegacyTextBridge: parseBoolean("COMPAT_LEGACY_TEXT_BRIDGE", true),
    compatRunCmdCommands: parseBoolean("COMPAT_RUN_CMD_COMMANDS", true),
    bootRemoteReconcile: parseBoolean("BOOT_REMOTE_RECONCILE", true),
    chatLockEnabled: parseBoolean("CHAT_LOCK_ENABLED", true),
    lockWarnWaitMs,
    watcherEnabled: parseBoolean("WATCHER_ENABLED", true),
    watchdogEnabled: parseBoolean("WATCHDOG_ENABLED", true),
    webhookHost,
    webhookPortStart,
    webhookPortEnd,
    watchdogIntervalMs,
    watchdogStaleAfterMs,
    watchdogMaxRetryCount,
    humanPromptsEnabled: parseBoolean("HUMAN_PROMPTS_ENABLED", false),
    humanPromptLocalTtlMs,
  };
}

export { OPEN_CODE_ADAPTER_MODE };

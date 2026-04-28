import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { createTelegramRouter, TELEGRAM_ROUTER_AUTH_SOURCE, type TelegramRouterAuthContext } from "../adapters/telegram/router";
import { createApplicationUseCases } from "../application/use-cases";
import {
  ADAPTER_ERROR_CODES,
  type CancelOrInterruptResult,
  type ObserveSessionResult,
  type OpenCodeSessionAdapter,
  type PersistenceDriver,
  type Result,
  type SendResult,
  type SessionState,
  type SubmitPromptInputResult,
} from "../application/contracts";
import { type Config, STATE_DRIVERS } from "../config";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { DANGEROUS_ACTION_CONFIRMATION_STATUS } from "../domain/entities";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";

class FakeBot {
  readonly messages: Array<{ readonly chatId: number; readonly text: string; readonly options?: TelegramBot.SendMessageOptions }> = [];
  readonly callbacks: Array<{ readonly id: string; readonly text?: string }> = [];

  async sendMessage(
    chatId: number,
    text: string,
    options?: TelegramBot.SendMessageOptions
  ): Promise<TelegramBot.Message> {
    this.messages.push({ chatId, text, options });
    return { message_id: this.messages.length, chat: { id: chatId, type: "private" } } as TelegramBot.Message;
  }

  async answerCallbackQuery(id: string, options?: TelegramBot.AnswerCallbackQueryOptions): Promise<boolean> {
    this.callbacks.push({ id, text: options?.text });
    return true;
  }
}

class FakeAdapter implements OpenCodeSessionAdapter {
  readonly sentMessages: Array<{
    readonly projectId: string;
    readonly sessionId: string;
    readonly message: string;
    readonly chatId: string;
  }> = [];

  readonly runCommands: Array<{
    readonly projectId: string;
    readonly sessionId: string;
    readonly command: string;
    readonly chatId: string;
  }> = [];

  async resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return ok({ canonicalPath: input.rootPath });
  }

  async createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
  }): Promise<Result<SessionState>> {
    return ok({
      projectId: input.projectId,
      sessionId: "sess-created",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  }

  async attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    if (input.sessionId === "missing") {
      return err(ADAPTER_ERROR_CODES.SESSION_NOT_FOUND, "missing");
    }

    return ok({
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  }

  async sendMessage(_input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    this.sentMessages.push(_input);
    return ok({
      message: "ok",
      state: { projectId: "proj-demo", sessionId: "sess-demo", status: "idle" },
    });
  }

  async runCommand(_input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    this.runCommands.push(_input);
    return ok({
      message: "ok",
      state: { projectId: "proj-demo", sessionId: "sess-demo", status: "idle" },
    });
  }

  async getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    return ok({
      projectId: input.projectId,
      sessionId: input.sessionId,
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
  }

  async cancelOrInterrupt(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<CancelOrInterruptResult>> {
    return ok({ status: "accepted", message: "ok" });
  }

  async observeSession(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>> {
    return ok({ mode: "not-available-yet" });
  }

  async submitPromptInput(): Promise<Result<SubmitPromptInputResult>> {
    return ok({ status: "accepted" });
  }
}

async function withVerificationContext<T>(
  overrides: {
    readonly localHostActionsEnabled?: boolean;
    readonly attachLocalEnabled?: boolean;
    readonly localHostConfirmationTtlMs?: number;
    readonly isLocalHostEnvironmentReady?: (input: {
      readonly intent: "attach-local";
      readonly targetEnvironment: string;
      readonly projectId: string;
      readonly sessionId: string;
    }) => Promise<{ readonly ok: boolean; readonly reason?: string }>;
  },
  work: (input: {
    readonly bot: FakeBot;
    readonly adapter: FakeAdapter;
    readonly persistence: PersistenceDriver;
    readonly useCases: ReturnType<typeof createApplicationUseCases>;
    readonly router: ReturnType<typeof createTelegramRouter>;
    readonly auditLines: string[];
  }) => Promise<T>
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc12-"));
  const config = createVerificationConfig(tempDir, overrides);
  const persistence = await createJsonPersistenceDriver(config);
  const adapter = new FakeAdapter();
  const useCases = createApplicationUseCases({
    persistence,
    adapter,
    localHostOptions: {
      allowedActorIds: config.allowedUserIds,
      localHostActionsEnabled: config.localHostActionsEnabled,
      attachLocalEnabled: config.attachLocalEnabled,
      localHostConfirmationTtlMs: config.localHostConfirmationTtlMs,
      isLocalHostEnvironmentReady: overrides.isLocalHostEnvironmentReady,
    },
  });
  const bot = new FakeBot();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    persistence,
    compatRunCmdCommands: false,
    localHostActionsEnabled: config.localHostActionsEnabled,
    attachLocalEnabled: config.attachLocalEnabled,
    localHostConfirmationTtlMs: config.localHostConfirmationTtlMs,
  });

  const auditLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("Sensitive action audit")) {
      auditLines.push(line);
    }

    originalLog(...args);
  };

  try {
    return await work({ bot, adapter, persistence, useCases, router, auditLines });
  } finally {
    console.log = originalLog;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createVerificationConfig(
  tempDir: string,
  overrides: {
    readonly localHostActionsEnabled?: boolean;
    readonly attachLocalEnabled?: boolean;
    readonly localHostConfirmationTtlMs?: number;
  }
): Config {
  return {
    telegramBotToken: "token",
    allowedUserIds: ["42"],
    openCodeUrl: "http://localhost:3000/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 1000,
    openCodeControlTimeoutMs: 1000,
    openCodeExecTimeoutMs: 1000,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath: path.join(tempDir, "state.json"),
    compatLegacyTextBridge: true,
    compatRunCmdCommands: false,
    bootRemoteReconcile: false,
    chatLockEnabled: false,
    lockWarnWaitMs: 100,
    watcherEnabled: false,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4045,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000,
    watchdogMaxRetryCount: 1,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 1000,
    localHostActionsEnabled: overrides.localHostActionsEnabled ?? true,
    attachLocalEnabled: overrides.attachLocalEnabled ?? true,
    localHostConfirmationTtlMs: overrides.localHostConfirmationTtlMs ?? 60_000,
  };
}

function createAuthContext(actorId = "42"): TelegramRouterAuthContext {
  return {
    authorized: true,
    actorId,
    source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
  };
}

function createMessage(chatId: string, text: string, chatType: TelegramBot.Chat["type"] = "private"): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(chatId), type: chatType },
    from: { id: 42, is_bot: false, first_name: "Test" },
    text,
  } as TelegramBot.Message;
}

function createCallback(
  chatId: string,
  callbackId: string,
  data: string,
  chatType: TelegramBot.Chat["type"] = "private"
): TelegramBot.CallbackQuery {
  return {
    id: callbackId,
    from: { id: 42, is_bot: false, first_name: "Test" },
    chat_instance: "chat-instance",
    data,
    message: {
      message_id: 9,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: chatType },
      text: "callback",
    } as TelegramBot.Message,
  } as TelegramBot.CallbackQuery;
}

async function seedActiveBinding(useCases: ReturnType<typeof createApplicationUseCases>): Promise<void> {
  const selected = await useCases.selectProject({
    chatId: "1001",
    selector: "proj-demo",
    rootPath: "/tmp/proj-demo",
  });
  assert.equal(selected.ok, true);

  const attached = await useCases.attachSession({ chatId: "1001", sessionId: "sess-demo" });
  assert.equal(attached.ok, true);
}

async function getConfirmations(persistence: PersistenceDriver) {
  return persistence.runInTransaction(async (unit) => unit.dangerousActionConfirmations?.listAll() ?? []);
}

async function verifyHelpHidesDangerousCommandWhenDisabled(): Promise<void> {
  await withVerificationContext(
    { localHostActionsEnabled: false, attachLocalEnabled: false },
    async ({ bot, router }) => {
      await router.handleMessage(createMessage("1001", "/help"), createAuthContext());
      assert.equal(bot.messages.length, 1);
      assert.equal(bot.messages[0]?.text.includes("/attach-local"), false);

      await router.handleMessage(createMessage("1001", "/attach-local"), createAuthContext());
      assert.equal(bot.messages[1]?.text.includes("deshabilitada"), true);
    }
  );
}

async function verifyPrivateOnlyRejectsWithoutSideEffects(): Promise<void> {
  await withVerificationContext({}, async ({ bot, persistence, router, auditLines }) => {
    await router.handleMessage(createMessage("1001", "/help", "group"), createAuthContext());
    assert.equal(bot.messages[0]?.text.includes("/attach-local"), false);

    await router.handleMessage(createMessage("1001", "/attach-local", "group"), createAuthContext());
    assert.equal(bot.messages[1]?.text.includes("chat privado"), true);

    const confirmations = await getConfirmations(persistence);
    assert.equal(confirmations.length, 0);
    assert.equal(auditLines.some((line) => line.includes('"reason":"chat-not-private"')), true);
  });
}

async function verifyArbitraryShellProhibitedAtRuntime(): Promise<void> {
  await withVerificationContext({}, async ({ bot, adapter, persistence, router, useCases, auditLines }) => {
    await seedActiveBinding(useCases);

    await router.handleMessage(createMessage("1001", "/run powershell -NoProfile -Command whoami"), createAuthContext());
    await router.handleMessage(createMessage("1001", "/cmd wsl.exe -- bash -lc 'touch /tmp/pwned'"), createAuthContext());

    assert.equal(bot.messages.length, 2);
    assert.equal(bot.messages[0]?.text.includes("/run y /cmd ya no forman parte del flujo PTY-only"), true);
    assert.equal(bot.messages[1]?.text.includes("/run y /cmd ya no forman parte del flujo PTY-only"), true);
    assert.equal(adapter.runCommands.length, 0);
    assert.equal(adapter.sentMessages.length, 0);

    const confirmations = await getConfirmations(persistence);
    assert.equal(confirmations.length, 0);
    assert.equal(
      auditLines.some(
        (line) => line.includes('"result":"requested"') || line.includes('"result":"executed"')
      ),
      false
    );
  });
}

async function verifyNormalFlowsStayClean(): Promise<void> {
  await withVerificationContext({}, async ({ bot, router, useCases }) => {
    await seedActiveBinding(useCases);

    await router.handleMessage(createMessage("1001", "/status"), createAuthContext());
    await router.handleMessage(createMessage("1001", "/project"), createAuthContext());
    await router.handleMessage(createMessage("2002", "hola"), createAuthContext());

    assert.equal(bot.messages.length, 3);

    for (const message of bot.messages) {
      assert.equal(message.text.includes("/attach-local"), false);
      assert.equal(message.text.includes("sensible/experimental"), false);
      assert.equal(message.text.includes("host local"), false);
    }
  });
}

async function verifyConfirmationFlowReplayAndAudit(): Promise<void> {
  await withVerificationContext({}, async ({ bot, persistence, router, useCases, auditLines }) => {
    await seedActiveBinding(useCases);

    await router.handleMessage(createMessage("1001", "/help"), createAuthContext());
    assert.equal(bot.messages[0]?.text.includes("/attach-local"), true);

    await router.handleMessage(createMessage("1001", "/attach-local"), createAuthContext());
    assert.equal(bot.messages[1]?.text.includes("Confirmación sensible requerida"), true);

    const confirmations = await getConfirmations(persistence);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0]?.status, DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE);

    const callbackData = bot.messages[1]?.options?.reply_markup;
    assert.ok(callbackData && "inline_keyboard" in callbackData);
    const confirmToken = callbackData.inline_keyboard[0]?.[0]?.callback_data;
    assert.ok(confirmToken);

    await router.handleCallbackQuery(createCallback("1001", "cb-1", confirmToken), createAuthContext());
    const afterConfirm = await getConfirmations(persistence);
    assert.equal(afterConfirm[0]?.status, DANGEROUS_ACTION_CONFIRMATION_STATUS.CONFIRMED);
    assert.equal(bot.messages.at(-1)?.text.includes("Hardening confirmado"), true);

    await router.handleCallbackQuery(createCallback("1001", "cb-2", confirmToken), createAuthContext());
    assert.equal(bot.messages.at(-1)?.text.includes("Confirmación ya procesada"), true);
    assert.equal(auditLines.some((line) => line.includes('"result":"executed"')), true);
  });
}

async function verifyConfirmationExpiry(): Promise<void> {
  await withVerificationContext(
    { localHostConfirmationTtlMs: 5 },
    async ({ bot, persistence, router, useCases }) => {
      await seedActiveBinding(useCases);
      await router.handleMessage(createMessage("1001", "/attach-local"), createAuthContext());

      const callbackData = bot.messages[0]?.options?.reply_markup;
      assert.ok(callbackData && "inline_keyboard" in callbackData);
      const confirmToken = callbackData.inline_keyboard[0]?.[0]?.callback_data;
      assert.ok(confirmToken);

      await new Promise((resolve) => setTimeout(resolve, 15));
      await router.handleCallbackQuery(createCallback("1001", "cb-expired", confirmToken), createAuthContext());

      const confirmations = await getConfirmations(persistence);
      assert.equal(confirmations[0]?.status, DANGEROUS_ACTION_CONFIRMATION_STATUS.EXPIRED);
      assert.equal(bot.messages.at(-1)?.text.includes("inválida"), true);
    }
  );
}

async function verifyContextInvalidation(): Promise<void> {
  await withVerificationContext({}, async ({ bot, persistence, router, useCases }) => {
    await seedActiveBinding(useCases);
    await router.handleMessage(createMessage("1001", "/attach-local"), createAuthContext());

    const callbackData = bot.messages[0]?.options?.reply_markup;
    assert.ok(callbackData && "inline_keyboard" in callbackData);
    const confirmToken = callbackData.inline_keyboard[0]?.[0]?.callback_data;
    assert.ok(confirmToken);

    const switched = await useCases.selectProject({
      chatId: "1001",
      selector: "proj-other",
      rootPath: "/tmp/proj-other",
    });
    assert.equal(switched.ok, true);

    await router.handleCallbackQuery(createCallback("1001", "cb-stale", confirmToken), createAuthContext());

    const confirmations = await getConfirmations(persistence);
    assert.equal(confirmations[0]?.status, DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED);
    assert.equal(confirmations[0]?.invalidatedReason, "project-changed");
    assert.equal(bot.messages.at(-1)?.text.includes("ya procesada"), true);
  });
}

async function verifyEnvironmentUnavailableRevalidation(): Promise<void> {
  await withVerificationContext(
    {
      isLocalHostEnvironmentReady: async () => ({
        ok: false,
        reason: "tmux-missing",
      }),
    },
    async ({ bot, persistence, router, useCases, auditLines }) => {
      await seedActiveBinding(useCases);
      await router.handleMessage(createMessage("1001", "/attach-local"), createAuthContext());

      const callbackData = bot.messages[0]?.options?.reply_markup;
      assert.ok(callbackData && "inline_keyboard" in callbackData);
      const confirmToken = callbackData.inline_keyboard[0]?.[0]?.callback_data;
      assert.ok(confirmToken);

      await router.handleCallbackQuery(createCallback("1001", "cb-env", confirmToken), createAuthContext());

      const confirmations = await getConfirmations(persistence);
      assert.equal(confirmations[0]?.status, DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED);
      assert.equal(confirmations[0]?.invalidatedReason, "environment-unavailable");
      assert.equal(bot.messages.at(-1)?.text.includes("Confirmación sensible inválida"), true);
      assert.equal(auditLines.some((line) => line.includes('"reason":"environment-unavailable"')), true);
      assert.equal(auditLines.some((line) => line.includes('"result":"executed"')), false);
    }
  );
}

async function main(): Promise<void> {
  await verifyHelpHidesDangerousCommandWhenDisabled();
  await verifyPrivateOnlyRejectsWithoutSideEffects();
  await verifyArbitraryShellProhibitedAtRuntime();
  await verifyNormalFlowsStayClean();
  await verifyConfirmationFlowReplayAndAudit();
  await verifyConfirmationExpiry();
  await verifyContextInvalidation();
  await verifyEnvironmentUnavailableRevalidation();
  console.log("RFC-012 verification passed");
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(_code: (typeof ADAPTER_ERROR_CODES)[keyof typeof ADAPTER_ERROR_CODES], message: string): Result<never> {
  return {
    ok: false,
    error: new DomainError(ERROR_CODES.NOT_FOUND, message),
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

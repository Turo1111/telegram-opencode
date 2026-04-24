import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import {
  OpenCodeSessionAdapter,
  PersistenceUnit,
  Result,
  SESSION_EVENT_KIND,
  SessionEvent,
  SessionState,
  SendResult,
  ObserveSessionResult,
  CancelOrInterruptResult,
  WebhookAuthContext,
  PersistenceDriver,
} from "../application/contracts";
import { createSessionWatcherService } from "../application/session-watcher-service";
import { ACTIVE_TASK_STATUS, OPERATIONAL_MODES } from "../domain/entities";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { Config, STATE_DRIVERS, loadConfig } from "../config";
import {
  createSessionWebhookReceiver,
  type ReceiverHandlerResult,
} from "../infrastructure/http/session-webhook-receiver";
import {
  evaluateMessageAuthorization,
  registerTelegramIngress,
  TelegramIngressBot,
  TelegramIngressHandlers,
} from "../bot";
import { ChatLockManager } from "../application/chat-lock-manager";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

class VerificationAdapter implements OpenCodeSessionAdapter {
  async resolveProject(): Promise<Result<{ canonicalPath: string }>> {
    return { ok: true, value: { canonicalPath: "/tmp" } };
  }

  async createSession(): Promise<Result<SessionState>> {
    throw new Error("not used");
  }

  async attachSession(): Promise<Result<SessionState>> {
    throw new Error("not used");
  }

  async sendMessage(): Promise<Result<SendResult>> {
    throw new Error("not used");
  }

  async runCommand(): Promise<Result<SendResult>> {
    throw new Error("not used");
  }

  async getSessionState(): Promise<Result<SessionState>> {
    return {
      ok: false,
      error: new DomainError(ERROR_CODES.NOT_FOUND, "missing"),
    };
  }

  async cancelOrInterrupt(): Promise<Result<CancelOrInterruptResult>> {
    throw new Error("not used");
  }

  async observeSession(): Promise<Result<ObserveSessionResult>> {
    return { ok: true, value: { mode: "not-available-yet" } };
  }

  async submitPromptInput(): Promise<Result<{ status: "accepted"; message?: string }>> {
    return { ok: true, value: { status: "accepted" } };
  }
}

class FakeIngressBot implements TelegramIngressBot {
  private readonly messageListeners: Array<(msg: TelegramBot.Message) => void | Promise<void>> = [];
  private readonly callbackListeners: Array<(query: TelegramBot.CallbackQuery) => void | Promise<void>> = [];
  private readonly pollingErrorListeners: Array<(err: Error) => void> = [];

  callbackAnswers = 0;
  sentMessages = 0;

  on(event: "message", listener: (msg: TelegramBot.Message) => void | Promise<void>): TelegramIngressBot;
  on(event: "callback_query", listener: (query: TelegramBot.CallbackQuery) => void | Promise<void>): TelegramIngressBot;
  on(event: "polling_error", listener: (err: Error) => void): TelegramIngressBot;
  on(
    event: "message" | "callback_query" | "polling_error",
    listener:
      | ((msg: TelegramBot.Message) => void | Promise<void>)
      | ((query: TelegramBot.CallbackQuery) => void | Promise<void>)
      | ((err: Error) => void)
  ): TelegramIngressBot {
    if (event === "message") {
      this.messageListeners.push(listener as (msg: TelegramBot.Message) => void | Promise<void>);
      return this;
    }

    if (event === "callback_query") {
      this.callbackListeners.push(listener as (query: TelegramBot.CallbackQuery) => void | Promise<void>);
      return this;
    }

    this.pollingErrorListeners.push(listener as (err: Error) => void);
    return this;
  }

  async answerCallbackQuery(): Promise<TelegramBot.Message | boolean> {
    this.callbackAnswers += 1;
    return true;
  }

  async sendMessage(): Promise<TelegramBot.Message> {
    this.sentMessages += 1;
    return { message_id: this.sentMessages } as TelegramBot.Message;
  }

  async emitMessage(msg: TelegramBot.Message): Promise<void> {
    for (const listener of this.messageListeners) {
      await listener(msg);
    }
  }

  async emitCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    for (const listener of this.callbackListeners) {
      await listener(query);
    }
  }
}

class ProbeChatLockManager implements ChatLockManager {
  runExclusiveCalls = 0;

  async runExclusive<T>(_chatId: string, work: () => Promise<T>): Promise<T> {
    this.runExclusiveCalls += 1;
    return work();
  }

  getQueueDepth(): number {
    return 0;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCase(
  id: string,
  scenario: string,
  expected: string,
  run: () => Promise<string>
): Promise<ScenarioResult> {
  try {
    const actual = await run();
    return { id, scenario, expected, actual, ok: true };
  } catch (error) {
    return {
      id,
      scenario,
      expected,
      actual: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

function buildConfigFixture(tempDir: string): Config {
  return {
    telegramBotToken: "dummy",
    allowedUserIds: ["7001"],
    openCodeUrl: "http://127.0.0.1:3000",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath: path.join(tempDir, "state.json"),
    compatLegacyTextBridge: false,
    compatRunCmdCommands: true,
    bootRemoteReconcile: true,
    chatLockEnabled: true,
    lockWarnWaitMs: 1500,
    watcherEnabled: true,
    watchdogEnabled: true,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4540,
    webhookPortEnd: 4550,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000,
    watchdogMaxRetryCount: 2,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300000,
  };
}

function createMessage(chatId: string, actorId: number): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(chatId),
      type: "private",
    },
    from: {
      id: actorId,
      is_bot: false,
      first_name: "tester",
    },
    text: "/status",
  } as TelegramBot.Message;
}

function createCallbackQuery(chatId: string, actorId: number, queryId: string): TelegramBot.CallbackQuery {
  return {
    id: queryId,
    from: {
      id: actorId,
      is_bot: false,
      first_name: "tester",
    },
    chat_instance: "chat-instance",
    data: "prompt:abc:yes",
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: Number(chatId),
        type: "private",
      },
      text: "prompt",
    } as TelegramBot.Message,
  } as TelegramBot.CallbackQuery;
}

function createCallbackQueryWithoutActor(chatId: string, queryId: string): TelegramBot.CallbackQuery {
  return {
    id: queryId,
    chat_instance: "chat-instance",
    data: "prompt:abc:yes",
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: Number(chatId),
        type: "private",
      },
      text: "prompt",
    } as TelegramBot.Message,
  } as TelegramBot.CallbackQuery;
}

async function withWebhookHarness(
  run: (ctx: {
    readonly tempDir: string;
    readonly config: Config;
    readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
    readonly watcher: ReturnType<typeof createSessionWatcherService>;
    readonly receiver: Awaited<ReturnType<typeof createSessionWebhookReceiver>>;
    readonly registration: ReturnType<ReturnType<typeof createSessionWatcherService>["createRegistration"]>;
  }) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc9-security-auth-"));
  const config = buildConfigFixture(tempDir);
  const persistence = await createJsonPersistenceDriver(config);
  const adapter = new VerificationAdapter();

  let handler: (auth: WebhookAuthContext, event: SessionEvent) => Promise<ReceiverHandlerResult> = async () => ({
    statusCode: 503,
    body: { ok: false },
  });

  const receiver = await createSessionWebhookReceiver({
    config,
    onEvent: async (auth, event) => handler(auth, event),
  });

  const watcher = createSessionWatcherService({
    config,
    persistence,
    adapter,
    callbackUrl: receiver.callbackUrl,
    notify: async () => undefined,
  });

  const registration = watcher.createRegistration();
  handler = watcher.handleIncomingEvent;

  try {
    await run({
      tempDir,
      config,
      persistence,
      watcher,
      receiver,
      registration,
    });
  } finally {
    watcher.stopScheduler();
    await receiver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function seedSessionFixture(input: {
  readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
  readonly tempDir: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly chatId: string;
  readonly taskId?: string;
  readonly watcherToken?: string;
  readonly watcherCallbackUrl?: string;
}): Promise<void> {
  await input.persistence.runInTransaction(async (unit) => {
    await unit.projects.upsert({
      projectId: input.projectId,
      alias: input.projectId,
      rootPath: input.tempDir,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    await unit.sessions.upsert({
      sessionId: input.sessionId,
      projectId: input.projectId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      watcherEnabled: true,
      watcherToken: input.watcherToken,
      watcherCallbackUrl: input.watcherCallbackUrl,
    });

    await unit.bindings.upsert({
      chatId: input.chatId,
      activeProjectId: input.projectId,
      activeSessionId: input.sessionId,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    if (input.taskId) {
      await unit.states.upsert({
        chatId: input.chatId,
        mode: OPERATIONAL_MODES.TASK_RUNNING,
        activeTaskId: input.taskId,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      await unit.tasks.upsert({
        taskId: input.taskId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        status: ACTIVE_TASK_STATUS.IN_PROGRESS,
        command: "npm test",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      return;
    }

    await unit.states.upsert({
      chatId: input.chatId,
      mode: OPERATIONAL_MODES.SESSION_LINKED,
      activeTaskId: undefined,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

async function postWebhook(url: string, bearerToken: string | undefined, sessionId: string): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (bearerToken !== undefined) {
    headers.Authorization = bearerToken;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event: SESSION_EVENT_KIND.COMPLETED,
      session_id: sessionId,
      timestamp: new Date().toISOString(),
    }),
  });

  return response.status;
}

async function withPatchedEnv(patch: Readonly<Record<string, string | undefined>>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }
}

function buildBaseEnv(): Record<string, string> {
  return {
    TELEGRAM_BOT_TOKEN: "dummy",
    OPEN_CODE_URL: "http://127.0.0.1:3000",
    OPEN_CODE_TOKEN: "dev-token",
    ALLOWED_USER_ID: "7001",
    WEBHOOK_HOST: "127.0.0.1",
    WEBHOOK_PORT_START: "4540",
    WEBHOOK_PORT_END: "4550",
  };
}

function createStaleBindingRacePersistence(
  inner: Awaited<ReturnType<typeof createJsonPersistenceDriver>>,
  options: {
    readonly raceChatId: string;
    readonly raceProjectId: string;
  }
): PersistenceDriver {
  let txCount = 0;

  return {
    async runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T> {
      txCount += 1;
      if (txCount === 2) {
        await inner.runInTransaction(async (unit) => {
          await unit.bindings.upsert({
            chatId: options.raceChatId,
            activeProjectId: options.raceProjectId,
            activeSessionId: "sess-race-other",
            updatedAt: new Date().toISOString(),
          });
        });
      }

      return inner.runInTransaction(work);
    },
  };
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  results.push(
    await runCase("CFG-01", "Config fail-fast without ALLOWED_USER_ID", "startup fails before boot", async () => {
      await withPatchedEnv(
        {
          ...buildBaseEnv(),
          ALLOWED_USER_ID: undefined,
          ALLOWED_USER_IDS: undefined,
        },
        async () => {
          let failed = false;
          try {
            loadConfig();
          } catch (error) {
            failed = true;
            assert(String(error).includes("Missing required env var: ALLOWED_USER_ID"), "missing explicit allowlist error");
          }

          assert(failed, "config should fail without ALLOWED_USER_ID");
        }
      );

      return "fail-fast validated";
    })
  );

  results.push(
    await runCase("CFG-02", "Config fail-fast on placeholder allowlist", "placeholder is rejected", async () => {
      await withPatchedEnv(
        {
          ...buildBaseEnv(),
          ALLOWED_USER_ID: "7001",
          ALLOWED_USER_IDS: "replace_me",
        },
        async () => {
          let failed = false;
          try {
            loadConfig();
          } catch (error) {
            failed = true;
            assert(String(error).includes("placeholder value"), "missing placeholder-specific error");
          }

          assert(failed, "config should fail for placeholder allowlist value");
        }
      );

      return "placeholder rejection validated";
    })
  );

  results.push(
    await runCase(
      "CFG-03",
      "Single-user mandatory configuration succeeds",
      "loadConfig succeeds with one effective allowlist entry from ALLOWED_USER_ID",
      async () => {
        await withPatchedEnv(
          {
            ...buildBaseEnv(),
            ALLOWED_USER_ID: "7001",
            ALLOWED_USER_IDS: undefined,
          },
          async () => {
            const config = loadConfig();
            assert(config.allowedUserIds.length === 1, `expected one allowlist entry, got ${config.allowedUserIds.length}`);
            assert(config.allowedUserIds[0] === "7001", `expected allowlist entry 7001, got ${config.allowedUserIds[0]}`);
          }
        );

        return "single-user allowlist boot validated";
      }
    )
  );

  results.push(
    await runCase(
      "CFG-04",
      "Unsafe non-loopback webhook host is rejected",
      "loadConfig fails fast for WEBHOOK_HOST=0.0.0.0",
      async () => {
        await withPatchedEnv(
          {
            ...buildBaseEnv(),
            WEBHOOK_HOST: "0.0.0.0",
          },
          async () => {
            let failed = false;
            try {
              loadConfig();
            } catch (error) {
              failed = true;
              assert(String(error).includes("Invalid loopback host for WEBHOOK_HOST"), "missing loopback host explicit error");
            }

            assert(failed, "config should fail for non-loopback webhook host");
          }
        );

        return "unsafe host fail-fast validated";
      }
    )
  );

  results.push(
    await runCase(
      "ING-01",
      "Unauthorized message+callback are silently dropped",
      "no handlers invoked and no lock acquired",
      async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc9-ingress-unauth-"));
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        let messageCalls = 0;
        let callbackCalls = 0;

        const handlers: TelegramIngressHandlers = {
          messageHandler: async () => {
            messageCalls += 1;
          },
          callbackQueryHandler: async () => {
            callbackCalls += 1;
          },
        };

        try {
          registerTelegramIngress({
            bot,
            config: buildConfigFixture(tempDir),
            chatLockManager: lock,
            handlers,
          });

          await bot.emitMessage(createMessage("9001", 9999));
          await bot.emitCallbackQuery(createCallbackQuery("9001", 9999, "cb-unauth"));

          assert(messageCalls === 0, "unauthorized message should not reach handler");
          assert(callbackCalls === 0, "unauthorized callback should not reach handler");
          assert(lock.runExclusiveCalls === 0, "unauthorized updates should not acquire lock");
          assert(bot.callbackAnswers === 0, "silent-drop should not answer callback_query");
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }

        return "silent-drop validated for message+callback";
      }
    )
  );

  results.push(
    await runCase(
      "ING-02",
      "Authorized message+callback preserve ingress behavior",
      "both handlers executed and lock acquired twice",
      async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc9-ingress-auth-"));
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        let messageCalls = 0;
        let callbackCalls = 0;

        const handlers: TelegramIngressHandlers = {
          messageHandler: async () => {
            messageCalls += 1;
          },
          callbackQueryHandler: async () => {
            callbackCalls += 1;
          },
        };

        try {
          registerTelegramIngress({
            bot,
            config: buildConfigFixture(tempDir),
            chatLockManager: lock,
            handlers,
          });

          await bot.emitMessage(createMessage("7001", 7001));
          await bot.emitCallbackQuery(createCallbackQuery("7001", 7001, "cb-auth"));

          assert(messageCalls === 1, "authorized message should reach handler");
          assert(callbackCalls === 1, "authorized callback should reach handler");
          assert(lock.runExclusiveCalls === 2, "authorized message+callback should acquire lock twice");
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }

        return "authorized flow preserved";
      }
    )
  );

  results.push(
    await runCase(
      "ING-03",
      "Callback query without from.id is unauthorized",
      "callback silently dropped without lock or handler execution",
      async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc9-ingress-callback-missing-actor-"));
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        let callbackCalls = 0;

        const handlers: TelegramIngressHandlers = {
          messageHandler: async () => undefined,
          callbackQueryHandler: async () => {
            callbackCalls += 1;
          },
        };

        try {
          registerTelegramIngress({
            bot,
            config: buildConfigFixture(tempDir),
            chatLockManager: lock,
            handlers,
          });

          await bot.emitCallbackQuery(createCallbackQueryWithoutActor("7001", "cb-missing-actor"));

          assert(callbackCalls === 0, "callback without actor should not reach handler");
          assert(lock.runExclusiveCalls === 0, "callback without actor should not acquire lock");
          assert(bot.callbackAnswers === 0, "silent-drop should not answer callback_query without actor");
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }

        return "missing-actor callback rejected with silent-drop";
      }
    )
  );

  results.push(
    await runCase(
      "MIG-01",
      "Migration compatibility with existing ALLOWED_USER_ID-only env",
      "single-user env remains authorized and unchanged after RFC9",
      async () => {
        await withPatchedEnv(
          {
            ...buildBaseEnv(),
            ALLOWED_USER_ID: "7001",
            ALLOWED_USER_IDS: undefined,
          },
          async () => {
            const config = loadConfig();
            assert(config.allowedUserIds.length === 1, `expected one allowlist entry, got ${config.allowedUserIds.length}`);

            const decision = evaluateMessageAuthorization(new Set(config.allowedUserIds), createMessage("7001", 7001));
            assert(decision.authorized, "ALLOWED_USER_ID-only env should keep authorized flow valid");
            assert(decision.actorId === "7001", `expected actorId 7001, got ${decision.actorId}`);
          }
        );

        return "legacy ALLOWED_USER_ID path remains valid";
      }
    )
  );

  results.push(
    await runCase("WEB-01", "Webhook missing/malformed auth", "both return 401", async () => {
      await withWebhookHarness(async ({ receiver }) => {
        const missingStatus = await postWebhook(receiver.callbackUrl, undefined, "sess-auth");
        const malformedStatus = await postWebhook(receiver.callbackUrl, "Bearer token trailing", "sess-auth");

        assert(missingStatus === 401, `missing auth should be 401, got ${missingStatus}`);
        assert(malformedStatus === 401, `malformed auth should be 401, got ${malformedStatus}`);
      });

      return "401 contract validated";
    })
  );

  results.push(
    await runCase("WEB-02", "Webhook invalid token", "returns 403", async () => {
      await withWebhookHarness(async ({ persistence, tempDir, receiver, registration }) => {
        await seedSessionFixture({
          persistence,
          tempDir,
          projectId: "proj-auth",
          sessionId: "sess-auth",
          chatId: "7001",
          taskId: "task-auth",
          watcherToken: registration.bearerToken,
          watcherCallbackUrl: receiver.callbackUrl,
        });

        const status = await postWebhook(receiver.callbackUrl, "Bearer not-the-session-token", "sess-auth");
        assert(status === 403, `invalid token should be 403, got ${status}`);
      });

      return "403 contract validated";
    })
  );

  results.push(
    await runCase("WEB-03", "Webhook unknown session", "returns 404", async () => {
      await withWebhookHarness(async ({ receiver, registration }) => {
        const status = await postWebhook(receiver.callbackUrl, `Bearer ${registration.bearerToken}`, "sess-unknown");
        assert(status === 404, `unknown session should be 404, got ${status}`);
      });

      return "404 contract validated";
    })
  );

  results.push(
    await runCase("WEB-04", "Webhook stale binding race", "returns 409", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc9-webhook-race-"));
      const config = buildConfigFixture(tempDir);
      const persistence = await createJsonPersistenceDriver(config);
      const adapter = new VerificationAdapter();

      let handler: (auth: WebhookAuthContext, event: SessionEvent) => Promise<ReceiverHandlerResult> = async () => ({
        statusCode: 503,
        body: { ok: false },
      });

      const receiver = await createSessionWebhookReceiver({
        config,
        onEvent: async (auth, event) => handler(auth, event),
      });

      const racedPersistence = createStaleBindingRacePersistence(persistence, {
        raceChatId: "7001",
        raceProjectId: "proj-race",
      });

      const watcher = createSessionWatcherService({
        config,
        persistence: racedPersistence,
        adapter,
        callbackUrl: receiver.callbackUrl,
        notify: async () => undefined,
      });

      const registration = watcher.createRegistration();
      handler = watcher.handleIncomingEvent;

      try {
        await seedSessionFixture({
          persistence,
          tempDir,
          projectId: "proj-race",
          sessionId: "sess-race",
          chatId: "7001",
          taskId: "task-race",
          watcherToken: registration.bearerToken,
          watcherCallbackUrl: receiver.callbackUrl,
        });

        const status = await postWebhook(receiver.callbackUrl, `Bearer ${registration.bearerToken}`, "sess-race");
        assert(status === 409, `stale binding should be 409, got ${status}`);
      } finally {
        watcher.stopScheduler();
        await receiver.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }

      return "409 contract validated";
    })
  );

  results.push(
    await runCase(
      "REPLAY-01",
      "Replay with old token after terminal event",
      "first request 202, replay 403",
      async () => {
        await withWebhookHarness(async ({ persistence, tempDir, receiver, registration }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-terminal",
            sessionId: "sess-terminal",
            chatId: "7001",
            taskId: "task-terminal",
            watcherToken: registration.bearerToken,
            watcherCallbackUrl: receiver.callbackUrl,
          });

          const firstStatus = await postWebhook(receiver.callbackUrl, `Bearer ${registration.bearerToken}`, "sess-terminal");
          const replayStatus = await postWebhook(receiver.callbackUrl, `Bearer ${registration.bearerToken}`, "sess-terminal");

          assert(firstStatus === 202, `first terminal event should be 202, got ${firstStatus}`);
          assert(replayStatus === 403, `replay after terminal should be 403, got ${replayStatus}`);
        });

        return "terminal replay blocked";
      }
    )
  );

  results.push(
    await runCase("REPLAY-02", "Replay with old token after restart", "restore invalidates token and replay is 403", async () => {
      await withWebhookHarness(async ({ persistence, tempDir, receiver, registration, watcher }) => {
        await seedSessionFixture({
          persistence,
          tempDir,
          projectId: "proj-restart",
          sessionId: "sess-restart",
          chatId: "7001",
          taskId: "task-restart",
          watcherToken: registration.bearerToken,
          watcherCallbackUrl: receiver.callbackUrl,
        });

        await watcher.restoreAfterRestart("2026-01-01T00:02:00.000Z");

        const replayStatus = await postWebhook(receiver.callbackUrl, `Bearer ${registration.bearerToken}`, "sess-restart");
        assert(replayStatus === 403, `replay after restart should be 403, got ${replayStatus}`);
      });

      return "restart replay blocked";
    })
  );

  const lines = [
    "RFC-009 Security/Auth Verification",
    "",
    "| ID | Scenario | Expected | Actual | Result |",
    "|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.scenario} | ${result.expected} | ${result.actual.replace(/\|/gu, "\\|")} | ${
          result.ok ? "PASS" : "FAIL"
        } |`
    ),
  ];

  const passed = results.filter((result) => result.ok).length;
  lines.push("", `Resumen: ${passed}/${results.length} escenarios PASS.`);
  const output = lines.join("\n");

  if (passed !== results.length) {
    // eslint-disable-next-line no-console
    console.error(output);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(output);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("No pude ejecutar verificación RFC9", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

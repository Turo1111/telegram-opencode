import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { createTelegramRouter } from "../adapters/telegram/router";
import { sendAsyncSessionNotice } from "../adapters/telegram/message-sender";
import {
  ApplicationUseCases,
  createApplicationUseCases,
  SUBMIT_PENDING_PROMPT_RESULT_STATUS,
} from "../application/use-cases";
import {
  AsyncSessionNotice,
  CancelOrInterruptResult,
  ObserveSessionResult,
  OpenCodeSessionAdapter,
  Result,
  SendResult,
  SESSION_EVENT_KIND,
  SessionEvent,
  SessionState,
  SessionWatcherRegistration,
  SubmitPromptInputResult,
  WebhookAuthContext,
} from "../application/contracts";
import { Config } from "../config";
import {
  ACTIVE_TASK_STATUS,
  OPERATIONAL_MODES,
  PENDING_PROMPT_STATUS,
  PROMPT_TYPE,
  PendingPrompt,
} from "../domain/entities";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { createSessionWebhookReceiver, ReceiverHandlerResult } from "../infrastructure/http/session-webhook-receiver";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { createSessionWatcherService } from "../application/session-watcher-service";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

class FakeBot {
  readonly sentMessages: Array<{
    readonly chatId: number;
    readonly text: string;
    readonly options?: TelegramBot.SendMessageOptions;
  }> = [];
  readonly callbackAnswers: Array<{ readonly id: string; readonly text?: string }> = [];
  readonly editTextCalls: Array<{ readonly chatId: number; readonly messageId: number; readonly text: string }> = [];
  readonly editMarkupCalls: Array<{ readonly chatId: number; readonly messageId: number }> = [];

  failSend = false;
  failEditText = false;
  failEditMarkup = false;

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions): Promise<TelegramBot.Message> {
    if (this.failSend) {
      throw new Error("ETELEGRAM send failed");
    }

    this.sentMessages.push({ chatId, text, options });
    return {
      message_id: this.sentMessages.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      text,
    } as TelegramBot.Message;
  }

  async answerCallbackQuery(id: string, options?: TelegramBot.AnswerCallbackQueryOptions): Promise<void> {
    this.callbackAnswers.push({ id, text: options?.text });
  }

  async editMessageText(text: string, options: TelegramBot.EditMessageTextOptions): Promise<void> {
    this.editTextCalls.push({
      chatId: Number(options.chat_id),
      messageId: Number(options.message_id),
      text,
    });

    if (this.failEditText) {
      throw new Error("ETELEGRAM editMessageText failed");
    }
  }

  async editMessageReplyMarkup(
    _replyMarkup: TelegramBot.InlineKeyboardMarkup,
    options: TelegramBot.EditMessageReplyMarkupOptions
  ): Promise<void> {
    this.editMarkupCalls.push({
      chatId: Number(options.chat_id),
      messageId: Number(options.message_id),
    });

    if (this.failEditMarkup) {
      throw new Error("ETELEGRAM editMessageReplyMarkup failed");
    }
  }
}

class FakeAdapter implements OpenCodeSessionAdapter {
  private readonly states = new Map<string, SessionState>();
  submitCalls: number = 0;
  submitFailure?: DomainError;

  seedState(state: SessionState): void {
    this.states.set(state.sessionId, state);
  }

  async resolveProject(input: { projectId: string }): Promise<Result<{ canonicalPath: string }>> {
    return { ok: true, value: { canonicalPath: input.projectId } };
  }

  async createSession(input: { projectId: string }): Promise<Result<SessionState>> {
    return {
      ok: true,
      value: {
        sessionId: "sess-created",
        projectId: input.projectId,
        status: "idle",
      },
    };
  }

  async attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    return {
      ok: true,
      value: {
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "idle",
      },
    };
  }

  async sendMessage(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SendResult>> {
    return {
      ok: true,
      value: {
        message: "ok",
        state: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: "idle",
        },
      },
    };
  }

  async runCommand(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SendResult>> {
    return {
      ok: true,
      value: {
        message: "run-ok",
        state: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: "idle",
        },
      },
    };
  }

  async getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const state = this.states.get(input.sessionId);
    if (!state) {
      return {
        ok: true,
        value: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: "running",
        },
      };
    }

    return { ok: true, value: state };
  }

  async cancelOrInterrupt(_input: { projectId: string; sessionId: string; chatId: string }): Promise<Result<CancelOrInterruptResult>> {
    return {
      ok: true,
      value: {
        status: "accepted",
      },
    };
  }

  async observeSession(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>> {
    return {
      ok: true,
      value: {
        mode: "not-available-yet",
      },
    };
  }

  async submitPromptInput(_input: {
    projectId: string;
    sessionId: string;
    promptId: string;
    input: string;
    source: "telegram" | "pc";
  }): Promise<Result<SubmitPromptInputResult>> {
    this.submitCalls += 1;

    if (this.submitFailure) {
      return {
        ok: false,
        error: this.submitFailure,
      };
    }

    return {
      ok: true,
      value: {
        status: "accepted",
      },
    };
  }
}

class PolicyOnlyUseCases implements ApplicationUseCases {
  createSessionCalls = 0;
  sendTextCalls = 0;

  constructor(
    private readonly mode: "task-running" | "needs-attention",
    private readonly projectId: string,
    private readonly sessionId: string
  ) {}

  async selectProject(): Promise<Result<{ projectId: string; alias: string }>> {
    return {
      ok: true,
      value: { projectId: this.projectId, alias: this.projectId },
    };
  }

  async attachSession(): Promise<Result<{ projectId: string; sessionId: string }>> {
    return {
      ok: true,
      value: { projectId: this.projectId, sessionId: this.sessionId },
    };
  }

  async createSession(): Promise<Result<{ projectId: string; sessionId: string }>> {
    this.createSessionCalls += 1;
    return {
      ok: true,
      value: { projectId: this.projectId, sessionId: this.sessionId },
    };
  }

  async sendText(): Promise<Result<any>> {
    this.sendTextCalls += 1;
    return {
      ok: true,
      value: {
        projectId: this.projectId,
        sessionId: this.sessionId,
        message: "ok",
        needsAttention: false,
        state: {
          projectId: this.projectId,
          sessionId: this.sessionId,
          status: "idle",
        },
      },
    };
  }

  async runSessionCommand(): Promise<Result<any>> {
    return {
      ok: true,
      value: {
        projectId: this.projectId,
        sessionId: this.sessionId,
        message: "ok",
        needsAttention: false,
        state: {
          projectId: this.projectId,
          sessionId: this.sessionId,
          status: "idle",
        },
      },
    };
  }

  async submitPendingPrompt(): Promise<Result<any>> {
    return {
      ok: true,
      value: {
        projectId: this.projectId,
        sessionId: this.sessionId,
        promptId: "prompt-x",
        status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT,
        promptStatus: PENDING_PROMPT_STATUS.INVALIDATED,
      },
    };
  }

  async cancelSession(): Promise<Result<any>> {
    return {
      ok: true,
      value: {
        projectId: this.projectId,
        sessionId: this.sessionId,
        status: "accepted",
        message: "ok",
      },
    };
  }

  async getStatus(_chatId: string): Promise<Result<any>> {
    return {
      ok: true,
      value: {
        mode: this.mode,
        projectId: this.projectId,
        projectAlias: this.projectId,
        sessionId: this.sessionId,
        activeTaskId: this.mode === "task-running" ? "task-1" : undefined,
      },
    };
  }
}

interface HarnessContext {
  readonly tempDir: string;
  readonly config: Config;
  readonly adapter: FakeAdapter;
  readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
  readonly watcher: ReturnType<typeof createSessionWatcherService>;
  readonly notices: AsyncSessionNotice[];
  readonly receiver: Awaited<ReturnType<typeof createSessionWebhookReceiver>>;
  readonly registration: SessionWatcherRegistration;
}

async function withHarness(
  fixtureName: string,
  humanPromptsEnabled: boolean,
  run: (ctx: HarnessContext) => Promise<string>
): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${fixtureName}-`));
  const notices: AsyncSessionNotice[] = [];
  const adapter = new FakeAdapter();
  const config = buildConfig(tempDir, humanPromptsEnabled);
  const persistence = await createJsonPersistenceDriver(config);

  let onEvent: (auth: WebhookAuthContext, event: SessionEvent) => Promise<ReceiverHandlerResult> = async () => ({
    statusCode: 503,
    body: { ok: false },
  });

  const receiver = await createSessionWebhookReceiver({
    config,
    onEvent: async (auth, event) => onEvent(auth, event),
  });

  const watcher = createSessionWatcherService({
    config,
    persistence,
    adapter,
    callbackUrl: receiver.callbackUrl,
    notify: async (notice) => {
      notices.push(notice);
    },
  });

  onEvent = watcher.handleIncomingEvent;
  const registration = watcher.createRegistration();

  try {
    return await run({
      tempDir,
      config,
      adapter,
      persistence,
      watcher,
      notices,
      receiver,
      registration,
    });
  } finally {
    watcher.stopScheduler();
    await receiver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function buildConfig(tempDir: string, humanPromptsEnabled: boolean): Config {
  return {
    telegramBotToken: "dummy",
    allowedUserIds: ["8001"],
    openCodeUrl: "http://127.0.0.1:3000",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: "json",
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
    webhookPortStart: 4400,
    webhookPortEnd: 4410,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1,
    watchdogMaxRetryCount: 3,
    humanPromptsEnabled,
    humanPromptLocalTtlMs: 1000,
  };
}

async function seedSessionFixture(input: {
  readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
  readonly tempDir: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly chatId: string;
  readonly watcherToken?: string;
  readonly watcherCallbackUrl?: string;
  readonly mode: "task-running" | "needs-attention" | "session-linked";
  readonly taskId?: string;
  readonly lastObservedAt?: string;
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
      lastObservedAt: input.lastObservedAt,
    });

    await unit.bindings.upsert({
      chatId: input.chatId,
      activeProjectId: input.projectId,
      activeSessionId: input.sessionId,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await unit.states.upsert({
      chatId: input.chatId,
      mode:
        input.mode === "task-running"
          ? OPERATIONAL_MODES.TASK_RUNNING
          : input.mode === "needs-attention"
            ? OPERATIONAL_MODES.NEEDS_ATTENTION
            : OPERATIONAL_MODES.SESSION_LINKED,
      activeTaskId: input.mode === "task-running" ? input.taskId ?? "task-1" : undefined,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    if (input.mode === "task-running") {
      await unit.tasks.upsert({
        taskId: input.taskId ?? "task-1",
        chatId: input.chatId,
        sessionId: input.sessionId,
        status: ACTIVE_TASK_STATUS.IN_PROGRESS,
        command: "npm test",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }
  });
}

function createMessage(chatId: string, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(chatId),
      type: "private",
    },
    text,
  } as TelegramBot.Message;
}

function createCallbackQuery(chatId: string, callbackData: string, queryId = "cb-1"): TelegramBot.CallbackQuery {
  return {
    id: queryId,
    from: {
      id: 1,
      is_bot: false,
      first_name: "tester",
    },
    chat_instance: "chat-instance",
    data: callbackData,
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

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  results.push(
    await runCase(
      "S01",
      "Success prompt boolean end-to-end",
      "inline keyboard + callback submit/resolved",
      async () =>
        withHarness("rfc8-success", true, async (ctx) => {
          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-1",
            sessionId: "sess-1",
            chatId: "8001",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "task-running",
            taskId: "task-1",
          });

          const eventResult = await ctx.watcher.handleIncomingEvent(
            { bearerToken: ctx.registration.bearerToken },
            {
              kind: SESSION_EVENT_KIND.NEEDS_INPUT,
              sessionId: "sess-1",
              projectId: "proj-1",
              occurredAt: "2026-01-01T00:00:01.000Z",
              data: {
                prompt_id: "prompt-1",
                prompt_type: "boolean",
                message: "¿Autorizar?",
                options: ["Sí", "No"],
              },
            }
          );

          assert(eventResult.body.ok === true, "needs-input webhook debería aceptarse");
          assert(ctx.notices.length === 1, "debería emitirse un async notice needs-input");

          const bot = new FakeBot();
          await sendAsyncSessionNotice({
            bot: bot as unknown as TelegramBot,
            notice: ctx.notices[0],
            persistence: ctx.persistence,
          });

          const sent = bot.sentMessages[0];
          assert(Boolean(sent), "debería enviarse prompt a Telegram");
          assert(Boolean(sent.options?.reply_markup), "prompt boolean debería usar inline keyboard");

          const persistedPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-1")
          );
          assert(persistedPrompt?.telegramMessageId === 1, "debería persistir referencia telegram_message_id");

          const useCases = createApplicationUseCases({
            persistence: ctx.persistence,
            adapter: ctx.adapter,
          });
          const router = createTelegramRouter({
            bot: bot as unknown as TelegramBot,
            useCases,
            persistence: ctx.persistence,
            compatRunCmdCommands: true,
          });

          await router.handleCallbackQuery(createCallbackQuery("8001", "prompt:prompt-1:yes"));
          assert(ctx.adapter.submitCalls === 1, "callback debería bridgear una sola vez");

          const resolvedPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-1")
          );
          assert(resolvedPrompt?.status === PENDING_PROMPT_STATUS.RESOLVED, "prompt debería quedar resolved");
          return "inline + submit/resolved OK";
        })
    )
  );

  results.push(
    await runCase(
      "S02",
      "PC handoff first + late callback",
      "prompt invalidated and callback idempotent",
      async () =>
        withHarness("rfc8-handoff", true, async (ctx) => {
          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-2",
            sessionId: "sess-2",
            chatId: "8002",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "needs-attention",
          });

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-2",
              projectId: "proj-2",
              sessionId: "sess-2",
              chatId: "8002",
              promptType: PROMPT_TYPE.BOOLEAN,
              message: "¿seguimos?",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              telegramChatId: "8002",
              telegramMessageId: 10,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          await ctx.watcher.handleIncomingEvent(
            { bearerToken: ctx.registration.bearerToken },
            {
              kind: SESSION_EVENT_KIND.STARTED,
              sessionId: "sess-2",
              projectId: "proj-2",
              occurredAt: "2026-01-01T00:00:02.000Z",
            }
          );

          const invalidatedPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-2")
          );
          assert(invalidatedPrompt?.status === PENDING_PROMPT_STATUS.INVALIDATED, "prompt debería invalidarse por handoff");

          const bot = new FakeBot();
          const useCases = createApplicationUseCases({
            persistence: ctx.persistence,
            adapter: ctx.adapter,
          });
          const router = createTelegramRouter({
            bot: bot as unknown as TelegramBot,
            useCases,
            persistence: ctx.persistence,
            compatRunCmdCommands: true,
          });

          await router.handleCallbackQuery(createCallbackQuery("8002", "prompt:prompt-2:yes", "cb-late"));

          assert(ctx.adapter.submitCalls === 0, "callback tardío no debe bridgear");
          const answer = bot.callbackAnswers.find((entry) => entry.id === "cb-late")?.text;
          assert(answer?.includes("Prompt ya resuelto/no vigente") ?? false, "faltó ack idempotente para callback tardío");
          return "handoff invalidó prompt + callback tardío idempotente";
        })
    )
  );

  results.push(
    await runCase(
      "S03",
      "Timeout watchdog",
      "prompt active pasa a expired",
      async () =>
        withHarness("rfc8-timeout", true, async (ctx) => {
          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-3",
            sessionId: "sess-3",
            chatId: "8003",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "needs-attention",
            lastObservedAt: "2026-01-01T00:00:00.000Z",
          });

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-3",
              projectId: "proj-3",
              sessionId: "sess-3",
              chatId: "8003",
              promptType: PROMPT_TYPE.TEXT,
              message: "escribí algo",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          ctx.adapter.seedState({
            sessionId: "sess-3",
            projectId: "proj-3",
            status: "running",
          });

          await ctx.watcher.runWatchdogSweep("2026-01-01T00:00:03.000Z");

          const expiredPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-3")
          );
          assert(expiredPrompt?.status === PENDING_PROMPT_STATUS.EXPIRED, "watchdog debería expirar prompt vencido");
          return "prompt expired por TTL local";
        })
    )
  );

  results.push(
    await runCase(
      "S04",
      "Bridge error compensation",
      "submitted revierte a active y limpia meta",
      async () =>
        withHarness("rfc8-bridge-error", true, async (ctx) => {
          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-4",
            sessionId: "sess-4",
            chatId: "8004",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "needs-attention",
          });

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-4",
              projectId: "proj-4",
              sessionId: "sess-4",
              chatId: "8004",
              promptType: PROMPT_TYPE.BOOLEAN,
              message: "¿confirmás?",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          ctx.adapter.submitFailure = new DomainError(ERROR_CODES.UPSTREAM_TIMEOUT, "timeout bridge");
          const useCases = createApplicationUseCases({
            persistence: ctx.persistence,
            adapter: ctx.adapter,
          });

          const submitResult = await useCases.submitPendingPrompt({
            chatId: "8004",
            sessionId: "sess-4",
            promptId: "prompt-4",
            choice: "yes",
            callbackQueryId: "cb-err",
          });

          assert(!submitResult.ok, "bridge error debería propagarse como error");

          const recoveredPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-4")
          );
          assert(recoveredPrompt?.status === PENDING_PROMPT_STATUS.ACTIVE, "debería revertir a active");
          assert(recoveredPrompt?.submittedInput === undefined, "debería limpiar submitted_input");
          assert(recoveredPrompt?.telegramCallbackQueryId === undefined, "debería limpiar callback_query_id");
          return "fallback CAS OK";
        })
    )
  );

  results.push(
    await runCase(
      "S05",
      "Telegram delivery/edit error paths",
      "delivery falla explícito y cleanup usa fallback sin tirar",
      async () =>
        withHarness("rfc8-telegram-errors", true, async (ctx) => {
          const bot = new FakeBot();
          bot.failSend = true;

          let sendFailed = false;
          try {
            await sendAsyncSessionNotice({
              bot: bot as unknown as TelegramBot,
              notice: {
                chatId: "8005",
                kind: "needs-input",
                projectId: "proj-5",
                sessionId: "sess-5",
                summary: "confirmá",
                prompt: {
                  promptId: "prompt-5",
                  promptType: PROMPT_TYPE.BOOLEAN,
                  message: "¿ok?",
                  options: ["Sí", "No"],
                },
              },
              persistence: ctx.persistence,
            });
          } catch {
            sendFailed = true;
          }

          assert(sendFailed, "error de delivery debe quedar visible (no swallow)");

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-5-clean",
              projectId: "proj-5",
              sessionId: "sess-5",
              chatId: "8005",
              promptType: PROMPT_TYPE.BOOLEAN,
              message: "cleanup",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              telegramChatId: "8005",
              telegramMessageId: 77,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          const cleanupBot = new FakeBot();
          cleanupBot.failEditText = true;
          cleanupBot.failEditMarkup = true;

          await sendAsyncSessionNotice({
            bot: cleanupBot as unknown as TelegramBot,
            notice: {
              chatId: "8005",
              kind: "terminal",
              projectId: "proj-5",
              sessionId: "sess-5",
              promptCleanup: {
                promptId: "prompt-5-clean",
                telegramChatId: "8005",
                telegramMessageId: 77,
                reason: "invalidated",
              },
            },
            persistence: ctx.persistence,
          });

          assert(cleanupBot.editTextCalls.length === 1, "debería intentar editMessageText");
          assert(cleanupBot.editMarkupCalls.length === 1, "debería fallback a editMessageReplyMarkup");

          const cleanedPrompt = await ctx.persistence.runInTransaction((unit) =>
            unit.pendingPrompts.findByPromptId("prompt-5-clean")
          );
          assert(cleanedPrompt?.status === PENDING_PROMPT_STATUS.INVALIDATED, "cleanup debería persistir estado invalidated");
          return "delivery/edit error paths cubiertos";
        })
    )
  );

  results.push(
    await runCase(
      "S06",
      "Busy lock + needs-attention compatibility",
      "sin concurrencia en busy y texto libre bloqueado en prompt no-text",
      async () =>
        withHarness("rfc8-busy-needs", true, async (ctx) => {
          const busyBot = new FakeBot();
          const busyUseCases = new PolicyOnlyUseCases("task-running", "proj-6", "sess-6");
          const busyRouter = createTelegramRouter({
            bot: busyBot as unknown as TelegramBot,
            useCases: busyUseCases,
            compatRunCmdCommands: true,
          });

          await busyRouter.handleMessage(createMessage("8006", "/new"));
          assert(busyUseCases.createSessionCalls === 0, "busy no debe ejecutar /new concurrente");
          const busyMsg = busyBot.sentMessages[0]?.text ?? "";
          assert(busyMsg.includes("Comando bloqueado por tarea en curso"), "faltó rechazo explícito en busy");

          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-6",
            sessionId: "sess-6",
            chatId: "8006",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "needs-attention",
          });

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-6",
              projectId: "proj-6",
              sessionId: "sess-6",
              chatId: "8006",
              promptType: PROMPT_TYPE.BOOLEAN,
              message: "solo botones",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          const needsBot = new FakeBot();
          const needsUseCases = new PolicyOnlyUseCases("needs-attention", "proj-6", "sess-6");
          const needsRouter = createTelegramRouter({
            bot: needsBot as unknown as TelegramBot,
            useCases: needsUseCases,
            persistence: ctx.persistence,
            compatRunCmdCommands: true,
          });

          await needsRouter.handleMessage(createMessage("8006", "texto libre durante prompt"));
          assert(needsUseCases.sendTextCalls === 0, "needs-attention con prompt no-text no debe mandar texto upstream");
          const needsMsg = needsBot.sentMessages[0]?.text ?? "";
          assert(needsMsg.includes("requiere seleccionar una opción"), "faltó guía de usar botones");
          return "busy-lock/needs-attention OK";
        })
    )
  );

  results.push(
    await runCase(
      "S07",
      "Rollback HUMAN_PROMPTS_ENABLED=false",
      "notice de texto sin teclado + sin prompt activo nuevo",
      async () =>
        withHarness("rfc8-rollback", false, async (ctx) => {
          await seedSessionFixture({
            persistence: ctx.persistence,
            tempDir: ctx.tempDir,
            projectId: "proj-7",
            sessionId: "sess-7",
            chatId: "8007",
            watcherToken: ctx.registration.bearerToken,
            watcherCallbackUrl: ctx.receiver.callbackUrl,
            mode: "needs-attention",
          });

          await ctx.persistence.runInTransaction(async (unit) => {
            await unit.pendingPrompts.upsert({
              promptId: "prompt-old",
              projectId: "proj-7",
              sessionId: "sess-7",
              chatId: "8007",
              promptType: PROMPT_TYPE.BOOLEAN,
              message: "viejo",
              status: PENDING_PROMPT_STATUS.ACTIVE,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            });
          });

          await ctx.watcher.handleIncomingEvent(
            { bearerToken: ctx.registration.bearerToken },
            {
              kind: SESSION_EVENT_KIND.NEEDS_INPUT,
              sessionId: "sess-7",
              projectId: "proj-7",
              occurredAt: "2026-01-01T00:00:10.000Z",
              data: {
                prompt_id: "prompt-new",
                prompt_type: "boolean",
                message: "¿nuevo?",
                options: ["Sí", "No"],
                summary: "OpenCode espera confirmación",
              },
            }
          );

          assert(ctx.notices.length === 1, "rollback igual debe emitir needs-input notice");
          assert(ctx.notices[0].prompt === undefined, "con feature off no debe incluir prompt interactivo");

          const bot = new FakeBot();
          await sendAsyncSessionNotice({
            bot: bot as unknown as TelegramBot,
            notice: ctx.notices[0],
            persistence: ctx.persistence,
          });

          assert(bot.sentMessages.length === 1, "debería enviar notice de texto");
          const sent = bot.sentMessages[0];
          assert(!sent.options?.reply_markup, "rollback no debería mandar inline keyboard");

          const prompts = await ctx.persistence.runInTransaction((unit) => unit.pendingPrompts.listAll());
          const activePrompts = prompts.filter((prompt) => prompt.status === PENDING_PROMPT_STATUS.ACTIVE);
          assert(activePrompts.length === 0, "no debe quedar prompt activo cuando feature está off");
          const oldPrompt = prompts.find((prompt) => prompt.promptId === "prompt-old");
          assert(oldPrompt?.status === PENDING_PROMPT_STATUS.INVALIDATED, "prompt previo debe invalidarse");
          return "fallback no interactivo OK";
        })
    )
  );

  const lines = [
    "RFC-008 Human Prompts Verification",
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
  console.error("No pude ejecutar verificación RFC8", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

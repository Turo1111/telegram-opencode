import TelegramBot from "node-telegram-bot-api";
import {
  registerTelegramIngress,
  TELEGRAM_AUTH_REJECT_REASON,
  TelegramIngressBot,
  TelegramIngressHandlers,
} from "../bot";
import { ChatLockManager } from "../application/chat-lock-manager";
import { Config } from "../config";
import { logger } from "../logger";
import { createMessageHandler, createCallbackQueryHandler } from "../handlers";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
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

function buildConfig(): Config {
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
    stateDbPath: "./tmp/state.sqlite",
    stateJsonPath: "./tmp/state.json",
    compatLegacyTextBridge: false,
    compatRunCmdCommands: true,
    bootRemoteReconcile: true,
    chatLockEnabled: true,
    lockWarnWaitMs: 1500,
    watcherEnabled: true,
    watchdogEnabled: true,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4045,
    watchdogIntervalMs: 15000,
    watchdogStaleAfterMs: 60000,
    watchdogMaxRetryCount: 3,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300000,
  };
}

function createMessage(chatId: string, actorId: number | undefined, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(chatId),
      type: "private",
    },
    from:
      actorId === undefined
        ? undefined
        : {
            id: actorId,
            is_bot: false,
            first_name: "tester",
          },
    text,
  } as TelegramBot.Message;
}

function createCallbackQuery(chatId: string, actorId: number | undefined, queryId: string): TelegramBot.CallbackQuery {
  return {
    id: queryId,
    from:
      actorId === undefined
        ? ({ id: Number.NaN } as TelegramBot.User)
        : {
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

function createUseCasesThatMustNotRun(counter: { calls: number }) {
  const unexpected = async (name: string): Promise<never> => {
    counter.calls += 1;
    throw new Error(`router defensive reject falló: no debería invocar use case ${name}`);
  };

  return {
    selectProject: () => unexpected("selectProject"),
    attachSession: () => unexpected("attachSession"),
    createSession: () => unexpected("createSession"),
    sendText: () => unexpected("sendText"),
    runSessionCommand: () => unexpected("runSessionCommand"),
    submitPendingPrompt: () => unexpected("submitPendingPrompt"),
    cancelSession: () => unexpected("cancelSession"),
    getStatus: () => unexpected("getStatus"),
  };
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
      "Unauthorized message is silently dropped",
      "no handler, no lock acquisition, telemetry event",
      async () => {
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        const handled: string[] = [];
        const telemetryEvents: string[] = [];
        const originalLoggerInfo = logger.info;
        logger.info = (_message, meta) => {
          if (meta?.event === "telegram-auth-rejected") {
            telemetryEvents.push(String(meta.event));
          }
        };

        const handlers: TelegramIngressHandlers = {
          messageHandler: async () => {
            handled.push("message");
          },
          callbackQueryHandler: async () => {
            handled.push("callback");
          },
        };

        try {
          registerTelegramIngress({
            bot,
            config: buildConfig(),
            chatLockManager: lock,
            handlers,
          });

          await bot.emitMessage(createMessage("9001", 9999, "hola"));

          assert(handled.length === 0, "update no autorizado no debe llegar al handler");
          assert(lock.runExclusiveCalls === 0, "lock no debe adquirirse para actor no autorizado");
          assert(bot.callbackAnswers === 0, "message drop no debe generar callback answers");
          assert(telemetryEvents.length === 1, "debería emitir exactamente un evento de rechazo inicial");

          return "silent-drop sin side effects OK";
        } finally {
          logger.info = originalLoggerInfo;
        }
      }
    )
  );

  results.push(
    await runCase(
      "S05",
      "Forced bypass into handlers/router still rejects unauthorized actor",
      "no Telegram response and no use-case execution",
      async () => {
        const bot = new FakeIngressBot();
        const useCaseCounter = { calls: 0 };
        const useCases = createUseCasesThatMustNotRun(useCaseCounter);
        const config = buildConfig();

        const messageHandler = createMessageHandler({
          bot: bot as unknown as TelegramBot,
          useCases: useCases as never,
          config,
        });
        const callbackHandler = createCallbackQueryHandler({
          bot: bot as unknown as TelegramBot,
          useCases: useCases as never,
          config,
        });

        const originalLoggerInfo = logger.info;
        const defensiveRejectEvents: string[] = [];
        logger.info = (_message, meta) => {
          if (
            meta?.event === "telegram-auth-rejected" &&
            meta?.routeDecision === "auth-defensive-reject"
          ) {
            defensiveRejectEvents.push(String(meta.event));
          }
        };

        try {
          await messageHandler(createMessage("7001", 9999, "/status"));
          await callbackHandler(createCallbackQuery("7001", 9999, "cb-bypass"));

          assert(useCaseCounter.calls === 0, "router defensivo debe cortar antes de ejecutar casos de uso");
          assert(bot.sentMessages === 0, "router defensivo no debe enviar mensajes al usuario");
          assert(bot.callbackAnswers === 0, "router defensivo no debe responder callback_query");
          assert(defensiveRejectEvents.length === 2, "debería loguear rechazo defensivo para message y callback");

          return "bypass simulation bloqueado por guard defensivo en router";
        } finally {
          logger.info = originalLoggerInfo;
        }
      }
    )
  );

  results.push(
    await runCase(
      "S02",
      "Unauthorized callback_query is silently dropped",
      "no callback handler, no callback answer",
      async () => {
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        let callbackHandled = 0;

        registerTelegramIngress({
          bot,
          config: buildConfig(),
          chatLockManager: lock,
          handlers: {
            messageHandler: async () => undefined,
            callbackQueryHandler: async () => {
              callbackHandled += 1;
            },
          },
        });

        await bot.emitCallbackQuery(createCallbackQuery("9002", 9999, "cb-unauth"));

        assert(callbackHandled === 0, "callback no autorizado no debe invocar handler");
        assert(lock.runExclusiveCalls === 0, "callback no autorizado no debe entrar al lock");
        assert(bot.callbackAnswers === 0, "silent-drop no debe responder answerCallbackQuery");

        return "callback unauthorized silent-drop OK";
      }
    )
  );

  results.push(
    await runCase(
      "S03",
      "Authorized message and callback preserve flow",
      "handlers called and lock acquired twice",
      async () => {
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        let messageHandled = 0;
        let callbackHandled = 0;

        registerTelegramIngress({
          bot,
          config: buildConfig(),
          chatLockManager: lock,
          handlers: {
            messageHandler: async () => {
              messageHandled += 1;
            },
            callbackQueryHandler: async () => {
              callbackHandled += 1;
            },
          },
        });

        await bot.emitMessage(createMessage("8001", 8001, "/status"));
        await bot.emitCallbackQuery(createCallbackQuery("8001", 8001, "cb-auth"));

        assert(messageHandled === 1, "message autorizado debe ejecutar su handler");
        assert(callbackHandled === 1, "callback autorizado debe ejecutar su handler");
        assert(lock.runExclusiveCalls === 2, "message+callback autorizados deben adquirir lock");

        return "authorized ingress preserves behavior";
      }
    )
  );

  results.push(
    await runCase(
      "S04",
      "Missing actor identity is rejected",
      `reject reason ${TELEGRAM_AUTH_REJECT_REASON.ACTOR_MISSING}`,
      async () => {
        const bot = new FakeIngressBot();
        const lock = new ProbeChatLockManager();
        const reasons: string[] = [];
        const originalLoggerInfo = logger.info;
        logger.info = (_message, meta) => {
          if (meta?.event === "telegram-auth-rejected") {
            reasons.push(String(meta.reason));
          }
        };

        try {
          registerTelegramIngress({
            bot,
            config: buildConfig(),
            chatLockManager: lock,
            handlers: {
              messageHandler: async () => undefined,
              callbackQueryHandler: async () => undefined,
            },
          });

          await bot.emitMessage(createMessage("9003", undefined, "hola"));
          await bot.emitMessage(createMessage("9003", undefined, "hola de nuevo"));

          assert(lock.runExclusiveCalls === 0, "actor missing no debe adquirir lock");
          assert(reasons[0] === TELEGRAM_AUTH_REJECT_REASON.ACTOR_MISSING, "debería registrar reason actor-missing");
          assert(reasons.length === 1, "telemetría debe ser low-noise para rechazos consecutivos");

          return "actor-missing rejected with low-noise telemetry";
        } finally {
          logger.info = originalLoggerInfo;
        }
      }
    )
  );

  const lines = [
    "Telegram ingress auth gate verification",
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
  console.error(
    "No pude ejecutar verificación de auth ingress",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});

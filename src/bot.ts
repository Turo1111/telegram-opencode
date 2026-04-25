import TelegramBot from "node-telegram-bot-api";
import { Config } from "./config";
import { logger, LOCK_OUTCOME, LockOutcome } from "./logger";
import { createTelegramHandlers } from "./handlers";
import { ApplicationUseCases } from "./application/use-cases";
import { ChatLockManager, createChatLockManager } from "./application/chat-lock-manager";
import { PersistenceDriver } from "./application/contracts";

export interface StartBotDeps {
  config: Config;
  useCases: ApplicationUseCases;
  persistence?: PersistenceDriver;
}

export const TELEGRAM_AUTH_REJECT_REASON = {
  ACTOR_MISSING: "actor-missing",
  ACTOR_NOT_ALLOWED: "actor-not-allowed",
} as const;

export type TelegramAuthRejectReason = (typeof TELEGRAM_AUTH_REJECT_REASON)[keyof typeof TELEGRAM_AUTH_REJECT_REASON];

export interface TelegramIngressAuthDecision {
  readonly authorized: boolean;
  readonly actorId?: string;
  readonly reason?: TelegramAuthRejectReason;
}

export interface TelegramIngressHandlers {
  readonly messageHandler: (msg: TelegramBot.Message) => Promise<void>;
  readonly callbackQueryHandler: (query: TelegramBot.CallbackQuery) => Promise<void>;
}

export interface TelegramIngressBot {
  on(event: "message", listener: (msg: TelegramBot.Message) => void | Promise<void>): TelegramIngressBot;
  on(
    event: "callback_query",
    listener: (query: TelegramBot.CallbackQuery) => void | Promise<void>
  ): TelegramIngressBot;
  on(event: "polling_error", listener: (err: Error) => void): TelegramIngressBot;
  answerCallbackQuery(
    callbackQueryId: string,
    options?: Omit<TelegramBot.AnswerCallbackQueryOptions, "callback_query_id">
  ): Promise<TelegramBot.Message | boolean>;
}

interface RegisterTelegramIngressDeps {
  readonly bot: TelegramIngressBot;
  readonly config: Config;
  readonly chatLockManager: ChatLockManager;
  readonly handlers: TelegramIngressHandlers;
}

const AUTH_REJECT_LOG_WINDOW_MS = 60_000;

function normalizeActorId(from: TelegramBot.User | undefined): string | undefined {
  if (!from) {
    return undefined;
  }

  if (!Number.isSafeInteger(from.id) || from.id <= 0) {
    return undefined;
  }

  return String(from.id);
}

function buildAuthorizationSet(allowedUserIds: readonly string[]): ReadonlySet<string> {
  return new Set(allowedUserIds);
}

function authorizeIngressActor(allowedActorIds: ReadonlySet<string>, actorId: string | undefined): TelegramIngressAuthDecision {
  if (!actorId) {
    return {
      authorized: false,
      reason: TELEGRAM_AUTH_REJECT_REASON.ACTOR_MISSING,
    };
  }

  if (!allowedActorIds.has(actorId)) {
    return {
      authorized: false,
      actorId,
      reason: TELEGRAM_AUTH_REJECT_REASON.ACTOR_NOT_ALLOWED,
    };
  }

  return {
    authorized: true,
    actorId,
  };
}

function createAuthRejectTelemetry() {
  let windowStartedAtMs = Date.now();
  let rejectedCount = 0;
  const reasonBreakdown = new Map<TelegramAuthRejectReason, number>();

  return {
    track(reason: TelegramAuthRejectReason, updateType: "message" | "callback_query"): void {
      const now = Date.now();
      const elapsed = now - windowStartedAtMs;

      if (elapsed >= AUTH_REJECT_LOG_WINDOW_MS && rejectedCount > 0) {
        logger.info("Telegram unauthorized updates dropped", {
          event: "telegram-auth-rejected",
          rejectedCount,
          windowMs: AUTH_REJECT_LOG_WINDOW_MS,
          reasonBreakdown: Object.fromEntries(reasonBreakdown.entries()),
        });

        windowStartedAtMs = now;
        rejectedCount = 0;
        reasonBreakdown.clear();
      }

      rejectedCount += 1;
      reasonBreakdown.set(reason, (reasonBreakdown.get(reason) ?? 0) + 1);

      if (rejectedCount === 1) {
        logger.info("Telegram unauthorized update dropped", {
          event: "telegram-auth-rejected",
          updateType,
          reason,
        });
      }
    },
  };
}

export function evaluateMessageAuthorization(
  allowedActorIds: ReadonlySet<string>,
  msg: TelegramBot.Message
): TelegramIngressAuthDecision {
  return authorizeIngressActor(allowedActorIds, normalizeActorId(msg.from));
}

export function evaluateCallbackAuthorization(
  allowedActorIds: ReadonlySet<string>,
  query: TelegramBot.CallbackQuery
): TelegramIngressAuthDecision {
  return authorizeIngressActor(allowedActorIds, normalizeActorId(query.from));
}

export function registerTelegramIngress(deps: RegisterTelegramIngressDeps): void {
  const { bot, config, chatLockManager, handlers } = deps;
  const allowedActorIds = buildAuthorizationSet(config.allowedUserIds);
  const authRejectTelemetry = createAuthRejectTelemetry();

  bot.on("message", async (msg) => {
    const auth = evaluateMessageAuthorization(allowedActorIds, msg);
    if (!auth.authorized) {
      authRejectTelemetry.track(auth.reason ?? TELEGRAM_AUTH_REJECT_REASON.ACTOR_MISSING, "message");
      return;
    }

    const chatId = String(msg.chat.id);

    const executeHandler = async () => {
      await handlers.messageHandler(msg);
    };

    if (!config.chatLockEnabled) {
      await executeHandler();
      return;
    }

    const waitStartMs = Date.now();
    const queueDepthOnEnqueue = chatLockManager.getQueueDepth(chatId);

    try {
      await chatLockManager.runExclusive(chatId, async () => {
        const acquiredAtMs = Date.now();
        const waitMs = acquiredAtMs - waitStartMs;
        const queueDepthOnAcquire = chatLockManager.getQueueDepth(chatId);

        logger.lock("Chat lock acquired", {
          chatId,
          waitMs,
          heldMs: 0,
          queueDepth: queueDepthOnAcquire,
          outcome: waitMs > 0 ? LOCK_OUTCOME.ACQUIRED_AFTER_WAIT : LOCK_OUTCOME.ACQUIRED_IMMEDIATE,
        });

        if (waitMs >= config.lockWarnWaitMs) {
          logger.info("Chat lock wait exceeded warning threshold", {
            chatId,
            waitMs,
            lockWarnWaitMs: config.lockWarnWaitMs,
            queueDepth: queueDepthOnEnqueue,
          });
        }

        const heldStartMs = Date.now();
        let releaseOutcome: LockOutcome = LOCK_OUTCOME.RELEASED_SUCCESS;

        try {
          await executeHandler();
        } catch (error) {
          releaseOutcome = LOCK_OUTCOME.RELEASED_ERROR;
          throw error;
        } finally {
          const heldMs = Date.now() - heldStartMs;
          logger.lock("Chat lock released", {
            chatId,
            waitMs,
            heldMs,
            queueDepth: chatLockManager.getQueueDepth(chatId),
            outcome: releaseOutcome,
          });
        }
      });
    } catch (error) {
      logger.error("Message handling failed under chat lock", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  bot.on("callback_query", async (query) => {
    const auth = evaluateCallbackAuthorization(allowedActorIds, query);
    if (!auth.authorized) {
      authRejectTelemetry.track(auth.reason ?? TELEGRAM_AUTH_REJECT_REASON.ACTOR_MISSING, "callback_query");
      return;
    }

    const chatId = query.message ? String(query.message.chat.id) : undefined;
    if (!chatId) {
      return;
    }

    const executeHandler = async () => {
      await handlers.callbackQueryHandler(query);
    };

    if (!config.chatLockEnabled) {
      await executeHandler();
      return;
    }

    const waitStartMs = Date.now();
    const queueDepthOnEnqueue = chatLockManager.getQueueDepth(chatId);

    try {
      await chatLockManager.runExclusive(chatId, async () => {
        const acquiredAtMs = Date.now();
        const waitMs = acquiredAtMs - waitStartMs;
        const queueDepthOnAcquire = chatLockManager.getQueueDepth(chatId);

        logger.lock("Chat lock acquired (callback_query)", {
          chatId,
          waitMs,
          heldMs: 0,
          queueDepth: queueDepthOnAcquire,
          outcome: waitMs > 0 ? LOCK_OUTCOME.ACQUIRED_AFTER_WAIT : LOCK_OUTCOME.ACQUIRED_IMMEDIATE,
        });

        if (waitMs >= config.lockWarnWaitMs) {
          logger.info("Chat lock wait exceeded warning threshold (callback_query)", {
            chatId,
            waitMs,
            lockWarnWaitMs: config.lockWarnWaitMs,
            queueDepth: queueDepthOnEnqueue,
          });
        }

        const heldStartMs = Date.now();
        let releaseOutcome: LockOutcome = LOCK_OUTCOME.RELEASED_SUCCESS;

        try {
          await executeHandler();
        } catch (error) {
          releaseOutcome = LOCK_OUTCOME.RELEASED_ERROR;
          throw error;
        } finally {
          const heldMs = Date.now() - heldStartMs;
          logger.lock("Chat lock released (callback_query)", {
            chatId,
            waitMs,
            heldMs,
            queueDepth: chatLockManager.getQueueDepth(chatId),
            outcome: releaseOutcome,
          });
        }
      });
    } catch (error) {
      logger.error("Callback query handling failed under chat lock", {
        chatId,
        message: error instanceof Error ? error.message : String(error),
      });

      if (query.id) {
        await bot.answerCallbackQuery(query.id, {
          text: "No pude procesar la respuesta. Probá de nuevo.",
          show_alert: false,
        }).catch(() => undefined);
      }
    }
  });
}

export function startBot(deps: StartBotDeps): TelegramBot {
  const { config, useCases, persistence } = deps;
  const chatLockManager = createChatLockManager();
  const bot = new TelegramBot(config.telegramBotToken, {
    polling: {
      interval: config.pollingIntervalMs,
    },
    request: { family: 4 } as unknown as TelegramBot.ConstructorOptions["request"],
  });

  const { messageHandler, callbackQueryHandler } = createTelegramHandlers({
    bot,
    useCases,
    persistence,
    config,
  });

  registerTelegramIngress({
    bot,
    config,
    chatLockManager,
    handlers: {
      messageHandler,
      callbackQueryHandler,
    },
  });

  bot.on("polling_error", (err) => {
    const errorWithCode = err as Error & { code?: string };
    logger.error("Polling error", {
      message: err.message,
      code: errorWithCode.code,
    });
  });

  logger.info("Bot started with polling", {
    intervalMs: config.pollingIntervalMs,
    networkFamily: 4,
    chatLockEnabled: config.chatLockEnabled,
    lockWarnWaitMs: config.lockWarnWaitMs,
  });
  return bot;
}

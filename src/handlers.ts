import TelegramBot from "node-telegram-bot-api";
import { ApplicationUseCases } from "./application/use-cases";
import { PersistenceDriver } from "./application/contracts";
import {
  createTelegramRouter,
  TELEGRAM_ROUTER_AUTH_REJECT_REASON,
  TELEGRAM_ROUTER_AUTH_SOURCE,
  TelegramRouterAuthContext,
} from "./adapters/telegram/router";
import { Config } from "./config";
import { callOpenCode } from "./opencode";
import { logger } from "./logger";
import { sendTelegramText, TELEGRAM_CONTENT_KIND } from "./adapters/telegram/message-sender";

export interface HandlerDeps {
  bot: TelegramBot;
  useCases: ApplicationUseCases;
  persistence?: PersistenceDriver;
  config: Config;
  callOpenCodeFn?: typeof callOpenCode;
}

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

function buildMessageAuthContext(
  allowedActorIds: ReadonlySet<string>,
  msg: TelegramBot.Message
): TelegramRouterAuthContext {
  const actorId = normalizeActorId(msg.from);
  if (!actorId) {
    return {
      authorized: false,
      reason: TELEGRAM_ROUTER_AUTH_REJECT_REASON.ACTOR_MISSING,
      source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
    };
  }

  if (!allowedActorIds.has(actorId)) {
    return {
      authorized: false,
      actorId,
      reason: TELEGRAM_ROUTER_AUTH_REJECT_REASON.ACTOR_NOT_ALLOWED,
      source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
    };
  }

  return {
    authorized: true,
    actorId,
    source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
  };
}

function buildCallbackAuthContext(
  allowedActorIds: ReadonlySet<string>,
  query: TelegramBot.CallbackQuery
): TelegramRouterAuthContext {
  const actorId = normalizeActorId(query.from);
  if (!actorId) {
    return {
      authorized: false,
      reason: TELEGRAM_ROUTER_AUTH_REJECT_REASON.ACTOR_MISSING,
      source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
    };
  }

  if (!allowedActorIds.has(actorId)) {
    return {
      authorized: false,
      actorId,
      reason: TELEGRAM_ROUTER_AUTH_REJECT_REASON.ACTOR_NOT_ALLOWED,
      source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
    };
  }

  return {
    authorized: true,
    actorId,
    source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS,
  };
}

export function createMessageHandler(deps: HandlerDeps) {
  const allowedActorIds = buildAuthorizationSet(deps.config.allowedUserIds);
  const router = createTelegramRouter({
    bot: deps.bot,
    useCases: deps.useCases,
    persistence: deps.persistence,
    compatRunCmdCommands: deps.config.compatRunCmdCommands,
    openCodeAdapterMode: deps.config.openCodeAdapter,
  });

  return async function handleTelegramMessage(msg: TelegramBot.Message) {
    const authContext = buildMessageAuthContext(allowedActorIds, msg);
    const text = msg.text?.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      await router.handleMessage(msg, authContext);
      return;
    }

    if (!deps.config.compatLegacyTextBridge) {
      await router.handleMessage(msg, authContext);
      return;
    }

    const chatId = String(msg.chat.id);
    const status = await deps.useCases.getStatus(chatId);

    if (status.ok && status.value.projectId && status.value.sessionId) {
      await router.handleMessage(msg, authContext);
      return;
    }

    if (status.ok) {
      try {
        const openCodeCaller = deps.callOpenCodeFn ?? callOpenCode;
        const legacyResponse = await openCodeCaller(deps.config, {
          prompt: text,
          userId: chatId,
          metadata: {
            source: "telegram-legacy-compat",
            projectId: status.value.projectId ?? "none",
            sessionId: status.value.sessionId ?? "none",
          },
        });

        const answer = legacyResponse.answer.trim() || "Listo. OpenCode no devolvió texto en esta respuesta.";
        logger.info("Legacy text bridge used", {
          chatId,
          compatLegacyTextBridge: deps.config.compatLegacyTextBridge,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: answer,
          contentKind: TELEGRAM_CONTENT_KIND.MODEL,
        });
        return;
      } catch (error) {
        logger.error("Legacy compatibility bridge failed; falling back to session router", {
          chatId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await router.handleMessage(msg, authContext);
  };
}

export function createCallbackQueryHandler(deps: HandlerDeps) {
  const allowedActorIds = buildAuthorizationSet(deps.config.allowedUserIds);
  const router = createTelegramRouter({
    bot: deps.bot,
    useCases: deps.useCases,
    persistence: deps.persistence,
    compatRunCmdCommands: deps.config.compatRunCmdCommands,
    openCodeAdapterMode: deps.config.openCodeAdapter,
  });

  return async function handleTelegramCallbackQuery(query: TelegramBot.CallbackQuery) {
    const authContext = buildCallbackAuthContext(allowedActorIds, query);
    await router.handleCallbackQuery(query, authContext);
  };
}

export async function handleMessage(deps: HandlerDeps, msg: TelegramBot.Message) {
  const handler = createMessageHandler(deps);
  await handler(msg);
}

import TelegramBot from "node-telegram-bot-api";
import {
  ApplicationUseCases,
  CANCEL_SESSION_RESULT_STATUS,
  SUBMIT_PENDING_PROMPT_RESULT_STATUS,
  StatusOutput,
} from "../../application/use-cases";
import { PersistenceDriver, PersistenceUnit } from "../../application/contracts";
import { DomainError } from "../../domain/errors";
import { PENDING_PROMPT_STATUS, PROMPT_TYPE } from "../../domain/entities";
import {
  formatBusyCommandRejected,
  formatCancelNoActiveTask,
  formatCancelSuccess,
  formatCancelUnsupported,
  formatCommandCatalog,
  formatLegacyRunCmdDisabled,
  formatLegacyRunCmdDeprecationNotice,
  formatFreeTextRejectedBusy,
  formatDomainError,
  formatNoSessionGuide,
  formatProjectQuery,
  formatProjectSelected,
  formatRunCommandSuccess,
  formatSendSuccess,
  formatSessionCreated,
  formatSessionLinked,
  formatPromptIdempotentNotice,
  formatPromptRequiresTextNotice,
  formatPromptTextOnlyNotice,
  formatStatus,
  formatUnknownError,
  formatUsage,
} from "./templates";
import { logger } from "../../logger";
import { sendTelegramText } from "./message-sender";
import { ADAPTER_ERROR_CODES } from "../../application/contracts";
import { OPEN_CODE_ADAPTER_MODE, OpenCodeAdapterMode } from "../../infrastructure/opencode-adapter-mode";

export interface TelegramRouterDeps {
  bot: TelegramBot;
  useCases: ApplicationUseCases;
  persistence?: PersistenceDriver;
  compatRunCmdCommands: boolean;
  openCodeAdapterMode?: OpenCodeAdapterMode;
}

const CLI_CANCEL_UNSUPPORTED_GUIDANCE =
  "En modo CLI no está disponible /cancel. Gestioná la interrupción desde tu terminal OpenCode en PC/WSL.";

export const TELEGRAM_ROUTER_AUTH_SOURCE = {
  HANDLERS: "handlers",
  INGRESS: "ingress",
} as const;

export type TelegramRouterAuthSource =
  (typeof TELEGRAM_ROUTER_AUTH_SOURCE)[keyof typeof TELEGRAM_ROUTER_AUTH_SOURCE];

export const TELEGRAM_ROUTER_AUTH_REJECT_REASON = {
  ACTOR_MISSING: "actor-missing",
  ACTOR_NOT_ALLOWED: "actor-not-allowed",
  AUTH_CONTEXT_MISSING: "auth-context-missing",
} as const;

export type TelegramRouterAuthRejectReason =
  (typeof TELEGRAM_ROUTER_AUTH_REJECT_REASON)[keyof typeof TELEGRAM_ROUTER_AUTH_REJECT_REASON];

export interface TelegramRouterAuthContext {
  readonly authorized: boolean;
  readonly actorId?: string;
  readonly reason?: TelegramRouterAuthRejectReason;
  readonly source: TelegramRouterAuthSource;
}

export const TELEGRAM_COMMAND_INTENT_KIND = {
  HELP: "help",
  STATUS: "status",
  PROJECT: "project",
  SESSION: "session",
  NEW: "new",
  CANCEL: "cancel",
  RUN: "run",
  UNKNOWN: "unknown",
} as const;

export type TelegramCommandIntentKind =
  (typeof TELEGRAM_COMMAND_INTENT_KIND)[keyof typeof TELEGRAM_COMMAND_INTENT_KIND];

export const COMMAND_POLICY = {
  READ_ONLY: "read-only",
  EXECUTION: "execution",
  MUTATING: "mutating",
} as const;

export type CommandPolicy = (typeof COMMAND_POLICY)[keyof typeof COMMAND_POLICY];

export interface TelegramCommandIntent {
  readonly kind: TelegramCommandIntentKind;
  readonly raw: string;
  readonly args?: string;
  readonly aliasUsed?: string;
}

export const TELEGRAM_ROUTE_DECISION = {
  COMMAND: "command",
  CALLBACK_QUERY: "callback-query",
  CALLBACK_QUERY_IDEMPOTENT: "callback-query-idempotent",
  AUTH_DEFENSIVE_REJECT: "auth-defensive-reject",
  FREE_TEXT_ALLOWED: "free-text-allowed",
  FREE_TEXT_ALLOWED_PROMPT_TEXT: "free-text-allowed-prompt-text",
  FREE_TEXT_REJECTED_PROMPT_NON_TEXT: "free-text-rejected-prompt-non-text",
  FREE_TEXT_REJECTED_NO_CONTEXT: "free-text-rejected-no-context",
  FREE_TEXT_REJECTED_RUNNING: "free-text-rejected-running",
  FREE_TEXT_REJECTED_STATE: "free-text-rejected-state",
} as const;

export type TelegramRouteDecision = (typeof TELEGRAM_ROUTE_DECISION)[keyof typeof TELEGRAM_ROUTE_DECISION];

const COMMAND_INTENT_POLICY = {
  [TELEGRAM_COMMAND_INTENT_KIND.STATUS]: COMMAND_POLICY.READ_ONLY,
  [TELEGRAM_COMMAND_INTENT_KIND.CANCEL]: COMMAND_POLICY.READ_ONLY,
  [TELEGRAM_COMMAND_INTENT_KIND.PROJECT]: COMMAND_POLICY.READ_ONLY,
  [TELEGRAM_COMMAND_INTENT_KIND.SESSION]: COMMAND_POLICY.EXECUTION,
  [TELEGRAM_COMMAND_INTENT_KIND.NEW]: COMMAND_POLICY.EXECUTION,
  [TELEGRAM_COMMAND_INTENT_KIND.RUN]: COMMAND_POLICY.EXECUTION,
  [TELEGRAM_COMMAND_INTENT_KIND.HELP]: COMMAND_POLICY.EXECUTION,
  [TELEGRAM_COMMAND_INTENT_KIND.UNKNOWN]: COMMAND_POLICY.EXECUTION,
} as const satisfies Record<TelegramCommandIntentKind, CommandPolicy>;

const COMMAND_ALIASES = {
  start: TELEGRAM_COMMAND_INTENT_KIND.HELP,
  help: TELEGRAM_COMMAND_INTENT_KIND.HELP,
  status: TELEGRAM_COMMAND_INTENT_KIND.STATUS,
  st: TELEGRAM_COMMAND_INTENT_KIND.STATUS,
  project: TELEGRAM_COMMAND_INTENT_KIND.PROJECT,
  p: TELEGRAM_COMMAND_INTENT_KIND.PROJECT,
  session: TELEGRAM_COMMAND_INTENT_KIND.SESSION,
  s: TELEGRAM_COMMAND_INTENT_KIND.SESSION,
  new: TELEGRAM_COMMAND_INTENT_KIND.NEW,
  n: TELEGRAM_COMMAND_INTENT_KIND.NEW,
  cancel: TELEGRAM_COMMAND_INTENT_KIND.CANCEL,
  c: TELEGRAM_COMMAND_INTENT_KIND.CANCEL,
  run: TELEGRAM_COMMAND_INTENT_KIND.RUN,
  cmd: TELEGRAM_COMMAND_INTENT_KIND.RUN,
} as const;

const COMMAND_CATALOG = [
  "/start | /help",
  "/status | /st",
  "/project | /p <alias|projectId>",
  "/session | /s <sessionId>",
  "/new | /n",
  "/cancel | /c",
] as const;

export function createTelegramRouter(deps: TelegramRouterDeps) {
  return {
    async handleMessage(msg: TelegramBot.Message, authContext?: TelegramRouterAuthContext): Promise<void> {
      if (shouldDefensivelyRejectByAuthContext(authContext, "message", String(msg.chat.id))) {
        return;
      }

      const text = msg.text?.trim();
      if (!text) return;

      const chatId = String(msg.chat.id);

      if (text.startsWith("/")) {
        await handleCommand(deps, chatId, text);
        return;
      }

      await handleText(deps, chatId, text);
    },
    async handleCallbackQuery(query: TelegramBot.CallbackQuery, authContext?: TelegramRouterAuthContext): Promise<void> {
      const chatId = query.message ? String(query.message.chat.id) : undefined;
      if (shouldDefensivelyRejectByAuthContext(authContext, "callback_query", chatId)) {
        return;
      }

      if (!chatId || !query.id) {
        return;
      }

      const parsed = parsePromptCallbackPayload(query.data);
      if (!parsed) {
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Acción inválida o desactualizada.",
          show_alert: false,
        });
        return;
      }

      logger.info("Telegram route decision", {
        chatId,
        routeDecision: TELEGRAM_ROUTE_DECISION.CALLBACK_QUERY,
        promptId: parsed.promptId,
        event: "telegram-callback-query",
        status: "received",
      });

      if (!deps.persistence) {
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Confirmaciones humanas no disponibles en esta instancia.",
          show_alert: false,
        });
        return;
      }

      const prompt = await deps.persistence.runInTransaction((unit: PersistenceUnit) =>
        unit.pendingPrompts.findByPromptId(parsed.promptId)
      );
      if (!prompt) {
        logger.prompt("Telegram callback ignored: prompt not found", {
          session_id: undefined,
          chat_id: chatId,
          prompt_id: parsed.promptId,
          event: "telegram-callback-query",
          status: "not-found",
          reason: "prompt-missing",
        });
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Este prompt ya no está disponible.",
          show_alert: false,
        });
        return;
      }

      if (prompt.status !== PENDING_PROMPT_STATUS.ACTIVE) {
        logger.prompt("Telegram callback ignored (idempotent)", {
          session_id: prompt.sessionId,
          chat_id: chatId,
          prompt_id: parsed.promptId,
          event: "telegram-callback-query",
          status: prompt.status,
          reason: "prompt-not-active",
        });
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Prompt ya resuelto/no vigente.",
          show_alert: false,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: formatPromptIdempotentNotice(prompt.status),
        });
        return;
      }

      if (prompt.promptType === PROMPT_TYPE.TEXT) {
        logger.prompt("Telegram callback rejected: prompt requires text", {
          session_id: prompt.sessionId,
          chat_id: chatId,
          prompt_id: parsed.promptId,
          event: "telegram-callback-query",
          status: prompt.status,
          reason: "prompt-type-text",
        });
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Este prompt requiere respuesta de texto.",
          show_alert: false,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: formatPromptRequiresTextNotice(),
        });
        return;
      }

      if (prompt.telegramCallbackQueryId) {
        logger.prompt("Telegram callback ignored: duplicate callback query", {
          session_id: prompt.sessionId,
          chat_id: chatId,
          prompt_id: parsed.promptId,
          event: "telegram-callback-query",
          status: prompt.status,
          reason: "duplicate-callback",
          first_callback_query_id: prompt.telegramCallbackQueryId,
          callback_query_id: query.id,
        });
        await deps.bot.answerCallbackQuery(query.id, {
          text: "Ya registré una respuesta para este prompt.",
          show_alert: false,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: formatPromptIdempotentNotice(PENDING_PROMPT_STATUS.SUBMITTED),
        });
        return;
      }

      const submitResult = await deps.useCases.submitPendingPrompt({
        chatId,
        sessionId: prompt.sessionId,
        promptId: parsed.promptId,
        choice: parsed.choice,
        callbackQueryId: query.id,
      });

      if (!submitResult.ok) {
        logger.prompt("Telegram callback submit failed", {
          session_id: prompt.sessionId,
          chat_id: chatId,
          prompt_id: parsed.promptId,
          event: "telegram-callback-query",
          status: "submit-error",
          reason: submitResult.error.code,
        });
        await deps.bot.answerCallbackQuery(query.id, {
          text: "No pude enviar la respuesta a OpenCode. Probá nuevamente.",
          show_alert: false,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: formatDomainError(submitResult.error),
        });
        return;
      }

      if (submitResult.value.status === SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT) {
        logger.prompt("Telegram callback resolved as idempotent", {
          session_id: submitResult.value.sessionId,
          chat_id: chatId,
          prompt_id: submitResult.value.promptId,
          event: "telegram-callback-query",
          status: submitResult.value.promptStatus,
          reason: submitResult.value.reason ?? "idempotent",
        });

        await deps.bot.answerCallbackQuery(query.id, {
          text: "Prompt ya resuelto/no vigente.",
          show_alert: false,
        });
        await sendTelegramText({
          bot: deps.bot,
          chatId: Number(chatId),
          text: formatPromptIdempotentNotice(submitResult.value.promptStatus),
        });
        return;
      }

      logger.prompt("Telegram callback submitted to OpenCode", {
        session_id: submitResult.value.sessionId,
        chat_id: chatId,
        prompt_id: submitResult.value.promptId,
        event: "telegram-callback-query",
        status: submitResult.value.promptStatus,
        reason: "bridge-accepted",
      });

      await deps.bot.answerCallbackQuery(query.id, {
        text: "Respuesta recibida. Continúo con la sesión…",
        show_alert: false,
      });
    },
  };
}

function shouldDefensivelyRejectByAuthContext(
  authContext: TelegramRouterAuthContext | undefined,
  updateType: "message" | "callback_query",
  chatId: string | undefined
): boolean {
  if (!authContext || authContext.authorized) {
    return false;
  }

  logger.info("Telegram route decision", {
    event: "telegram-auth-rejected",
    routeDecision: TELEGRAM_ROUTE_DECISION.AUTH_DEFENSIVE_REJECT,
    updateType,
    chatId,
    authSource: authContext.source,
    reason: authContext.reason ?? TELEGRAM_ROUTER_AUTH_REJECT_REASON.ACTOR_NOT_ALLOWED,
    actorId: authContext.actorId,
  });

  return true;
}

async function handleCommand(deps: TelegramRouterDeps, chatId: string, text: string): Promise<void> {
  const intent = parseCommandIntent(text);
  const policy = resolveCommandPolicy(intent);
  const numericChatId = Number(chatId);
  const send = (message: string) => sendTelegramText({ bot: deps.bot, chatId: numericChatId, text: message });

  try {
    logger.info("Telegram route decision", {
      chatId,
      routeDecision: TELEGRAM_ROUTE_DECISION.COMMAND,
      intentKind: intent.kind,
      aliasUsed: intent.aliasUsed,
      commandPolicy: policy,
    });

    const statusResult = await deps.useCases.getStatus(chatId);
    if (!statusResult.ok) {
      await send(formatDomainError(statusResult.error));
      return;
    }

    if (shouldRejectBusyCommand(statusResult.value, policy, intent)) {
      await send(formatBusyCommandRejected(statusResult.value, intent.raw));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.HELP) {
      await send(formatCommandCatalog(COMMAND_CATALOG));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.PROJECT) {
      if (!intent.args) {
        await send(formatProjectQuery(statusResult.value));
        return;
      }

      const result = await deps.useCases.selectProject({
        chatId,
        selector: intent.args,
      });

      if (!result.ok) {
        await send(formatDomainError(result.error));
        return;
      }

      await send(formatProjectSelected(result.value.projectId, result.value.alias));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.SESSION) {
      if (!intent.args) {
        await send(formatUsage("session"));
        return;
      }

      const result = await deps.useCases.attachSession({
        chatId,
        sessionId: intent.args,
      });

      if (!result.ok) {
        await send(formatDomainError(result.error));
        return;
      }

      await send(formatSessionLinked(result.value.sessionId, result.value.projectId));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.NEW) {
      const result = await deps.useCases.createSession({ chatId });

      if (!result.ok) {
        await send(formatDomainError(result.error));
        return;
      }

      await send(formatSessionCreated(result.value.sessionId, result.value.projectId));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.STATUS) {
      await send(formatStatus(statusResult.value));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.CANCEL) {
      if (
        deps.openCodeAdapterMode === OPEN_CODE_ADAPTER_MODE.CLI &&
        statusResult.value.projectId &&
        statusResult.value.sessionId
      ) {
        await send(formatCancelUnsupported(statusResult.value, CLI_CANCEL_UNSUPPORTED_GUIDANCE));
        return;
      }

      if (statusResult.value.mode !== "task-running") {
        await send(formatCancelNoActiveTask(statusResult.value));
        return;
      }

      const cancelResult = await deps.useCases.cancelSession({ chatId });
      if (!cancelResult.ok) {
        const adapterCode = cancelResult.error.details?.adapterCode;
        if (adapterCode === ADAPTER_ERROR_CODES.UNSUPPORTED) {
          const guidance =
            typeof cancelResult.error.details?.guidance === "string"
              ? cancelResult.error.details.guidance
              : undefined;
          await send(formatCancelUnsupported(statusResult.value, guidance));
          return;
        }

        await send(formatDomainError(cancelResult.error));
        return;
      }

      if (cancelResult.value.status === CANCEL_SESSION_RESULT_STATUS.NO_ACTIVE_TASK) {
        await send(formatCancelNoActiveTask(statusResult.value));
        return;
      }

      await send(formatCancelSuccess(cancelResult.value, statusResult.value));
      return;
    }

    if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.RUN) {
      if (!deps.compatRunCmdCommands) {
        await send(formatLegacyRunCmdDisabled());
        return;
      }

      if (!intent.args) {
        await send("Uso: /run <comando>. Alias: /cmd <comando>");
        return;
      }

      const result = await deps.useCases.runSessionCommand({
        chatId,
        command: intent.args,
      });

      if (!result.ok) {
        await send(formatDomainError(result.error));
        return;
      }

      await send(`${formatLegacyRunCmdDeprecationNotice()}\n\n${formatRunCommandSuccess(result.value)}`);
      return;
    }

    await send(formatCommandCatalog(COMMAND_CATALOG, intent.raw));
  } catch (error) {
    logger.error("Telegram command handling failed", {
      chatId,
      command: intent.raw,
      message: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof DomainError) {
      await send(formatDomainError(error));
      return;
    }

    await send(formatUnknownError());
  }
}

function resolveCommandPolicy(intent: TelegramCommandIntent): CommandPolicy {
  if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.PROJECT && intent.args) {
    return COMMAND_POLICY.MUTATING;
  }

  return COMMAND_INTENT_POLICY[intent.kind] ?? COMMAND_POLICY.EXECUTION;
}

function shouldRejectBusyCommand(status: StatusOutput, policy: CommandPolicy, intent: TelegramCommandIntent): boolean {
  if (status.mode !== "task-running") {
    return false;
  }

  if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.STATUS) {
    return false;
  }

  if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.CANCEL) {
    return false;
  }

  if (intent.kind === TELEGRAM_COMMAND_INTENT_KIND.PROJECT && !intent.args) {
    return false;
  }

  return policy !== COMMAND_POLICY.READ_ONLY;
}

async function handleText(deps: TelegramRouterDeps, chatId: string, text: string): Promise<void> {
  try {
    const numericChatId = Number(chatId);
    const send = (message: string) => sendTelegramText({ bot: deps.bot, chatId: numericChatId, text: message });
    const status = await deps.useCases.getStatus(chatId);
    if (!status.ok) {
      await send(formatDomainError(status.error));
      return;
    }

    if (!status.value.projectId || !status.value.sessionId) {
      logger.info("Telegram route decision", {
        chatId,
        routeDecision: TELEGRAM_ROUTE_DECISION.FREE_TEXT_REJECTED_NO_CONTEXT,
        statusMode: status.value.mode,
      });
      await send(formatNoSessionGuide());
      return;
    }

    if (status.value.mode === "task-running") {
      logger.info("Telegram route decision", {
        chatId,
        routeDecision: TELEGRAM_ROUTE_DECISION.FREE_TEXT_REJECTED_RUNNING,
        statusMode: status.value.mode,
      });
      await send(formatFreeTextRejectedBusy(status.value));
      return;
    }

    const allowedModes: ReadonlySet<string> = new Set(["idle", "session-linked", "needs-attention"]);
    if (!allowedModes.has(status.value.mode)) {
      logger.info("Telegram route decision", {
        chatId,
        routeDecision: TELEGRAM_ROUTE_DECISION.FREE_TEXT_REJECTED_STATE,
        statusMode: status.value.mode,
      });
      await send(formatNoSessionGuide(status.value));
      return;
    }

    const activePrompt = await findActivePromptByStatus(deps.persistence, status.value);
    if (activePrompt && activePrompt.promptType !== PROMPT_TYPE.TEXT) {
      logger.info("Telegram route decision", {
        chatId,
        routeDecision: TELEGRAM_ROUTE_DECISION.FREE_TEXT_REJECTED_PROMPT_NON_TEXT,
        statusMode: status.value.mode,
        promptId: activePrompt.promptId,
        promptType: activePrompt.promptType,
      });
      await send(formatPromptTextOnlyNotice());
      return;
    }

    logger.info("Telegram route decision", {
      chatId,
      routeDecision: activePrompt
        ? TELEGRAM_ROUTE_DECISION.FREE_TEXT_ALLOWED_PROMPT_TEXT
        : TELEGRAM_ROUTE_DECISION.FREE_TEXT_ALLOWED,
      statusMode: status.value.mode,
      promptId: activePrompt?.promptId,
      promptType: activePrompt?.promptType,
    });

    if (activePrompt && activePrompt.promptType === PROMPT_TYPE.TEXT) {
      const submitResult = await deps.useCases.submitPendingPrompt({
        chatId,
        sessionId: activePrompt.sessionId,
        promptId: activePrompt.promptId,
        text,
      });

      if (!submitResult.ok) {
        logger.prompt("Telegram text prompt submit failed", {
          session_id: activePrompt.sessionId,
          chat_id: chatId,
          prompt_id: activePrompt.promptId,
          event: "telegram-text-submit",
          status: "submit-error",
          reason: submitResult.error.code,
        });
        await send(formatDomainError(submitResult.error));
        return;
      }

      if (submitResult.value.status === SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT) {
        logger.prompt("Telegram text prompt idempotent submit", {
          session_id: submitResult.value.sessionId,
          chat_id: chatId,
          prompt_id: submitResult.value.promptId,
          event: "telegram-text-submit",
          status: submitResult.value.promptStatus,
          reason: submitResult.value.reason ?? "idempotent",
        });
        await send(formatPromptIdempotentNotice(submitResult.value.promptStatus));
        return;
      }

      logger.prompt("Telegram text prompt submitted to OpenCode", {
        session_id: submitResult.value.sessionId,
        chat_id: chatId,
        prompt_id: submitResult.value.promptId,
        event: "telegram-text-submit",
        status: submitResult.value.promptStatus,
        reason: "bridge-accepted",
      });

      await send(formatSendSuccess("Respuesta enviada. Continúo con la sesión…", false));
      return;
    }

    const result = await deps.useCases.sendText({ chatId, text });
    if (!result.ok) {
      await send(formatDomainError(result.error));
      return;
    }

    await send(formatSendSuccess(result.value.reply ?? result.value.message, result.value.needsAttention));
  } catch (error) {
    logger.error("Telegram text handling failed", {
      chatId,
      message: error instanceof Error ? error.message : String(error),
    });
    await sendTelegramText({ bot: deps.bot, chatId: Number(chatId), text: formatUnknownError() });
  }
}

function parsePromptCallbackPayload(data: string | undefined): { promptId: string; choice: string } | undefined {
  if (!data || !data.startsWith("prompt:")) {
    return undefined;
  }

  const [prefix, promptId, ...choiceParts] = data.split(":");
  if (prefix !== "prompt" || !promptId || choiceParts.length === 0) {
    return undefined;
  }

  const choice = choiceParts.join(":").trim();
  if (!choice) {
    return undefined;
  }

  return {
    promptId: promptId.trim(),
    choice,
  };
}

async function findActivePromptByStatus(deps: PersistenceDriver | undefined, status: StatusOutput) {
  if (!deps) {
    return undefined;
  }

  if (!status.sessionId || status.mode !== "needs-attention") {
    return undefined;
  }

  return deps.runInTransaction((unit: PersistenceUnit) => unit.pendingPrompts.findActiveBySessionId(status.sessionId!));
}

function normalizeCommand(text: string): string {
  const firstToken = text.split(/\s+/u)[0] ?? "";
  const withoutBotName = firstToken.includes("@") ? firstToken.split("@")[0] : firstToken;
  return withoutBotName.replace(/^\//u, "").trim().toLowerCase();
}

function extractArgs(text: string): string {
  const firstSpace = text.indexOf(" ");
  if (firstSpace < 0) return "";
  return text.slice(firstSpace + 1).trim();
}

function parseCommandIntent(text: string): TelegramCommandIntent {
  const command = normalizeCommand(text);
  const args = extractArgs(text);
  const kind = COMMAND_ALIASES[command as keyof typeof COMMAND_ALIASES] ?? TELEGRAM_COMMAND_INTENT_KIND.UNKNOWN;

  return {
    kind,
    raw: command,
    args: args || undefined,
    aliasUsed: command,
  };
}

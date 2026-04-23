import TelegramBot from "node-telegram-bot-api";
import {
  ASYNC_SESSION_NOTICE_KIND,
  AsyncSessionNotice,
  BootRecoveryNotice,
  PersistenceDriver,
} from "../../application/contracts";
import { PENDING_PROMPT_STATUS, PROMPT_TYPE } from "../../domain/entities";
import { logger } from "../../logger";
import { sanitizeTelegramHtml } from "./sanitize";
import {
  formatActiveHumanPrompt,
  formatAsyncSessionNotice,
  formatPromptCancelledNotice,
  formatPromptExpiredNotice,
  formatRecoveryNotice,
  formatStalePromptNotice,
} from "./templates";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_SAFE_CHUNK_LENGTH = 3800;
const TRUNCATION_NOTICE = "… [recortado por límite de Telegram]";

export interface SendTelegramTextInput {
  readonly bot: TelegramBot;
  readonly chatId: number;
  readonly text: string;
}

export interface SendBootRecoveryNoticesInput {
  readonly bot: TelegramBot;
  readonly notices: readonly BootRecoveryNotice[];
}

export interface SendAsyncSessionNoticeInput {
  readonly bot: TelegramBot;
  readonly notice: AsyncSessionNotice;
  readonly persistence?: PersistenceDriver;
}

export async function sendTelegramText(input: SendTelegramTextInput): Promise<void> {
  const sanitized = sanitizeTelegramHtml(input.text);
  const chunks = chunkTelegramMessage(sanitized);

  logger.info("Telegram sender chunk plan", {
    chatId: input.chatId,
    chunkCount: chunks.length,
    maxLength: TELEGRAM_MAX_MESSAGE_LENGTH,
  });

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const prefixedChunk = chunks.length > 1 ? `(${index + 1}/${chunks.length})\n${chunk}` : chunk;

    await sendWithParseModeFallback(input.bot, input.chatId, prefixedChunk, index + 1, chunks.length);
  }
}

export async function sendBootRecoveryNotices(input: SendBootRecoveryNoticesInput): Promise<void> {
  const noticesByChat = new Map<string, BootRecoveryNotice>();

  for (const notice of input.notices) {
    if (!notice.chatId.trim() || noticesByChat.has(notice.chatId)) {
      continue;
    }

    noticesByChat.set(notice.chatId, notice);
  }

  for (const notice of noticesByChat.values()) {
    const numericChatId = Number(notice.chatId);
    if (Number.isNaN(numericChatId)) {
      logger.error("Cannot dispatch recovery notice due invalid chat id", {
        chatId: notice.chatId,
        kind: notice.kind,
      });
      continue;
    }

    try {
      await sendTelegramText({
        bot: input.bot,
        chatId: numericChatId,
        text: formatRecoveryNotice(notice),
      });
    } catch (error) {
      logger.error("Failed to dispatch boot recovery notice", {
        chatId: notice.chatId,
        kind: notice.kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function sendAsyncSessionNotice(input: SendAsyncSessionNoticeInput): Promise<void> {
  const numericChatId = Number(input.notice.chatId);
  if (Number.isNaN(numericChatId)) {
    logger.error("Cannot dispatch async session notice due invalid chat id", {
      chatId: input.notice.chatId,
      kind: input.notice.kind,
    });
    return;
  }

  if (input.notice.kind === ASYNC_SESSION_NOTICE_KIND.NEEDS_INPUT && input.notice.prompt) {
    const message = await sendPromptMessage(input.bot, numericChatId, input.notice.prompt);

    if (input.persistence) {
      await trackPromptMessageReference(input.persistence, input.notice.prompt.promptId, {
        telegramChatId: input.notice.chatId,
        telegramMessageId: message.message_id,
      });
    }
  }

  if (input.notice.promptCleanup?.telegramMessageId) {
    await cleanupPromptMessage(input.bot, input.notice, numericChatId);

    if (input.persistence) {
      const cleanupStatus =
        input.notice.promptCleanup.reason === "expired"
          ? PENDING_PROMPT_STATUS.EXPIRED
          : input.notice.promptCleanup.reason === "cancelled"
            ? PENDING_PROMPT_STATUS.CANCELLED
            : PENDING_PROMPT_STATUS.INVALIDATED;

      await trackPromptCleanup(input.persistence, input.notice.promptCleanup.promptId, cleanupStatus);
    }
  }

  if (input.notice.kind !== ASYNC_SESSION_NOTICE_KIND.NEEDS_INPUT || !input.notice.prompt) {
    await sendTelegramText({
      bot: input.bot,
      chatId: numericChatId,
      text: formatAsyncSessionNotice(input.notice),
    });
  }
}

async function sendPromptMessage(
  bot: TelegramBot,
  chatId: number,
  prompt: NonNullable<AsyncSessionNotice["prompt"]>
): Promise<TelegramBot.Message> {
  const text = sanitizeTelegramHtml(
    formatActiveHumanPrompt({
      message: prompt.message,
      promptType: prompt.promptType,
      options: prompt.options,
      expiresAt: prompt.expiresAt,
    })
  );

  const replyMarkup: TelegramBot.SendMessageOptions["reply_markup"] =
    prompt.promptType === PROMPT_TYPE.BOOLEAN
      ? {
          inline_keyboard: [
            [
            { text: "✅ Sí", callback_data: buildPromptCallbackData(prompt.promptId, "yes") },
            { text: "❌ No", callback_data: buildPromptCallbackData(prompt.promptId, "no") },
            ],
          ],
        }
      : prompt.promptType === PROMPT_TYPE.OPTIONS
        ? {
            inline_keyboard: [
              ...(prompt.options?.map((option) => [
                {
                  text: option,
                  callback_data: buildPromptCallbackData(prompt.promptId, option),
                },
              ]) ?? []),
            ],
          }
        : undefined;

  try {
    return await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  } catch (error) {
    if (!isParseModeError(error)) {
      throw error;
    }

    return bot.sendMessage(chatId, text, {
      reply_markup: replyMarkup,
    });
  }
}

async function cleanupPromptMessage(bot: TelegramBot, notice: AsyncSessionNotice, fallbackChatId: number): Promise<void> {
  const cleanup = notice.promptCleanup;
  if (!cleanup?.telegramMessageId) {
    return;
  }

  const chatId = Number(cleanup.telegramChatId ?? String(fallbackChatId));
  if (Number.isNaN(chatId)) {
    return;
  }

  const closingText =
    cleanup.reason === "expired"
      ? formatPromptExpiredNotice()
      : cleanup.reason === "cancelled"
        ? formatPromptCancelledNotice()
        : formatStalePromptNotice();

  const sanitizedText = sanitizeTelegramHtml(closingText);

  try {
    await bot.editMessageText(sanitizedText, {
      chat_id: chatId,
      message_id: cleanup.telegramMessageId,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.info("Telegram prompt cleanup edit fallback", {
      chatId,
      promptId: cleanup.promptId,
      reason: cleanup.reason,
      message,
    });
  }

  try {
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      {
        chat_id: chatId,
        message_id: cleanup.telegramMessageId,
      }
    );
  } catch (error) {
    logger.error("Failed to remove inline keyboard during prompt cleanup", {
      chatId,
      promptId: cleanup.promptId,
      reason: cleanup.reason,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildPromptCallbackData(promptId: string, choice: string): string {
  return `prompt:${promptId}:${choice}`;
}

async function trackPromptMessageReference(
  persistence: PersistenceDriver,
  promptId: string,
  ref: {
    readonly telegramChatId: string;
    readonly telegramMessageId: number;
  }
): Promise<void> {
  await persistence.runInTransaction(async (unit) => {
    const existing = await unit.pendingPrompts.findByPromptId(promptId);
    if (!existing) {
      return;
    }

    await unit.pendingPrompts.upsert({
      ...existing,
      telegramChatId: ref.telegramChatId,
      telegramMessageId: ref.telegramMessageId,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function trackPromptCleanup(
  persistence: PersistenceDriver,
  promptId: string,
  status: (typeof PENDING_PROMPT_STATUS)[keyof typeof PENDING_PROMPT_STATUS]
): Promise<void> {
  await persistence.runInTransaction(async (unit) => {
    const existing = await unit.pendingPrompts.findByPromptId(promptId);
    if (!existing || existing.status === status) {
      return;
    }

    await unit.pendingPrompts.upsert({
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function sendWithParseModeFallback(
  bot: TelegramBot,
  chatId: number,
  htmlText: string,
  chunkIndex: number,
  chunkCount: number
): Promise<void> {
  try {
    await bot.sendMessage(chatId, htmlText, { parse_mode: "HTML" });
  } catch (error) {
    if (!isParseModeError(error)) {
      throw error;
    }

    logger.info("Telegram sender parse-mode fallback", {
      chatId,
      chunkIndex,
      chunkCount,
      reason: error instanceof Error ? error.message : String(error),
      fallbackPlainText: true,
    });

    const prefixedPlainText = chunkCount > 1 ? `(${chunkIndex}/${chunkCount})\n${htmlText}` : htmlText;
    await bot.sendMessage(chatId, prefixedPlainText);
  }
}

function isParseModeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("parse") || message.includes("entities") || message.includes("can't") || message.includes("cant");
}

function chunkTelegramMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const normalizedParagraph = paragraph.trim();
    if (!normalizedParagraph) {
      continue;
    }

    const segments = splitParagraphIntoSafeSegments(normalizedParagraph);

    for (const segment of segments) {
      const candidate = current ? `${current}\n\n${segment}` : segment;
      if (candidate.length <= TELEGRAM_SAFE_CHUNK_LENGTH) {
        current = candidate;
        continue;
      }

      if (current) {
        chunks.push(current);
      }

      current = segment;
    }
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length === 0) {
    return [truncateFragment(text)];
  }

  return chunks;
}

function splitParagraphIntoSafeSegments(paragraph: string): string[] {
  if (paragraph.length <= TELEGRAM_SAFE_CHUNK_LENGTH) {
    return [paragraph];
  }

  const lines = paragraph.split("\n");
  const segments: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= TELEGRAM_SAFE_CHUNK_LENGTH) {
      current = candidate;
      continue;
    }

    if (current) {
      segments.push(current);
    }

    if (line.length <= TELEGRAM_SAFE_CHUNK_LENGTH) {
      current = line;
      continue;
    }

    segments.push(truncateFragment(line));
    current = "";
  }

  if (current) {
    segments.push(current);
  }

  return segments;
}

function truncateFragment(fragment: string): string {
  const maxLength = TELEGRAM_SAFE_CHUNK_LENGTH - TRUNCATION_NOTICE.length - 1;
  if (fragment.length <= TELEGRAM_SAFE_CHUNK_LENGTH) {
    return fragment;
  }

  return `${fragment.slice(0, Math.max(1, maxLength))} ${TRUNCATION_NOTICE}`;
}

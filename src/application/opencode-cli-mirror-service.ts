import TelegramBot from "node-telegram-bot-api";
import { Config } from "../config";
import { PersistenceDriver } from "./contracts";
import { exportSession, OpenCodeCliMessage, OPEN_CODE_CLI_ROLE } from "../infrastructure/opencode-cli";
import { readOpenCodeLocalSessionMessages } from "../infrastructure/opencode-local-store";
import { OPEN_CODE_ADAPTER_MODE } from "../infrastructure/opencode-adapter-mode";
import { sendTelegramText, TELEGRAM_CONTENT_KIND } from "../adapters/telegram/message-sender";
import { formatExecutionMetadataBlock } from "../adapters/telegram/templates";
import { logger } from "../logger";
import { syncRuntimeMetadata } from "./runtime-metadata-sync";

export interface OpenCodeCliMirrorServiceDeps {
  readonly config: Config;
  readonly persistence: PersistenceDriver;
  readonly bot: TelegramBot;
  readonly exportSessionFn?: typeof exportSession;
  readonly readLocalSessionMessagesFn?: typeof readOpenCodeLocalSessionMessages;
  readonly openCodeLocalDbPath?: string;
  readonly sendTelegramTextFn?: typeof sendTelegramText;
}

export interface OpenCodeCliMirrorService {
  start(): void;
  stop(): void;
  registerTelegramEcho(sessionId: string, assistantText: string): void;
  runSweepNow(): Promise<void>;
}

interface SessionMirrorTarget {
  readonly chatId: string;
  readonly sessionId: string;
}

const TELEGRAM_ECHO_FIFO_LIMIT = 20;

export function createOpenCodeCliMirrorService(deps: OpenCodeCliMirrorServiceDeps): OpenCodeCliMirrorService {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const lastSeenAssistantMessageKeyBySession = new Map<string, string>();
  const suppressAssistantTextBySession = new Map<string, string[]>();
  const rememberedMetadataBySession = new Map<string, { agent?: string; model?: string }>();

  return {
    start() {
      if (timer) {
        return;
      }

      const intervalMs = Math.max(1500, deps.config.pollingIntervalMs);
      timer = setInterval(() => {
        void sweep().catch((error) => {
          logger.error("OpenCode CLI mirror sweep failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, intervalMs);

      void sweep().catch((error) => {
        logger.error("OpenCode CLI mirror initial sweep failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    },

    stop() {
      if (!timer) {
        return;
      }

      clearInterval(timer);
      timer = undefined;
    },

    registerTelegramEcho(sessionId: string, assistantText: string) {
      const normalizedText = assistantText.trim();
      if (!normalizedText) {
        return;
      }

      const pending = suppressAssistantTextBySession.get(sessionId) ?? [];
      pending.push(normalizedText);
      if (pending.length > TELEGRAM_ECHO_FIFO_LIMIT) {
        pending.splice(0, pending.length - TELEGRAM_ECHO_FIFO_LIMIT);
      }
      suppressAssistantTextBySession.set(sessionId, pending);
    },

    async runSweepNow() {
      await sweep();
    },
  };

  async function sweep(): Promise<void> {
    if (running) {
      return;
    }

    running = true;
    try {
      const targets = await listActiveSessionTargets(deps.persistence);
      pruneInactiveSessions(targets);

      for (const target of targets) {
        try {
          await mirrorSession(target);
        } catch (error) {
          logger.error("OpenCode CLI mirror session sync failed", {
            chatId: target.chatId,
            sessionId: target.sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      running = false;
    }
  }

  async function mirrorSession(target: SessionMirrorTarget): Promise<void> {
    const exported = await loadSessionMessages(target.sessionId);

    const assistantMessages = exported.messages.filter((message) => message.role === OPEN_CODE_CLI_ROLE.ASSISTANT);
    if (assistantMessages.length === 0) {
      return;
    }

    const lastSeenKey = lastSeenAssistantMessageKeyBySession.get(target.sessionId);

    if (!lastSeenKey) {
      const latest = assistantMessages[assistantMessages.length - 1];
      lastSeenAssistantMessageKeyBySession.set(target.sessionId, buildMessageKey(latest));
      return;
    }

    const freshAssistantMessages = sliceAfterLastSeen(assistantMessages, lastSeenKey);

    for (const message of freshAssistantMessages) {
      if (shouldSuppressTelegramEcho(target.sessionId, message.text)) {
        lastSeenAssistantMessageKeyBySession.set(target.sessionId, buildMessageKey(message));
        continue;
      }

      const numericChatId = Number(target.chatId);
      if (Number.isNaN(numericChatId)) {
        continue;
      }

      await (deps.sendTelegramTextFn ?? sendTelegramText)({
        bot: deps.bot,
        chatId: numericChatId,
        text: message.text,
        contentKind: TELEGRAM_CONTENT_KIND.MODEL,
      });

      const metadata = await resolveSessionMetadata(target, exported.messages);
      const metadataNotice = formatExecutionMetadataBlock({
        effectiveAgent: metadata.agent,
        effectiveModel: metadata.model,
      });
      if (metadataNotice.trim()) {
        await (deps.sendTelegramTextFn ?? sendTelegramText)({
          bot: deps.bot,
          chatId: numericChatId,
          text: metadataNotice,
          contentKind: TELEGRAM_CONTENT_KIND.TELEGRAM_NATIVE,
        });
      }

      const current = rememberedMetadataBySession.get(target.sessionId);
      if (current?.model && !metadata.model) {
        metadata.model = current.model;
      }

      lastSeenAssistantMessageKeyBySession.set(target.sessionId, buildMessageKey(message));
    }
  }

  async function resolveSessionMetadata(
    target: SessionMirrorTarget,
    runtimeMessages: readonly OpenCodeCliMessage[]
  ): Promise<{ agent?: string; model?: string }> {
    const previous = rememberedMetadataBySession.get(target.sessionId);

    const snapshot = await deps.persistence.runInTransaction(async (unit) => {
      const persisted = await unit.sessions.findById(target.sessionId);
      if (!persisted) {
        return { persisted: undefined, configuredAgent: undefined };
      }

      const configuredAgent = unit.agentSelections
        ? normalizeMetaString(
            (
              await unit.agentSelections.findByChatAndProject(target.chatId, persisted.projectId)
            )?.activeAgent
          )
        : undefined;

      return { persisted, configuredAgent };
    });

    const synced = await syncRuntimeMetadata({
      persistence: deps.persistence,
      chatId: target.chatId,
      projectId: snapshot.persisted?.projectId ?? "",
      sessionId: target.sessionId,
      nowIso: new Date().toISOString(),
      readRuntimeMessages: async () => runtimeMessages,
      fallback: {
        requestedAgent: snapshot.persisted?.requestedAgent,
        requestedModel: snapshot.persisted?.requestedModel,
        effectiveAgent: snapshot.persisted?.effectiveAgent,
        effectiveModel: snapshot.persisted?.effectiveModel,
      },
    });

    const detectedAgent =
      normalizeMetaString(synced.effectiveAgent) ??
      normalizeMetaString(snapshot.persisted?.requestedAgent);
    const detectedModel =
      normalizeMetaString(synced.effectiveModel) ??
      normalizeMetaString(snapshot.persisted?.requestedModel);

    const next = {
      agent: detectedAgent ?? previous?.agent ?? snapshot.configuredAgent,
      model: detectedModel ?? previous?.model,
    };

    rememberedMetadataBySession.set(target.sessionId, next);
    return next;
  }

  async function loadSessionMessages(sessionId: string) {
    if (isLocalCliLikeMode(deps.config)) {
      return (deps.readLocalSessionMessagesFn ?? readOpenCodeLocalSessionMessages)({
        sessionId,
        dbPath: deps.openCodeLocalDbPath,
      });
    }

    return (deps.exportSessionFn ?? exportSession)({
      sessionId,
      timeoutMs: deps.config.openCodeControlTimeoutMs,
    });
  }

  function shouldSuppressTelegramEcho(sessionId: string, messageText: string): boolean {
    const queue = suppressAssistantTextBySession.get(sessionId);
    if (!queue || queue.length === 0) {
      return false;
    }

    const normalized = messageText.trim();
    const head = queue[0];
    if (head !== normalized) {
      return false;
    }

    queue.shift();
    if (queue.length === 0) {
      suppressAssistantTextBySession.delete(sessionId);
    }

    return true;
  }

  function pruneInactiveSessions(targets: readonly SessionMirrorTarget[]): void {
    const activeSessionIds = new Set(targets.map((target) => target.sessionId));

    for (const sessionId of lastSeenAssistantMessageKeyBySession.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        lastSeenAssistantMessageKeyBySession.delete(sessionId);
      }
    }

    for (const sessionId of suppressAssistantTextBySession.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        suppressAssistantTextBySession.delete(sessionId);
      }
    }

    for (const sessionId of rememberedMetadataBySession.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        rememberedMetadataBySession.delete(sessionId);
      }
    }
  }
}

function normalizeMetaString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isLocalCliLikeMode(config: Config): boolean {
  const adapterMode = config.openCodeAdapter ?? OPEN_CODE_ADAPTER_MODE.HTTP;
  return adapterMode === OPEN_CODE_ADAPTER_MODE.CLI || adapterMode === OPEN_CODE_ADAPTER_MODE.PTY;
}

function sliceAfterLastSeen(
  messages: readonly OpenCodeCliMessage[],
  lastSeenKey: string | undefined
): readonly OpenCodeCliMessage[] {
  const index = messages.findIndex((message) => buildMessageKey(message) === lastSeenKey);
  if (index < 0) {
    return messages;
  }

  return messages.slice(index + 1);
}

export function buildMessageKey(message: OpenCodeCliMessage): string {
  const timestampPart = message.createdAt ?? "no-ts";
  const textPart = message.text.trim() || "no-text";
  return `${message.id}|${timestampPart}|${textPart}`;
}

async function listActiveSessionTargets(persistence: PersistenceDriver): Promise<readonly SessionMirrorTarget[]> {
  return persistence.runInTransaction(async (unit) => {
    const bindings = await unit.bindings.listAll();
    const targets: SessionMirrorTarget[] = [];

    for (const binding of bindings) {
      if (!binding.activeProjectId || !binding.activeSessionId) {
        continue;
      }

      targets.push({
        chatId: binding.chatId,
        sessionId: binding.activeSessionId,
      });
    }

    return targets;
  });
}

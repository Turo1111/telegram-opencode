import { randomUUID } from "node:crypto";
import {
  ASYNC_SESSION_NOTICE_KIND,
  AsyncSessionNotice,
  OpenCodeSessionAdapter,
  PendingPromptRepository,
  PersistenceDriver,
  PersistenceUnit,
  SESSION_EVENT_KIND,
  SessionEvent,
  SessionNeedsInputData,
  SessionWatcherRegistration,
  TERMINAL_EVENT_SOURCE,
  TerminalEventSource,
  WatchdogCandidate,
  WebhookAuthContext,
} from "./contracts";
import { Config } from "../config";
import {
  ACTIVE_TASK_STATUS,
  OPERATIONAL_MODES,
  PENDING_PROMPT_STATUS,
  PROMPT_TYPE,
  PendingPrompt,
  PendingPromptStatus,
  createIdleState,
} from "../domain/entities";
import { ERROR_CODES } from "../domain/errors";
import { completeTaskIfExists, resolveStableSessionMode } from "./boot-recovery-service";
import type { ReceiverHandlerResult } from "../infrastructure/http/session-webhook-receiver";
import { logger } from "../logger";

export interface SessionWatcherServiceDeps {
  readonly config: Config;
  readonly persistence: PersistenceDriver;
  readonly adapter: OpenCodeSessionAdapter;
  readonly notify: (notice: AsyncSessionNotice) => Promise<void>;
  readonly callbackUrl: string;
}

export interface SessionWatcherService {
  createRegistration(): SessionWatcherRegistration;
  handleIncomingEvent(auth: WebhookAuthContext, event: SessionEvent): Promise<ReceiverHandlerResult>;
  runWatchdogSweep(nowIso?: string): Promise<void>;
  restoreAfterRestart(nowIso?: string): Promise<void>;
  startScheduler(): void;
  stopScheduler(): void;
}

export function createSessionWatcherService(deps: SessionWatcherServiceDeps): SessionWatcherService {
  let timer: NodeJS.Timeout | undefined;
  const chatQueue = new Map<string, Promise<void>>();

  async function findBindingBySessionId(sessionId: string): Promise<{ chatId: string } | undefined> {
    return deps.persistence.runInTransaction(async (unit) => {
      const bindings = await unit.bindings.listAll();
      const match = bindings.find((binding) => binding.activeSessionId === sessionId);
      return match ? { chatId: match.chatId } : undefined;
    });
  }

  return {
    createRegistration() {
      return {
        callbackUrl: deps.callbackUrl,
        bearerToken: randomUUID(),
      };
    },
    async handleIncomingEvent(auth, event) {
      try {
        const result = await applyEvent(auth, event, TERMINAL_EVENT_SOURCE.WEBHOOK, {
          enqueue: true,
        });
        return {
          statusCode: result.accepted ? 202 : result.statusCode,
          body: { ok: result.accepted, reason: result.reason },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Watcher event rejected", { sessionId: event.sessionId, message });
        return { statusCode: 400, body: { ok: false, error: message } };
      }
    },
    async runWatchdogSweep(nowIso = new Date().toISOString()) {
      const candidates = await listWatchdogCandidates(deps.persistence, nowIso, deps.config.watchdogStaleAfterMs);

      for (const candidate of candidates) {
        await enqueueByChat(chatQueue, candidate.chatId, async () => {
          await expirePendingPromptIfNeeded(candidate, nowIso);

          const state = await deps.adapter.getSessionState({
            projectId: candidate.projectId,
            sessionId: candidate.sessionId,
          });

          if (!state.ok) {
            const retryable =
              state.error.code === ERROR_CODES.UPSTREAM_TIMEOUT || state.error.code === ERROR_CODES.UPSTREAM_5XX;

            await deps.persistence.runInTransaction(async (unit) => {
              const session = await unit.sessions.findById(candidate.sessionId);
              if (!session || session.terminalCause) {
                return;
              }

              const nextRetryCount = (session.watchdogRetryCount ?? 0) + 1;
              await unit.sessions.upsert({
                ...session,
                updatedAt: nowIso,
                watchdogRetryCount: nextRetryCount,
              });
            });

            if (retryable && candidate.watchdogRetryCount + 1 < deps.config.watchdogMaxRetryCount) {
              return;
            }

            await applySyntheticTerminal(candidate, nowIso, "watchdog-state-unavailable", TERMINAL_EVENT_SOURCE.WATCHDOG);
            return;
          }

          if (state.value.status === "running") {
            await cancelPendingPromptOnWatchdogResume(candidate, nowIso);
            await touchSession(candidate.sessionId, nowIso);
            return;
          }

          if (state.value.status === "needs-attention") {
            await applyEvent(
              { bearerToken: candidate.watcherToken ?? "watchdog" },
              {
                kind: SESSION_EVENT_KIND.NEEDS_INPUT,
                sessionId: candidate.sessionId,
                projectId: candidate.projectId,
                occurredAt: nowIso,
                data: { source: "watchdog" },
              },
              TERMINAL_EVENT_SOURCE.WATCHDOG,
              {
                bypassToken: true,
                enqueue: false,
                knownChatId: candidate.chatId,
              }
            );
            return;
          }

          if (state.value.status === "completed" || state.value.status === "idle") {
            await cancelPendingPromptOnWatchdogResume(candidate, nowIso);
            await applySyntheticTerminal(candidate, nowIso, "watchdog-recovered-terminal", TERMINAL_EVENT_SOURCE.WATCHDOG);
            return;
          }

          await applySyntheticTerminal(candidate, nowIso, "watchdog-remote-missing", TERMINAL_EVENT_SOURCE.WATCHDOG);
        });
      }
    },
    async restoreAfterRestart(nowIso = new Date().toISOString()) {
      const notices = await deps.persistence.runInTransaction(async (unit) => {
        const [bindings, sessions] = await Promise.all([unit.bindings.listAll(), unit.sessions.listAll()]);
        const bindingBySessionId = new Map(
          bindings
            .filter((binding) => binding.activeProjectId && binding.activeSessionId)
            .map((binding) => [binding.activeSessionId!, binding])
        );
        const pending: AsyncSessionNotice[] = [];

        for (const session of sessions) {
          const binding = bindingBySessionId.get(session.sessionId);
          if (!binding || !session.watcherEnabled || session.terminalCause) {
            continue;
          }

          if (!session.watcherToken) {
            continue;
          }

          await unit.sessions.upsert({
            ...session,
            watcherToken: undefined,
            continuityLostAt: nowIso,
            updatedAt: nowIso,
          });

          pending.push({
            chatId: binding.chatId,
            kind: ASYNC_SESSION_NOTICE_KIND.CONTINUITY_LOST,
            projectId: session.projectId,
            sessionId: session.sessionId,
            summary: "El webhook anterior quedó invalidado y la sesión se va a reconciliar por watchdog.",
          });
        }

        return pending;
      });

      for (const notice of notices) {
        await deps.notify(notice);
      }

      if (deps.config.watchdogEnabled) {
        await this.runWatchdogSweep(nowIso);
      }
    },
    startScheduler() {
      if (!deps.config.watchdogEnabled || timer) {
        return;
      }

      timer = setInterval(() => {
        void this.runWatchdogSweep().catch((error) => {
          logger.error("Watchdog sweep failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }, deps.config.watchdogIntervalMs);
    },
    stopScheduler() {
      if (!timer) {
        return;
      }

      clearInterval(timer);
      timer = undefined;
    },
  };

  async function applySyntheticTerminal(
    candidate: WatchdogCandidate,
    occurredAt: string,
    cause: string,
    source: TerminalEventSource
  ): Promise<void> {
    await applyEvent(
      { bearerToken: "watchdog" },
      {
        kind: SESSION_EVENT_KIND.FAILED,
        sessionId: candidate.sessionId,
        occurredAt,
        data: { cause },
      },
      source,
      {
        bypassToken: true,
        enqueue: false,
        knownChatId: candidate.chatId,
      }
    );
  }

  async function touchSession(sessionId: string, nowIso: string): Promise<void> {
    await deps.persistence.runInTransaction(async (unit) => {
      const session = await unit.sessions.findById(sessionId);
      if (!session) {
        return;
      }

      await unit.sessions.upsert({
        ...session,
        lastObservedAt: nowIso,
        updatedAt: nowIso,
        watchdogRetryCount: 0,
      });
    });
  }

  async function expirePendingPromptIfNeeded(candidate: WatchdogCandidate, nowIso: string): Promise<void> {
    const prompt = await deps.persistence.runInTransaction((unit) =>
      unit.pendingPrompts.findActiveBySessionId(candidate.sessionId)
    );
    if (!prompt || !isPromptExpired(prompt, nowIso, deps.config.humanPromptLocalTtlMs)) {
      return;
    }

    await deps.persistence.runInTransaction(async (unit) => {
      const currentPrompt = await unit.pendingPrompts.findByPromptId(prompt.promptId);
      if (!currentPrompt || currentPrompt.status !== PENDING_PROMPT_STATUS.ACTIVE) {
        return;
      }

      await unit.pendingPrompts.compareAndSetStatus({
        promptId: currentPrompt.promptId,
        fromStatus: PENDING_PROMPT_STATUS.ACTIVE,
        toStatus: PENDING_PROMPT_STATUS.EXPIRED,
        updatedAt: nowIso,
      });

      await clearNeedsAttentionIfPromptClosed(unit, candidate.chatId, candidate.sessionId, nowIso);

      logger.prompt("Pending prompt expired by watchdog", {
        session_id: candidate.sessionId,
        chat_id: candidate.chatId,
        prompt_id: currentPrompt.promptId,
        event: "watchdog-expire-prompt",
        status: PENDING_PROMPT_STATUS.EXPIRED,
        reason: "ttl-reached",
      });
    });
  }

  async function cancelPendingPromptOnWatchdogResume(candidate: WatchdogCandidate, nowIso: string): Promise<void> {
    await deps.persistence.runInTransaction(async (unit) => {
      const active = await unit.pendingPrompts.findActiveBySessionId(candidate.sessionId);
      if (!active) {
        return;
      }

      await unit.pendingPrompts.compareAndSetStatus({
        promptId: active.promptId,
        fromStatus: PENDING_PROMPT_STATUS.ACTIVE,
        toStatus: PENDING_PROMPT_STATUS.CANCELLED,
        updatedAt: nowIso,
      });

      await clearNeedsAttentionIfPromptClosed(unit, candidate.chatId, candidate.sessionId, nowIso);

      logger.prompt("Pending prompt cancelled by watchdog resume", {
        session_id: candidate.sessionId,
        chat_id: candidate.chatId,
        prompt_id: active.promptId,
        event: "watchdog-cancel-prompt",
        status: PENDING_PROMPT_STATUS.CANCELLED,
        reason: "remote-resumed",
      });
    });
  }

  async function applyEvent(
    auth: WebhookAuthContext,
    event: SessionEvent,
    source: TerminalEventSource,
    options: {
      readonly bypassToken?: boolean;
      readonly enqueue?: boolean;
      readonly knownChatId?: string;
    } = {}
  ): Promise<{ accepted: boolean; statusCode: number; reason?: string }> {
    const binding = options.knownChatId
      ? { chatId: options.knownChatId }
      : await findBindingBySessionId(event.sessionId);
    if (!binding) {
      return { accepted: false, statusCode: 404, reason: "unknown-session" };
    }

    const runMutation = async () => {
      const notice = await deps.persistence.runInTransaction(async (unit) => {
        const session = await unit.sessions.findById(event.sessionId);
        if (!session) {
          return { accepted: false, statusCode: 404, reason: "unknown-session" } as const;
        }

        if (!options.bypassToken && (!session.watcherToken || session.watcherToken !== auth.bearerToken)) {
          return { accepted: false, statusCode: 403, reason: "invalid-token" } as const;
        }

        if (session.terminalCause && isTerminalEvent(event.kind)) {
          return { accepted: false, statusCode: 202, reason: "duplicate-terminal" } as const;
        }

        const existingBinding = await unit.bindings.findByChatId(binding.chatId);
        const existingState = (await unit.states.findByChatId(binding.chatId)) ?? createIdleState(binding.chatId, event.occurredAt);
        if (!existingBinding || existingBinding.activeSessionId !== session.sessionId) {
          return { accepted: false, statusCode: 409, reason: "stale-binding" } as const;
        }

        const inProgressTask = existingState.activeTaskId ? await unit.tasks.findById(existingState.activeTaskId) : undefined;
        const taskId = inProgressTask?.taskId;

        if (event.kind === SESSION_EVENT_KIND.NEEDS_INPUT) {
          const promptNotice = deps.config.humanPromptsEnabled
            ? await (async () => {
                const promptData = parseSessionNeedsInputData(event.data);
                if (!promptData) {
                  return undefined;
                }

                return handleNeedsInputPrompt(unit, {
                  chatId: binding.chatId,
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  occurredAt: event.occurredAt,
                  promptData,
                });
              })()
            : {
                prompt: undefined,
                promptCleanup: await invalidatePendingPromptForSession(unit, {
                  sessionId: session.sessionId,
                  chatId: binding.chatId,
                  occurredAt: event.occurredAt,
                  reason: "human-prompts-disabled",
                }),
              };

          await completeTaskIfExists(unit, taskId, ACTIVE_TASK_STATUS.COMPLETED, event.occurredAt);
          await unit.states.upsert({
            ...existingState,
            mode: OPERATIONAL_MODES.NEEDS_ATTENTION,
            activeTaskId: undefined,
            updatedAt: event.occurredAt,
          });
          await unit.sessions.upsert({
            ...session,
            lastObservedAt: event.occurredAt,
            awaitingInputAt: event.occurredAt,
            updatedAt: event.occurredAt,
            watchdogRetryCount: 0,
          });

          return {
            accepted: true,
            statusCode: 202,
              notice: {
                chatId: binding.chatId,
                kind: ASYNC_SESSION_NOTICE_KIND.NEEDS_INPUT,
                projectId: session.projectId,
                sessionId: session.sessionId,
                taskId,
                summary: readSummary(event.data),
                prompt: promptNotice?.prompt,
                promptCleanup: promptNotice?.promptCleanup,
              } satisfies AsyncSessionNotice,
            } as const;
        }

        if (event.kind === SESSION_EVENT_KIND.STARTED) {
          await invalidatePendingPromptForSession(unit, {
            sessionId: session.sessionId,
            chatId: binding.chatId,
            occurredAt: event.occurredAt,
            reason: "session-started",
          });

          await clearNeedsAttentionIfPromptClosed(unit, binding.chatId, session.sessionId, event.occurredAt);

          await unit.sessions.upsert({
            ...session,
            lastObservedAt: event.occurredAt,
            awaitingInputAt: undefined,
            updatedAt: event.occurredAt,
            watchdogRetryCount: 0,
          });

          return { accepted: true, statusCode: 202 } as const;
        }

        const promptCleanup = await invalidatePendingPromptForSession(unit, {
          sessionId: session.sessionId,
          chatId: binding.chatId,
          occurredAt: event.occurredAt,
          reason: "terminal-event",
        });

        await completeTaskIfExists(
          unit,
          taskId,
          event.kind === SESSION_EVENT_KIND.COMPLETED ? ACTIVE_TASK_STATUS.COMPLETED : ACTIVE_TASK_STATUS.FAILED,
          event.occurredAt
        );

        await unit.states.upsert({
          ...existingState,
          mode: resolveStableSessionMode(existingState.mode),
          activeTaskId: undefined,
          updatedAt: event.occurredAt,
        });
        await unit.sessions.upsert({
          ...session,
          watcherToken: source === TERMINAL_EVENT_SOURCE.WEBHOOK ? undefined : session.watcherToken,
          lastObservedAt: event.occurredAt,
          awaitingInputAt: undefined,
          terminalCause: resolveTerminalCause(event, source),
          terminalSource: source,
          notificationSentAt: event.occurredAt,
          updatedAt: event.occurredAt,
          watchdogRetryCount: 0,
        });

        return {
          accepted: true,
          statusCode: 202,
          notice: {
            chatId: binding.chatId,
            kind: ASYNC_SESSION_NOTICE_KIND.TERMINAL,
            projectId: session.projectId,
            sessionId: session.sessionId,
            taskId,
            terminalCause: resolveTerminalCause(event, source),
              terminalSource: source,
              summary: readSummary(event.data),
              promptCleanup,
            } satisfies AsyncSessionNotice,
          } as const;
      });

      if (notice.accepted && "notice" in notice && notice.notice) {
        await deps.notify(notice.notice);
      }

      return notice;
    };

    if (options.enqueue === false) {
      return runMutation();
    }

    return enqueueByChat(chatQueue, binding.chatId, runMutation);
  }
}

interface NeedsInputPromptMutationInput {
  readonly chatId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly occurredAt: string;
  readonly promptData: SessionNeedsInputData;
}

interface NeedsInputPromptMutationOutput {
  readonly prompt: {
    readonly promptId: string;
    readonly promptType: SessionNeedsInputData["promptType"];
    readonly message: string;
    readonly options?: readonly string[];
    readonly expiresAt?: string;
  };
  readonly promptCleanup?: AsyncSessionNotice["promptCleanup"];
}

async function handleNeedsInputPrompt(
  unit: PersistenceUnit,
  input: NeedsInputPromptMutationInput
): Promise<NeedsInputPromptMutationOutput | undefined> {
  const currentActive = await unit.pendingPrompts.findActiveBySessionId(input.sessionId);
  let promptCleanup: AsyncSessionNotice["promptCleanup"] | undefined;

  if (currentActive && currentActive.promptId !== input.promptData.promptId) {
    const invalidated = await unit.pendingPrompts.compareAndSetStatus({
      promptId: currentActive.promptId,
      fromStatus: PENDING_PROMPT_STATUS.ACTIVE,
      toStatus: PENDING_PROMPT_STATUS.INVALIDATED,
      updatedAt: input.occurredAt,
    });

    if (invalidated) {
      promptCleanup = {
        promptId: invalidated.promptId,
        telegramChatId: invalidated.telegramChatId,
        telegramMessageId: invalidated.telegramMessageId,
        reason: "invalidated",
      };
    }
  }

  const persisted = await unit.pendingPrompts.findByPromptId(input.promptData.promptId);
  const prompt: PendingPrompt = {
    promptId: input.promptData.promptId,
    sessionId: input.sessionId,
    chatId: input.chatId,
    projectId: input.projectId,
    promptType: input.promptData.promptType,
    message: input.promptData.message,
    options: input.promptData.options,
    status: PENDING_PROMPT_STATUS.ACTIVE,
    expiresAt: input.promptData.expiresAt,
    telegramChatId: persisted?.telegramChatId,
    telegramMessageId: persisted?.telegramMessageId,
    telegramCallbackQueryId: persisted?.telegramCallbackQueryId,
    submittedInput: undefined,
    createdAt: persisted?.createdAt ?? input.occurredAt,
    updatedAt: input.occurredAt,
  };

  await unit.pendingPrompts.upsert(prompt);
  return {
    prompt: {
      promptId: prompt.promptId,
      promptType: prompt.promptType,
      message: prompt.message,
      options: prompt.options,
      expiresAt: prompt.expiresAt,
    },
    promptCleanup,
  };
}

async function invalidatePendingPromptForSession(
  unit: PersistenceUnit,
  input: {
    readonly sessionId: string;
    readonly chatId: string;
    readonly occurredAt: string;
    readonly reason: string;
  }
): Promise<AsyncSessionNotice["promptCleanup"] | undefined> {
  const active = await unit.pendingPrompts.findActiveBySessionId(input.sessionId);
  const invalidatedActive = active
    ? await unit.pendingPrompts.compareAndSetStatus({
        promptId: active.promptId,
        fromStatus: PENDING_PROMPT_STATUS.ACTIVE,
        toStatus: PENDING_PROMPT_STATUS.INVALIDATED,
        updatedAt: input.occurredAt,
      })
    : undefined;

  const submitted = await findLatestPromptByStatuses(unit.pendingPrompts, input.sessionId, [
    PENDING_PROMPT_STATUS.SUBMITTED,
  ]);
  const invalidatedSubmitted = submitted
    ? await unit.pendingPrompts.compareAndSetStatus({
        promptId: submitted.promptId,
        fromStatus: PENDING_PROMPT_STATUS.SUBMITTED,
        toStatus: PENDING_PROMPT_STATUS.INVALIDATED,
        updatedAt: input.occurredAt,
      })
    : undefined;

  const invalidated = invalidatedActive ?? invalidatedSubmitted;
  if (!invalidated) {
    return undefined;
  }

  logger.prompt("Pending prompt invalidated by watcher signal", {
    session_id: input.sessionId,
    chat_id: input.chatId,
    prompt_id: invalidated.promptId,
    event: "watcher-invalidate-prompt",
    status: PENDING_PROMPT_STATUS.INVALIDATED,
    reason: input.reason,
  });

  return {
    promptId: invalidated.promptId,
    telegramChatId: invalidated.telegramChatId,
    telegramMessageId: invalidated.telegramMessageId,
    reason: "invalidated",
  };
}

async function clearNeedsAttentionIfPromptClosed(
  unit: PersistenceUnit,
  chatId: string,
  sessionId: string,
  nowIso: string
): Promise<void> {
  const activePrompt = await unit.pendingPrompts.findActiveBySessionId(sessionId);
  if (activePrompt) {
    return;
  }

  const state = await unit.states.findByChatId(chatId);
  if (!state || state.mode !== OPERATIONAL_MODES.NEEDS_ATTENTION) {
    return;
  }

  await unit.states.upsert({
    ...state,
    mode: resolveStableSessionMode(state.mode),
    updatedAt: nowIso,
  });

  const session = await unit.sessions.findById(sessionId);
  if (!session) {
    return;
  }

  await unit.sessions.upsert({
    ...session,
    awaitingInputAt: undefined,
    updatedAt: nowIso,
  });
}

function parseSessionNeedsInputData(data: Readonly<Record<string, unknown>> | undefined): SessionNeedsInputData | undefined {
  if (!data) {
    return undefined;
  }

  const promptId = readString(data.promptId) ?? readString(data.prompt_id);
  const promptType = normalizePromptType(readString(data.promptType) ?? readString(data.prompt_type));
  const message = readString(data.message) ?? readString(data.summary);
  const options = readStringArray(data.options);
  const expiresAt = readString(data.expiresAt) ?? readString(data.expires_at);

  if (!promptId || !promptType || !message) {
    return undefined;
  }

  return {
    promptId,
    promptType,
    message,
    options,
    expiresAt,
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

function normalizePromptType(value: string | undefined): SessionNeedsInputData["promptType"] | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (normalized === PROMPT_TYPE.BOOLEAN) {
    return PROMPT_TYPE.BOOLEAN;
  }

  if (normalized === PROMPT_TYPE.OPTIONS) {
    return PROMPT_TYPE.OPTIONS;
  }

  if (normalized === PROMPT_TYPE.TEXT) {
    return PROMPT_TYPE.TEXT;
  }

  return undefined;
}

async function findLatestPromptByStatuses(
  repository: PendingPromptRepository,
  sessionId: string,
  statuses: readonly PendingPromptStatus[]
): Promise<PendingPrompt | undefined> {
  const prompts = await repository.listAll();
  const candidates = prompts
    .filter((entry) => entry.sessionId === sessionId && statuses.includes(entry.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return candidates[0];
}

function isPromptExpired(prompt: PendingPrompt, nowIso: string, fallbackTtlMs: number): boolean {
  const nowMs = Date.parse(nowIso);
  const expiresAtMs = prompt.expiresAt ? Date.parse(prompt.expiresAt) : NaN;
  if (!Number.isNaN(expiresAtMs)) {
    return nowMs >= expiresAtMs;
  }

  const createdAtMs = Date.parse(prompt.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return false;
  }

  return nowMs - createdAtMs >= fallbackTtlMs;
}

async function listWatchdogCandidates(
  persistence: PersistenceDriver,
  nowIso: string,
  staleAfterMs: number
): Promise<readonly WatchdogCandidate[]> {
  return persistence.runInTransaction(async (unit) => {
    const [bindings, states, sessions] = await Promise.all([unit.bindings.listAll(), unit.states.listAll(), unit.sessions.listAll()]);
    const stateByChatId = new Map(states.map((state) => [state.chatId, state]));
    const nowMs = Date.parse(nowIso);
    const candidates: WatchdogCandidate[] = [];

    for (const binding of bindings) {
      if (!binding.activeProjectId || !binding.activeSessionId) {
        continue;
      }

      const session = sessions.find((item) => item.sessionId === binding.activeSessionId);
      if (!session || !session.watcherEnabled || session.terminalCause) {
        continue;
      }

      const lastObservedMs = session.lastObservedAt ? Date.parse(session.lastObservedAt) : 0;
      if (lastObservedMs && nowMs - lastObservedMs < staleAfterMs) {
        continue;
      }

      candidates.push({
        chatId: binding.chatId,
        projectId: binding.activeProjectId,
        sessionId: binding.activeSessionId,
        activeTaskId: stateByChatId.get(binding.chatId)?.activeTaskId,
        lastObservedAt: session.lastObservedAt,
        watcherToken: session.watcherToken,
        terminalCause: session.terminalCause,
        watchdogRetryCount: session.watchdogRetryCount ?? 0,
      });
    }

    return candidates;
  });
}

async function enqueueByChat<T>(
  queue: Map<string, Promise<void>>,
  chatId: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = queue.get(chatId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  queue.set(chatId, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queue.get(chatId) === tail) {
      queue.delete(chatId);
    }
  }
}

function resolveTerminalCause(event: SessionEvent, source: TerminalEventSource): string {
  const explicit = typeof event.data?.cause === "string" ? event.data.cause : undefined;
  if (explicit) {
    return explicit;
  }

  if (event.kind === SESSION_EVENT_KIND.COMPLETED) {
    return source === TERMINAL_EVENT_SOURCE.WATCHDOG ? "watchdog-recovered-completed" : "completed";
  }

  return source === TERMINAL_EVENT_SOURCE.WATCHDOG ? "watchdog-recovered-failed" : "failed";
}

function readSummary(data: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!data) {
    return undefined;
  }

  const summary = data.summary;
  return typeof summary === "string" && summary.trim() ? summary : undefined;
}

function isTerminalEvent(kind: SessionEvent["kind"]): boolean {
  return kind === SESSION_EVENT_KIND.COMPLETED || kind === SESSION_EVENT_KIND.FAILED;
}

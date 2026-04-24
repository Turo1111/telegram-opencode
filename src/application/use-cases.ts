import {
  BootRecoveryNotice,
  OpenCodeSessionAdapter,
  TelegramPromptCallback,
  PersistenceDriver,
  PersistenceUnit,
  RemoteSessionStatus,
  Result,
  SessionWatcherRegistration,
  SessionState,
} from "./contracts";
import { mapRemoteStatusToOperationalMode } from "./remote-mappers";
import { BootRecoveryService, completeTaskIfExists, resolveStableSessionMode } from "./boot-recovery-service";
import {
  ACTIVE_TASK_STATUS,
  ActiveTask,
  ChatBinding,
  OPERATIONAL_MODES,
  PENDING_PROMPT_STATUS,
  OperationalState,
  PendingPrompt,
  Project,
  Session,
  applyProjectSelection,
  assertNoActiveTaskConflict,
  createIdleState,
} from "../domain/entities";
import { DomainError, ERROR_CODES, asDomainError } from "../domain/errors";
import { logger } from "../logger";

export interface SelectProjectInput {
  chatId: string;
  selector: string;
  rootPath?: string;
}

export interface AttachSessionInput {
  chatId: string;
  sessionId: string;
}

export interface CreateSessionInput {
  chatId: string;
}

export interface SendTextInput {
  chatId: string;
  text: string;
}

export interface RunSessionCommandInput {
  chatId: string;
  command: string;
}

export interface SelectProjectOutput {
  projectId: string;
  alias: string;
}

export interface SessionOutput {
  projectId: string;
  sessionId: string;
}

export interface SendTextOutput {
  projectId: string;
  sessionId: string;
  taskId?: string;
  reply?: string;
  message: string;
  needsAttention: boolean;
  status?: RemoteSessionStatus;
  state: SessionState;
}

export interface RunSessionCommandOutput {
  projectId: string;
  sessionId: string;
  taskId?: string;
  ack?: string;
  message: string;
  needsAttention: boolean;
  status?: RemoteSessionStatus;
  state: SessionState;
  warning?: string;
}

export interface StatusOutput {
  mode: OperationalState["mode"];
  projectId?: string;
  projectAlias?: string;
  sessionId?: string;
  activeTaskId?: string;
  recoveryStatus?: string;
  recoveryReason?: string;
  lastReconciledAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

export interface CancelSessionInput {
  chatId: string;
}

export interface SubmitPendingPromptInput {
  readonly chatId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly choice?: string;
  readonly text?: string;
  readonly callbackQueryId?: string;
}

export const SUBMIT_PENDING_PROMPT_RESULT_STATUS = {
  RESOLVED: "resolved",
  IDEMPOTENT: "idempotent",
} as const;

export type SubmitPendingPromptResultStatus =
  (typeof SUBMIT_PENDING_PROMPT_RESULT_STATUS)[keyof typeof SUBMIT_PENDING_PROMPT_RESULT_STATUS];

export interface SubmitPendingPromptOutput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly status: SubmitPendingPromptResultStatus;
  readonly promptStatus: PendingPrompt["status"];
  readonly reason?: string;
}

export const CANCEL_SESSION_RESULT_STATUS = {
  CANCELLED: "cancelled",
  ACCEPTED: "accepted",
  NO_ACTIVE_TASK: "no-active-task",
} as const;

export type CancelSessionResultStatus =
  (typeof CANCEL_SESSION_RESULT_STATUS)[keyof typeof CANCEL_SESSION_RESULT_STATUS];

export interface CancelSessionOutput {
  projectId: string;
  sessionId: string;
  status: CancelSessionResultStatus;
  message: string;
}

export interface ApplicationUseCases {
  selectProject(input: SelectProjectInput): Promise<Result<SelectProjectOutput>>;
  attachSession(input: AttachSessionInput): Promise<Result<SessionOutput>>;
  createSession(input: CreateSessionInput): Promise<Result<SessionOutput>>;
  sendText(input: SendTextInput): Promise<Result<SendTextOutput>>;
  runSessionCommand(input: RunSessionCommandInput): Promise<Result<RunSessionCommandOutput>>;
  submitPendingPrompt(input: SubmitPendingPromptInput): Promise<Result<SubmitPendingPromptOutput>>;
  cancelSession(input: CancelSessionInput): Promise<Result<CancelSessionOutput>>;
  getStatus(chatId: string): Promise<Result<StatusOutput>>;
}

interface CreateApplicationUseCasesDeps {
  persistence: PersistenceDriver;
  adapter: OpenCodeSessionAdapter;
  createWatcherRegistration?: () => SessionWatcherRegistration | undefined;
  onAssistantMessageProduced?: (input: {
    readonly sessionId: string;
    readonly message: string;
    readonly source: "send-text" | "run-command";
  }) => void;
}

export interface BootRecoverResult {
  recoveredChats: number;
  chatsInError: number;
  cleanedBindings: number;
  notices: readonly BootRecoveryNotice[];
  evaluatedBindings: number;
}

export interface BootRecoverOptions {
  readonly adapter?: OpenCodeSessionAdapter;
  readonly remoteReconcileEnabled?: boolean;
  readonly nowIso?: string;
}

interface ChatRuntimeContext {
  binding: ChatBinding;
  state: OperationalState;
  project?: Project;
  session?: Session;
  activeTask?: ActiveTask;
}

export function createApplicationUseCases(deps: CreateApplicationUseCasesDeps): ApplicationUseCases {
  return {
    async selectProject(input) {
      const selector = input.selector.trim();
      if (!selector) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Indicá un proyecto. Ej: /project mi-proyecto");
      }

      const nowIso = new Date().toISOString();
      const currentContext = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      try {
        assertNoActiveTaskConflict(currentContext.state, currentContext.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      const candidate = await deps.persistence.runInTransaction(async (unit) => {
        const byAlias = await unit.projects.findByAlias(selector);
        const byId = byAlias ? undefined : await unit.projects.findById(selector);
        const existing = byAlias ?? byId;

        if (existing) {
          return {
            project: existing,
            shouldResolve: false,
            binding: await ensureBinding(unit, input.chatId, nowIso),
          };
        }

        const rootPath = input.rootPath?.trim() || selector;
        const project: Project = {
          projectId: selector,
          alias: selector,
          rootPath,
          createdAt: nowIso,
          lastUsedAt: nowIso,
        };

        return {
          project,
          shouldResolve: true,
          binding: await ensureBinding(unit, input.chatId, nowIso),
        };
      });

      if (candidate.shouldResolve) {
        const resolved = await deps.adapter.resolveProject({
          projectId: candidate.project.projectId,
          rootPath: candidate.project.rootPath,
        });

        if (!resolved.ok) {
          return resolved;
        }

        candidate.project = {
          ...candidate.project,
          rootPath: resolved.value.canonicalPath,
        };
      }

      const output = await deps.persistence.runInTransaction(async (unit) => {
        const nextBinding = applyProjectSelection(candidate.binding, candidate.project.projectId, nowIso);
        const nextState: OperationalState = {
          chatId: input.chatId,
          mode: OPERATIONAL_MODES.IDLE,
          activeTaskId: undefined,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          updatedAt: nowIso,
        };

        await unit.projects.upsert({
          ...candidate.project,
          lastUsedAt: nowIso,
        });
        await unit.projects.markLastUsed(candidate.project.projectId, nowIso);
        await unit.bindings.upsert(nextBinding);
        await unit.states.upsert(nextState);

        return {
          projectId: candidate.project.projectId,
          alias: candidate.project.alias,
        } satisfies SelectProjectOutput;
      });

      return okResult(output);
    },

    async attachSession(input) {
      const sessionId = input.sessionId.trim();
      if (!sessionId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Indicá una sesión. Ej: /session sess-123");
      }

      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      const attached = await deps.adapter.attachSession({
        projectId: context.binding.activeProjectId,
        sessionId,
      });

      if (!attached.ok) {
        return attached;
      }

      const persisted = await deps.persistence.runInTransaction(async (unit) => {
        const existingBinding = await ensureBinding(unit, input.chatId, nowIso);
        const existingProject = await unit.projects.findById(context.binding.activeProjectId!);

        if (!existingProject) {
          throw new DomainError(ERROR_CODES.NOT_FOUND, "Proyecto activo no encontrado al vincular sesión");
        }

        const session: Session = {
          sessionId: attached.value.sessionId,
          projectId: attached.value.projectId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };

        const nextBinding: ChatBinding = {
          ...existingBinding,
          activeProjectId: attached.value.projectId,
          activeSessionId: attached.value.sessionId,
          updatedAt: nowIso,
        };

        const nextState = mapRemoteStatusToOperationalState({
          chatId: input.chatId,
          modeHint: attached.value.status,
          taskId: attached.value.taskId,
          nowIso,
        });

        await unit.sessions.upsert(session);
        await unit.bindings.upsert(nextBinding);
        await unit.states.upsert(nextState);
        await unit.projects.markLastUsed(attached.value.projectId, nowIso);

        return {
          projectId: attached.value.projectId,
          sessionId: attached.value.sessionId,
        } satisfies SessionOutput;
      });

      return okResult(persisted);
    },

    async createSession(input) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      if (!context.project) {
        return errResult(ERROR_CODES.NOT_FOUND, "No encuentro el proyecto activo. Volvé a seleccionarlo con /project");
      }

      const watcherRegistration = deps.createWatcherRegistration?.();
      const created = await deps.adapter.createSession({
        projectId: context.project.projectId,
        rootPath: context.project.rootPath,
        source: "telegram",
        watch: watcherRegistration,
      });

      if (!created.ok) {
        return created;
      }

      const persisted = await deps.persistence.runInTransaction(async (unit) => {
        const existingBinding = await ensureBinding(unit, input.chatId, nowIso);
        const session: Session = {
          sessionId: created.value.sessionId,
          projectId: created.value.projectId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const watchedSession = hydrateWatchedSession(session, created.value, watcherRegistration);

        const nextBinding: ChatBinding = {
          ...existingBinding,
          activeProjectId: created.value.projectId,
          activeSessionId: created.value.sessionId,
          updatedAt: nowIso,
        };

        const nextState = mapRemoteStatusToOperationalState({
          chatId: input.chatId,
          modeHint: created.value.status,
          taskId: created.value.taskId,
          nowIso,
        });

        await unit.sessions.upsert(watchedSession);
        await unit.bindings.upsert(nextBinding);
        await unit.states.upsert(nextState);
        await unit.projects.markLastUsed(created.value.projectId, nowIso);

        return {
          projectId: created.value.projectId,
          sessionId: created.value.sessionId,
        } satisfies SessionOutput;
      });

      return okResult(persisted);
    },

    async sendText(input) {
      const text = input.text.trim();
      if (!text) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Mandame un mensaje con contenido");
      }

      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId || !context.binding.activeSessionId) {
        return errResult(
          ERROR_CODES.VALIDATION_ERROR,
          "Primero elegí proyecto y sesión (/project, /session o /new)"
        );
      }

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      const response = await deps.adapter.sendMessage({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        message: text,
        chatId: input.chatId,
        watch: buildWatcherRegistration(context.session, deps.createWatcherRegistration),
      });

      if (!response.ok) {
        return response;
      }

      const taskId = response.value.taskId?.trim() || undefined;
      const needsAttention = response.value.needsAttention ?? false;
      const status = response.value.state.status ?? response.value.status;

      await deps.persistence.runInTransaction(async (unit) => {
        const existingState = (await unit.states.findByChatId(input.chatId)) ?? createIdleState(input.chatId, nowIso);
        const existingSession = await unit.sessions.findById(context.binding.activeSessionId!);
        const nextMode = resolveOperationalModeFromSendOutcome({
          status,
          taskId,
          needsAttention,
          stableMode: existingState.mode,
        });

        const nextState: OperationalState = {
          ...existingState,
          mode: nextMode,
          activeTaskId: taskId,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          updatedAt: nowIso,
        };

        if (taskId) {
          const task: ActiveTask = {
            taskId,
            chatId: input.chatId,
            sessionId: context.binding.activeSessionId!,
            status: ACTIVE_TASK_STATUS.IN_PROGRESS,
            command: text,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          await unit.tasks.upsert(task);
        }

        if (existingSession) {
          await unit.sessions.upsert({
            ...existingSession,
            updatedAt: nowIso,
            watcherEnabled: existingSession.watcherEnabled ?? false,
            terminalCause: undefined,
            terminalSource: undefined,
            notificationSentAt: undefined,
          });
        }

        await unit.states.upsert(nextState);
      });

      if (response.value.message.trim()) {
        deps.onAssistantMessageProduced?.({
          sessionId: context.binding.activeSessionId,
          message: response.value.message,
          source: "send-text",
        });
      }

      return okResult({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        taskId,
        reply: response.value.reply,
        message: response.value.message,
        needsAttention,
        status,
        state: response.value.state,
      });
    },

    async runSessionCommand(input) {
      const command = input.command.trim();
      if (!command) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Indicá un comando. Ej: /run npm test");
      }

      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId || !context.binding.activeSessionId) {
        return errResult(
          ERROR_CODES.VALIDATION_ERROR,
          "Primero elegí proyecto y sesión (/project, /session o /new)"
        );
      }

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      const response = await deps.adapter.runCommand({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        command,
        chatId: input.chatId,
        watch: buildWatcherRegistration(context.session, deps.createWatcherRegistration),
      });

      if (!response.ok) {
        return response;
      }

      const taskId = response.value.taskId?.trim() || undefined;
      const needsAttention = response.value.needsAttention ?? false;
      const status = response.value.state.status ?? response.value.status;
      const modeResolution = resolveOperationalModeFromRunCommand({
        status,
        taskId,
        needsAttention,
        stableMode: context.state.mode,
      });

      await deps.persistence.runInTransaction(async (unit) => {
        const existingState = (await unit.states.findByChatId(input.chatId)) ?? createIdleState(input.chatId, nowIso);
        const existingSession = await unit.sessions.findById(context.binding.activeSessionId!);
        const nextState: OperationalState = {
          ...existingState,
          mode: modeResolution.mode,
          activeTaskId: taskId,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          updatedAt: nowIso,
        };

        if (taskId) {
          const task: ActiveTask = {
            taskId,
            chatId: input.chatId,
            sessionId: context.binding.activeSessionId!,
            status: ACTIVE_TASK_STATUS.IN_PROGRESS,
            command,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          await unit.tasks.upsert(task);
        }

        if (existingSession) {
          await unit.sessions.upsert({
            ...existingSession,
            updatedAt: nowIso,
            watcherEnabled: existingSession.watcherEnabled ?? false,
            terminalCause: undefined,
            terminalSource: undefined,
            notificationSentAt: undefined,
          });
        }

        await unit.states.upsert(nextState);
      });

      if (response.value.message.trim()) {
        deps.onAssistantMessageProduced?.({
          sessionId: context.binding.activeSessionId,
          message: response.value.message,
          source: "run-command",
        });
      }

      return okResult({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        taskId,
        ack: response.value.ack,
        message: response.value.message,
        needsAttention,
        status,
        state: response.value.state,
        warning: modeResolution.warning,
      });
    },

    async submitPendingPrompt(input) {
      const normalized = normalizePromptCallbackInput(input);
      if (!normalized.ok) {
        return normalized;
      }

      const nowIso = new Date().toISOString();
      const preflight = await deps.persistence.runInTransaction(async (unit) => {
        const prompt = await unit.pendingPrompts.findByPromptId(normalized.value.promptId);
        if (!prompt) {
          return {
            kind: "error",
            result: errResult<SubmitPendingPromptOutput>(ERROR_CODES.NOT_FOUND, "El prompt ya no existe o expiró."),
          } as const;
        }

        if (prompt.chatId !== normalized.value.chatId || prompt.sessionId !== normalized.value.sessionId) {
          return {
            kind: "error",
            result: errResult<SubmitPendingPromptOutput>(
              ERROR_CODES.VALIDATION_ERROR,
              "El prompt no coincide con la sesión o chat actual."
            ),
          } as const;
        }

        if (isClosedPromptStatus(prompt.status)) {
          logger.prompt("Pending prompt submit ignored (closed status)", {
            session_id: prompt.sessionId,
            chat_id: prompt.chatId,
            prompt_id: prompt.promptId,
            event: "submit-prompt",
            status: prompt.status,
            reason: "closed-status",
          });
          return {
            kind: "idempotent",
            output: toIdempotentPromptOutput(prompt, "closed-status"),
          } as const;
        }

        if (prompt.status === PENDING_PROMPT_STATUS.SUBMITTED) {
          logger.prompt("Pending prompt submit ignored (already submitted)", {
            session_id: prompt.sessionId,
            chat_id: prompt.chatId,
            prompt_id: prompt.promptId,
            event: "submit-prompt",
            status: prompt.status,
            reason: "already-submitted",
          });
          return {
            kind: "idempotent",
            output: toIdempotentPromptOutput(prompt, "already-submitted"),
          } as const;
        }

        const submitted = await unit.pendingPrompts.compareAndSetStatus({
          promptId: prompt.promptId,
          fromStatus: PENDING_PROMPT_STATUS.ACTIVE,
          toStatus: PENDING_PROMPT_STATUS.SUBMITTED,
          updatedAt: nowIso,
          submittedInput: normalized.value.answer,
          telegramCallbackQueryId: normalized.value.callbackQueryId,
        });

        if (!submitted) {
          const latest = await unit.pendingPrompts.findByPromptId(prompt.promptId);
          if (!latest) {
            return {
              kind: "error",
              result: errResult<SubmitPendingPromptOutput>(ERROR_CODES.NOT_FOUND, "El prompt ya no existe o expiró."),
            } as const;
          }

          return {
            kind: "idempotent",
            output: toIdempotentPromptOutput(latest, "status-changed-during-cas"),
          } as const;
        }

        logger.prompt("Pending prompt moved to submitted", {
          session_id: submitted.sessionId,
          chat_id: submitted.chatId,
          prompt_id: submitted.promptId,
          event: "submit-prompt",
          status: submitted.status,
          reason: "cas-active-to-submitted",
        });

        return {
          kind: "submitted",
          prompt: submitted,
        } as const;
      });

      if (preflight.kind === "error") {
        return preflight.result;
      }

      if (preflight.kind === "idempotent") {
        return okResult(preflight.output);
      }

      const submittedPrompt = preflight.prompt;
      const bridge = await deps.adapter.submitPromptInput({
        projectId: submittedPrompt.projectId,
        sessionId: submittedPrompt.sessionId,
        promptId: submittedPrompt.promptId,
        input: normalized.value.answer,
        source: "telegram",
      });

      if (!bridge.ok) {
        await deps.persistence.runInTransaction(async (unit) => {
          await unit.pendingPrompts.compareAndSetStatus({
            promptId: submittedPrompt.promptId,
            fromStatus: PENDING_PROMPT_STATUS.SUBMITTED,
            toStatus: PENDING_PROMPT_STATUS.ACTIVE,
            updatedAt: new Date().toISOString(),
            clearSubmissionMeta: true,
          });
        });

        logger.prompt("Pending prompt bridge failed; compensation applied", {
          session_id: submittedPrompt.sessionId,
          chat_id: submittedPrompt.chatId,
          prompt_id: submittedPrompt.promptId,
          event: "submit-prompt",
          status: PENDING_PROMPT_STATUS.ACTIVE,
          reason: "bridge-failed-reverted-to-active",
        });
        return {
          ok: false,
          error: bridge.error,
        };
      }

      const resolution = await deps.persistence.runInTransaction(async (unit) => {
        const resolved = await unit.pendingPrompts.compareAndSetStatus({
          promptId: submittedPrompt.promptId,
          fromStatus: PENDING_PROMPT_STATUS.SUBMITTED,
          toStatus: PENDING_PROMPT_STATUS.RESOLVED,
          updatedAt: new Date().toISOString(),
        });

        if (resolved) {
          logger.prompt("Pending prompt resolved after bridge success", {
            session_id: resolved.sessionId,
            chat_id: resolved.chatId,
            prompt_id: resolved.promptId,
            event: "submit-prompt",
            status: resolved.status,
            reason: "bridge-accepted",
          });
          return {
            kind: "resolved",
            output: {
              projectId: resolved.projectId,
              sessionId: resolved.sessionId,
              promptId: resolved.promptId,
              status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.RESOLVED,
              promptStatus: resolved.status,
            } satisfies SubmitPendingPromptOutput,
          } as const;
        }

        const latest = await unit.pendingPrompts.findByPromptId(submittedPrompt.promptId);
        if (!latest) {
          return {
            kind: "resolved",
            output: {
              projectId: submittedPrompt.projectId,
              sessionId: submittedPrompt.sessionId,
              promptId: submittedPrompt.promptId,
              status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.RESOLVED,
              promptStatus: PENDING_PROMPT_STATUS.RESOLVED,
              reason: "missing-after-bridge",
            } satisfies SubmitPendingPromptOutput,
          } as const;
        }

        return {
          kind: "idempotent",
          output: toIdempotentPromptOutput(latest, "status-changed-after-bridge"),
        } as const;
      });

      return okResult(resolution.output);
    },

    async cancelSession(input) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId || !context.binding.activeSessionId) {
        return errResult(
          ERROR_CODES.VALIDATION_ERROR,
          "Primero elegí proyecto y sesión (/project, /session o /new)"
        );
      }

      const hasActiveTask =
        context.state.mode === OPERATIONAL_MODES.TASK_RUNNING ||
        context.activeTask?.status === ACTIVE_TASK_STATUS.IN_PROGRESS;

      if (!hasActiveTask) {
        return okResult({
          projectId: context.binding.activeProjectId,
          sessionId: context.binding.activeSessionId,
          status: CANCEL_SESSION_RESULT_STATUS.NO_ACTIVE_TASK,
          message: "No hay tarea activa para cancelar.",
        });
      }

      const response = await deps.adapter.cancelOrInterrupt({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        chatId: input.chatId,
      });

      if (!response.ok) {
        return response;
      }

      const status = response.value.status;
      const mode = status === "cancelled" || status === "accepted" ? OPERATIONAL_MODES.SESSION_LINKED : context.state.mode;

      await deps.persistence.runInTransaction(async (unit) => {
        const existingState = (await unit.states.findByChatId(input.chatId)) ?? createIdleState(input.chatId, nowIso);
        await unit.states.upsert({
          ...existingState,
          mode,
          activeTaskId: undefined,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          updatedAt: nowIso,
        });

        const previousTaskId = existingState.activeTaskId ?? context.activeTask?.taskId;
        if (!previousTaskId) {
          return;
        }

        await completeTaskIfExists(unit, previousTaskId, ACTIVE_TASK_STATUS.COMPLETED, nowIso);
      });

      return okResult({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        status:
          status === "accepted"
            ? CANCEL_SESSION_RESULT_STATUS.ACCEPTED
            : CANCEL_SESSION_RESULT_STATUS.CANCELLED,
        message: response.value.message?.trim() || "Se envió la solicitud de cancelación a OpenCode.",
      });
    },

    async getStatus(chatId) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));

      if (context.binding.activeProjectId && context.binding.activeSessionId) {
        const remoteStatus = await deps.adapter.getSessionState({
          projectId: context.binding.activeProjectId,
          sessionId: context.binding.activeSessionId,
        });

        if (remoteStatus.ok) {
          await deps.persistence.runInTransaction(async (unit) => {
            const currentState = (await unit.states.findByChatId(chatId)) ?? createIdleState(chatId, nowIso);
            const nextState = mapRemoteStatusToOperationalState({
              chatId,
              modeHint: remoteStatus.value.status,
              taskId: remoteStatus.value.taskId,
              nowIso,
            });

            await unit.states.upsert({
              ...currentState,
              ...nextState,
              updatedAt: nowIso,
              lastErrorCode: undefined,
              lastErrorMessage: undefined,
            });

            const previousTaskId = currentState.activeTaskId;
            if (previousTaskId && nextState.mode !== OPERATIONAL_MODES.TASK_RUNNING) {
              await completeTaskIfExists(unit, previousTaskId, ACTIVE_TASK_STATUS.COMPLETED, nowIso);
            }

            if (remoteStatus.value.taskId) {
              const remoteTask = await unit.tasks.findById(remoteStatus.value.taskId);
              await unit.tasks.upsert({
                taskId: remoteStatus.value.taskId,
                chatId,
                sessionId: context.binding.activeSessionId!,
                command: remoteTask?.command ?? "(task en ejecución)",
                createdAt: remoteTask?.createdAt ?? nowIso,
                updatedAt: nowIso,
                status:
                  remoteStatus.value.status === "running"
                    ? ACTIVE_TASK_STATUS.IN_PROGRESS
                    : ACTIVE_TASK_STATUS.COMPLETED,
              });
            }
          });
        }
      }

      const fresh = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));
      return okResult(toStatusOutput(fresh));
    },
  };
}

export async function bootRecover(
  persistence: PersistenceDriver,
  optionsOrNowIso?: BootRecoverOptions | string
): Promise<BootRecoverResult> {
  const options: BootRecoverOptions =
    typeof optionsOrNowIso === "string" ? { nowIso: optionsOrNowIso } : optionsOrNowIso ?? {};

  const service = new BootRecoveryService({
    persistence,
    adapter: options.adapter,
    remoteReconcileEnabled: options.remoteReconcileEnabled ?? false,
  });

  return service.reconcileAll(options.nowIso ?? new Date().toISOString());
}

async function ensureBinding(unit: PersistenceUnit, chatId: string, nowIso: string): Promise<ChatBinding> {
  return (await unit.bindings.findByChatId(chatId)) ?? {
    chatId,
    updatedAt: nowIso,
  };
}

async function loadChatRuntimeContext(unit: PersistenceUnit, chatId: string, nowIso: string): Promise<ChatRuntimeContext> {
  const binding = await ensureBinding(unit, chatId, nowIso);
  const state = (await unit.states.findByChatId(chatId)) ?? createIdleState(chatId, nowIso);

  const project = binding.activeProjectId ? await unit.projects.findById(binding.activeProjectId) : undefined;
  const session = binding.activeSessionId ? await unit.sessions.findById(binding.activeSessionId) : undefined;

  const stateTask = state.activeTaskId ? await unit.tasks.findById(state.activeTaskId) : undefined;
  const inProgressBySession = session ? await unit.tasks.findInProgressBySessionId(session.sessionId) : undefined;

  return {
    binding,
    state,
    project,
    session,
    activeTask: stateTask ?? inProgressBySession,
  };
}

function mapRemoteStatusToOperationalState(input: {
  chatId: string;
  modeHint: RemoteSessionStatus;
  taskId?: string;
  nowIso: string;
}): OperationalState {
  const taskId = input.taskId?.trim() || undefined;
  const nextMode = mapRemoteStatusToOperationalMode(input.modeHint);

  if (nextMode === OPERATIONAL_MODES.TASK_RUNNING) {
    return {
      chatId: input.chatId,
      mode: OPERATIONAL_MODES.TASK_RUNNING,
      activeTaskId: taskId,
      updatedAt: input.nowIso,
    };
  }

  if (nextMode === OPERATIONAL_MODES.NEEDS_ATTENTION) {
    return {
      chatId: input.chatId,
      mode: OPERATIONAL_MODES.NEEDS_ATTENTION,
      activeTaskId: undefined,
      updatedAt: input.nowIso,
    };
  }

  return {
    chatId: input.chatId,
    mode: OPERATIONAL_MODES.SESSION_LINKED,
    activeTaskId: undefined,
    updatedAt: input.nowIso,
  };
}

function resolveOperationalModeFromSendOutcome(input: {
  status?: RemoteSessionStatus;
  taskId?: string;
  needsAttention: boolean;
  stableMode: OperationalState["mode"];
}): OperationalState["mode"] {
  const modeFromStatus = input.status ? mapRemoteStatusToOperationalMode(input.status) : undefined;

  if (modeFromStatus) {
    return modeFromStatus;
  }

  if (input.taskId) {
    return OPERATIONAL_MODES.TASK_RUNNING;
  }

  if (input.needsAttention) {
    return OPERATIONAL_MODES.NEEDS_ATTENTION;
  }

  return input.stableMode === OPERATIONAL_MODES.ERROR ? OPERATIONAL_MODES.SESSION_LINKED : input.stableMode;
}

function resolveOperationalModeFromRunCommand(input: {
  status?: RemoteSessionStatus;
  taskId?: string;
  needsAttention: boolean;
  stableMode: OperationalState["mode"];
}): { mode: OperationalState["mode"]; warning?: string } {
  if (input.status === "running") {
    return {
      mode: OPERATIONAL_MODES.TASK_RUNNING,
    };
  }

  if (input.status === "needs-attention") {
    return {
      mode: OPERATIONAL_MODES.NEEDS_ATTENTION,
    };
  }

  if (input.status === "idle" || input.status === "completed") {
    return {
      mode: OPERATIONAL_MODES.SESSION_LINKED,
    };
  }

  if (input.status === "unknown") {
    return {
      mode: resolveStableSessionMode(input.stableMode),
      warning: "OpenCode devolvió estado desconocido. Mantengo el modo estable local hasta la próxima actualización.",
    };
  }

  if (input.taskId) {
    return {
      mode: OPERATIONAL_MODES.TASK_RUNNING,
    };
  }

  if (input.needsAttention) {
    return {
      mode: OPERATIONAL_MODES.NEEDS_ATTENTION,
    };
  }

  return {
    mode: resolveStableSessionMode(input.stableMode),
  };
}

function buildWatcherRegistration(
  session: Session | undefined,
  factory: (() => SessionWatcherRegistration | undefined) | undefined
): SessionWatcherRegistration | undefined {
  if (session?.watcherToken && session.watcherCallbackUrl) {
    return {
      bearerToken: session.watcherToken,
      callbackUrl: session.watcherCallbackUrl,
    };
  }

  return factory?.();
}

function hydrateWatchedSession(
  session: Session,
  remoteState: SessionState,
  registration: SessionWatcherRegistration | undefined
): Session {
  if (!registration) {
    return session;
  }

  return {
    ...session,
    watcherToken: registration.bearerToken,
    watcherCallbackUrl: registration.callbackUrl,
    watcherEnabled: true,
    lastObservedAt: remoteState.updatedAt ?? session.updatedAt,
    awaitingInputAt: remoteState.status === "needs-attention" ? session.updatedAt : undefined,
    terminalCause: undefined,
    terminalSource: undefined,
    notificationSentAt: undefined,
    continuityLostAt: undefined,
    watchdogRetryCount: 0,
  };
}

function toStatusOutput(context: ChatRuntimeContext): StatusOutput {
  return {
    mode: context.state.mode,
    projectId: context.binding.activeProjectId,
    projectAlias: context.project?.alias,
    sessionId: context.binding.activeSessionId,
    activeTaskId: context.state.activeTaskId ?? context.activeTask?.taskId,
    recoveryStatus: context.state.recoveryStatus,
    recoveryReason: context.state.recoveryReason,
    lastReconciledAt: context.state.lastReconciledAt,
    lastErrorCode: context.state.lastErrorCode,
    lastErrorMessage: context.state.lastErrorMessage,
  };
}

function normalizePromptCallbackInput(input: SubmitPendingPromptInput): Result<{
  chatId: string;
  sessionId: string;
  promptId: string;
  answer: string;
  callbackQueryId?: string;
}> {
  const callback: TelegramPromptCallback = {
    chatId: input.chatId,
    sessionId: input.sessionId,
    promptId: input.promptId,
    choice: input.choice,
    text: input.text,
    callbackQueryId: input.callbackQueryId,
  };

  const chatId = callback.chatId.trim();
  const sessionId = callback.sessionId.trim();
  const promptId = callback.promptId.trim();
  const answer = (callback.choice ?? callback.text ?? "").trim();

  if (!chatId || !sessionId || !promptId) {
    return errResult(ERROR_CODES.VALIDATION_ERROR, "Faltan datos requeridos para responder el prompt.");
  }

  if (!answer) {
    return errResult(ERROR_CODES.VALIDATION_ERROR, "La respuesta del prompt no puede estar vacía.");
  }

  return okResult({
    chatId,
    sessionId,
    promptId,
    answer,
    callbackQueryId: callback.callbackQueryId?.trim() || undefined,
  });
}

function isClosedPromptStatus(status: PendingPrompt["status"]): boolean {
  return (
    status === PENDING_PROMPT_STATUS.RESOLVED ||
    status === PENDING_PROMPT_STATUS.INVALIDATED ||
    status === PENDING_PROMPT_STATUS.EXPIRED ||
    status === PENDING_PROMPT_STATUS.CANCELLED
  );
}

function toIdempotentPromptOutput(prompt: PendingPrompt, reason: string): SubmitPendingPromptOutput {
  return {
    projectId: prompt.projectId,
    sessionId: prompt.sessionId,
    promptId: prompt.promptId,
    status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT,
    promptStatus: prompt.status,
    reason,
  };
}

function okResult<T>(value: T): Result<T> {
  return { ok: true, value };
}

function errResult<T>(code: DomainError["code"], message: string): Result<T> {
  return {
    ok: false,
    error: new DomainError(code, message),
  };
}

function errResultFromUnknown<T>(error: unknown): Result<T> {
  const domainError = asDomainError(error);
  return {
    ok: false,
    error: domainError,
  };
}

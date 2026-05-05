import {
  BootRecoveryNotice,
  AttachLocalLaunchResult,
  LocalTerminalLauncher,
  SENSITIVE_ACTION_AUDIT_RESULT,
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
  assertLocalHostActionAllowed,
  LOCAL_HOST_ACTION_GUARD_REASON,
  LOCAL_HOST_ACTION_KIND,
  resolveLocalHostFeature,
  TELEGRAM_CHAT_TYPES,
  type LocalHostActionKind,
} from "./local-host-hardening";
import {
  ACTIVE_TASK_STATUS,
  ATTACH_LOCAL_EXECUTION_RESULT,
  ActiveTask,
  AgentSelection,
  ModelSelection,
  ChatBinding,
  DANGEROUS_ACTION_CONFIRMATION_STATUS,
  LOCAL_TERMINAL_LAUNCHER,
  DangerousActionConfirmation,
  DangerousActionConfirmationStatus,
  OPERATIONAL_MODES,
  PENDING_PROMPT_STATUS,
  OperationalState,
  PendingPrompt,
  Project,
  Session,
  FALLBACK_AGENTS,
  SupportedAgent,
  isSupportedAgent,
  applyProjectSelection,
  assertNoActiveTaskConflict,
  createIdleState,
} from "../domain/entities";
import { toTmuxSessionName } from "../infrastructure/opencode-tmux-host";
import { DomainError, ERROR_CODES, asDomainError } from "../domain/errors";
import { logger } from "../logger";
import { syncRuntimeMetadata } from "./runtime-metadata-sync";
import { OpenCodeCliMessage } from "../infrastructure/opencode-cli";

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

export interface BootstrapSessionCandidateInput {
  readonly chatId: string;
  readonly initialPrompt: string;
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

export interface BootstrapSessionCandidateOutput {
  readonly projectId: string;
  readonly sessionId: string;
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
  requestedAgent?: string;
  requestedModel?: string;
  effectiveAgent?: string;
  effectiveModel?: string;
  modelValidationDegraded?: string;
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
  requestedAgent?: string;
  requestedModel?: string;
  effectiveAgent?: string;
  effectiveModel?: string;
  modelValidationDegraded?: string;
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

export interface SessionMetadataSyncOutput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly changed: boolean;
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
}

export interface SetActiveAgentOutput {
  readonly activeAgent: SupportedAgent;
  readonly sessionReconfigured: boolean;
  readonly attachLocalReopened?: boolean;
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
  bootstrapSessionCandidate?(input: BootstrapSessionCandidateInput): Promise<Result<BootstrapSessionCandidateOutput>>;
  sendText(input: SendTextInput): Promise<Result<SendTextOutput>>;
  runSessionCommand(input: RunSessionCommandInput): Promise<Result<RunSessionCommandOutput>>;
  submitPendingPrompt(input: SubmitPendingPromptInput): Promise<Result<SubmitPendingPromptOutput>>;
  cancelSession(input: CancelSessionInput): Promise<Result<CancelSessionOutput>>;
  getStatus(chatId: string): Promise<Result<StatusOutput>>;
  refreshSessionMetadata?(chatId: string): Promise<Result<SessionMetadataSyncOutput>>;
  listSupportedAgents?(chatId: string): Promise<{
    agents: readonly string[];
    degraded?: { reason: string };
  }>;
  getActiveAgent?(chatId: string): Promise<Result<SupportedAgent>>;
  setActiveAgent?(input: { chatId: string; agent: string }): Promise<Result<SetActiveAgentOutput>>;
  listAvailableModels?(chatId: string): Promise<Result<{ activeModel?: string; models: readonly string[]; degraded?: string }>>;
  getActiveModel?(chatId: string): Promise<Result<string>>;
  setActiveModel?(input: { chatId: string; model: string }): Promise<Result<{ activeModel: string; sessionReconfigured: boolean; attachLocalReopened?: boolean }>>;
}

export interface ConfirmDangerousActionInput {
  readonly actorId: string;
  readonly chatId: string;
  readonly chatType: string;
  readonly confirmationId: string;
}

export const CONFIRM_DANGEROUS_ACTION_RESULT_STATUS = {
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  IDEMPOTENT: "idempotent",
} as const;

export type ConfirmDangerousActionResultStatus =
  (typeof CONFIRM_DANGEROUS_ACTION_RESULT_STATUS)[keyof typeof CONFIRM_DANGEROUS_ACTION_RESULT_STATUS];

export interface ConfirmDangerousActionOutput {
  readonly confirmationId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly intent: string;
  readonly status: ConfirmDangerousActionResultStatus;
  readonly confirmationStatus: DangerousActionConfirmationStatus;
  readonly message: string;
  readonly reason?: string;
  readonly attachLocal?: AttachLocalLaunchResult;
}

export interface DangerousActionUseCases {
  confirmDangerousAction(input: ConfirmDangerousActionInput): Promise<Result<ConfirmDangerousActionOutput>>;
}

interface LocalHostEnvironmentCheckResult {
  readonly ok: boolean;
  readonly reason?: string;
}

interface LocalHostHardeningOptions {
  readonly allowedActorIds?: readonly string[];
  readonly localHostActionsEnabled?: boolean;
  readonly attachLocalEnabled?: boolean;
  readonly localHostConfirmationTtlMs?: number;
  readonly isLocalHostEnvironmentReady?: (input: {
    readonly intent: LocalHostActionKind;
    readonly targetEnvironment: string;
    readonly projectId: string;
    readonly sessionId: string;
  }) => Promise<LocalHostEnvironmentCheckResult>;
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
  localHostOptions?: LocalHostHardeningOptions;
  localTerminalLauncher?: LocalTerminalLauncher;
  hasTmuxSessionBySessionId?: (input: {
    readonly opencodeSessionId: string;
    readonly timeoutMs: number;
  }) => Promise<{ readonly exists: boolean; readonly tmuxSessionName: string }>;
  openCodeDefaultAgent?: SupportedAgent;
  readRuntimeMessages?: (sessionId: string) => Promise<readonly OpenCodeCliMessage[]>;
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

export function createApplicationUseCases(
  deps: CreateApplicationUseCasesDeps
): ApplicationUseCases & DangerousActionUseCases {
  const localHostAllowedActors = deps.localHostOptions?.allowedActorIds
    ? new Set(deps.localHostOptions.allowedActorIds)
    : undefined;

const HIDDEN_AGENT_WORDS = [
  "compaction", "explore", "general", "summary", "title",
  "apply", "archive", "design", "init", "onboard",
  "propose", "spec", "tasks", "verify",
];

function shouldShowAgent(agentId: string): boolean {
  return !HIDDEN_AGENT_WORDS.some((word) => agentId.includes(word));
}

  return {
    async listSupportedAgents(chatId: string) {
      const adapter = deps.adapter;

      if (!adapter.listAgents) {
        logger.warn("[agent-catalog] Adapter does not support listAgents — using FALLBACK_AGENTS");
        return { agents: FALLBACK_AGENTS as readonly string[], degraded: { reason: "unsupported" } };
      }

      const catalog = await adapter.listAgents({ chatId, projectId: "", sessionId: undefined });
      if (!catalog.ok) {
        logger.warn("[agent-catalog] Adapter error — using FALLBACK_AGENTS", {
          error: catalog.error.message,
        });
        return { agents: FALLBACK_AGENTS as readonly string[], degraded: { reason: "adapter-error" } };
      }

      if (!catalog.value.ok) {
        logger.warn("[agent-catalog] Catalog degraded — using FALLBACK_AGENTS", {
          reason: catalog.value.degraded?.reason ?? "unknown",
          usingCache: catalog.value.degraded?.usingCache ?? false,
        });
        return {
          agents: FALLBACK_AGENTS as readonly string[],
          degraded: { reason: catalog.value.degraded?.reason ?? "unknown" },
        };
      }

      const raw = catalog.value.agents.map((a) => a.id);
      const agents = raw.filter(shouldShowAgent);

      logger.info("[agent-catalog] Dynamic catalog loaded", {
        raw: raw.length,
        filtered: agents.length,
      });
      return { agents };
    },

    async getActiveAgent(chatId) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));
      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }

      const effectiveAgent = await resolveEffectiveAgent(
        deps.persistence,
        chatId,
        context.binding.activeProjectId,
        deps.openCodeDefaultAgent
      );
      return okResult(effectiveAgent);
    },

    async setActiveAgent(input) {
      const agent = normalizeAgentSelectionInput(input.agent);
      if (!isSupportedAgent(agent)) {
        // Not in fallback — check dynamic catalog
        if (deps.adapter.listAgents) {
          const catalog = await deps.adapter.listAgents({ chatId: input.chatId, projectId: "", sessionId: undefined });
          if (!catalog.ok || !catalog.value.ok) {
            return errResult(ERROR_CODES.VALIDATION_ERROR, "Agente no válido");
          }
          const agentIds = catalog.value.agents.map((a) => a.id);
          if (!agentIds.includes(agent)) {
            return errResult(ERROR_CODES.VALIDATION_ERROR, "Agente no válido");
          }
        } else {
          return errResult(ERROR_CODES.VALIDATION_ERROR, "Agente no válido");
        }
      }

      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));
      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }

      await deps.persistence.runInTransaction(async (unit) => {
        const repository = unit.agentSelections;
        if (!repository) {
          throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "Repositorio de selección de agente no disponible");
        }
        const selection: AgentSelection = {
          chatId: input.chatId,
          projectId: context.binding.activeProjectId!,
          activeAgent: agent,
          updatedAt: nowIso,
        };
        await repository.upsert(selection);
      });

      let sessionReconfigured = false;
      if (context.binding.activeSessionId && deps.adapter.configureSessionAgent) {
        const configured = await deps.adapter.configureSessionAgent({
          projectId: context.binding.activeProjectId,
          sessionId: context.binding.activeSessionId,
          agent,
        });
        if (!configured.ok) {
          return configured;
        }
        sessionReconfigured = true;
      }

      const attachLocalReopened = await reopenAttachLocalIfNeeded({
        localTerminalLauncher: deps.localTerminalLauncher,
        persistence: deps.persistence,
        chatId: input.chatId,
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        sessionReconfigured,
      });

      return okResult({
        activeAgent: agent,
        sessionReconfigured,
        ...(attachLocalReopened ? { attachLocalReopened } : {}),
      });
    },

    async listAvailableModels(chatId) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));
      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }
      if (!deps.adapter.listModels) {
        return okResult({ activeModel: undefined, models: [], degraded: "unsupported" });
      }
      const catalog = await deps.adapter.listModels({
        chatId,
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
      });
      if (!catalog.ok) return catalog;
      const active = await resolveEffectiveModel(deps.persistence, deps.adapter, chatId, context.binding.activeProjectId, context.binding.activeSessionId);
      return okResult({ activeModel: active.effectiveModel, models: catalog.value.models.map((m) => m.id), degraded: catalog.value.degraded?.reason });
    },

    async getActiveModel(chatId) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));
      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }
      const resolved = await resolveEffectiveModel(deps.persistence, deps.adapter, chatId, context.binding.activeProjectId, context.binding.activeSessionId);
      return okResult(resolved.effectiveModel);
    },

    async setActiveModel(input) {
      const model = input.model.trim().replace(/^"|"$/gu, "");
      if (!model) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Modelo no válido");
      }
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));
      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project");
      }
      if (!deps.adapter.listModels) {
        return errResult(ERROR_CODES.UPSTREAM_5XX, "Catálogo de modelos no disponible en este entorno");
      }
      const catalog = await deps.adapter.listModels({ chatId: input.chatId, projectId: context.binding.activeProjectId, sessionId: context.binding.activeSessionId });
      if (!catalog.ok) return catalog;
      const allowed = new Set(catalog.value.models.map((m) => m.id));
      if (!allowed.has(model)) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Modelo no válido");
      }
      await deps.persistence.runInTransaction(async (unit) => {
        const repository = unit.modelSelections;
        if (!repository) {
          throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "Repositorio de selección de modelo no disponible");
        }
        const selection: ModelSelection = { chatId: input.chatId, projectId: context.binding.activeProjectId!, activeModel: model, updatedAt: nowIso };
        await repository.upsert(selection);
      });
      let sessionReconfigured = false;
      if (context.binding.activeSessionId && deps.adapter.configureSessionModel) {
        const configured = await deps.adapter.configureSessionModel({ projectId: context.binding.activeProjectId, sessionId: context.binding.activeSessionId, model });
        if (!configured.ok) return configured;
        sessionReconfigured = true;
      }
      const attachLocalReopened = await reopenAttachLocalIfNeeded({
        localTerminalLauncher: deps.localTerminalLauncher,
        persistence: deps.persistence,
        chatId: input.chatId,
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        sessionReconfigured,
      });

      return okResult({
        activeModel: model,
        sessionReconfigured,
        ...(attachLocalReopened ? { attachLocalReopened } : {}),
      });
    },

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
        if (currentContext.binding.activeProjectId) {
          await invalidateDangerousConfirmationsForProject(unit, input.chatId, currentContext.binding.activeProjectId);
        }

        if (currentContext.binding.activeSessionId) {
          await invalidateDangerousConfirmationsForSession(unit, input.chatId, currentContext.binding.activeSessionId);
        }

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

      const activeModelSelection = await deps.persistence.runInTransaction(async (unit) => {
        if (!unit.modelSelections) {
          return undefined;
        }

        return unit.modelSelections.findByChatAndProject(input.chatId, context.binding.activeProjectId!);
      });
      const desiredModel = activeModelSelection?.activeModel ?? context.session?.requestedModel ?? context.session?.effectiveModel;

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      const attached = await deps.adapter.attachSession({
        projectId: context.binding.activeProjectId,
        sessionId,
        model: desiredModel,
      });

      if (!attached.ok) {
        return attached;
      }

      const persisted = await deps.persistence.runInTransaction(async (unit) => {
        if (context.binding.activeSessionId) {
          await invalidateDangerousConfirmationsForSession(unit, input.chatId, context.binding.activeSessionId);
        }

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
          requestedModel: attached.value.requestedModel,
          effectiveModel: attached.value.effectiveModel,
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

      if (deps.localTerminalLauncher && deps.hasTmuxSessionBySessionId) {
        const project = await deps.persistence.runInTransaction((unit) => unit.projects.findById(persisted.projectId));
        if (project) {
          const tmuxCheck = await deps.hasTmuxSessionBySessionId({
            opencodeSessionId: persisted.sessionId,
            timeoutMs: 3_000,
          });

          if (tmuxCheck.exists) {
            try {
              await deps.localTerminalLauncher.launchAttach({
                projectPath: project.rootPath,
                sessionId: persisted.sessionId,
                tmuxSessionName: tmuxCheck.tmuxSessionName,
              });
            } catch (error) {
              logger.error("Auto attach-local launch failed", {
                projectId: persisted.projectId,
                sessionId: persisted.sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

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
        if (context.binding.activeSessionId) {
          await invalidateDangerousConfirmationsForSession(unit, input.chatId, context.binding.activeSessionId);
        }

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

      if (deps.localTerminalLauncher && deps.hasTmuxSessionBySessionId) {
        const project = await deps.persistence.runInTransaction((unit) => unit.projects.findById(persisted.projectId));
        if (project) {
          const tmuxCheck = await deps.hasTmuxSessionBySessionId({
            opencodeSessionId: persisted.sessionId,
            timeoutMs: 3_000,
          });

          if (tmuxCheck.exists) {
            try {
              await deps.localTerminalLauncher.launchAttach({
                projectPath: project.rootPath,
                sessionId: persisted.sessionId,
                tmuxSessionName: tmuxCheck.tmuxSessionName,
              });
            } catch (error) {
              logger.error("Auto attach-local launch failed", {
                projectId: persisted.projectId,
                sessionId: persisted.sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

      return okResult(persisted);
    },

    async bootstrapSessionCandidate(input) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, input.chatId, nowIso));

      if (!context.binding.activeProjectId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project <alias|ruta> antes de crear una sesión.");
      }

      try {
        assertNoActiveTaskConflict(context.state, context.activeTask);
      } catch (error) {
        return errResultFromUnknown(error);
      }

      if (!context.project) {
        return errResult(ERROR_CODES.NOT_FOUND, "No encuentro el proyecto activo. Volvé a seleccionarlo con /project");
      }

      if (!deps.adapter.bootstrapSession) {
        return errResult(ERROR_CODES.UNSUPPORTED, "/new no está disponible en este backend. Usá /sesiones o /session <id>.");
      }

      const initialPrompt = input.initialPrompt.trim();
      if (!initialPrompt) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Usá /new <mensaje inicial>");
      }

      const bootstrapped = await deps.adapter.bootstrapSession({
        projectId: context.project.projectId,
        rootPath: context.project.rootPath,
        initialPrompt,
        timeoutMs: 30_000,
      });

      if (!bootstrapped.ok) {
        return bootstrapped;
      }

      const persisted = await deps.persistence.runInTransaction(async (unit) => {
        if (context.binding.activeSessionId) {
          await invalidateDangerousConfirmationsForSession(unit, input.chatId, context.binding.activeSessionId);
        }

        const existingBinding = await ensureBinding(unit, input.chatId, nowIso);
        const session: Session = {
          sessionId: bootstrapped.value.sessionId,
          projectId: bootstrapped.value.projectId,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const nextBinding: ChatBinding = {
          ...existingBinding,
          activeProjectId: bootstrapped.value.projectId,
          activeSessionId: bootstrapped.value.sessionId,
          updatedAt: nowIso,
        };
        const nextState = mapRemoteStatusToOperationalState({
          chatId: input.chatId,
          modeHint: bootstrapped.value.status,
          taskId: bootstrapped.value.taskId,
          nowIso,
        });

        await unit.sessions.upsert(session);
        await unit.bindings.upsert(nextBinding);
        await unit.states.upsert(nextState);
        await unit.projects.markLastUsed(bootstrapped.value.projectId, nowIso);

        return {
          projectId: bootstrapped.value.projectId,
          sessionId: bootstrapped.value.sessionId,
        } satisfies BootstrapSessionCandidateOutput;
      });

      if (deps.localTerminalLauncher && deps.hasTmuxSessionBySessionId) {
        const project = await deps.persistence.runInTransaction((unit) => unit.projects.findById(persisted.projectId));
        if (project) {
          const tmuxCheck = await deps.hasTmuxSessionBySessionId({
            opencodeSessionId: persisted.sessionId,
            timeoutMs: 3_000,
          });

          if (tmuxCheck.exists) {
            try {
              await deps.localTerminalLauncher.launchAttach({
                projectPath: project.rootPath,
                sessionId: persisted.sessionId,
                tmuxSessionName: tmuxCheck.tmuxSessionName,
              });
            } catch (error) {
              logger.error("Auto attach-local launch failed", {
                projectId: persisted.projectId,
                sessionId: persisted.sessionId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }

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

      const effectiveModelResolution = await resolveEffectiveModel(
        deps.persistence,
        deps.adapter,
        input.chatId,
        context.binding.activeProjectId,
        context.binding.activeSessionId
      );

      const response = await deps.adapter.sendMessage({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        message: text,
        chatId: input.chatId,
        agent: await resolveEffectiveAgent(
          deps.persistence,
          input.chatId,
          context.binding.activeProjectId,
          deps.openCodeDefaultAgent
        ),
        model: effectiveModelResolution.effectiveModel,
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
            requestedAgent: response.value.requestedAgent,
            requestedModel: response.value.requestedModel,
            effectiveAgent: response.value.effectiveAgent,
            effectiveModel: response.value.effectiveModel,
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
        requestedAgent: response.value.requestedAgent,
        requestedModel: response.value.requestedModel,
        effectiveAgent: response.value.effectiveAgent,
        effectiveModel: response.value.effectiveModel,
        modelValidationDegraded: effectiveModelResolution.degraded,
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

      const effectiveModelResolution = await resolveEffectiveModel(
        deps.persistence,
        deps.adapter,
        input.chatId,
        context.binding.activeProjectId,
        context.binding.activeSessionId
      );

      const response = await deps.adapter.runCommand({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        command,
        chatId: input.chatId,
        agent: await resolveEffectiveAgent(
          deps.persistence,
          input.chatId,
          context.binding.activeProjectId,
          deps.openCodeDefaultAgent
        ),
        model: effectiveModelResolution.effectiveModel,
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
            requestedAgent: response.value.requestedAgent,
            requestedModel: response.value.requestedModel,
            effectiveAgent: response.value.effectiveAgent,
            effectiveModel: response.value.effectiveModel,
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
        requestedAgent: response.value.requestedAgent,
        requestedModel: response.value.requestedModel,
        effectiveAgent: response.value.effectiveAgent,
        effectiveModel: response.value.effectiveModel,
        modelValidationDegraded: effectiveModelResolution.degraded,
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

    async refreshSessionMetadata(chatId) {
      const nowIso = new Date().toISOString();
      const context = await deps.persistence.runInTransaction((unit) => loadChatRuntimeContext(unit, chatId, nowIso));

      if (!context.binding.activeProjectId || !context.binding.activeSessionId) {
        return errResult(ERROR_CODES.VALIDATION_ERROR, "Primero elegí proyecto y sesión (/project, /session o /new)");
      }

      const currentState = context.state;

      const remoteStatus = await deps.adapter.getSessionState({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
      });

      if (!remoteStatus.ok) {
        const fallback = await deps.persistence.runInTransaction(async (unit) => {
          const persisted = await unit.sessions.findById(context.binding.activeSessionId!);
          if (!persisted) {
            return undefined;
          }

          return {
            requestedAgent: persisted.requestedAgent,
            requestedModel: persisted.requestedModel,
            effectiveAgent: persisted.effectiveAgent,
            effectiveModel: persisted.effectiveModel,
          };
        });

        return okResult({
          projectId: context.binding.activeProjectId,
          sessionId: context.binding.activeSessionId,
          changed: false,
          requestedAgent: fallback?.requestedAgent,
          requestedModel: fallback?.requestedModel,
          effectiveAgent: fallback?.effectiveAgent,
          effectiveModel: fallback?.effectiveModel,
        });
      }

      const synced = await syncRuntimeMetadata({
        persistence: deps.persistence,
        chatId,
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        nowIso,
        readRuntimeMessages: deps.readRuntimeMessages,
        fallback: {
          requestedAgent: context.session?.requestedAgent,
          requestedModel: context.session?.requestedModel,
          effectiveAgent: context.session?.effectiveAgent,
          effectiveModel: context.session?.effectiveModel,
        },
      });

      await deps.persistence.runInTransaction(async (unit) => {
        if (remoteStatus.value.status === "running" && currentState.mode !== OPERATIONAL_MODES.TASK_RUNNING) {
          await unit.states.upsert({
            ...currentState,
            mode: OPERATIONAL_MODES.TASK_RUNNING,
            updatedAt: nowIso,
          });
        }
      });

      return okResult({
        projectId: context.binding.activeProjectId,
        sessionId: context.binding.activeSessionId,
        changed: synced.changed,
        requestedAgent: synced.requestedAgent,
        requestedModel: synced.requestedModel,
        effectiveAgent: synced.effectiveAgent,
        effectiveModel: synced.effectiveModel,
      });
    },

    async confirmDangerousAction(input) {
      const nowIso = new Date().toISOString();
      const featureResolution = resolveLocalHostFeature({
        action: LOCAL_HOST_ACTION_KIND.ATTACH_LOCAL,
        localHostActionsEnabled: deps.localHostOptions?.localHostActionsEnabled ?? false,
        attachLocalEnabled: deps.localHostOptions?.attachLocalEnabled ?? false,
      });

      const preflight = await deps.persistence.runInTransaction(async (unit) => {
        const repository = unit.dangerousActionConfirmations;
        if (!repository) {
          return {
            kind: "error",
            result: errResult<ConfirmDangerousActionOutput>(
              ERROR_CODES.UNAVAILABLE,
              "La confirmación sensible no está disponible en esta instancia."
            ),
          } as const;
        }

        const confirmation = await repository.findByConfirmationId(input.confirmationId);
        if (!confirmation) {
          return {
            kind: "error",
            result: errResult<ConfirmDangerousActionOutput>(
              ERROR_CODES.NOT_FOUND,
              "La confirmación ya no existe o venció."
            ),
          } as const;
        }

        if (confirmation.status !== DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE) {
          return {
            kind: "idempotent",
            output: toDangerousActionOutput({
              confirmation,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.IDEMPOTENT,
              confirmationStatus: confirmation.status,
              message: "Esta confirmación ya no está vigente.",
              reason: confirmation.invalidatedReason ?? "already-terminal",
            }),
          } as const;
        }

        if (new Date(confirmation.expiresAt).getTime() <= Date.now()) {
          const expired = await repository.compareAndSetStatus({
            confirmationId: confirmation.confirmationId,
            fromStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
            toStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.EXPIRED,
            invalidatedReason: "expired",
          });

          const finalConfirmation = expired ?? confirmation;
          logger.audit(buildSensitiveAuditEvent(finalConfirmation, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: "expired",
            timestamp: nowIso,
          }));

          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: finalConfirmation,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: expired?.status ?? DANGEROUS_ACTION_CONFIRMATION_STATUS.EXPIRED,
              message: "La confirmación sensible expiró.",
              reason: "expired",
            }),
          } as const;
        }

        const binding = await ensureBinding(unit, input.chatId, nowIso);
        const session = binding.activeSessionId ? await unit.sessions.findById(binding.activeSessionId) : undefined;
        const guard = assertLocalHostActionAllowed({
          actorId: input.actorId,
          allowedActorIds: localHostAllowedActors,
          chatType: input.chatType,
          featureEnabled: featureResolution.featureEnabled,
          projectId: binding.activeProjectId,
          sessionId: binding.activeSessionId,
          sessionProjectId: session?.projectId,
        });

        if (!guard.ok) {
          const invalidated = await repository.compareAndSetStatus({
            confirmationId: confirmation.confirmationId,
            fromStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
            toStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
            invalidatedReason: guard.reason,
          });
          const finalConfirmation = invalidated ?? confirmation;

          logger.audit(buildSensitiveAuditEvent(finalConfirmation, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: guard.reason,
            timestamp: nowIso,
          }));

          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: finalConfirmation,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: invalidated?.status ?? DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
              message: "El contexto cambió o dejó de ser seguro para esta acción.",
              reason: guard.reason,
            }),
          } as const;
        }

        if (
          confirmation.actorId !== input.actorId ||
          confirmation.chatId !== input.chatId ||
          confirmation.chatType !== input.chatType ||
          confirmation.projectId !== binding.activeProjectId ||
          confirmation.sessionId !== binding.activeSessionId ||
          confirmation.intent !== LOCAL_HOST_ACTION_KIND.ATTACH_LOCAL
        ) {
          const invalidated = await repository.compareAndSetStatus({
            confirmationId: confirmation.confirmationId,
            fromStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
            toStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
            invalidatedReason: "context-mismatch",
          });
          const finalConfirmation = invalidated ?? confirmation;

          logger.audit(buildSensitiveAuditEvent(finalConfirmation, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: "context-mismatch",
            timestamp: nowIso,
          }));

          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: finalConfirmation,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: invalidated?.status ?? DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
              message: "La confirmación dejó de coincidir con el contexto activo.",
              reason: "context-mismatch",
            }),
          } as const;
        }

        const environmentCheck = deps.localHostOptions?.isLocalHostEnvironmentReady
          ? await deps.localHostOptions.isLocalHostEnvironmentReady({
              intent: LOCAL_HOST_ACTION_KIND.ATTACH_LOCAL,
              targetEnvironment: confirmation.targetEnvironment,
              projectId: confirmation.projectId,
              sessionId: confirmation.sessionId,
            })
          : { ok: true };

        const environmentGuard = assertLocalHostActionAllowed({
          actorId: input.actorId,
          allowedActorIds: localHostAllowedActors,
          chatType: input.chatType,
          featureEnabled: featureResolution.featureEnabled,
          projectId: confirmation.projectId,
          sessionId: confirmation.sessionId,
          sessionProjectId: session?.projectId,
          environmentReady: environmentCheck.ok,
          environmentReason: environmentCheck.reason,
        });

        if (!environmentGuard.ok) {
          const invalidated = await repository.compareAndSetStatus({
            confirmationId: confirmation.confirmationId,
            fromStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
            toStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
            invalidatedReason: environmentGuard.reason,
          });
          const finalConfirmation = invalidated ?? confirmation;

          logger.audit(buildSensitiveAuditEvent(finalConfirmation, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: environmentGuard.reason,
            timestamp: nowIso,
          }));

          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: finalConfirmation,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: invalidated?.status ?? DANGEROUS_ACTION_CONFIRMATION_STATUS.INVALIDATED,
              message: "El entorno local no está listo para esta acción sensible.",
              reason: environmentGuard.reason,
            }),
          } as const;
        }

        const confirmed = await repository.compareAndSetStatus({
          confirmationId: confirmation.confirmationId,
          fromStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
          toStatus: DANGEROUS_ACTION_CONFIRMATION_STATUS.CONFIRMED,
          usedAt: nowIso,
        });

        if (!confirmed) {
          const latest = await repository.findByConfirmationId(confirmation.confirmationId);
          if (!latest) {
            return {
              kind: "error",
              result: errResult<ConfirmDangerousActionOutput>(
                ERROR_CODES.NOT_FOUND,
                "La confirmación ya no existe o expiró."
              ),
            } as const;
          }

          return {
            kind: "idempotent",
            output: toDangerousActionOutput({
              confirmation: latest,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.IDEMPOTENT,
              confirmationStatus: latest.status,
              message: "Esta confirmación ya fue procesada.",
              reason: latest.invalidatedReason ?? "status-changed-during-confirm",
            }),
          } as const;
        }

        logger.audit(buildSensitiveAuditEvent(confirmed, {
          result: SENSITIVE_ACTION_AUDIT_RESULT.CONFIRMED,
          timestamp: nowIso,
        }));

        const project = await unit.projects.findById(confirmed.projectId);
        const matchedSession = await unit.sessions.findById(confirmed.sessionId);
        if (!project || !matchedSession || matchedSession.projectId !== confirmed.projectId) {
          const rejectedReason = "context-mismatch";
          logger.audit(buildSensitiveAuditEvent(confirmed, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: rejectedReason,
            timestamp: nowIso,
          }));
          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: confirmed,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: confirmed.status,
              message: "No se pudo validar el contexto de proyecto/sesión.",
              reason: rejectedReason,
            }),
          } as const;
        }

        if (!deps.localTerminalLauncher || !deps.hasTmuxSessionBySessionId) {
          logger.audit(buildSensitiveAuditEvent(confirmed, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.EXECUTED,
            reason: "platform-placeholder-no-local-exec",
            timestamp: nowIso,
          }));

          return {
            kind: "confirmed",
            output: toDangerousActionOutput({
              confirmation: confirmed,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.CONFIRMED,
              confirmationStatus: confirmed.status,
              message:
                "Confirmación validada. La acción local real todavía no está implementada; este RFC deja listo el perímetro de seguridad.",
            }),
          } as const;
        }

        const tmuxCheck = await deps.hasTmuxSessionBySessionId({
          opencodeSessionId: confirmed.sessionId,
          timeoutMs: 3_000,
        });

        if (!tmuxCheck.exists) {
          const manualCommand = `wsl.exe bash -lc 'tmux attach -t ${tmuxCheck.tmuxSessionName}'`;
          const outcome = await repository.recordExecutionOutcome({
            confirmationId: confirmed.confirmationId,
            executionResult: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
            executionReason: "tmux-session-missing",
            launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
            tmuxSessionName: tmuxCheck.tmuxSessionName,
            manualCommand,
            executedAt: nowIso,
          });

          logger.audit(buildSensitiveAuditEvent(outcome ?? confirmed, {
            result: SENSITIVE_ACTION_AUDIT_RESULT.REJECTED,
            reason: "tmux-session-missing",
            timestamp: nowIso,
          }));

          return {
            kind: "rejected",
            output: toDangerousActionOutput({
              confirmation: outcome ?? confirmed,
              status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED,
              confirmationStatus: confirmed.status,
              message: "No encontré la sesión tmux activa. Revalidá con /sesiones o /session.",
              reason: "tmux-session-missing",
              attachLocal: {
                launcher: LOCAL_TERMINAL_LAUNCHER.MANUAL_FALLBACK,
                result: ATTACH_LOCAL_EXECUTION_RESULT.FAILED,
                tmuxSessionName: tmuxCheck.tmuxSessionName,
                manualCommand,
                reason: "tmux-session-missing",
              },
            }),
          } as const;
        }

        const launchResult = await deps.localTerminalLauncher.launchAttach({
          projectPath: project.rootPath,
          sessionId: confirmed.sessionId,
          tmuxSessionName: tmuxCheck.tmuxSessionName,
        });

        const persisted = await repository.recordExecutionOutcome({
          confirmationId: confirmed.confirmationId,
          executionResult: launchResult.result,
          executionReason: launchResult.reason,
          launcher: launchResult.launcher,
          tmuxSessionName: launchResult.tmuxSessionName,
          manualCommand: launchResult.manualCommand,
          executedAt: nowIso,
        });

        logger.audit(buildSensitiveAuditEvent(persisted ?? confirmed, {
          result:
            launchResult.result === ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED
              ? SENSITIVE_ACTION_AUDIT_RESULT.REQUESTED
              : SENSITIVE_ACTION_AUDIT_RESULT.FAILED,
          reason: launchResult.reason,
          timestamp: nowIso,
        }));

        return {
          kind: "confirmed",
          output: toDangerousActionOutput({
            confirmation: persisted ?? confirmed,
            status: CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.CONFIRMED,
            confirmationStatus: confirmed.status,
            message:
              launchResult.result === ATTACH_LOCAL_EXECUTION_RESULT.REQUESTED
                ? "Terminal local solicitada para adjuntar tmux."
                : "No pude abrir terminal automáticamente. Usá fallback manual.",
            attachLocal: launchResult,
          }),
        } as const;
      });

      if (preflight.kind === "error") {
        return preflight.result;
      }

      return okResult(preflight.output);
    },
  };

}

function normalizeAgentSelectionInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const startsWithDoubleQuote = trimmed.startsWith('"') && trimmed.endsWith('"');
  const startsWithSingleQuote = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (!startsWithDoubleQuote && !startsWithSingleQuote) {
    return trimmed;
  }

  return trimmed.slice(1, -1).trim();
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

function toDangerousActionOutput(input: {
  readonly confirmation: DangerousActionConfirmation;
  readonly status: ConfirmDangerousActionResultStatus;
  readonly confirmationStatus: DangerousActionConfirmationStatus;
  readonly message: string;
  readonly reason?: string;
  readonly attachLocal?: AttachLocalLaunchResult;
}): ConfirmDangerousActionOutput {
  return {
    confirmationId: input.confirmation.confirmationId,
    projectId: input.confirmation.projectId,
    sessionId: input.confirmation.sessionId,
    intent: input.confirmation.intent,
    status: input.status,
    confirmationStatus: input.confirmationStatus,
    message: input.message,
    reason: input.reason,
    attachLocal: input.attachLocal,
  };
}

function buildSensitiveAuditEvent(
  confirmation: DangerousActionConfirmation,
  input: {
    readonly result: (typeof SENSITIVE_ACTION_AUDIT_RESULT)[keyof typeof SENSITIVE_ACTION_AUDIT_RESULT];
    readonly timestamp: string;
    readonly reason?: string;
  }
) {
  return {
    actorId: confirmation.actorId,
    chatId: confirmation.chatId,
    chatType: confirmation.chatType,
    action: confirmation.intent,
    projectId: confirmation.projectId,
    sessionId: confirmation.sessionId,
    result: input.result,
    reason: input.reason,
    timestamp: input.timestamp,
    confirmationId: confirmation.confirmationId,
    featureFlag: confirmation.featureFlag,
    targetEnvironment: confirmation.targetEnvironment,
  };
}

async function invalidateDangerousConfirmationsForProject(
  unit: PersistenceUnit,
  chatId: string,
  projectId: string
): Promise<void> {
  await unit.dangerousActionConfirmations?.invalidateActiveByProject({
    chatId,
    projectId,
    reason: "project-changed",
  });
}

async function invalidateDangerousConfirmationsForSession(
  unit: PersistenceUnit,
  chatId: string,
  sessionId: string
): Promise<void> {
  await unit.dangerousActionConfirmations?.invalidateActiveBySession({
    chatId,
    sessionId,
    reason: "session-changed",
  });
}

async function resolveEffectiveAgent(
  persistence: PersistenceDriver,
  chatId: string,
  projectId: string,
  configuredDefaultAgent?: SupportedAgent
): Promise<SupportedAgent> {
  const selection = await persistence.runInTransaction(async (unit) => {
    if (!unit.agentSelections) return undefined;
    return unit.agentSelections.findByChatAndProject(chatId, projectId);
  });

  if (selection?.activeAgent) {
    return selection.activeAgent;
  }

  return configuredDefaultAgent ?? FALLBACK_AGENTS[0];
}

async function resolveEffectiveModel(
  persistence: PersistenceDriver,
  adapter: OpenCodeSessionAdapter,
  chatId: string,
  projectId: string,
  sessionId?: string
): Promise<{ effectiveModel: string; requestedModel?: string; fallbackApplied: boolean; degraded?: string }> {
  const selection = await persistence.runInTransaction(async (unit) => {
    if (!unit.modelSelections) return undefined;
    return unit.modelSelections.findByChatAndProject(chatId, projectId);
  });

  const requestedModel = selection?.activeModel;
  const defaultModel = "openai/gpt-5.3-codex";

  if (!adapter.listModels) {
    return { effectiveModel: requestedModel ?? defaultModel, requestedModel, fallbackApplied: false, degraded: "unsupported" };
  }

  const catalog = await adapter.listModels({ chatId, projectId, sessionId });
  if (!catalog.ok || !catalog.value.ok) {
    return {
      effectiveModel: requestedModel ?? defaultModel,
      requestedModel,
      fallbackApplied: false,
      degraded: catalog.ok ? catalog.value.degraded?.reason : "unavailable",
    };
  }

  const modelIds = new Set(catalog.value.models.map((m) => m.id));
  if (requestedModel && modelIds.has(requestedModel)) {
    return { effectiveModel: requestedModel, requestedModel, fallbackApplied: false };
  }

  const effectiveModel = modelIds.has(defaultModel) ? defaultModel : catalog.value.models[0]?.id ?? defaultModel;
  return { effectiveModel, requestedModel, fallbackApplied: Boolean(requestedModel && requestedModel !== effectiveModel) };
}

async function reopenAttachLocalIfNeeded(input: {
  readonly localTerminalLauncher?: LocalTerminalLauncher;
  readonly persistence: PersistenceDriver;
  readonly chatId: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly sessionReconfigured: boolean;
}): Promise<boolean> {
  if (!input.sessionReconfigured || !input.localTerminalLauncher || !input.projectId || !input.sessionId) {
    return false;
  }

  const project = await input.persistence.runInTransaction((unit) => unit.projects.findById(input.projectId!));
  if (!project) {
    return false;
  }

  try {
    await input.localTerminalLauncher.launchAttach({
      projectPath: project.rootPath,
      sessionId: input.sessionId,
      tmuxSessionName: toTmuxSessionName(input.sessionId),
    });
    return true;
  } catch (error) {
    logger.error("Auto attach-local reopen failed", {
      chatId: input.chatId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function mergeSessionMetadata(
  session: {
    readonly sessionId: string;
    readonly projectId: string;
    readonly createdAt: string;
    readonly updatedAt?: string;
    readonly requestedAgent?: string;
    readonly requestedModel?: string;
    readonly effectiveAgent?: string;
    readonly effectiveModel?: string;
  },
  state: SessionState
): {
  readonly sessionId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
} {
  return {
    ...session,
    requestedAgent: state.requestedAgent ?? session.requestedAgent,
    requestedModel: state.requestedModel ?? session.requestedModel,
    effectiveAgent: state.effectiveAgent ?? session.effectiveAgent ?? state.requestedAgent ?? session.requestedAgent,
    effectiveModel: state.effectiveModel ?? session.effectiveModel ?? session.requestedModel,
  };
}

function hasSessionMetadataChanged(
  before: {
    readonly requestedAgent?: string;
    readonly requestedModel?: string;
    readonly effectiveAgent?: string;
    readonly effectiveModel?: string;
  },
  after: {
    readonly requestedAgent?: string;
    readonly requestedModel?: string;
    readonly effectiveAgent?: string;
    readonly effectiveModel?: string;
  }
): boolean {
  return (
    before.requestedAgent !== after.requestedAgent ||
    before.requestedModel !== after.requestedModel ||
    before.effectiveAgent !== after.effectiveAgent ||
    before.effectiveModel !== after.effectiveModel
  );
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

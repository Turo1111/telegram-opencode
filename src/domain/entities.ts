import { DomainError, ERROR_CODES } from "./errors";

export const OPERATIONAL_MODES = {
  IDLE: "idle",
  SESSION_LINKED: "session-linked",
  TASK_RUNNING: "task-running",
  NEEDS_ATTENTION: "needs-attention",
  ERROR: "error",
} as const;

export type OperationalMode = (typeof OPERATIONAL_MODES)[keyof typeof OPERATIONAL_MODES];

export const ACTIVE_TASK_STATUS = {
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export type ActiveTaskStatus = (typeof ACTIVE_TASK_STATUS)[keyof typeof ACTIVE_TASK_STATUS];

export const PROMPT_TYPE = {
  BOOLEAN: "boolean",
  OPTIONS: "options",
  TEXT: "text",
} as const;

export type PromptType = (typeof PROMPT_TYPE)[keyof typeof PROMPT_TYPE];

export const PENDING_PROMPT_STATUS = {
  ACTIVE: "active",
  SUBMITTED: "submitted",
  RESOLVED: "resolved",
  INVALIDATED: "invalidated",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
  FAILED_DELIVERY: "failed_delivery",
} as const;

export type PendingPromptStatus =
  (typeof PENDING_PROMPT_STATUS)[keyof typeof PENDING_PROMPT_STATUS];

export interface Project {
  projectId: string;
  alias: string;
  rootPath: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface Session {
  sessionId: string;
  projectId: string;
  createdAt: string;
  updatedAt?: string;
  watcherToken?: string;
  watcherCallbackUrl?: string;
  watcherEnabled?: boolean;
  lastObservedAt?: string;
  awaitingInputAt?: string;
  terminalCause?: string;
  terminalSource?: string;
  notificationSentAt?: string;
  continuityLostAt?: string;
  watchdogRetryCount?: number;
  requestedAgent?: string;
  requestedModel?: string;
  effectiveAgent?: string;
  effectiveModel?: string;
}

export interface ChatBinding {
  chatId: string;
  activeProjectId?: string;
  activeSessionId?: string;
  updatedAt: string;
}

export interface ActiveTask {
  taskId: string;
  chatId: string;
  sessionId: string;
  status: ActiveTaskStatus;
  command: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalState {
  chatId: string;
  mode: OperationalMode;
  activeTaskId?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  recoveryStatus?: string;
  recoveryReason?: string;
  lastReconciledAt?: string;
  updatedAt: string;
}

export interface PendingPrompt {
  promptId: string;
  sessionId: string;
  chatId: string;
  projectId: string;
  promptType: PromptType;
  message: string;
  options?: readonly string[];
  status: PendingPromptStatus;
  expiresAt?: string;
  telegramChatId?: string;
  telegramMessageId?: number;
  telegramCallbackQueryId?: string;
  submittedInput?: string;
  createdAt: string;
  updatedAt: string;
}

export const FALLBACK_AGENTS = ["build", "plan", "gentleman", "sdd-orchestrator"] as const;

export type SupportedAgent = string;

/** @deprecated Use FALLBACK_AGENTS instead */
export const SUPPORTED_AGENTS = {
  BUILD: "build",
  PLAN: "plan",
  GENTLEMAN: "gentleman",
  SDD_ORCHESTRATOR: "sdd-orchestrator",
} as const;

export interface AgentSelection {
  chatId: string;
  projectId: string;
  activeAgent: SupportedAgent;
  updatedAt: string;
}

export interface ModelSelection {
  chatId: string;
  projectId: string;
  activeModel: string;
  updatedAt: string;
}

export function isSupportedAgent(value: string): value is SupportedAgent {
  return (FALLBACK_AGENTS as readonly string[]).includes(value);
}

export const DANGEROUS_ACTION_CONFIRMATION_STATUS = {
  ACTIVE: "active",
  CONFIRMED: "confirmed",
  EXPIRED: "expired",
  INVALIDATED: "invalidated",
  CANCELLED: "cancelled",
} as const;

export type DangerousActionConfirmationStatus =
  (typeof DANGEROUS_ACTION_CONFIRMATION_STATUS)[keyof typeof DANGEROUS_ACTION_CONFIRMATION_STATUS];

export const ATTACH_LOCAL_EXECUTION_RESULT = {
  REQUESTED: "requested",
  FAILED: "failed",
} as const;

export type AttachLocalExecutionResult =
  (typeof ATTACH_LOCAL_EXECUTION_RESULT)[keyof typeof ATTACH_LOCAL_EXECUTION_RESULT];

export const LOCAL_TERMINAL_LAUNCHER = {
  WT: "wt",
  POWERSHELL: "powershell",
  MANUAL_FALLBACK: "manual-fallback",
  GNOME_TERMINAL: "gnome-terminal",
  KONSOLE: "konsole",
  X_TERMINAL_EMULATOR: "x-terminal-emulator",
  TERMINAL_APP: "terminal-app",
  ITERM: "iterm",
  BASH: "bash",
} as const;

export type LocalTerminalLauncherKind =
  (typeof LOCAL_TERMINAL_LAUNCHER)[keyof typeof LOCAL_TERMINAL_LAUNCHER];

export interface DangerousActionConfirmation {
  confirmationId: string;
  actorId: string;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  projectId: string;
  sessionId: string;
  intent: string;
  featureFlag: string;
  targetEnvironment: string;
  status: DangerousActionConfirmationStatus;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
  invalidatedReason?: string;
  executionResult?: AttachLocalExecutionResult;
  executionReason?: string;
  launcher?: LocalTerminalLauncherKind;
  tmuxSessionName?: string;
  manualCommand?: string;
  executedAt?: string;
}

export interface DomainSnapshot {
  binding: ChatBinding;
  state: OperationalState;
  session?: Session;
  activeTask?: ActiveTask;
}

export function createIdleState(chatId: string, nowIso: string): OperationalState {
  return {
    chatId,
    mode: OPERATIONAL_MODES.IDLE,
    updatedAt: nowIso,
  };
}

export function applyProjectSelection(binding: ChatBinding, projectId: string, nowIso: string): ChatBinding {
  if (!projectId.trim()) {
    throw new DomainError(ERROR_CODES.VALIDATION_ERROR, "Project id cannot be empty");
  }

  return {
    ...binding,
    activeProjectId: projectId,
    activeSessionId: undefined,
    updatedAt: nowIso,
  };
}

export function assertSessionBelongsToProject(session: Session, projectId: string): void {
  if (session.projectId !== projectId) {
    throw new DomainError(ERROR_CODES.VALIDATION_ERROR, "Session does not belong to active project", {
      details: {
        expectedProjectId: projectId,
        sessionProjectId: session.projectId,
        sessionId: session.sessionId,
      },
    });
  }
}

export function deriveMode(snapshot: DomainSnapshot): OperationalMode {
  validateBindingInvariants(snapshot);

  const { state, binding, activeTask } = snapshot;

  if (state.mode === OPERATIONAL_MODES.ERROR) {
    return OPERATIONAL_MODES.ERROR;
  }

  if (!binding.activeProjectId || !binding.activeSessionId) {
    return OPERATIONAL_MODES.IDLE;
  }

  if (activeTask && activeTask.status === ACTIVE_TASK_STATUS.IN_PROGRESS) {
    return OPERATIONAL_MODES.TASK_RUNNING;
  }

  return OPERATIONAL_MODES.SESSION_LINKED;
}

export function validateBindingInvariants(snapshot: DomainSnapshot): void {
  const { binding, state, session, activeTask } = snapshot;

  if (binding.activeSessionId && !binding.activeProjectId) {
    throw new DomainError(
      ERROR_CODES.INCONSISTENT_BINDING,
      "Invariant violated: activeSessionId requires activeProjectId",
      {
        details: { chatId: binding.chatId, activeSessionId: binding.activeSessionId },
      }
    );
  }

  if (state.mode === OPERATIONAL_MODES.IDLE && (binding.activeProjectId || binding.activeSessionId)) {
    throw new DomainError(
      ERROR_CODES.INCONSISTENT_BINDING,
      "Invariant violated: idle mode cannot have active project/session",
      {
        details: {
          chatId: binding.chatId,
          activeProjectId: binding.activeProjectId,
          activeSessionId: binding.activeSessionId,
        },
      }
    );
  }

  if (
    state.mode === OPERATIONAL_MODES.SESSION_LINKED &&
    (!binding.activeProjectId || !binding.activeSessionId)
  ) {
    throw new DomainError(
      ERROR_CODES.INCONSISTENT_BINDING,
      "Invariant violated: session-linked mode requires active project and active session",
      {
        details: {
          chatId: binding.chatId,
          activeProjectId: binding.activeProjectId,
          activeSessionId: binding.activeSessionId,
        },
      }
    );
  }

  if (state.mode === OPERATIONAL_MODES.TASK_RUNNING && !state.activeTaskId) {
    throw new DomainError(
      ERROR_CODES.INCONSISTENT_BINDING,
      "Invariant violated: task-running mode requires activeTaskId",
      {
        details: { chatId: binding.chatId },
      }
    );
  }

  if (session && binding.activeProjectId) {
    assertSessionBelongsToProject(session, binding.activeProjectId);
  }

  if (activeTask && session && activeTask.sessionId !== session.sessionId) {
    throw new DomainError(
      ERROR_CODES.INCONSISTENT_BINDING,
      "Invariant violated: active task must belong to current session",
      {
        details: {
          chatId: binding.chatId,
          expectedSessionId: session.sessionId,
          taskSessionId: activeTask.sessionId,
        },
      }
    );
  }
}

export function assertNoActiveTaskConflict(state: OperationalState, activeTask?: ActiveTask): void {
  const hasInProgressTask =
    state.mode === OPERATIONAL_MODES.TASK_RUNNING ||
    activeTask?.status === ACTIVE_TASK_STATUS.IN_PROGRESS;

  if (hasInProgressTask) {
    throw new DomainError(
      ERROR_CODES.CONFLICT_ACTIVE_TASK,
      "Cannot execute a new order while another task is in progress",
      {
        details: {
          chatId: state.chatId,
          activeTaskId: state.activeTaskId ?? activeTask?.taskId,
          mode: state.mode,
        },
      }
    );
  }
}

import {
  ActiveTask,
  ATTACH_LOCAL_EXECUTION_RESULT,
  AgentSelection,
  ModelSelection,
  ChatBinding,
  DangerousActionConfirmation,
  DangerousActionConfirmationStatus,
  LOCAL_TERMINAL_LAUNCHER,
  LocalTerminalLauncherKind,
  OperationalState,
  PendingPrompt,
  PendingPromptStatus,
  PromptType,
  Project,
  Session,
  SupportedAgent,
} from "../domain/entities";
import { DomainError } from "../domain/errors";

export interface OkResult<T> {
  ok: true;
  value: T;
}

export interface ErrResult {
  ok: false;
  error: DomainError;
}

export type Result<T> = OkResult<T> | ErrResult;

export const ADAPTER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_PROJECT_MISMATCH: "SESSION_PROJECT_MISMATCH",
  TASK_RUNNING: "TASK_RUNNING",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
  UNSUPPORTED: "UNSUPPORTED",
  AMBIGUOUS_SESSION_CANDIDATE: "AMBIGUOUS_SESSION_CANDIDATE",
  UNKNOWN: "UNKNOWN",
} as const;

export type AdapterErrorCode = (typeof ADAPTER_ERROR_CODES)[keyof typeof ADAPTER_ERROR_CODES];

export interface AdapterError {
  readonly code: AdapterErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export interface OkAdapterResult<T> {
  readonly ok: true;
  readonly data: T;
}

export interface ErrAdapterResult {
  readonly ok: false;
  readonly error: AdapterError;
}

export type AdapterResult<T> = OkAdapterResult<T> | ErrAdapterResult;

export const REMOTE_SESSION_STATUS = {
  IDLE: "idle",
  RUNNING: "running",
  NEEDS_ATTENTION: "needs-attention",
  COMPLETED: "completed",
  UNKNOWN: "unknown",
} as const;

export type RemoteSessionStatus = (typeof REMOTE_SESSION_STATUS)[keyof typeof REMOTE_SESSION_STATUS];

export const RECOVERY_STATUS = {
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  RECOVERED: "recovered",
} as const;

export type RecoveryStatus = (typeof RECOVERY_STATUS)[keyof typeof RECOVERY_STATUS];

export const RECOVERY_REASON = {
  REMOTE_MISSING: "remote-missing",
  REMOTE_CLOSED: "remote-closed",
  REMOTE_TIMEOUT: "remote-timeout",
  REMOTE_UNAVAILABLE: "remote-unavailable",
  REMOTE_CHECK_FAILED: "remote-check-failed",
  NO_ACTIVE_BINDING: "no-active-binding",
} as const;

export type RecoveryReason = (typeof RECOVERY_REASON)[keyof typeof RECOVERY_REASON];

export const BOOT_RECOVERY_NOTICE_KIND = {
  SESSION_RESUMED: "session-resumed",
  SESSION_CLOSED: "session-closed",
  DEGRADED: "degraded",
} as const;

export type BootRecoveryNoticeKind =
  (typeof BOOT_RECOVERY_NOTICE_KIND)[keyof typeof BOOT_RECOVERY_NOTICE_KIND];

export interface BootRecoveryNotice {
  readonly chatId: string;
  readonly kind: BootRecoveryNoticeKind;
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly reason?: RecoveryReason;
  readonly message?: string;
}

export interface SessionState {
  sessionId: string;
  projectId: string;
  status: RemoteSessionStatus;
  taskId?: string;
  updatedAt?: string;
  requestedAgent?: string;
  requestedModel?: string;
  effectiveAgent?: string;
  effectiveModel?: string;
}

export interface BootstrapSessionInput {
  readonly projectId: string;
  readonly rootPath: string;
  readonly initialPrompt: string;
  readonly timeoutMs: number;
}

export const SESSION_EVENT_KIND = {
  STARTED: "SESSION_STARTED",
  COMPLETED: "SESSION_COMPLETED",
  FAILED: "SESSION_FAILED",
  NEEDS_INPUT: "SESSION_NEEDS_INPUT",
} as const;

export type SessionEventKind = (typeof SESSION_EVENT_KIND)[keyof typeof SESSION_EVENT_KIND];

export const TERMINAL_EVENT_SOURCE = {
  WEBHOOK: "webhook",
  WATCHDOG: "watchdog",
  BOOT_RECOVERY: "boot-recovery",
} as const;

export type TerminalEventSource =
  (typeof TERMINAL_EVENT_SOURCE)[keyof typeof TERMINAL_EVENT_SOURCE];

export interface SessionWatcherRegistration {
  readonly callbackUrl: string;
  readonly bearerToken: string;
}

export interface SessionEvent {
  readonly kind: SessionEventKind;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly occurredAt: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface SessionNeedsInputData {
  readonly promptId: string;
  readonly promptType: PromptType;
  readonly message: string;
  readonly options?: readonly string[];
  readonly expiresAt?: string;
}

export interface TelegramPromptCallback {
  readonly chatId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly choice?: string;
  readonly text?: string;
  readonly callbackQueryId?: string;
}

export interface ResumePromptInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly input: string;
  readonly source: "telegram" | "pc";
}

export interface SubmitPromptInputResult {
  readonly status: "accepted";
  readonly message?: string;
}

export interface WebhookAuthContext {
  readonly bearerToken: string;
  readonly remoteAddress?: string;
}

export interface WatchdogCandidate {
  readonly chatId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly activeTaskId?: string;
  readonly lastObservedAt?: string;
  readonly watcherToken?: string;
  readonly terminalCause?: string;
  readonly watchdogRetryCount: number;
}

export const ASYNC_SESSION_NOTICE_KIND = {
  TERMINAL: "terminal",
  NEEDS_INPUT: "needs-input",
  CONTINUITY_LOST: "continuity-lost",
} as const;

export type AsyncSessionNoticeKind =
  (typeof ASYNC_SESSION_NOTICE_KIND)[keyof typeof ASYNC_SESSION_NOTICE_KIND];

export interface EffectiveFallbackInfo {
  readonly kind: "model-fallback" | "agent-override" | "multiple";
  readonly requestedAgent?: string;
  readonly effectiveAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveModel?: string;
}

export interface AsyncSessionNotice {
  readonly chatId: string;
  readonly kind: AsyncSessionNoticeKind;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly terminalCause?: string;
  readonly terminalSource?: TerminalEventSource;
  readonly summary?: string;
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
  readonly fallbackInfo?: EffectiveFallbackInfo;
  readonly prompt?: {
    readonly promptId: string;
    readonly promptType: PromptType;
    readonly message: string;
    readonly options?: readonly string[];
    readonly expiresAt?: string;
  };
  readonly promptCleanup?: {
    readonly promptId: string;
    readonly telegramChatId?: string;
    readonly telegramMessageId?: number;
    readonly reason: "invalidated" | "expired" | "cancelled";
  };
}

export interface SendResult {
  taskId?: string;
  reply?: string;
  ack?: string;
  message: string;
  needsAttention?: boolean;
  status?: RemoteSessionStatus;
  state: SessionState;
  requestedAgent?: string;
  requestedModel?: string;
  effectiveAgent?: string;
  effectiveModel?: string;
  modelValidationDegraded?: ModelCatalogDegradeReason;
  fallbackInfo?: EffectiveFallbackInfo;
}

export interface SessionMetadataSyncResult {
  readonly chatId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly changed: boolean;
  readonly requestedAgent?: string;
  readonly requestedModel?: string;
  readonly effectiveAgent?: string;
  readonly effectiveModel?: string;
}

export interface ObserveSessionResult {
  mode: "not-available-yet";
}

export interface CancelOrInterruptResult {
  status: "cancelled" | "accepted" | "not-available-yet";
  message?: string;
}

export interface ProjectRepository {
  findById(projectId: string): Promise<Project | undefined>;
  findByAlias(alias: string): Promise<Project | undefined>;
  listAll(): Promise<Project[]>;
  upsert(project: Project): Promise<void>;
  markLastUsed(projectId: string, lastUsedAt: string): Promise<void>;
}

export interface SessionRepository {
  findById(sessionId: string): Promise<Session | undefined>;
  findByProjectId(projectId: string): Promise<Session[]>;
  listAll(): Promise<Session[]>;
  upsert(session: Session): Promise<void>;
}

export interface BindingRepository {
  findByChatId(chatId: string): Promise<ChatBinding | undefined>;
  listAll(): Promise<ChatBinding[]>;
  upsert(binding: ChatBinding): Promise<void>;
}

export interface StateRepository {
  findByChatId(chatId: string): Promise<OperationalState | undefined>;
  listAll(): Promise<OperationalState[]>;
  upsert(state: OperationalState): Promise<void>;
}

export interface ActiveTaskRepository {
  findById(taskId: string): Promise<ActiveTask | undefined>;
  findInProgressBySessionId(sessionId: string): Promise<ActiveTask | undefined>;
  listAll(): Promise<ActiveTask[]>;
  upsert(task: ActiveTask): Promise<void>;
}

export interface PendingPromptRepository {
  compareAndSetStatus(input: {
    readonly promptId: string;
    readonly fromStatus: PendingPromptStatus;
    readonly toStatus: PendingPromptStatus;
    readonly updatedAt: string;
    readonly submittedInput?: string;
    readonly telegramCallbackQueryId?: string;
    readonly clearSubmissionMeta?: boolean;
  }): Promise<PendingPrompt | undefined>;
  findByPromptId(promptId: string): Promise<PendingPrompt | undefined>;
  findActiveBySessionId(sessionId: string): Promise<PendingPrompt | undefined>;
  listAll(): Promise<PendingPrompt[]>;
  upsert(prompt: PendingPrompt): Promise<void>;
}

export interface AgentSelectionRepository {
  findByChatAndProject(chatId: string, projectId: string): Promise<AgentSelection | undefined>;
  upsert(selection: AgentSelection): Promise<void>;
}

export const MODEL_CATALOG_DEGRADE_REASON = {
  TIMEOUT: "timeout",
  UNAVAILABLE: "unavailable",
  UNSUPPORTED: "unsupported",
  UPSTREAM: "upstream",
} as const;

export type ModelCatalogDegradeReason =
  (typeof MODEL_CATALOG_DEGRADE_REASON)[keyof typeof MODEL_CATALOG_DEGRADE_REASON];

export interface ModelCatalogItem {
  readonly id: string;
  readonly label?: string;
  readonly source: "http" | "cli" | "pty";
}

export interface ModelCatalogResult {
  readonly ok: boolean;
  readonly models: readonly ModelCatalogItem[];
  readonly fetchedAt: string;
  readonly degraded?: {
    readonly reason: ModelCatalogDegradeReason;
    readonly usingCache: boolean;
  };
}

export const AGENT_CATALOG_DEGRADE_REASON = MODEL_CATALOG_DEGRADE_REASON;
export type AgentCatalogDegradeReason = (typeof AGENT_CATALOG_DEGRADE_REASON)[keyof typeof AGENT_CATALOG_DEGRADE_REASON];

export interface AgentCatalogItem {
  readonly id: string;
  readonly label?: string;
}

export interface AgentCatalogResult {
  readonly ok: boolean;
  readonly agents: readonly AgentCatalogItem[];
  readonly fetchedAt: string;
  readonly degraded?: {
    readonly reason: AgentCatalogDegradeReason;
    readonly usingCache: boolean;
  };
}

export interface ModelSelectionRepository {
  findByChatAndProject(chatId: string, projectId: string): Promise<ModelSelection | undefined>;
  upsert(selection: ModelSelection): Promise<void>;
}

export const SENSITIVE_ACTION_AUDIT_RESULT = {
  REQUESTED: "requested",
  CONFIRMATION_ISSUED: "confirmation-issued",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  FAILED: "failed",
  EXECUTED: "executed",
} as const;

export type SensitiveActionAuditResult =
  (typeof SENSITIVE_ACTION_AUDIT_RESULT)[keyof typeof SENSITIVE_ACTION_AUDIT_RESULT];

export interface SensitiveActionAuditEvent {
  readonly actorId?: string;
  readonly chatId: string;
  readonly chatType?: string;
  readonly action: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly result: SensitiveActionAuditResult;
  readonly reason?: string;
  readonly timestamp: string;
  readonly confirmationId?: string;
  readonly featureFlag?: string;
  readonly targetEnvironment?: string;
}

export interface DangerousActionConfirmationRepository {
  compareAndSetStatus(input: {
    readonly confirmationId: string;
    readonly fromStatus: DangerousActionConfirmationStatus;
    readonly toStatus: DangerousActionConfirmationStatus;
    readonly usedAt?: string;
    readonly invalidatedReason?: string;
  }): Promise<DangerousActionConfirmation | undefined>;
  findByConfirmationId(confirmationId: string): Promise<DangerousActionConfirmation | undefined>;
  invalidateActiveByChat(input: {
    readonly chatId: string;
    readonly reason: string;
  }): Promise<number>;
  invalidateActiveByProject(input: {
    readonly chatId: string;
    readonly projectId: string;
    readonly reason: string;
  }): Promise<number>;
  invalidateActiveBySession(input: {
    readonly chatId: string;
    readonly sessionId: string;
    readonly reason: string;
  }): Promise<number>;
  recordExecutionOutcome(input: {
    readonly confirmationId: string;
    readonly executionResult: (typeof ATTACH_LOCAL_EXECUTION_RESULT)[keyof typeof ATTACH_LOCAL_EXECUTION_RESULT];
    readonly executionReason?: string;
    readonly launcher: (typeof LOCAL_TERMINAL_LAUNCHER)[keyof typeof LOCAL_TERMINAL_LAUNCHER];
    readonly tmuxSessionName: string;
    readonly manualCommand: string;
    readonly executedAt: string;
  }): Promise<DangerousActionConfirmation | undefined>;
  listAll(): Promise<DangerousActionConfirmation[]>;
  upsert(confirmation: DangerousActionConfirmation): Promise<void>;
}

export interface AttachLocalLaunchResult {
  readonly launcher: LocalTerminalLauncherKind;
  readonly result: (typeof ATTACH_LOCAL_EXECUTION_RESULT)[keyof typeof ATTACH_LOCAL_EXECUTION_RESULT];
  readonly tmuxSessionName: string;
  readonly manualCommand: string;
  readonly reason?: string;
}

export interface LocalTerminalLauncher {
  isEnvironmentReady(): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  launchAttach(input: {
    readonly projectPath: string;
    readonly sessionId: string;
    readonly tmuxSessionName: string;
  }): Promise<AttachLocalLaunchResult>;
  getManualCommand?(sessionName: string): string;
  getEnvironmentLabel?(): string;
}

export interface PersistenceUnit {
  projects: ProjectRepository;
  sessions: SessionRepository;
  bindings: BindingRepository;
  states: StateRepository;
  tasks: ActiveTaskRepository;
  agentSelections?: AgentSelectionRepository;
  modelSelections?: ModelSelectionRepository;
  pendingPrompts: PendingPromptRepository;
  dangerousActionConfirmations?: DangerousActionConfirmationRepository;
}

export interface PersistenceDriver {
  runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T>;
}

export interface OpenCodeSessionAdapter {
  resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>>;
  bootstrapSession?(input: BootstrapSessionInput): Promise<Result<SessionState>>;
  configureSessionAgent?(input: {
    projectId: string;
    sessionId: string;
    agent: SupportedAgent;
  }): Promise<Result<{ projectId: string; sessionId: string; agent: SupportedAgent }>>;
  listModels?(input: { projectId: string; sessionId?: string; chatId: string }): Promise<Result<ModelCatalogResult>>;
  listAgents?(input: {
    projectId: string;
    sessionId?: string;
    chatId: string;
  }): Promise<Result<AgentCatalogResult>>;
  configureSessionModel?(input: {
    projectId: string;
    sessionId: string;
    model: string;
  }): Promise<Result<{ projectId: string; sessionId: string; model: string }>>;
  createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SessionState>>;
  attachSession(input: { projectId: string; sessionId: string; model?: string }): Promise<Result<SessionState>>;
  sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
    agent?: SupportedAgent;
    model?: string;
  }): Promise<Result<SendResult>>;
  runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
    agent?: SupportedAgent;
    model?: string;
  }): Promise<Result<SendResult>>;
  getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>>;
  cancelOrInterrupt(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<CancelOrInterruptResult>>;
  observeSession(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>>;
  refreshSessionMetadata?(input: { chatId: string }): Promise<Result<SessionMetadataSyncResult>>;
  submitPromptInput(input: ResumePromptInput): Promise<Result<SubmitPromptInputResult>>;
}

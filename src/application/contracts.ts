import {
  ActiveTask,
  ChatBinding,
  OperationalState,
  PendingPrompt,
  PendingPromptStatus,
  PromptType,
  Project,
  Session,
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

export interface AsyncSessionNotice {
  readonly chatId: string;
  readonly kind: AsyncSessionNoticeKind;
  readonly projectId: string;
  readonly sessionId: string;
  readonly taskId?: string;
  readonly terminalCause?: string;
  readonly terminalSource?: TerminalEventSource;
  readonly summary?: string;
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

export interface PersistenceUnit {
  projects: ProjectRepository;
  sessions: SessionRepository;
  bindings: BindingRepository;
  states: StateRepository;
  tasks: ActiveTaskRepository;
  pendingPrompts: PendingPromptRepository;
}

export interface PersistenceDriver {
  runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T>;
}

export interface OpenCodeSessionAdapter {
  resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>>;
  createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SessionState>>;
  attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>>;
  sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>>;
  runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
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
  submitPromptInput(input: ResumePromptInput): Promise<Result<SubmitPromptInputResult>>;
}

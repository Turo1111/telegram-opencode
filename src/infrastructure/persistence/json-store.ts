import fs from "node:fs/promises";
import path from "node:path";
import {
  ActiveTaskRepository,
  BindingRepository,
  PendingPromptRepository,
  RECOVERY_STATUS,
  RECOVERY_REASON,
  PersistenceDriver,
  PersistenceUnit,
  ProjectRepository,
  SessionRepository,
  StateRepository,
} from "../../application/contracts";
import { Config } from "../../config";
import {
  ActiveTask,
  ChatBinding,
  OperationalState,
  PendingPrompt,
  Project,
  Session,
} from "../../domain/entities";
import { asDomainError, DomainError, ERROR_CODES } from "../../domain/errors";
import { logger } from "../../logger";

interface JsonStoreData {
  projects: Record<string, Project>;
  sessions: Record<string, Session>;
  bindings: Record<string, ChatBinding>;
  states: Record<string, OperationalState>;
  tasks: Record<string, ActiveTask>;
  pendingPrompts: Record<string, PendingPrompt>;
}

const EMPTY_STORE: JsonStoreData = {
  projects: {},
  sessions: {},
  bindings: {},
  states: {},
  tasks: {},
  pendingPrompts: {},
};

export async function createJsonPersistenceDriver(config: Config): Promise<PersistenceDriver> {
  const filePath = path.resolve(config.stateJsonPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const initialData = await openJsonWithContinuity(filePath);
  return new JsonPersistenceDriver(filePath, initialData);
}

async function openJsonWithContinuity(filePath: string): Promise<JsonStoreData> {
  try {
    return await readStoreFile(filePath);
  } catch (error) {
    const domainError = asDomainError(error);
    await backupUnreadableJsonState(filePath);
    await writeStoreFileAtomically(filePath, EMPTY_STORE);

    logger.error("JSON persistence unreadable at startup, restored clean state", {
      path: filePath,
      reason: domainError.message,
    });

    try {
      return await readStoreFile(filePath);
    } catch (retryError) {
      throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "JSON corrupted and reinitialization failed", {
        cause: retryError,
      });
    }
  }
}

class JsonPersistenceDriver implements PersistenceDriver {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private data: JsonStoreData
  ) {}

  async runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const snapshot = cloneData(this.data);
      const unit = createJsonUnit(snapshot);

      try {
        const result = await work(unit);
        await writeStoreFileAtomically(this.filePath, snapshot);
        this.data = snapshot;
        return result;
      } catch (error) {
        throw asDomainError(error);
      }
    });
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;

    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

async function readStoreFile(filePath: string): Promise<JsonStoreData> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return sanitizeStore(parsed);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      await writeStoreFileAtomically(filePath, EMPTY_STORE);
      return cloneData(EMPTY_STORE);
    }

    if (error instanceof SyntaxError) {
      throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "State JSON is not valid", {
        cause: error,
      });
    }

    throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "Cannot read JSON state store", {
      cause: error,
    });
  }
}

async function backupUnreadableJsonState(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }

  const backupBasePath = `${filePath}.bak`;
  const backupPath = `${backupBasePath}.${Date.now().toString(36)}`;

  await fs.rename(filePath, backupPath);
}

function sanitizeStore(value: unknown): JsonStoreData {
  if (!value || typeof value !== "object") {
    return cloneData(EMPTY_STORE);
  }

  const candidate = value as Partial<JsonStoreData>;

  return {
    projects: sanitizeRecord<Project>(candidate.projects),
    sessions: sanitizeSessionRecord(candidate.sessions),
    bindings: sanitizeRecord<ChatBinding>(candidate.bindings),
    states: sanitizeStateRecord(candidate.states),
    tasks: sanitizeRecord<ActiveTask>(candidate.tasks),
    pendingPrompts: sanitizePendingPromptRecord(candidate.pendingPrompts),
  };
}

function sanitizePendingPromptRecord(value: unknown): Record<string, PendingPrompt> {
  const unsafePrompts = sanitizeRecord<PendingPrompt>(value);
  const result: Record<string, PendingPrompt> = {};

  for (const [promptId, prompt] of Object.entries(unsafePrompts)) {
    result[promptId] = normalizePendingPrompt(prompt);
  }

  return result;
}

function normalizePendingPrompt(prompt: PendingPrompt): PendingPrompt {
  return {
    ...prompt,
    options:
      Array.isArray(prompt.options) && prompt.options.every((entry) => typeof entry === "string")
        ? [...prompt.options]
        : undefined,
    expiresAt: typeof prompt.expiresAt === "string" ? prompt.expiresAt : undefined,
    telegramChatId: typeof prompt.telegramChatId === "string" ? prompt.telegramChatId : undefined,
    telegramMessageId: typeof prompt.telegramMessageId === "number" ? prompt.telegramMessageId : undefined,
    telegramCallbackQueryId:
      typeof prompt.telegramCallbackQueryId === "string" ? prompt.telegramCallbackQueryId : undefined,
    submittedInput: typeof prompt.submittedInput === "string" ? prompt.submittedInput : undefined,
  };
}

function sanitizeSessionRecord(value: unknown): Record<string, Session> {
  const unsafeSessions = sanitizeRecord<Session>(value);
  const result: Record<string, Session> = {};

  for (const [sessionId, session] of Object.entries(unsafeSessions)) {
    result[sessionId] = normalizeSession(session);
  }

  return result;
}

function normalizeSession(session: Session): Session {
  return {
    ...session,
    watcherToken: typeof session.watcherToken === "string" ? session.watcherToken : undefined,
    watcherCallbackUrl:
      typeof session.watcherCallbackUrl === "string" ? session.watcherCallbackUrl : undefined,
    watcherEnabled: typeof session.watcherEnabled === "boolean" ? session.watcherEnabled : undefined,
    lastObservedAt: typeof session.lastObservedAt === "string" ? session.lastObservedAt : undefined,
    awaitingInputAt: typeof session.awaitingInputAt === "string" ? session.awaitingInputAt : undefined,
    terminalCause: typeof session.terminalCause === "string" ? session.terminalCause : undefined,
    terminalSource: typeof session.terminalSource === "string" ? session.terminalSource : undefined,
    notificationSentAt: typeof session.notificationSentAt === "string" ? session.notificationSentAt : undefined,
    continuityLostAt: typeof session.continuityLostAt === "string" ? session.continuityLostAt : undefined,
    watchdogRetryCount:
      typeof session.watchdogRetryCount === "number" && Number.isFinite(session.watchdogRetryCount)
        ? session.watchdogRetryCount
        : undefined,
  };
}

function sanitizeStateRecord(value: unknown): Record<string, OperationalState> {
  const unsafeStates = sanitizeRecord<OperationalState>(value);
  const result: Record<string, OperationalState> = {};

  for (const [chatId, state] of Object.entries(unsafeStates)) {
    result[chatId] = normalizeOperationalState(state);
  }

  return result;
}

function normalizeOperationalState(state: OperationalState): OperationalState {
  const recoveryStatus =
    typeof state.recoveryStatus === "string" &&
    Object.values(RECOVERY_STATUS).some((status) => status === state.recoveryStatus)
      ? state.recoveryStatus
      : undefined;

  const recoveryReason =
    typeof state.recoveryReason === "string" &&
    Object.values(RECOVERY_REASON).some((reason) => reason === state.recoveryReason)
      ? state.recoveryReason
      : undefined;

  return {
    ...state,
    recoveryStatus,
    recoveryReason,
    lastReconciledAt: typeof state.lastReconciledAt === "string" ? state.lastReconciledAt : undefined,
  };
}

function sanitizeRecord<T>(value: unknown): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...(value as Record<string, T>) };
}

function cloneData(data: JsonStoreData): JsonStoreData {
  return {
    projects: { ...data.projects },
    sessions: { ...data.sessions },
    bindings: { ...data.bindings },
    states: { ...data.states },
    tasks: { ...data.tasks },
    pendingPrompts: { ...data.pendingPrompts },
  };
}

async function writeStoreFileAtomically(filePath: string, data: JsonStoreData): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  const serialized = JSON.stringify(data, null, 2);

  try {
    await fs.writeFile(tmpPath, serialized, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "Cannot persist JSON state store", {
      cause: error,
    });
  }
}

function createJsonUnit(data: JsonStoreData): PersistenceUnit {
  const projects = createProjectRepository(data);
  const sessions = createSessionRepository(data);
  const bindings = createBindingRepository(data);
  const states = createStateRepository(data);
  const tasks = createActiveTaskRepository(data);
  const pendingPrompts = createPendingPromptRepository(data);

  return { projects, sessions, bindings, states, tasks, pendingPrompts };
}

function createProjectRepository(data: JsonStoreData): ProjectRepository {
  return {
    async findById(projectId) {
      return data.projects[projectId];
    },
    async findByAlias(alias) {
      const project = Object.values(data.projects).find((entry) => entry.alias === alias);
      return project;
    },
    async listAll() {
      return Object.values(data.projects).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async upsert(project) {
      data.projects[project.projectId] = { ...project };
    },
    async markLastUsed(projectId, lastUsedAt) {
      const existing = data.projects[projectId];
      if (!existing) return;

      data.projects[projectId] = {
        ...existing,
        lastUsedAt,
      };
    },
  };
}

function createSessionRepository(data: JsonStoreData): SessionRepository {
  return {
    async findById(sessionId) {
      return data.sessions[sessionId];
    },
    async findByProjectId(projectId) {
      return Object.values(data.sessions)
        .filter((entry) => entry.projectId === projectId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async listAll() {
      return Object.values(data.sessions).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async upsert(session) {
      data.sessions[session.sessionId] = { ...session };
    },
  };
}

function createBindingRepository(data: JsonStoreData): BindingRepository {
  return {
    async findByChatId(chatId) {
      return data.bindings[chatId];
    },
    async listAll() {
      return Object.values(data.bindings).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    },
    async upsert(binding) {
      data.bindings[binding.chatId] = { ...binding };
    },
  };
}

function createStateRepository(data: JsonStoreData): StateRepository {
  return {
    async findByChatId(chatId) {
      return data.states[chatId];
    },
    async listAll() {
      return Object.values(data.states).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    },
    async upsert(state) {
      data.states[state.chatId] = { ...state };
    },
  };
}

function createActiveTaskRepository(data: JsonStoreData): ActiveTaskRepository {
  return {
    async findById(taskId) {
      return data.tasks[taskId];
    },
    async findInProgressBySessionId(sessionId) {
      const inProgress = Object.values(data.tasks)
        .filter((entry) => entry.sessionId === sessionId && entry.status === "in-progress")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      return inProgress[0];
    },
    async listAll() {
      return Object.values(data.tasks).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    },
    async upsert(task) {
      data.tasks[task.taskId] = { ...task };
    },
  };
}

function createPendingPromptRepository(data: JsonStoreData): PendingPromptRepository {
  return {
    async compareAndSetStatus(input) {
      const existing = data.pendingPrompts[input.promptId];
      if (!existing || existing.status !== input.fromStatus) {
        return undefined;
      }

      const updated: PendingPrompt = {
        ...existing,
        status: input.toStatus,
        updatedAt: input.updatedAt,
        submittedInput: input.clearSubmissionMeta
          ? undefined
          : input.submittedInput ?? existing.submittedInput,
        telegramCallbackQueryId: input.clearSubmissionMeta
          ? undefined
          : input.telegramCallbackQueryId ?? existing.telegramCallbackQueryId,
      };

      data.pendingPrompts[input.promptId] = updated;
      return updated;
    },
    async findByPromptId(promptId) {
      return data.pendingPrompts[promptId];
    },
    async findActiveBySessionId(sessionId) {
      const active = Object.values(data.pendingPrompts)
        .filter((entry) => entry.sessionId === sessionId && entry.status === "active")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

      return active[0];
    },
    async listAll() {
      return Object.values(data.pendingPrompts).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    },
    async upsert(prompt) {
      data.pendingPrompts[prompt.promptId] = { ...prompt };
    },
  };
}

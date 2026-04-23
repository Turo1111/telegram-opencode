import fs from "node:fs/promises";
import path from "node:path";
import {
  ActiveTaskRepository,
  BindingRepository,
  PendingPromptRepository,
  RECOVERY_REASON,
  RECOVERY_STATUS,
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
  PendingPromptStatus,
  Project,
  Session,
} from "../../domain/entities";
import { asDomainError, DomainError, ERROR_CODES } from "../../domain/errors";

interface SqliteStatement<Row = unknown> {
  run(params?: Record<string, unknown>): unknown;
  get(params?: Record<string, unknown>): Row | undefined;
  all(params?: Record<string, unknown>): Row[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
}

interface SqliteModuleShape {
  DatabaseSync?: new (filePath: string) => SqliteDatabase;
  default?: {
    DatabaseSync?: new (filePath: string) => SqliteDatabase;
  };
  sqlite3?: {
    DatabaseSync?: new (filePath: string) => SqliteDatabase;
  };
}

interface ProjectRow {
  project_id: string;
  alias: string;
  root_path: string;
  created_at: string;
  last_used_at: string | null;
}

interface SessionRow {
  session_id: string;
  project_id: string;
  created_at: string;
  updated_at: string | null;
  watcher_token: string | null;
  watcher_callback_url: string | null;
  watcher_enabled: number | null;
  last_observed_at: string | null;
  awaiting_input_at: string | null;
  terminal_cause: string | null;
  terminal_source: string | null;
  notification_sent_at: string | null;
  continuity_lost_at: string | null;
  watchdog_retry_count: number | null;
}

interface BindingRow {
  chat_id: string;
  active_project_id: string | null;
  active_session_id: string | null;
  updated_at: string;
}

interface StateRow {
  chat_id: string;
  mode: OperationalState["mode"];
  active_task_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  recovery_status: string | null;
  recovery_reason: string | null;
  last_reconciled_at: string | null;
  updated_at: string;
}

interface ActiveTaskRow {
  task_id: string;
  chat_id: string;
  session_id: string;
  status: ActiveTask["status"];
  command: string;
  created_at: string;
  updated_at: string;
}

interface PendingPromptRow {
  prompt_id: string;
  session_id: string;
  chat_id: string;
  project_id: string;
  prompt_type: PendingPrompt["promptType"];
  message: string;
  options_json: string | null;
  status: PendingPromptStatus;
  expires_at: string | null;
  telegram_chat_id: string | null;
  telegram_message_id: number | null;
  telegram_callback_query_id: string | null;
  submitted_input: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  watcher_token TEXT,
  watcher_callback_url TEXT,
  watcher_enabled INTEGER,
  last_observed_at TEXT,
  awaiting_input_at TEXT,
  terminal_cause TEXT,
  terminal_source TEXT,
  notification_sent_at TEXT,
  continuity_lost_at TEXT,
  watchdog_retry_count INTEGER,
  FOREIGN KEY(project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

CREATE TABLE IF NOT EXISTS bindings (
  chat_id TEXT PRIMARY KEY,
  active_project_id TEXT,
  active_session_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS states (
  chat_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  active_task_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  recovery_status TEXT,
  recovery_reason TEXT,
  last_reconciled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS active_tasks (
  task_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_tasks_session_id ON active_tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_active_tasks_session_status ON active_tasks(session_id, status);

CREATE TABLE IF NOT EXISTS pending_prompts (
  prompt_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  prompt_type TEXT NOT NULL,
  message TEXT NOT NULL,
  options_json TEXT,
  status TEXT NOT NULL,
  expires_at TEXT,
  telegram_chat_id TEXT,
  telegram_message_id INTEGER,
  telegram_callback_query_id TEXT,
  submitted_input TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_prompts_session_status ON pending_prompts(session_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_prompts_chat_status ON pending_prompts(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_prompts_expires_status ON pending_prompts(expires_at, status);
`;

export async function createSqlitePersistenceDriver(config: Config): Promise<PersistenceDriver> {
  const DatabaseCtor = await resolveDatabaseCtor();
  const dbPath = path.resolve(config.stateDbPath);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const db = await openSqliteWithContinuity(DatabaseCtor, dbPath);

  return new SqlitePersistenceDriver(db);
}

async function openSqliteWithContinuity(
  DatabaseCtor: new (filePath: string) => SqliteDatabase,
  dbPath: string
): Promise<SqliteDatabase> {
  try {
    const db = new DatabaseCtor(dbPath);
    initializeSqlite(db);
    return db;
  } catch (error) {
    await backupUnreadableSqliteState(dbPath);
    await resetSqliteArtifacts(dbPath);

    try {
      const db = new DatabaseCtor(dbPath);
      initializeSqlite(db);
      return db;
    } catch (retryError) {
      throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "SQLite corrupted and reinitialization failed", {
        cause: retryError,
      });
    }
  }
}

function initializeSqlite(db: SqliteDatabase): void {
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec(SCHEMA_SQL);
  ensureSessionColumns(db);
  ensureStateColumns(db);
}

function ensureSessionColumns(db: SqliteDatabase): void {
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN watcher_token TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN watcher_callback_url TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN watcher_enabled INTEGER;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN last_observed_at TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN awaiting_input_at TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN terminal_cause TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN terminal_source TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN notification_sent_at TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN continuity_lost_at TEXT;");
  ensureColumn(db, "ALTER TABLE sessions ADD COLUMN watchdog_retry_count INTEGER;");
}

function ensureStateColumns(db: SqliteDatabase): void {
  ensureColumn(db, "ALTER TABLE states ADD COLUMN recovery_status TEXT;");
  ensureColumn(db, "ALTER TABLE states ADD COLUMN recovery_reason TEXT;");
  ensureColumn(db, "ALTER TABLE states ADD COLUMN last_reconciled_at TEXT;");
}

function ensureColumn(db: SqliteDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("duplicate column")) {
      return;
    }

    throw error;
  }
}

async function backupUnreadableSqliteState(dbPath: string): Promise<void> {
  const backupPath = `${dbPath}.bak`;
  const artifactPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  await fs.rm(backupPath, { force: true });

  for (const artifactPath of artifactPaths) {
    try {
      await fs.access(artifactPath);
    } catch {
      continue;
    }

    const safeName = path.basename(artifactPath).replace(/[^a-zA-Z0-9._-]/gu, "_");
    const target = `${backupPath}.${safeName}`;
    await fs.rename(artifactPath, target);
  }
}

async function resetSqliteArtifacts(dbPath: string): Promise<void> {
  await fs.rm(dbPath, { force: true });
  await fs.rm(`${dbPath}-wal`, { force: true });
  await fs.rm(`${dbPath}-shm`, { force: true });
}

async function resolveDatabaseCtor(): Promise<new (filePath: string) => SqliteDatabase> {
  const moduleName = "node:sqlite";

  let sqliteModule: SqliteModuleShape;
  try {
    sqliteModule = (await import(moduleName)) as SqliteModuleShape;
  } catch (error) {
    throw new DomainError(
      ERROR_CODES.PERSISTENCE_ERROR,
      "SQLite driver unavailable in current Node runtime",
      { cause: error }
    );
  }

  const ctor =
    sqliteModule.DatabaseSync ?? sqliteModule.default?.DatabaseSync ?? sqliteModule.sqlite3?.DatabaseSync;

  if (!ctor) {
    throw new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "SQLite DatabaseSync constructor not found");
  }

  return ctor;
}

class SqlitePersistenceDriver implements PersistenceDriver {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly db: SqliteDatabase) {}

  async runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      this.db.exec("BEGIN IMMEDIATE TRANSACTION;");

      try {
        const unit = createSqliteUnit(this.db);
        const result = await work(unit);
        this.db.exec("COMMIT;");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK;");
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

function createSqliteUnit(db: SqliteDatabase): PersistenceUnit {
  const projects = createProjectRepository(db);
  const sessions = createSessionRepository(db);
  const bindings = createBindingRepository(db);
  const states = createStateRepository(db);
  const tasks = createActiveTaskRepository(db);
  const pendingPrompts = createPendingPromptRepository(db);

  return { projects, sessions, bindings, states, tasks, pendingPrompts };
}

function createProjectRepository(db: SqliteDatabase): ProjectRepository {
  return {
    async findById(projectId) {
      const row = db.prepare<ProjectRow>(
        "SELECT project_id, alias, root_path, created_at, last_used_at FROM projects WHERE project_id = :projectId"
      ).get({ projectId });

      return row ? mapProjectRow(row) : undefined;
    },
    async findByAlias(alias) {
      const row = db.prepare<ProjectRow>(
        "SELECT project_id, alias, root_path, created_at, last_used_at FROM projects WHERE alias = :alias"
      ).get({ alias });

      return row ? mapProjectRow(row) : undefined;
    },
    async listAll() {
      const rows = db
        .prepare<ProjectRow>(
          "SELECT project_id, alias, root_path, created_at, last_used_at FROM projects ORDER BY created_at ASC"
        )
        .all();

      return rows.map(mapProjectRow);
    },
    async upsert(project) {
      db.prepare(
        `INSERT INTO projects (project_id, alias, root_path, created_at, last_used_at)
         VALUES (:projectId, :alias, :rootPath, :createdAt, :lastUsedAt)
         ON CONFLICT(project_id) DO UPDATE SET
           alias = excluded.alias,
           root_path = excluded.root_path,
           created_at = excluded.created_at,
           last_used_at = excluded.last_used_at`
      ).run({
        projectId: project.projectId,
        alias: project.alias,
        rootPath: project.rootPath,
        createdAt: project.createdAt,
        lastUsedAt: project.lastUsedAt ?? null,
      });
    },
    async markLastUsed(projectId, lastUsedAt) {
      db.prepare("UPDATE projects SET last_used_at = :lastUsedAt WHERE project_id = :projectId").run({
        projectId,
        lastUsedAt,
      });
    },
  };
}

function createSessionRepository(db: SqliteDatabase): SessionRepository {
  return {
    async findById(sessionId) {
      const row = db.prepare<SessionRow>(
        `SELECT session_id, project_id, created_at, updated_at, watcher_token, watcher_callback_url,
                watcher_enabled, last_observed_at, awaiting_input_at, terminal_cause, terminal_source,
                notification_sent_at, continuity_lost_at, watchdog_retry_count
           FROM sessions WHERE session_id = :sessionId`
      ).get({ sessionId });

      return row ? mapSessionRow(row) : undefined;
    },
    async findByProjectId(projectId) {
      const rows = db
        .prepare<SessionRow>(
          `SELECT session_id, project_id, created_at, updated_at, watcher_token, watcher_callback_url,
                  watcher_enabled, last_observed_at, awaiting_input_at, terminal_cause, terminal_source,
                  notification_sent_at, continuity_lost_at, watchdog_retry_count
             FROM sessions WHERE project_id = :projectId ORDER BY created_at ASC`
        )
        .all({ projectId });

      return rows.map(mapSessionRow);
    },
    async listAll() {
      const rows = db
        .prepare<SessionRow>(
          `SELECT session_id, project_id, created_at, updated_at, watcher_token, watcher_callback_url,
                  watcher_enabled, last_observed_at, awaiting_input_at, terminal_cause, terminal_source,
                  notification_sent_at, continuity_lost_at, watchdog_retry_count
             FROM sessions ORDER BY created_at ASC`
        )
        .all();

      return rows.map(mapSessionRow);
    },
    async upsert(session) {
      db.prepare(
        `INSERT INTO sessions (
           session_id, project_id, created_at, updated_at, watcher_token, watcher_callback_url,
           watcher_enabled, last_observed_at, awaiting_input_at, terminal_cause, terminal_source,
           notification_sent_at, continuity_lost_at, watchdog_retry_count
         )
         VALUES (
           :sessionId, :projectId, :createdAt, :updatedAt, :watcherToken, :watcherCallbackUrl,
           :watcherEnabled, :lastObservedAt, :awaitingInputAt, :terminalCause, :terminalSource,
           :notificationSentAt, :continuityLostAt, :watchdogRetryCount
         )
         ON CONFLICT(session_id) DO UPDATE SET
            project_id = excluded.project_id,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            watcher_token = excluded.watcher_token,
            watcher_callback_url = excluded.watcher_callback_url,
            watcher_enabled = excluded.watcher_enabled,
            last_observed_at = excluded.last_observed_at,
            awaiting_input_at = excluded.awaiting_input_at,
            terminal_cause = excluded.terminal_cause,
            terminal_source = excluded.terminal_source,
            notification_sent_at = excluded.notification_sent_at,
            continuity_lost_at = excluded.continuity_lost_at,
            watchdog_retry_count = excluded.watchdog_retry_count`
      ).run({
        sessionId: session.sessionId,
        projectId: session.projectId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt ?? null,
        watcherToken: session.watcherToken ?? null,
        watcherCallbackUrl: session.watcherCallbackUrl ?? null,
        watcherEnabled: session.watcherEnabled === undefined ? null : Number(session.watcherEnabled),
        lastObservedAt: session.lastObservedAt ?? null,
        awaitingInputAt: session.awaitingInputAt ?? null,
        terminalCause: session.terminalCause ?? null,
        terminalSource: session.terminalSource ?? null,
        notificationSentAt: session.notificationSentAt ?? null,
        continuityLostAt: session.continuityLostAt ?? null,
        watchdogRetryCount: session.watchdogRetryCount ?? 0,
      });
    },
  };
}

function createBindingRepository(db: SqliteDatabase): BindingRepository {
  return {
    async findByChatId(chatId) {
      const row = db.prepare<BindingRow>(
        "SELECT chat_id, active_project_id, active_session_id, updated_at FROM bindings WHERE chat_id = :chatId"
      ).get({ chatId });

      return row ? mapBindingRow(row) : undefined;
    },
    async listAll() {
      const rows = db
        .prepare<BindingRow>(
          "SELECT chat_id, active_project_id, active_session_id, updated_at FROM bindings ORDER BY updated_at ASC"
        )
        .all();

      return rows.map(mapBindingRow);
    },
    async upsert(binding) {
      db.prepare(
        `INSERT INTO bindings (chat_id, active_project_id, active_session_id, updated_at)
         VALUES (:chatId, :activeProjectId, :activeSessionId, :updatedAt)
         ON CONFLICT(chat_id) DO UPDATE SET
           active_project_id = excluded.active_project_id,
           active_session_id = excluded.active_session_id,
           updated_at = excluded.updated_at`
      ).run({
        chatId: binding.chatId,
        activeProjectId: binding.activeProjectId ?? null,
        activeSessionId: binding.activeSessionId ?? null,
        updatedAt: binding.updatedAt,
      });
    },
  };
}

function createStateRepository(db: SqliteDatabase): StateRepository {
  return {
    async findByChatId(chatId) {
      const row = db.prepare<StateRow>(
        "SELECT chat_id, mode, active_task_id, last_error_code, last_error_message, recovery_status, recovery_reason, last_reconciled_at, updated_at FROM states WHERE chat_id = :chatId"
      ).get({ chatId });

      return row ? mapStateRow(row) : undefined;
    },
    async listAll() {
      const rows = db
        .prepare<StateRow>(
          "SELECT chat_id, mode, active_task_id, last_error_code, last_error_message, recovery_status, recovery_reason, last_reconciled_at, updated_at FROM states ORDER BY updated_at ASC"
        )
        .all();

      return rows.map(mapStateRow);
    },
    async upsert(state) {
      db.prepare(
        `INSERT INTO states (chat_id, mode, active_task_id, last_error_code, last_error_message, recovery_status, recovery_reason, last_reconciled_at, updated_at)
         VALUES (:chatId, :mode, :activeTaskId, :lastErrorCode, :lastErrorMessage, :recoveryStatus, :recoveryReason, :lastReconciledAt, :updatedAt)
         ON CONFLICT(chat_id) DO UPDATE SET
            mode = excluded.mode,
            active_task_id = excluded.active_task_id,
            last_error_code = excluded.last_error_code,
            last_error_message = excluded.last_error_message,
            recovery_status = excluded.recovery_status,
            recovery_reason = excluded.recovery_reason,
            last_reconciled_at = excluded.last_reconciled_at,
            updated_at = excluded.updated_at`
      ).run({
        chatId: state.chatId,
        mode: state.mode,
        activeTaskId: state.activeTaskId ?? null,
        lastErrorCode: state.lastErrorCode ?? null,
        lastErrorMessage: state.lastErrorMessage ?? null,
        recoveryStatus: normalizeRecoveryStatus(state.recoveryStatus),
        recoveryReason: normalizeRecoveryReason(state.recoveryReason),
        lastReconciledAt: state.lastReconciledAt ?? null,
        updatedAt: state.updatedAt,
      });
    },
  };
}

function createActiveTaskRepository(db: SqliteDatabase): ActiveTaskRepository {
  return {
    async findById(taskId) {
      const row = db.prepare<ActiveTaskRow>(
        "SELECT task_id, chat_id, session_id, status, command, created_at, updated_at FROM active_tasks WHERE task_id = :taskId"
      ).get({ taskId });

      return row ? mapActiveTaskRow(row) : undefined;
    },
    async findInProgressBySessionId(sessionId) {
      const row = db.prepare<ActiveTaskRow>(
        "SELECT task_id, chat_id, session_id, status, command, created_at, updated_at FROM active_tasks WHERE session_id = :sessionId AND status = 'in-progress' ORDER BY updated_at DESC LIMIT 1"
      ).get({ sessionId });

      return row ? mapActiveTaskRow(row) : undefined;
    },
    async listAll() {
      const rows = db
        .prepare<ActiveTaskRow>(
          "SELECT task_id, chat_id, session_id, status, command, created_at, updated_at FROM active_tasks ORDER BY updated_at ASC"
        )
        .all();

      return rows.map(mapActiveTaskRow);
    },
    async upsert(task) {
      db.prepare(
        `INSERT INTO active_tasks (task_id, chat_id, session_id, status, command, created_at, updated_at)
         VALUES (:taskId, :chatId, :sessionId, :status, :command, :createdAt, :updatedAt)
         ON CONFLICT(task_id) DO UPDATE SET
           chat_id = excluded.chat_id,
           session_id = excluded.session_id,
           status = excluded.status,
           command = excluded.command,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      ).run({
        taskId: task.taskId,
        chatId: task.chatId,
        sessionId: task.sessionId,
        status: task.status,
        command: task.command,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
    },
  };
}

function createPendingPromptRepository(db: SqliteDatabase): PendingPromptRepository {
  return {
    async compareAndSetStatus(input) {
      const updateResult = db
        .prepare(
        `UPDATE pending_prompts
            SET status = :toStatus,
                updated_at = :updatedAt,
                submitted_input = CASE
                  WHEN :clearSubmissionMeta = 1 THEN NULL
                  ELSE COALESCE(:submittedInput, submitted_input)
                END,
                telegram_callback_query_id = CASE
                  WHEN :clearSubmissionMeta = 1 THEN NULL
                  ELSE COALESCE(:telegramCallbackQueryId, telegram_callback_query_id)
                END
          WHERE prompt_id = :promptId
            AND status = :fromStatus`
        )
        .run({
          promptId: input.promptId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          updatedAt: input.updatedAt,
          submittedInput: input.submittedInput ?? null,
          telegramCallbackQueryId: input.telegramCallbackQueryId ?? null,
          clearSubmissionMeta: input.clearSubmissionMeta ? 1 : 0,
        });

      if (extractSqliteChanges(updateResult) === 0) {
        return undefined;
      }

      const row = db.prepare<PendingPromptRow>(
        `SELECT prompt_id, session_id, chat_id, project_id, prompt_type, message, options_json, status,
                expires_at, telegram_chat_id, telegram_message_id, telegram_callback_query_id,
                submitted_input, created_at, updated_at
           FROM pending_prompts WHERE prompt_id = :promptId`
      ).get({ promptId: input.promptId });

      if (!row || row.status !== input.toStatus) {
        return undefined;
      }

      return mapPendingPromptRow(row);
    },
    async findByPromptId(promptId) {
      const row = db.prepare<PendingPromptRow>(
        `SELECT prompt_id, session_id, chat_id, project_id, prompt_type, message, options_json, status,
                expires_at, telegram_chat_id, telegram_message_id, telegram_callback_query_id,
                submitted_input, created_at, updated_at
           FROM pending_prompts WHERE prompt_id = :promptId`
      ).get({ promptId });

      return row ? mapPendingPromptRow(row) : undefined;
    },
    async findActiveBySessionId(sessionId) {
      const row = db.prepare<PendingPromptRow>(
        `SELECT prompt_id, session_id, chat_id, project_id, prompt_type, message, options_json, status,
                expires_at, telegram_chat_id, telegram_message_id, telegram_callback_query_id,
                submitted_input, created_at, updated_at
           FROM pending_prompts
          WHERE session_id = :sessionId AND status = 'active'
          ORDER BY updated_at DESC
          LIMIT 1`
      ).get({ sessionId });

      return row ? mapPendingPromptRow(row) : undefined;
    },
    async listAll() {
      const rows = db
        .prepare<PendingPromptRow>(
          `SELECT prompt_id, session_id, chat_id, project_id, prompt_type, message, options_json, status,
                  expires_at, telegram_chat_id, telegram_message_id, telegram_callback_query_id,
                  submitted_input, created_at, updated_at
             FROM pending_prompts
            ORDER BY updated_at ASC`
        )
        .all();

      return rows.map(mapPendingPromptRow);
    },
    async upsert(prompt) {
      db.prepare(
        `INSERT INTO pending_prompts (
           prompt_id, session_id, chat_id, project_id, prompt_type, message, options_json, status,
           expires_at, telegram_chat_id, telegram_message_id, telegram_callback_query_id,
           submitted_input, created_at, updated_at
         )
         VALUES (
           :promptId, :sessionId, :chatId, :projectId, :promptType, :message, :optionsJson, :status,
           :expiresAt, :telegramChatId, :telegramMessageId, :telegramCallbackQueryId,
           :submittedInput, :createdAt, :updatedAt
         )
         ON CONFLICT(prompt_id) DO UPDATE SET
           session_id = excluded.session_id,
           chat_id = excluded.chat_id,
           project_id = excluded.project_id,
           prompt_type = excluded.prompt_type,
           message = excluded.message,
           options_json = excluded.options_json,
           status = excluded.status,
           expires_at = excluded.expires_at,
           telegram_chat_id = excluded.telegram_chat_id,
           telegram_message_id = excluded.telegram_message_id,
           telegram_callback_query_id = excluded.telegram_callback_query_id,
           submitted_input = excluded.submitted_input,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      ).run({
        promptId: prompt.promptId,
        sessionId: prompt.sessionId,
        chatId: prompt.chatId,
        projectId: prompt.projectId,
        promptType: prompt.promptType,
        message: prompt.message,
        optionsJson: prompt.options ? JSON.stringify([...prompt.options]) : null,
        status: prompt.status,
        expiresAt: prompt.expiresAt ?? null,
        telegramChatId: prompt.telegramChatId ?? null,
        telegramMessageId: prompt.telegramMessageId ?? null,
        telegramCallbackQueryId: prompt.telegramCallbackQueryId ?? null,
        submittedInput: prompt.submittedInput ?? null,
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
      });
    },
  };
}

function mapProjectRow(row: ProjectRow): Project {
  return {
    projectId: row.project_id,
    alias: row.alias,
    rootPath: row.root_path,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

function mapSessionRow(row: SessionRow): Session {
  return {
    sessionId: row.session_id,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? undefined,
    watcherToken: row.watcher_token ?? undefined,
    watcherCallbackUrl: row.watcher_callback_url ?? undefined,
    watcherEnabled: row.watcher_enabled === null ? undefined : row.watcher_enabled === 1,
    lastObservedAt: row.last_observed_at ?? undefined,
    awaitingInputAt: row.awaiting_input_at ?? undefined,
    terminalCause: row.terminal_cause ?? undefined,
    terminalSource: row.terminal_source ?? undefined,
    notificationSentAt: row.notification_sent_at ?? undefined,
    continuityLostAt: row.continuity_lost_at ?? undefined,
    watchdogRetryCount: row.watchdog_retry_count ?? undefined,
  };
}

function mapBindingRow(row: BindingRow): ChatBinding {
  return {
    chatId: row.chat_id,
    activeProjectId: row.active_project_id ?? undefined,
    activeSessionId: row.active_session_id ?? undefined,
    updatedAt: row.updated_at,
  };
}

function mapStateRow(row: StateRow): OperationalState {
  return {
    chatId: row.chat_id,
    mode: row.mode,
    activeTaskId: row.active_task_id ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    lastErrorMessage: row.last_error_message ?? undefined,
    recoveryStatus: normalizeRecoveryStatus(row.recovery_status ?? undefined) ?? undefined,
    recoveryReason: normalizeRecoveryReason(row.recovery_reason ?? undefined) ?? undefined,
    lastReconciledAt: row.last_reconciled_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function normalizeRecoveryStatus(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return Object.values(RECOVERY_STATUS).some((status) => status === value) ? value : null;
}

function normalizeRecoveryReason(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return Object.values(RECOVERY_REASON).some((reason) => reason === value) ? value : null;
}

function mapActiveTaskRow(row: ActiveTaskRow): ActiveTask {
  return {
    taskId: row.task_id,
    chatId: row.chat_id,
    sessionId: row.session_id,
    status: row.status,
    command: row.command,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPendingPromptRow(row: PendingPromptRow): PendingPrompt {
  return {
    promptId: row.prompt_id,
    sessionId: row.session_id,
    chatId: row.chat_id,
    projectId: row.project_id,
    promptType: row.prompt_type,
    message: row.message,
    options: parsePendingPromptOptions(row.options_json),
    status: row.status,
    expiresAt: row.expires_at ?? undefined,
    telegramChatId: row.telegram_chat_id ?? undefined,
    telegramMessageId: row.telegram_message_id ?? undefined,
    telegramCallbackQueryId: row.telegram_callback_query_id ?? undefined,
    submittedInput: row.submitted_input ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePendingPromptOptions(raw: string | null): readonly string[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return undefined;
    }

    const options = value.filter((entry): entry is string => typeof entry === "string");
    return options.length > 0 ? options : undefined;
  } catch {
    return undefined;
  }
}

function extractSqliteChanges(result: unknown): number {
  if (!result || typeof result !== "object") {
    return 0;
  }

  const candidate = result as { changes?: unknown };
  return typeof candidate.changes === "number" ? candidate.changes : 0;
}

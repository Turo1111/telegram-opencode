import { promises as fs } from "node:fs";
import path from "node:path";
import { OpenCodeCliExport, OPEN_CODE_CLI_ROLE, OpenCodeCliMessage } from "./opencode-cli";

interface SqliteStatement<Row = unknown> {
  all(params?: Record<string, unknown>): Row[];
}

interface SqliteDatabase {
  prepare<Row = unknown>(sql: string): SqliteStatement<Row>;
  close?(): void;
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

interface LocalSessionRow {
  readonly message_id: string;
  readonly message_time_created: number;
  readonly message_data: string;
  readonly part_id: string | null;
  readonly part_time_created: number | null;
  readonly part_data: string | null;
}

interface LocalMessageData {
  readonly role?: string;
  readonly time?: {
    readonly created?: number;
    readonly completed?: number;
  };
}

interface LocalPartData {
  readonly type?: string;
  readonly text?: string;
  readonly synthetic?: boolean;
}

interface PendingLocalMessage {
  readonly id: string;
  readonly createdAt?: string;
  readonly parts: string[];
}

const REDACTED_TEXT_PATTERN = /^\[redacted:text:[^\]]+\]$/iu;

export async function readOpenCodeLocalSessionMessages(input: {
  readonly sessionId: string;
  readonly dbPath?: string;
}): Promise<OpenCodeCliExport> {
  const dbPath = path.resolve(input.dbPath ?? resolveOpenCodeLocalDbPath());
  await fs.access(dbPath);

  const DatabaseCtor = await resolveDatabaseCtor();
  const db = new DatabaseCtor(dbPath);

  try {
    const rows = db
      .prepare<LocalSessionRow>(
        `SELECT m.id AS message_id,
                m.time_created AS message_time_created,
                m.data AS message_data,
                p.id AS part_id,
                p.time_created AS part_time_created,
                p.data AS part_data
           FROM message m
           LEFT JOIN part p ON p.message_id = m.id
          WHERE m.session_id = :sessionId
          ORDER BY m.time_created ASC, p.time_created ASC, p.id ASC`
      )
      .all({ sessionId: input.sessionId });

    return {
      sessionId: input.sessionId,
      messages: collectAssistantMessages(rows),
    };
  } finally {
    db.close?.();
  }
}

export function resolveOpenCodeLocalDbPath(): string {
  const override = process.env.OPEN_CODE_LOCAL_DB_PATH?.trim();
  if (override) {
    return override;
  }

  const dataHome = process.env.XDG_DATA_HOME?.trim();
  if (dataHome) {
    return path.join(dataHome, "opencode", "opencode.db");
  }

  const home = process.env.HOME?.trim();
  if (!home) {
    throw new Error("Cannot resolve OpenCode local SQLite path: HOME is undefined");
  }

  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

function collectAssistantMessages(rows: readonly LocalSessionRow[]): readonly OpenCodeCliMessage[] {
  const messages: OpenCodeCliMessage[] = [];
  let current: PendingLocalMessage | undefined;

  for (const row of rows) {
    const messageData = parseJson<LocalMessageData>(row.message_data);
    if (normalizeRole(messageData?.role) !== OPEN_CODE_CLI_ROLE.ASSISTANT) {
      continue;
    }

    if (!current || current.id !== row.message_id) {
      if (current) {
        pushCompletedMessage(messages, current);
      }

      current = {
        id: row.message_id,
        createdAt:
          readTimestamp(messageData?.time?.created) ??
          readTimestamp(messageData?.time?.completed) ??
          readTimestamp(row.message_time_created),
        parts: [],
      };
    }

    const partText = extractMeaningfulPartText(row.part_data);
    if (partText) {
      current.parts.push(partText);
    }
  }

  if (current) {
    pushCompletedMessage(messages, current);
  }

  return messages;
}

function pushCompletedMessage(target: OpenCodeCliMessage[], message: PendingLocalMessage): void {
  const text = message.parts.join("\n\n").trim();
  if (!text) {
    return;
  }

  target.push({
    id: message.id,
    role: OPEN_CODE_CLI_ROLE.ASSISTANT,
    text,
    createdAt: message.createdAt,
  });
}

function extractMeaningfulPartText(rawPartData: string | null): string | undefined {
  if (!rawPartData) {
    return undefined;
  }

  const partData = parseJson<LocalPartData>(rawPartData);
  if (partData?.type !== "text" || partData.synthetic) {
    return undefined;
  }

  const text = typeof partData.text === "string" ? partData.text.trim() : "";
  if (!text || REDACTED_TEXT_PATTERN.test(text)) {
    return undefined;
  }

  return text;
}

async function resolveDatabaseCtor(): Promise<new (filePath: string) => SqliteDatabase> {
  const moduleName = "node:sqlite";
  const sqliteModule = (await import(moduleName)) as SqliteModuleShape;
  const ctor = sqliteModule.DatabaseSync ?? sqliteModule.default?.DatabaseSync ?? sqliteModule.sqlite3?.DatabaseSync;

  if (!ctor) {
    throw new Error("SQLite DatabaseSync constructor not found");
  }

  return ctor;
}

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeRole(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.trim().toLowerCase();
}

function readTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return new Date(value).toISOString();
}

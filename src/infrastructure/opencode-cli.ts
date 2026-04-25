import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const OPEN_CODE_CLI_ROLE = {
  ASSISTANT: "assistant",
  USER: "user",
} as const;

export type OpenCodeCliRole = (typeof OPEN_CODE_CLI_ROLE)[keyof typeof OPEN_CODE_CLI_ROLE];

export interface OpenCodeCliSessionListItem {
  readonly id: string;
  readonly path?: string;
  readonly title?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface OpenCodeCliMessage {
  readonly id: string;
  readonly role: OpenCodeCliRole;
  readonly text: string;
  readonly createdAt?: string;
}

export interface OpenCodeCliExport {
  readonly sessionId: string;
  readonly messages: readonly OpenCodeCliMessage[];
}

export interface OpenCodeCliCommandInput {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export interface OpenCodeCliCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class OpenCodeCliError extends Error {
  readonly kind: "not-installed" | "timeout" | "non-zero" | "invalid-json";
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    kind: OpenCodeCliError["kind"],
    message: string,
    details?: Readonly<Record<string, unknown>>
  ) {
    super(message);
    this.name = "OpenCodeCliError";
    this.kind = kind;
    this.details = details;
  }
}

export async function resolveCanonicalProjectPath(rootPath: string): Promise<string> {
  const absolutePath = path.resolve(rootPath);
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch {
    throw new OpenCodeCliError(
      "non-zero",
      `No existe el directorio: ${absolutePath}. Indicá una ruta local/WSL válida con /project <path_local>.`,
      {
        rootPath,
        absolutePath,
      }
    );
  }

  if (!stat.isDirectory()) {
    throw new OpenCodeCliError(
      "non-zero",
      `El path no es un directorio: ${absolutePath}. Indicá una ruta local/WSL válida con /project <path_local>.`,
      {
        rootPath,
        absolutePath,
      }
    );
  }

  return fs.realpath(absolutePath);
}

export async function listSessions(timeoutMs: number): Promise<readonly OpenCodeCliSessionListItem[]> {
  const result = await runOpenCodeCli({
    args: ["session", "list", "--format", "json"],
    timeoutMs,
  });

   return parseOpenCodeCliSessionList(result.stdout);
}

export async function runSessionMessage(input: {
  readonly sessionId: string;
  readonly dir: string;
  readonly message: string;
  readonly timeoutMs: number;
}): Promise<{ readonly replyText: string }> {
  const result = await runOpenCodeCli({
    args: buildRunSessionArgs(input),
    timeoutMs: input.timeoutMs,
  });

   const replyText = extractOpenCodeCliAssistantReply(result.stdout);
   return { replyText };
}

export async function startSessionMessage(input: {
  readonly sessionId: string;
  readonly dir: string;
  readonly message: string;
}): Promise<void> {
  await spawnOpenCodeCli({
    args: buildRunSessionArgs(input),
    cwd: input.dir,
  });
}

export async function exportSession(input: {
  readonly sessionId: string;
  readonly timeoutMs: number;
}): Promise<OpenCodeCliExport> {
  let result: OpenCodeCliCommandResult;

  try {
    result = await runOpenCodeCli({
      args: ["export", "--sanitize", input.sessionId],
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    if (!shouldFallbackFromSanitizedExport(error)) {
      throw error;
    }

    result = await runOpenCodeCli({
      args: ["export", input.sessionId],
      timeoutMs: input.timeoutMs,
    });
  }

   return parseOpenCodeCliExport(input.sessionId, result.stdout);
}

function shouldFallbackFromSanitizedExport(error: unknown): boolean {
  if (!(error instanceof OpenCodeCliError) || error.kind !== "non-zero") {
    return false;
  }

  const stderr = typeof error.details?.stderr === "string" ? error.details.stderr.toLowerCase() : "";
  const stdout = typeof error.details?.stdout === "string" ? error.details.stdout.toLowerCase() : "";
  const output = `${stderr}\n${stdout}`;
  return output.includes("unknown option") || output.includes("unexpected argument") || output.includes("--sanitize");
}

export function parseOpenCodeCliSessionList(raw: string): readonly OpenCodeCliSessionListItem[] {
  const parsed = parseJson(raw, "session list");
  const rawItems = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items
      : [];

  const items: OpenCodeCliSessionListItem[] = [];

  for (const item of rawItems) {
    if (!isRecord(item)) {
      continue;
    }

    const id = readString(item.id) ?? readString(item.sessionId) ?? readString(item.session_id);
    if (!id) {
      continue;
    }

    items.push({
      id,
      path: readString(item.path) ?? readString(item.dir) ?? readString(item.directory),
      title: readString(item.title) ?? readString(item.name),
      model: readString(item.model),
      createdAt:
        readTimestamp(item.createdAt) ??
        readTimestamp(item.created_at) ??
        readTimestamp(item.created),
      updatedAt:
        readTimestamp(item.updatedAt) ??
        readTimestamp(item.updated_at) ??
        readTimestamp(item.updated),
    });
  }

  return items;
}

export function parseOpenCodeCliExport(sessionId: string, raw: string): OpenCodeCliExport {
   const parsed = parseJson(raw, "export");

   return {
     sessionId,
     messages: extractMessages(parsed),
   };
}

export function extractOpenCodeCliAssistantReply(raw: string): string {
   const parsed = parseJson(raw, "run");
   return extractAssistantText(parsed) ?? "";
}

async function runOpenCodeCli(input: OpenCodeCliCommandInput): Promise<OpenCodeCliCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);

      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new OpenCodeCliError(
            "not-installed",
            "No se encontró el binario 'opencode' en PATH. Instalalo y ejecutalo desde PC/WSL.",
            {
              args: input.args,
            }
          )
        );
        return;
      }

      reject(
        new OpenCodeCliError("non-zero", `Error ejecutando opencode: ${error.message}`, {
          args: input.args,
          code,
        })
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (timedOut) {
        reject(
          new OpenCodeCliError("timeout", "OpenCode CLI no respondió a tiempo", {
            args: input.args,
            timeoutMs: input.timeoutMs,
          })
        );
        return;
      }

      if (code !== 0) {
        reject(
          new OpenCodeCliError("non-zero", "OpenCode CLI devolvió código no cero", {
            args: input.args,
            code,
            signal,
            stderr,
            stdout,
          })
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function parseJson(raw: string, operation: string): unknown {
  const normalizedRaw = normalizeJsonPayload(raw);

  if (!normalizedRaw.trim()) {
    return {};
  }

  try {
    return JSON.parse(normalizedRaw);
  } catch (error) {
    throw new OpenCodeCliError("invalid-json", `OpenCode CLI devolvió JSON inválido en ${operation}`, {
      operation,
      raw: normalizedRaw,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }

  const lines = trimmed.split(/\r?\n/u);
  const firstJsonLine = lines.findIndex((line) => {
    const normalizedLine = line.trimStart();
    return normalizedLine.startsWith("{") || normalizedLine.startsWith("[");
  });

  if (firstJsonLine < 0) {
    return trimmed;
  }

  return lines.slice(firstJsonLine).join("\n").trim();
}

function buildRunSessionArgs(input: {
  readonly sessionId: string;
  readonly dir: string;
  readonly message: string;
}): readonly string[] {
  return ["run", "--format", "json", "--session", input.sessionId, "--dir", input.dir, input.message];
}

async function spawnOpenCodeCli(input: {
  readonly args: readonly string[];
  readonly cwd?: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("opencode", input.args, {
      cwd: input.cwd,
      stdio: "ignore",
      env: process.env,
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });

    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new OpenCodeCliError(
            "not-installed",
            "No se encontró el binario 'opencode' en PATH. Instalalo y ejecutalo desde PC/WSL.",
            {
              args: input.args,
            }
          )
        );
        return;
      }

      reject(
        new OpenCodeCliError("non-zero", `Error ejecutando opencode: ${error.message}`, {
          args: input.args,
          code,
        })
      );
    });
  });
}

function extractAssistantText(value: unknown): string | undefined {
  const messages = extractMessages(value);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === OPEN_CODE_CLI_ROLE.ASSISTANT && message.text.trim()) {
      return message.text;
    }
  }

  if (isRecord(value)) {
    return readString(value.output) ?? readString(value.answer) ?? readString(value.message);
  }

  return undefined;
}

function extractMessages(value: unknown): readonly OpenCodeCliMessage[] {
  const rawMessages = collectCandidateMessages(value);
  const messages: OpenCodeCliMessage[] = [];

  for (const raw of rawMessages) {
    if (!isRecord(raw)) {
      continue;
    }

    const info = isRecord(raw.info) ? raw.info : undefined;
    const infoTime = info && isRecord(info.time) ? info.time : undefined;

    const role = normalizeRole(raw.role) ?? normalizeRole(info?.role);
    if (!role) {
      continue;
    }

    const text =
      readString(raw.text) ??
      readString(raw.message) ??
      readString(raw.content) ??
      readNestedText(raw.content) ??
      readPartsText(raw.parts);
    if (!text) {
      continue;
    }

    const id =
      readString(raw.id) ??
      readString(raw.messageId) ??
      readString(info?.id) ??
      buildSyntheticMessageId(role, text, messages.length);

    messages.push({
      id,
      role,
      text,
      createdAt:
        readTimestamp(raw.createdAt) ??
        readTimestamp(raw.created_at) ??
        readTimestamp(infoTime?.created) ??
        readTimestamp(infoTime?.completed),
    });
  }

  return messages;
}

function buildSyntheticMessageId(role: OpenCodeCliRole, text: string, index: number): string {
  return `${role}-${stableTextFingerprint(text)}-${index.toString()}`;
}

function stableTextFingerprint(text: string): string {
  let hash = 0;

  for (const char of text) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16);
}

function collectCandidateMessages(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  if (Array.isArray(value.messages)) {
    return value.messages;
  }

  if (Array.isArray(value.items)) {
    return value.items;
  }

  if (isRecord(value.session) && Array.isArray(value.session.messages)) {
    return value.session.messages;
  }

  return [];
}

function readNestedText(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts = value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => readString(entry.text))
    .filter((entry): entry is string => Boolean(entry));

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n");
}

function readPartsText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts = value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => readString(entry.text) ?? readNestedText(entry.content))
    .filter((entry): entry is string => Boolean(entry));

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join("\n\n");
}

function normalizeRole(value: unknown): OpenCodeCliRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === OPEN_CODE_CLI_ROLE.ASSISTANT) {
    return OPEN_CODE_CLI_ROLE.ASSISTANT;
  }

  if (normalized === OPEN_CODE_CLI_ROLE.USER || normalized === "human") {
    return OPEN_CODE_CLI_ROLE.USER;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function readTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return readString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

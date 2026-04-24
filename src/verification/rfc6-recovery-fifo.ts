import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { bootRecover, createApplicationUseCases } from "../application/use-cases";
import { OpenCodeSessionAdapter, Result, SendResult, SessionState } from "../application/contracts";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { Config, STATE_DRIVERS } from "../config";
import { createTelegramRouter } from "../adapters/telegram/router";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { createChatLockManager } from "../application/chat-lock-manager";

class FakeBot {
  readonly messages: Array<{ readonly chatId: number; readonly text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

class FakeRecoveryFifoAdapter implements OpenCodeSessionAdapter {
  private readonly sessions = new Map<string, SessionState>();

  seedSession(session: SessionState): void {
    this.sessions.set(session.sessionId, { ...session });
  }

  resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return Promise.resolve({ ok: true, value: { canonicalPath: input.rootPath } });
  }

  createSession(input: { projectId: string; rootPath: string; source: "telegram" }): Promise<Result<SessionState>> {
    const created: SessionState = {
      projectId: input.projectId,
      sessionId: `sess-${Date.now().toString(36)}`,
      status: "idle",
    };
    this.seedSession(created);
    return Promise.resolve({ ok: true, value: created });
  }

  attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.NOT_FOUND, "session missing") });
    }
    if (session.projectId !== input.projectId) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "project mismatch") });
    }
    return Promise.resolve({ ok: true, value: { ...session } });
  }

  sendMessage(): Promise<Result<SendResult>> {
    return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "not used") });
  }

  runCommand(): Promise<Result<SendResult>> {
    return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "not used") });
  }

  getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.NOT_FOUND, "session missing") });
    }
    return Promise.resolve({ ok: true, value: { ...session } });
  }

  cancelOrInterrupt(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<{ status: "cancelled" | "accepted" | "not-available-yet"; message?: string }>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.NOT_FOUND, "session missing") });
    }

    this.sessions.set(input.sessionId, {
      ...session,
      status: "idle",
      taskId: undefined,
    });

    return Promise.resolve({ ok: true, value: { status: "accepted", message: "cancel accepted" } });
  }

  observeSession(): Promise<Result<{ mode: "not-available-yet" }>> {
    return Promise.resolve({ ok: true, value: { mode: "not-available-yet" } });
  }

  submitPromptInput(_input: {
    projectId: string;
    sessionId: string;
    promptId: string;
    input: string;
    source: "telegram" | "pc";
  }): Promise<Result<{ status: "accepted"; message?: string }>> {
    return Promise.resolve({ ok: true, value: { status: "accepted" } });
  }
}

function createMessage(chatId: string, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(chatId),
      type: "private",
    },
    text,
  } as TelegramBot.Message;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc6-recovery-fifo-"));
  const adapter = new FakeRecoveryFifoAdapter();
  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["9100"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath: path.join(tempDir, "state.json"),
    compatLegacyTextBridge: false,
    compatRunCmdCommands: true,
    bootRemoteReconcile: true,
    chatLockEnabled: true,
    lockWarnWaitMs: 1500,
    watcherEnabled: false,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4045,
    watchdogIntervalMs: 15000,
    watchdogStaleAfterMs: 60000,
    watchdogMaxRetryCount: 3,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300000,
  };

  try {
    const persistence = await createJsonPersistenceDriver(config);
    const nowIso = "2026-01-01T00:00:00.000Z";

    await persistence.runInTransaction(async (unit) => {
      await unit.projects.upsert({
        projectId: "proj-rfc6",
        alias: "proj-rfc6",
        rootPath: "/tmp/proj-rfc6",
        createdAt: nowIso,
        lastUsedAt: nowIso,
      });
      await unit.sessions.upsert({
        projectId: "proj-rfc6",
        sessionId: "sess-rfc6",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      await unit.bindings.upsert({
        chatId: "9100",
        activeProjectId: "proj-rfc6",
        activeSessionId: "sess-rfc6",
        updatedAt: nowIso,
      });
      await unit.states.upsert({
        chatId: "9100",
        mode: "task-running",
        activeTaskId: "task-rfc6",
        updatedAt: nowIso,
      });
      await unit.tasks.upsert({
        taskId: "task-rfc6",
        chatId: "9100",
        sessionId: "sess-rfc6",
        command: "npm run dev",
        status: "in-progress",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    });

    adapter.seedSession({
      projectId: "proj-rfc6",
      sessionId: "sess-rfc6",
      status: "running",
      taskId: "task-rfc6",
    });

    await bootRecover(persistence, {
      adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T00:00:10.000Z",
    });

    const useCases = createApplicationUseCases({
      persistence,
      adapter,
    });

    const bot = new FakeBot();
    const router = createTelegramRouter({
      bot: bot as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });
    const lockManager = createChatLockManager();

    const pending = ["/status", "/project", "/project alpha", "/new", "/cancel"] as const;
    await Promise.all(
      pending.map((text) =>
        lockManager.runExclusive("9100", async () => {
          await router.handleMessage(createMessage("9100", text));
        })
      )
    );

    const outputs = bot.messages.map((entry) => entry.text);
    assert(outputs.length === pending.length, `cantidad de respuestas inesperada: ${outputs.length}`);
    assert(outputs[0]?.includes("Estado actual"), "1er pendiente debería ser /status");
    assert(outputs[1]?.includes("Proyecto actual"), "2do pendiente debería ser /project query");
    assert(outputs[2]?.includes("Comando bloqueado por tarea en curso"), "3er pendiente debería bloquear /project alpha");
    assert(outputs[3]?.includes("Comando bloqueado por tarea en curso"), "4to pendiente debería bloquear /new");
    assert(
      outputs[4]?.includes("Cancelación solicitada") || outputs[4]?.includes("No hay tarea activa para cancelar"),
      "5to pendiente debería resolver /cancel"
    );

    // eslint-disable-next-line no-console
    console.log("RFC-006 Recovery FIFO Verification");
    // eslint-disable-next-line no-console
    console.log("PASS - pendientes post-restart procesados FIFO y con misma matriz busy");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("No pude ejecutar verificación recovery FIFO RFC6", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

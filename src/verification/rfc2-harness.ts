import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { createApplicationUseCases, bootRecover } from "../application/use-cases";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { OpenCodeSessionAdapter, Result, SendResult, SessionState } from "../application/contracts";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { formatStatus } from "../adapters/telegram/templates";
import { createTelegramRouter } from "../adapters/telegram/router";
import { handleMessage } from "../handlers";
import { Config, STATE_DRIVERS } from "../config";
import { HttpOpenCodeSessionAdapter } from "../infrastructure/opencode-session-adapter";
import { createOpenCodeHttpClient } from "../opencode";
import { ADAPTER_ERROR_CODES } from "../application/contracts";

interface ScenarioResult {
  id: string;
  title: string;
  ok: boolean;
  details: string;
}

interface LocalRuntime {
  tempDir: string;
  dataFile: string;
  config: Config;
  adapter: FakeSessionAdapter;
}

const SCN_LOM_FIXTURES = {
  UNSUPPORTED: { expectedStatus: 501, expectedCode: "UNSUPPORTED" },
  TIMEOUT: { expectedStatus: 504, expectedCode: "TIMEOUT" },
  UNAVAILABLE: { expectedStatus: 503, expectedCode: "UNAVAILABLE" },
} as const;

type ScnLomFixture = keyof typeof SCN_LOM_FIXTURES;

interface ScnLomResponseSnapshot {
  readonly fixture: ScnLomFixture;
  readonly run: 1 | 2;
  readonly status: number;
  readonly code: string;
}

class FakeBot {
  public readonly messages: Array<{ chatId: number; text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

class FakeSessionAdapter implements OpenCodeSessionAdapter {
  private sessions = new Map<string, { projectId: string; status: SessionState["status"]; taskId?: string }>();
  private counter = 0;
  private taskCounter = 0;

  public sendMessageHits = 0;
  public runCommandHits = 0;

  resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return Promise.resolve({
      ok: true,
      value: {
        canonicalPath: input.rootPath.replace(/\\/gu, "/"),
      },
    });
  }

  createSession(input: { projectId: string; rootPath: string; source: "telegram" }): Promise<Result<SessionState>> {
    const sessionId = `sess-${++this.counter}`;
    this.sessions.set(sessionId, {
      projectId: input.projectId,
      status: "idle",
    });

    return Promise.resolve({
      ok: true,
      value: {
        sessionId,
        projectId: input.projectId,
        status: "idle",
      },
    });
  }

  attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const found = this.sessions.get(input.sessionId);
    if (!found) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.NOT_FOUND, "Sesión no encontrada"),
      });
    }

    if (found.projectId !== input.projectId) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "La sesión no coincide con el proyecto activo"),
      });
    }

    return Promise.resolve({
      ok: true,
      value: {
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: found.status,
        taskId: found.taskId,
      },
    });
  }

  sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    this.sendMessageHits += 1;
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.NOT_FOUND, "Sesión no encontrada") });
    }

    if (session.projectId !== input.projectId) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "La sesión no coincide con el proyecto activo"),
      });
    }

    if (input.message.includes("#running")) {
      const taskId = `task-${++this.taskCounter}`;
      session.status = "running";
      session.taskId = taskId;
      return Promise.resolve({
        ok: true,
        value: {
          taskId,
          reply: `ACK: ${input.message}`,
          message: `ACK: ${input.message}`,
          state: {
            sessionId: input.sessionId,
            projectId: input.projectId,
            status: session.status,
            taskId: session.taskId,
          },
          status: session.status,
          needsAttention: false,
        },
      });
    }

    session.status = "idle";
    session.taskId = undefined;
    return Promise.resolve({
      ok: true,
      value: {
        reply: `ACK: ${input.message}`,
        message: `ACK: ${input.message}`,
        state: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: session.status,
        },
        status: session.status,
        needsAttention: false,
      },
    });
  }

  runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    this.runCommandHits += 1;

    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({ ok: false, error: new DomainError(ERROR_CODES.NOT_FOUND, "Sesión no encontrada") });
    }

    if (session.projectId !== input.projectId) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "La sesión no coincide con el proyecto activo"),
      });
    }

    if (input.command.includes("#unknown")) {
      session.status = "unknown";
      session.taskId = undefined;
      return Promise.resolve({
        ok: true,
        value: {
          ack: `CMD: ${input.command}`,
          message: `CMD: ${input.command}`,
          state: {
            sessionId: input.sessionId,
            projectId: input.projectId,
            status: session.status,
          },
          needsAttention: false,
          status: "unknown",
        },
      });
    }

    if (input.command.includes("#completed")) {
      session.status = "completed";
      session.taskId = undefined;
      return Promise.resolve({
        ok: true,
        value: {
          ack: `CMD: ${input.command}`,
          message: `CMD: ${input.command}`,
          state: {
            sessionId: input.sessionId,
            projectId: input.projectId,
            status: session.status,
          },
          needsAttention: false,
          status: "completed",
        },
      });
    }

    return this.sendMessage({
      projectId: input.projectId,
      sessionId: input.sessionId,
      message: input.command,
      chatId: input.chatId,
    }).then((result) => {
      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        value: {
          ...result.value,
          ack: result.value.message,
        },
      };
    });
  }

  cancelOrInterrupt(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<{ status: "not-available-yet" }>> {
    return Promise.resolve({
      ok: false,
      error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "Operación no soportada", {
        details: {
          adapterCode: ADAPTER_ERROR_CODES.UNSUPPORTED,
          retryable: false,
        },
      }),
    });
  }

  observeSession(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<{ mode: "not-available-yet" }>> {
    return Promise.resolve({
      ok: true,
      value: {
        mode: "not-available-yet",
      },
    });
  }

  submitPromptInput(_input: {
    projectId: string;
    sessionId: string;
    promptId: string;
    input: string;
    source: "telegram" | "pc";
  }): Promise<Result<{ status: "accepted"; message?: string }>> {
    return Promise.resolve({
      ok: true,
      value: {
        status: "accepted",
      },
    });
  }

  getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.NOT_FOUND, "Sesión no encontrada"),
      });
    }

    if (session.projectId !== input.projectId) {
      return Promise.resolve({
        ok: false,
        error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "La sesión no coincide con el proyecto activo"),
      });
    }

    return Promise.resolve({
      ok: true,
      value: {
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: session.status,
        taskId: session.taskId,
      },
    });
  }

  seedSession(sessionId: string, projectId: string, status: SessionState["status"] = "idle"): void {
    this.sessions.set(sessionId, { projectId, status });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function unwrapOk<T>(result: Result<T>, message: string): T {
  if (!result.ok) {
    throw new Error(`${message}: ${result.error.code} ${result.error.message}`);
  }

  return result.value;
}

function createMessage(chatId: string, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    from: {
      id: Number(chatId),
      is_bot: false,
      first_name: "RFC2 Harness",
    },
    chat: {
      id: Number(chatId),
      type: "private",
    },
    text,
  } as TelegramBot.Message;
}

async function withLocalRuntime(run: (runtime: LocalRuntime) => Promise<string>): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc2-harness-"));
  const dataFile = path.join(tempDir, "state.json");
  const adapter = new FakeSessionAdapter();
  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "unused.sqlite"),
    stateJsonPath: dataFile,
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
    return await run({ tempDir, dataFile, config, adapter });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}


async function scenarioR1S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({
      chatId: "1001",
      selector: "demo-r1",
      rootPath: "/tmp/demo-r1",
    });

    assert(selected.ok, "selectProject debe ser exitoso");
    const status = await useCases.getStatus("1001");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");
    assert(statusValue.projectId === "demo-r1", "activeProjectId incorrecto");
    assert(!statusValue.sessionId, "activeSessionId debe limpiarse al seleccionar proyecto");

    return "selectProject setea activeProjectId y limpia session";
  });
}

async function scenarioR1S2(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({
      chatId: "1002",
      selector: "demo-r1s2",
      rootPath: "/tmp/secret-root",
    });
    assert(selected.ok, "selectProject debe ser exitoso");

    const status = await useCases.getStatus("1002");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");

    const rendered = formatStatus(statusValue);
    assert(!rendered.includes("/tmp/secret-root"), "status no debe filtrar rootPath");

    return "status enmascara rootPath y muestra solo IDs/alias";
  });
}

async function scenarioR2S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    adapter.seedSession("sess-existing", "proj-r2", "idle");
    const selected = await useCases.selectProject({ chatId: "1003", selector: "proj-r2", rootPath: "/tmp/proj-r2" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const attached = await useCases.attachSession({ chatId: "1003", sessionId: "sess-existing" });
    assert(attached.ok, "attachSession debe ser exitoso");

    const status = await useCases.getStatus("1003");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");
    assert(statusValue.mode === "session-linked", "mode esperado: session-linked");
    assert(statusValue.sessionId === "sess-existing", "sessionId no persistido");

    return "attachSession persiste binding y mode=session-linked";
  });
}

async function scenarioR2S2(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const created = await useCases.createSession({ chatId: "1004" });
    assert(!created.ok, "createSession sin proyecto debe fallar");
    if (!created.ok) {
      assert(created.error.code === ERROR_CODES.VALIDATION_ERROR, "error code esperado: VALIDATION_ERROR");
    }

    const status = await useCases.getStatus("1004");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");
    assert(statusValue.mode === "idle", "sin proyecto debería permanecer en idle");
    assert(!statusValue.sessionId, "no debe persistir sesión");

    return "precondición bloquea /new sin proyecto y no altera estado";
  });
}

async function scenarioR3S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1005", selector: "proj-r3", rootPath: "/tmp/proj-r3" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const created = await useCases.createSession({ chatId: "1005" });
    assert(created.ok, "createSession debe ser exitoso");

    const first = await useCases.sendText({ chatId: "1005", text: "orden #running" });
    const firstValue = unwrapOk(first, "primer sendText debe ser exitoso");
    assert(Boolean(firstValue.taskId), "primer sendText debe crear taskId");
    const hitsAfterFirst = adapter.sendMessageHits;

    const second = await useCases.sendText({ chatId: "1005", text: "segunda orden" });
    assert(!second.ok, "segunda orden debe ser bloqueada por guard");
    if (!second.ok) {
      assert(second.error.code === ERROR_CODES.CONFLICT_ACTIVE_TASK, "error code esperado: CONFLICT_ACTIVE_TASK");
    }
    assert(adapter.sendMessageHits === hitsAfterFirst, "guard debe bloquear antes de invocar OpenCode");

    return "active-task guard bloquea segunda orden y evita llamada upstream";
  });
}

async function scenarioR4S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1006", selector: "proj-r4", rootPath: "/tmp/proj-r4" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const created = await useCases.createSession({ chatId: "1006" });
    assert(created.ok, "createSession debe ser exitoso");

    const recovered = await bootRecover(persistence, {
      nowIso: "2026-01-01T00:00:00.000Z",
    });
    assert(recovered.chatsInError === 0, "rehydration consistente no debe marcar error");

    const afterRestart = createApplicationUseCases({ persistence, adapter });
    const status = await afterRestart.getStatus("1006");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");
    assert(statusValue.mode === "session-linked", "rehydration exitosa debe mantener continuidad");
    assert(Boolean(statusValue.projectId) && Boolean(statusValue.sessionId), "debe conservar project y session");

    return "bootRecover rehidrata estado consistente sin interacción adicional";
  });
}

async function scenarioR4S2(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const now = "2026-01-01T00:00:00.000Z";
    await persistence.runInTransaction(async (unit) => {
      await unit.projects.upsert({
        projectId: "proj-a",
        alias: "proj-a",
        rootPath: "/tmp/proj-a",
        createdAt: now,
      });
      await unit.projects.upsert({
        projectId: "proj-b",
        alias: "proj-b",
        rootPath: "/tmp/proj-b",
        createdAt: now,
      });
      await unit.sessions.upsert({
        sessionId: "sess-b",
        projectId: "proj-b",
        createdAt: now,
        updatedAt: now,
      });
      await unit.bindings.upsert({
        chatId: "1007",
        activeProjectId: "proj-a",
        activeSessionId: "sess-b",
        updatedAt: now,
      });
      await unit.states.upsert({
        chatId: "1007",
        mode: "session-linked",
        updatedAt: now,
      });
    });

    const recovered = await bootRecover(persistence, {
      nowIso: "2026-01-01T00:01:00.000Z",
    });
    assert(recovered.chatsInError === 1, "debe marcar chat inconsistente en error");

    const status = await useCases.getStatus("1007");
    const statusValue = unwrapOk(status, "getStatus debe ser exitoso");
    assert(statusValue.mode === "error", "mode esperado: error");
    assert(statusValue.lastErrorCode === ERROR_CODES.INCONSISTENT_BINDING, "error esperado: INCONSISTENT_BINDING");
    assert(!statusValue.sessionId, "activeSessionId debe limpiarse en cleanup seguro");

    return "bootRecover inconsistente setea mode=error y limpia activeSessionId";
  });
}

async function scenarioR5S1(): Promise<string> {
  const token = "token-r5";
  let requestHits = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/opencode/sessions/message") {
      requestHits += 1;
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            projectId: "proj-r5",
            sessionId: "sess-r5",
            status: "idle",
            message: "late",
          })
        );
      }, 220);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server de timeout");
  }

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
    openCodeToken: token,
    openCodeTimeoutMs: 50,
    openCodeControlTimeoutMs: 50,
    openCodeExecTimeoutMs: 50,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "/tmp/unused.sqlite",
    stateJsonPath: "/tmp/unused.json",
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
    const client = createOpenCodeHttpClient(config);
    const adapter = new HttpOpenCodeSessionAdapter(client);

    const response = await adapter.sendMessage({
      projectId: "proj-r5",
      sessionId: "sess-r5",
      message: "timeout please",
      chatId: "1008",
    });

    assert(!response.ok, "timeout doble debe devolver error normalizado");
    if (!response.ok) {
      assert(response.error.code === ERROR_CODES.UPSTREAM_TIMEOUT, "error esperado: UPSTREAM_TIMEOUT");
    }
    assert(requestHits === 2, "debe ejecutar un único retry corto (2 hits totales)");

    return "timeout usa retry corto único y mapea UPSTREAM_TIMEOUT";
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR5S2(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    adapter.seedSession("sess-good", "proj-good", "idle");
    adapter.seedSession("sess-other", "proj-other", "idle");

    const selected = await useCases.selectProject({
      chatId: "1009",
      selector: "proj-good",
      rootPath: "/tmp/proj-good",
    });
    assert(selected.ok, "selectProject debe ser exitoso");

    const attachedGood = await useCases.attachSession({ chatId: "1009", sessionId: "sess-good" });
    assert(attachedGood.ok, "attachSession inicial debe ser exitoso");

    const before = await useCases.getStatus("1009");
    const beforeValue = unwrapOk(before, "getStatus previo debe ser exitoso");

    const mismatch = await useCases.attachSession({ chatId: "1009", sessionId: "sess-other" });
    assert(!mismatch.ok, "attachSession mismatch debe fallar");
    if (!mismatch.ok) {
      assert(mismatch.error.code === ERROR_CODES.VALIDATION_ERROR, "error esperado: VALIDATION_ERROR");
    }

    const after = await useCases.getStatus("1009");
    const afterValue = unwrapOk(after, "getStatus posterior debe ser exitoso");
    assert(afterValue.sessionId === beforeValue.sessionId, "binding no debe corromperse tras mismatch");

    return "mismatch sesión/proyecto falla sin corromper binding activo";
  });
}

async function scenarioR6S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1010", selector: "proj-r6", rootPath: "/tmp/proj-r6" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const created = await useCases.createSession({ chatId: "1010" });
    assert(created.ok, "createSession debe ser exitoso");

    const fakeBot = new FakeBot();
    const router = createTelegramRouter({
      bot: fakeBot as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });

    await router.handleMessage(createMessage("1010", "/status"));
    assert(fakeBot.messages.length === 1, "router debe responder /status");
    const output = fakeBot.messages[0]?.text ?? "";
    assert(output.includes("Modo:"), "status debe incluir modo");
    assert(output.includes("Proyecto:"), "status debe incluir proyecto");
    assert(output.includes("Sesión:"), "status debe incluir sesión");

    return "/status devuelve resumen completo en español";
  });
}

async function scenarioR6S2(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const fakeBot = new FakeBot();
    const router = createTelegramRouter({
      bot: fakeBot as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });

    await router.handleMessage(createMessage("1011", "texto libre"));
    assert(fakeBot.messages.length === 1, "debe responder guía en idle");
    assert(fakeBot.messages[0]?.text.includes("Primero elegí proyecto y sesión"), "guía esperada no encontrada");
    assert(adapter.sendMessageHits === 0, "en idle no debe invocar sendText/openCode");

    const now = "2026-01-01T00:00:00.000Z";
    await persistence.runInTransaction(async (unit) => {
      await unit.projects.upsert({
        projectId: "proj-gate",
        alias: "proj-gate",
        rootPath: "/tmp/proj-gate",
        createdAt: now,
      });
      await unit.sessions.upsert({
        sessionId: "sess-gate",
        projectId: "proj-gate",
        createdAt: now,
      });
      await unit.bindings.upsert({
        chatId: "1012",
        activeProjectId: "proj-gate",
        activeSessionId: "sess-gate",
        updatedAt: now,
      });
      await unit.states.upsert({
        chatId: "1012",
        mode: "error",
        updatedAt: now,
        lastErrorCode: ERROR_CODES.INCONSISTENT_BINDING,
      });
    });

    const fakeBotGate = new FakeBot();
    const gatedRouter = createTelegramRouter({
      bot: fakeBotGate as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });

    const hitsBefore = adapter.sendMessageHits;
    await gatedRouter.handleMessage(createMessage("1012", "texto libre en modo error"));
    assert(fakeBotGate.messages.length === 1, "debe responder guía cuando modo no permitido");
    assert(adapter.sendMessageHits === hitsBefore, "modo error debe bloquear envío a OpenCode");

    return "texto libre en idle o modo no permitido responde guía y no envía upstream";
  });
}

async function scenarioR7(): Promise<string> {
  const token = "token-r7";
  let queryHits = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/opencode/query") {
      queryHits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prompt?: string };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer: `Respuesta mock: ${parsed.prompt ?? ""}` }));
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server legacy");
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc2-r7-"));

  try {
    const baseConfig: Config = {
      telegramBotToken: "dummy",
      allowedUserIds: ["1013", "1014"],
      openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
      openCodeToken: token,
      openCodeTimeoutMs: 500,
      openCodeControlTimeoutMs: 500,
      openCodeExecTimeoutMs: 500,
      pollingIntervalMs: 1000,
      locale: "es",
      stateDriver: STATE_DRIVERS.JSON,
      stateDbPath: path.join(tempDir, "unused.sqlite"),
      stateJsonPath: path.join(tempDir, "state.json"),
      compatLegacyTextBridge: true,
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

    const persistence = await createJsonPersistenceDriver(baseConfig);
    const adapter = new FakeSessionAdapter();
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1013", selector: "proj-r7", rootPath: "/tmp/proj-r7" });
    assert(selected.ok, "selectProject debe ser exitoso");
    const created = await useCases.createSession({ chatId: "1013" });
    assert(created.ok, "createSession debe ser exitoso");

    const msg = createMessage("1013", "hola legado");

    const botLegacy = new FakeBot();
    await handleMessage(
      {
        bot: botLegacy as unknown as TelegramBot,
        useCases,
        config: { ...baseConfig, compatLegacyTextBridge: true },
      },
      msg
    );

    assert(queryHits === 0, "con sesión activa debe priorizar router RFC3 y evitar bridge legacy");
    assert(botLegacy.messages[0]?.text.includes("ACK:"), "con sesión activa debe responder flujo session-adapter");

    const botRfc2 = new FakeBot();
    await handleMessage(
      {
        bot: botRfc2 as unknown as TelegramBot,
        useCases,
        config: { ...baseConfig, compatLegacyTextBridge: false },
      },
      createMessage("1013", "hola rfc2")
    );

    assert(queryHits === 0, "con flag false no debe invocar endpoint legacy");
    assert(botRfc2.messages[0]?.text.includes("ACK:"), "con flag false debe responder flujo RFC2");

    const botFallback = new FakeBot();
    await handleMessage(
      {
        bot: botFallback as unknown as TelegramBot,
        useCases,
        config: { ...baseConfig, compatLegacyTextBridge: true },
      },
      createMessage("1014", "hola sin sesion")
    );

    assert(queryHits === 1, "sin sesión activa y flag true debe usar bridge legacy como fallback explícito");
    assert(botFallback.messages[0]?.text.includes("Respuesta mock:"), "fallback legacy esperado no encontrado");

    return "coexistencia legacy: router primario con sesión activa y fallback legacy solo sin sesión";
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR8S1(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1015", selector: "proj-r8", rootPath: "/tmp/proj-r8" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const created = await useCases.createSession({ chatId: "1015" });
    assert(created.ok, "createSession debe ser exitoso");

    const fakeBot = new FakeBot();
    const router = createTelegramRouter({
      bot: fakeBot as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });

    const runBefore = adapter.runCommandHits;
    const sendBefore = adapter.sendMessageHits;

    await router.handleMessage(createMessage("1015", "/run npm test"));
    await router.handleMessage(createMessage("1015", "texto normal"));

    assert(adapter.runCommandHits === runBefore + 1, "comando /run debe despachar por runCommand");
    assert(adapter.sendMessageHits === sendBefore + 2, "texto libre debe despachar por sendMessage");
    assert(fakeBot.messages.length === 2, "debe responder ambos mensajes");

    return "router separa dispatch: /run -> runCommand y texto libre -> sendMessage";
  });
}

async function scenarioR8S2(): Promise<string> {
  const token = "token-r8";

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.url === "/opencode/sessions/observe") {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "UNSUPPORTED", error: "observe unsupported" }));
      return;
    }

    if (req.url === "/opencode/sessions/cancel") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "UNAVAILABLE", error: "upstream unavailable" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server RFC3");
  }

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
    openCodeToken: token,
    openCodeTimeoutMs: 120,
    openCodeControlTimeoutMs: 120,
    openCodeExecTimeoutMs: 120,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "/tmp/unused.sqlite",
    stateJsonPath: "/tmp/unused.json",
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
    const client = createOpenCodeHttpClient(config);
    const adapter = new HttpOpenCodeSessionAdapter(client);

    const cancelResult = await adapter.cancelOrInterrupt({
      projectId: "proj-r8",
      sessionId: "sess-r8",
      chatId: "1016",
    });
    assert(!cancelResult.ok, "cancel con 503 debe devolver error normalizado");
    if (!cancelResult.ok) {
      assert(cancelResult.error.code === ERROR_CODES.UPSTREAM_5XX, "cancel 503 debe mapear a UPSTREAM_5XX");
    }

    const observeResult = await adapter.observeSession({
      projectId: "proj-r8",
      sessionId: "sess-r8",
      chatId: "1016",
    });
    assert(observeResult.ok, "observeSession v0.1 debe ser explícito y exitoso con modo reservado");
    if (observeResult.ok) {
      assert(observeResult.value.mode === "not-available-yet", "observeSession debe devolver modo reservado");
    }

    return "normalización RFC3: cancel 503->UPSTREAM_5XX y observeSession reservado explícito";
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR8S3(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    const selected = await useCases.selectProject({ chatId: "1017", selector: "proj-r8s3", rootPath: "/tmp/proj-r8s3" });
    assert(selected.ok, "selectProject debe ser exitoso");

    const created = await useCases.createSession({ chatId: "1017" });
    assert(created.ok, "createSession debe ser exitoso");

    const completed = await useCases.runSessionCommand({ chatId: "1017", command: "make deploy #completed" });
    assert(completed.ok, "runSessionCommand completed debe ser exitoso");
    if (completed.ok) {
      assert(completed.value.status === "completed", "runSessionCommand debe transportar status completed");
    }

    const unknown = await useCases.runSessionCommand({ chatId: "1017", command: "make check #unknown" });
    assert(unknown.ok, "runSessionCommand unknown debe ser exitoso");
    if (unknown.ok) {
      assert(unknown.value.status === "unknown", "runSessionCommand debe transportar status unknown");
      assert(Boolean(unknown.value.warning), "status unknown debe emitir warning de modo estable");
    }

    return "runSessionCommand propaga completed/unknown y mantiene warning en unknown";
  });
}

async function scenarioR9S1(): Promise<string> {
  const token = "token-r9s1";

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/opencode/sessions/create") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "project missing" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server R9S1");
  }

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
    openCodeToken: token,
    openCodeTimeoutMs: 200,
    openCodeControlTimeoutMs: 200,
    openCodeExecTimeoutMs: 200,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "/tmp/unused.sqlite",
    stateJsonPath: "/tmp/unused.json",
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
    const adapter = new HttpOpenCodeSessionAdapter(createOpenCodeHttpClient(config));
    const created = await adapter.createSession({
      projectId: "proj-missing",
      rootPath: "/tmp/proj-missing",
      source: "telegram",
    });

    assert(!created.ok, "createSession con proyecto faltante debe fallar");
    if (!created.ok) {
      assert(created.error.code === ERROR_CODES.NOT_FOUND, "error esperado: NOT_FOUND");
      assert(
        created.error.details?.adapterCode === ADAPTER_ERROR_CODES.PROJECT_NOT_FOUND,
        "adapterCode esperado: PROJECT_NOT_FOUND"
      );
    }

    return "createSession 404 normaliza PROJECT_NOT_FOUND (adapterCode)";
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR9S2(): Promise<string> {
  const token = "token-r9s2";

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/opencode/sessions/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId: "sess-r9s2",
          projectId: "proj-r9s2",
          status: "mystery-status",
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server R9S2");
  }

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
    openCodeToken: token,
    openCodeTimeoutMs: 200,
    openCodeControlTimeoutMs: 200,
    openCodeExecTimeoutMs: 200,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "/tmp/unused.sqlite",
    stateJsonPath: "/tmp/unused.json",
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
    const adapter = new HttpOpenCodeSessionAdapter(createOpenCodeHttpClient(config));
    const state = await adapter.getSessionState({
      projectId: "proj-r9s2",
      sessionId: "sess-r9s2",
    });

    assert(state.ok, "getSessionState con estado upstream no mapeado debe ser exitoso");
    if (state.ok) {
      assert(state.value.status === "unknown", "status esperado: unknown");
    }

    return "getSessionState mapea estados upstream desconocidos a unknown";
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR9S3(): Promise<string> {
  const token = "token-r9s3";

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/opencode/sessions/cancel") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "cancel endpoint not available" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("No pude resolver puerto efímero del server R9S3");
  }

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["1001"],
    openCodeUrl: `http://127.0.0.1:${address.port}/opencode/query`,
    openCodeToken: token,
    openCodeTimeoutMs: 200,
    openCodeControlTimeoutMs: 200,
    openCodeExecTimeoutMs: 200,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "/tmp/unused.sqlite",
    stateJsonPath: "/tmp/unused.json",
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
    const adapter = new HttpOpenCodeSessionAdapter(createOpenCodeHttpClient(config));
    const result = await adapter.cancelOrInterrupt({
      projectId: "proj-r9s3",
      sessionId: "sess-r9s3",
      chatId: "1903",
    });

    assert(!result.ok, "cancel 404 sin code debe mapear unsupported");
    if (!result.ok) {
      assert(result.error.code === ERROR_CODES.VALIDATION_ERROR, "error esperado: VALIDATION_ERROR");
      assert(
        result.error.details?.adapterCode === ADAPTER_ERROR_CODES.UNSUPPORTED,
        "adapterCode esperado: UNSUPPORTED"
      );
      assert(result.error.details?.retryable === false, "retryable esperado: false");
    }

    return "cancel 404 sin código upstream normaliza UNSUPPORTED (retryable=false)";
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

async function scenarioR9S4(): Promise<string> {
  return withLocalRuntime(async ({ config, adapter }) => {
    const persistence = await createJsonPersistenceDriver(config);
    const useCases = createApplicationUseCases({ persistence, adapter });

    adapter.seedSession("sess-running", "proj-r9-gates", "running");
    adapter.seedSession("sess-needs", "proj-r9-gates", "needs-attention");

    const selectedRunning = await useCases.selectProject({
      chatId: "1904",
      selector: "proj-r9-gates",
      rootPath: "/tmp/proj-r9-gates",
    });
    assert(selectedRunning.ok, "selectProject running chat debe ser exitoso");

    const selectedNeeds = await useCases.selectProject({
      chatId: "1905",
      selector: "proj-r9-gates",
      rootPath: "/tmp/proj-r9-gates",
    });
    assert(selectedNeeds.ok, "selectProject needs-attention chat debe ser exitoso");

    const attachedRunning = await useCases.attachSession({ chatId: "1904", sessionId: "sess-running" });
    const attachedNeeds = await useCases.attachSession({ chatId: "1905", sessionId: "sess-needs" });
    assert(attachedRunning.ok && attachedNeeds.ok, "attachSession debe ser exitoso para ambos estados");

    const runningStatus = await useCases.getStatus("1904");
    const needsStatus = await useCases.getStatus("1905");
    const runningValue = unwrapOk(runningStatus, "status running debe ser exitoso");
    const needsValue = unwrapOk(needsStatus, "status needs-attention debe ser exitoso");

    assert(runningValue.mode === "task-running", "running remoto debe mapear a task-running");
    assert(needsValue.mode === "needs-attention", "needs-attention remoto debe preservarse");

    const botRunning = new FakeBot();
    const botNeeds = new FakeBot();
    const routerRunning = createTelegramRouter({
      bot: botRunning as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });
    const routerNeeds = createTelegramRouter({
      bot: botNeeds as unknown as TelegramBot,
      useCases,
      compatRunCmdCommands: true,
    });

    const hitsBefore = adapter.sendMessageHits;
    await routerRunning.handleMessage(createMessage("1904", "mensaje bloqueado por running"));
    const hitsAfterRunning = adapter.sendMessageHits;
    await routerNeeds.handleMessage(createMessage("1905", "mensaje permitido por needs-attention"));
    const hitsAfterNeeds = adapter.sendMessageHits;

    assert(hitsAfterRunning === hitsBefore, "modo task-running debe bloquear texto libre (sin llamada upstream)");
    assert(
      hitsAfterNeeds === hitsAfterRunning + 1,
      "modo needs-attention debe permitir texto libre (una llamada upstream)"
    );

    return "gate parity: running bloquea, needs-attention permite texto libre como en RFC2";
  });
}

function resolveForcedScnLomDivergence(): ScnLomFixture | null {
  const raw = process.env.RFC2_VERIFY_SCN_LOM_FORCE_DIVERGENCE;
  if (!raw) {
    return null;
  }

  const fixture = raw.trim().toUpperCase();
  if (!(fixture in SCN_LOM_FIXTURES)) {
    throw new Error(
      `[SCN-LOM-001] RFC2_VERIFY_SCN_LOM_FORCE_DIVERGENCE inválido: "${raw}". Valores válidos: ${Object.keys(
        SCN_LOM_FIXTURES
      ).join(", ")}`
    );
  }

  return fixture as ScnLomFixture;
}

async function createScnLomFixtureServer(
  forceDivergence: ScnLomFixture | null
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/scn-lom") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          fixture?: ScnLomFixture;
          run?: 1 | 2;
        };
        const fixture = parsed.fixture;
        const run = parsed.run;

        if (!fixture || !(fixture in SCN_LOM_FIXTURES) || (run !== 1 && run !== 2)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid payload" }));
          return;
        }

        const expectation = SCN_LOM_FIXTURES[fixture];
        const shouldDiverge = forceDivergence === fixture && run === 2;
        const code = shouldDiverge ? `${expectation.expectedCode}_DRIFT` : expectation.expectedCode;

        res.writeHead(expectation.expectedStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("[SCN-LOM-001] No pude resolver puerto efímero del servidor de fixtures");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function runScnLomFixtureRequest(
  baseUrl: string,
  fixture: ScnLomFixture,
  run: 1 | 2
): Promise<ScnLomResponseSnapshot> {
  const url = new URL("/scn-lom", baseUrl);

  return new Promise<ScnLomResponseSnapshot>((resolve, reject) => {
    const request = http.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: string };
            const code = parsed.code;
            if (typeof code !== "string") {
              reject(new Error(`[SCN-LOM-001] fixture ${fixture} run ${run}: respuesta sin code`));
              return;
            }

            resolve({
              fixture,
              run,
              status: response.statusCode ?? 0,
              code,
            });
          } catch {
            reject(new Error(`[SCN-LOM-001] fixture ${fixture} run ${run}: JSON inválido`));
          }
        });
      }
    );

    request.on("error", (error) => {
      reject(new Error(`[SCN-LOM-001] fixture ${fixture} run ${run}: request error ${error.message}`));
    });

    request.write(JSON.stringify({ fixture, run }));
    request.end();
  });
}

function assertScnLomDeterminism(first: ScnLomResponseSnapshot, second: ScnLomResponseSnapshot): void {
  const expectation = SCN_LOM_FIXTURES[first.fixture];

  if (first.status !== expectation.expectedStatus || first.code !== expectation.expectedCode) {
    throw new Error(
      `[SCN-LOM-001] fixture ${first.fixture} run ${first.run} mismatch: esperado status=${expectation.expectedStatus} code=${expectation.expectedCode}, recibido status=${first.status} code=${first.code}`
    );
  }

  if (second.status !== expectation.expectedStatus || second.code !== expectation.expectedCode) {
    throw new Error(
      `[SCN-LOM-001] fixture ${second.fixture} run ${second.run} mismatch: esperado status=${expectation.expectedStatus} code=${expectation.expectedCode}, recibido status=${second.status} code=${second.code}`
    );
  }

  if (first.status !== second.status || first.code !== second.code) {
    throw new Error(
      `[SCN-LOM-001] fixture ${first.fixture} no determinístico: run ${first.run} -> status=${first.status} code=${first.code}; run ${second.run} -> status=${second.status} code=${second.code}`
    );
  }
}

async function scenarioScnLom001(): Promise<string> {
  const forceDivergence = resolveForcedScnLomDivergence();
  const server = await createScnLomFixtureServer(forceDivergence);

  try {
    for (const fixture of Object.keys(SCN_LOM_FIXTURES) as ReadonlyArray<ScnLomFixture>) {
      const first = await runScnLomFixtureRequest(server.baseUrl, fixture, 1);
      const second = await runScnLomFixtureRequest(server.baseUrl, fixture, 2);
      assertScnLomDeterminism(first, second);
    }

    return forceDivergence
      ? `SCN-LOM fixtures estables (forzado=${forceDivergence})`
      : "SCN-LOM fixtures estables en status/code tras 2 corridas";
  } finally {
    await server.close();
  }
}


async function runScenario(id: string, title: string, work: () => Promise<string>): Promise<ScenarioResult> {
  try {
    const details = await work();
    return { id, title, ok: true, details };
  } catch (error) {
    return {
      id,
      title,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const scenarioDefs: ReadonlyArray<{
    id: string;
    title: string;
    work: () => Promise<string>;
  }> = [
    { id: "R1S1", title: "Selección válida de proyecto", work: scenarioR1S1 },
    { id: "R1S2", title: "No filtrar rootPath", work: scenarioR1S2 },
    { id: "R2S1", title: "Vincular sesión existente", work: scenarioR2S1 },
    { id: "R2S2", title: "Bloqueo por falta de proyecto", work: scenarioR2S2 },
    { id: "R3S1", title: "Guard bloquea segunda orden", work: scenarioR3S1 },
    { id: "R4S1", title: "Rehidratación exitosa", work: scenarioR4S1 },
    { id: "R4S2", title: "Rehidratación inconsistente", work: scenarioR4S2 },
    { id: "R5S1", title: "Timeout con retry corto único", work: scenarioR5S1 },
    { id: "R5S2", title: "Asociación inválida sin corromper binding", work: scenarioR5S2 },
    { id: "R6S1", title: "/status completo", work: scenarioR6S1 },
    { id: "R6S2", title: "Texto libre sin sesión y gate por modo", work: scenarioR6S2 },
    { id: "R7S1", title: "Coexistencia legacy y router RFC3", work: scenarioR7 },
    { id: "R8S1", title: "Routing split /run vs texto libre", work: scenarioR8S1 },
    { id: "R8S2", title: "Normalización RFC3 cancel/observe", work: scenarioR8S2 },
    { id: "R8S3", title: "runSessionCommand completed/unknown", work: scenarioR8S3 },
    { id: "R9S1", title: "createSession project missing -> PROJECT_NOT_FOUND", work: scenarioR9S1 },
    { id: "R9S2", title: "getSessionState unknown mapping", work: scenarioR9S2 },
    { id: "R9S3", title: "cancel unsupported explícito", work: scenarioR9S3 },
    { id: "R9S4", title: "Gate parity running/needs-attention", work: scenarioR9S4 },
    { id: "SCN-LOM-001", title: "Determinismo fixtures UNSUPPORTED/TIMEOUT/UNAVAILABLE", work: scenarioScnLom001 },
  ] as const;

  const scenarios: ScenarioResult[] = [];
  for (const scenario of scenarioDefs) {
    scenarios.push(await runScenario(scenario.id, scenario.title, scenario.work));
  }

  const passed = scenarios.filter((scenario) => scenario.ok).length;
  const total = scenarios.length;

  console.log("RFC2 verification harness results");
  console.log("=================================");
  for (const scenario of scenarios) {
    const badge = scenario.ok ? "✅" : "❌";
    console.log(`${badge} ${scenario.id} - ${scenario.title}`);
    console.log(`   ${scenario.details}`);
  }

  console.log("---------------------------------");
  console.log(`Summary: ${passed}/${total} passed`);

  if (passed !== total) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Harness execution failed", error);
  process.exit(1);
});

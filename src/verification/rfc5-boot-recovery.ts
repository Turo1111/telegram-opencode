import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { bootRecover, createApplicationUseCases } from "../application/use-cases";
import {
  BOOT_RECOVERY_NOTICE_KIND,
  OpenCodeSessionAdapter,
  RECOVERY_REASON,
  RECOVERY_STATUS,
  Result,
  SendResult,
  SessionState,
} from "../application/contracts";
import { Config, STATE_DRIVERS } from "../config";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { createPersistenceDriver } from "../infrastructure/persistence/factory";
import { ERROR_CODES, DomainError } from "../domain/errors";
import { bootstrapApplication } from "../index";

interface ScenarioResult {
  readonly id: string;
  readonly requirement: string;
  readonly scenario: string;
  readonly ok: boolean;
  readonly details: string;
}

interface LocalRuntime {
  readonly tempDir: string;
  readonly config: Config;
  readonly adapter: FakeRecoveryAdapter;
  readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
}

interface StartupProbe {
  readonly checkpoints: string[];
  startBotCalled: boolean;
}

class FakeRecoveryAdapter implements OpenCodeSessionAdapter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly failingBySessionId = new Map<string, DomainError>();

  seedSession(state: SessionState): void {
    this.sessions.set(state.sessionId, { ...state });
  }

  seedFailure(sessionId: string, error: DomainError): void {
    this.failingBySessionId.set(sessionId, error);
  }

  clearFailures(): void {
    this.failingBySessionId.clear();
  }

  resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return Promise.resolve({ ok: true, value: { canonicalPath: input.rootPath } });
  }

  createSession(input: { projectId: string; rootPath: string; source: "telegram" }): Promise<Result<SessionState>> {
    const session: SessionState = {
      sessionId: `sess-${Date.now().toString(36)}`,
      projectId: input.projectId,
      status: "idle",
    };
    this.seedSession(session);
    return Promise.resolve({ ok: true, value: session });
  }

  attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
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

    return Promise.resolve({ ok: true, value: session });
  }

  sendMessage(_input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    return Promise.resolve({
      ok: false,
      error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "No implementado en harness RFC5"),
    });
  }

  runCommand(_input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
  }): Promise<Result<SendResult>> {
    return Promise.resolve({
      ok: false,
      error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "No implementado en harness RFC5"),
    });
  }

  getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const forcedFailure = this.failingBySessionId.get(input.sessionId);
    if (forcedFailure) {
      return Promise.resolve({ ok: false, error: forcedFailure });
    }

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

    return Promise.resolve({ ok: true, value: { ...session } });
  }

  cancelOrInterrupt(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<{ status: "cancelled" | "accepted" | "not-available-yet"; message?: string }>> {
    return Promise.resolve({ ok: true, value: { status: "not-available-yet" } });
  }

  observeSession(_input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<{ mode: "not-available-yet" }>> {
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

class FakeBot {
  public readonly messages: Array<{ readonly chatId: number; readonly text: string }> = [];

  public failSendForChatIds = new Set<number>();

  async sendMessage(chatId: number, text: string): Promise<void> {
    if (this.failSendForChatIds.has(chatId)) {
      throw new Error("forced-telegram-send-failure");
    }

    this.messages.push({ chatId, text });
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function withLocalRuntime(run: (runtime: LocalRuntime) => Promise<string>): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc5-harness-"));
  const stateJsonPath = path.join(tempDir, "state.json");
  const stateDbPath = path.join(tempDir, "state.sqlite");
  const adapter = new FakeRecoveryAdapter();

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["5001"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath,
    stateJsonPath,
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

  const persistence = await createJsonPersistenceDriver(config);

  try {
    return await run({ tempDir, config, adapter, persistence });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function seedActiveBinding(runtime: LocalRuntime, input: {
  chatId: string;
  projectId: string;
  sessionId: string;
  activeTaskId?: string;
  mode?: "session-linked" | "task-running";
}): Promise<void> {
  const nowIso = "2026-01-01T00:00:00.000Z";

  await runtime.persistence.runInTransaction(async (unit) => {
    await unit.projects.upsert({
      projectId: input.projectId,
      alias: input.projectId,
      rootPath: `/tmp/${input.projectId}`,
      createdAt: nowIso,
      lastUsedAt: nowIso,
    });

    await unit.sessions.upsert({
      sessionId: input.sessionId,
      projectId: input.projectId,
      createdAt: nowIso,
      updatedAt: nowIso,
    });

    await unit.bindings.upsert({
      chatId: input.chatId,
      activeProjectId: input.projectId,
      activeSessionId: input.sessionId,
      updatedAt: nowIso,
    });

    await unit.states.upsert({
      chatId: input.chatId,
      mode: input.mode ?? "session-linked",
      activeTaskId: input.activeTaskId,
      updatedAt: nowIso,
    });

    if (input.activeTaskId) {
      await unit.tasks.upsert({
        taskId: input.activeTaskId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        status: "in-progress",
        command: "make test",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  });
}

async function readStatus(runtime: LocalRuntime, chatId: string) {
  const useCases = createApplicationUseCases({
    persistence: runtime.persistence,
    adapter: runtime.adapter,
  });
  return useCases.getStatus(chatId);
}

async function scenarioS01StartupGateFullReconciliationBeforePolling(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    const probe: StartupProbe = { checkpoints: [], startBotCalled: false };
    const nowIso = "2026-01-01T10:00:00.000Z";

    await seedActiveBinding(runtime, {
      chatId: "5001",
      projectId: "proj-a",
      sessionId: "sess-a",
    });

    runtime.adapter.seedSession({
      projectId: "proj-a",
      sessionId: "sess-a",
      status: "running",
      taskId: "task-upstream-1",
    });

    await bootstrapApplication({
      loadConfig: () => runtime.config,
      createPersistenceDriver: async () => {
        probe.checkpoints.push("createPersistenceDriver");
        return runtime.persistence;
      },
      createOpenCodeSessionAdapter: () => {
        probe.checkpoints.push("createAdapter");
        return runtime.adapter;
      },
      bootRecover: async (persistence, options) => {
        probe.checkpoints.push("bootRecover:start");
        const recoveryOptions = typeof options === "string" ? { nowIso: options } : options ?? {};
        const summary = await bootRecover(persistence, { ...recoveryOptions, nowIso });
        probe.checkpoints.push("bootRecover:end");
        return summary;
      },
      startBot: () => {
        probe.checkpoints.push("startBot");
        probe.startBotCalled = true;
        return new FakeBot() as unknown as TelegramBot;
      },
      sendBootRecoveryNotices: async () => {
        probe.checkpoints.push("sendNotices");
      },
      sendAsyncSessionNotice: async () => undefined,
      createSessionWebhookReceiver: async () => ({
        callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events",
        host: "127.0.0.1",
        port: 4040,
        close: async () => undefined,
      }),
      createSessionWatcherService: () => ({
        createRegistration: () => ({ callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events", bearerToken: "verification-token" }),
        handleIncomingEvent: async () => ({ statusCode: 202, body: { ok: true } }),
        runWatchdogSweep: async () => undefined,
        restoreAfterRestart: async () => undefined,
        startScheduler: () => undefined,
        stopScheduler: () => undefined,
      }),
    });

    assert(probe.startBotCalled, "startBot no fue invocado");
    const bootStartIndex = probe.checkpoints.indexOf("bootRecover:start");
    const bootEndIndex = probe.checkpoints.indexOf("bootRecover:end");
    const startBotIndex = probe.checkpoints.indexOf("startBot");

    assert(bootStartIndex >= 0 && bootEndIndex >= 0, "bootRecover no fue ejecutado");
    assert(startBotIndex > bootEndIndex, "startBot ocurrió antes de finalizar la reconciliación");

    return `orden de startup validada: ${probe.checkpoints.join(" -> ")}`;
  });
}

async function scenarioS02NoActiveBindingsStartup(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    const recovered = await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    assert(recovered.evaluatedBindings === 0, "debe evaluar 0 bindings");
    assert(recovered.notices.length === 0, "no debe generar notices");

    return `evaluatedBindings=${recovered.evaluatedBindings}, notices=${recovered.notices.length}`;
  });
}

async function scenarioS03RemoteRunningKeepsActiveBinding(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    await seedActiveBinding(runtime, {
      chatId: "5003",
      projectId: "proj-running",
      sessionId: "sess-running",
    });

    runtime.adapter.seedSession({
      projectId: "proj-running",
      sessionId: "sess-running",
      status: "running",
      taskId: "task-running-1",
    });

    await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const status = await readStatus(runtime, "5003");
    assert(status.ok, "getStatus debe ser ok");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.sessionId === "sess-running", "binding activo no debe cerrarse");
    assert(status.value.recoveryStatus === RECOVERY_STATUS.RECOVERED, "recoveryStatus esperado: recovered");
    assert(status.value.mode === "task-running", "mode esperado: task-running");

    return `mode=${status.value.mode}, recoveryStatus=${status.value.recoveryStatus}`;
  });
}

async function scenarioS04RemoteMissingOrClosedClosesBinding(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    await seedActiveBinding(runtime, {
      chatId: "5004",
      projectId: "proj-missing",
      sessionId: "sess-missing",
      activeTaskId: "task-missing-1",
      mode: "task-running",
    });

    runtime.adapter.seedSession({
      projectId: "proj-missing",
      sessionId: "sess-missing",
      status: "completed",
    });

    const recovered = await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const status = await readStatus(runtime, "5004");
    assert(status.ok, "getStatus debe ser ok");
    if (!status.ok) {
      return "unreachable";
    }

    assert(!status.value.sessionId, "sessionId debe limpiarse");
    assert(status.value.activeTaskId === undefined, "activeTaskId debe limpiarse");
    assert(status.value.recoveryReason === RECOVERY_REASON.REMOTE_MISSING, "recoveryReason debe ser remote-missing");
    assert(
      recovered.notices.some((notice) => notice.kind === BOOT_RECOVERY_NOTICE_KIND.SESSION_CLOSED),
      "debe encolar notice session-closed"
    );

    return `recoveryReason=${status.value.recoveryReason}, cleanedBindings=${recovered.cleanedBindings}`;
  });
}

async function scenarioS05RemoteTransientFailureMarksDegraded(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    await seedActiveBinding(runtime, {
      chatId: "5005",
      projectId: "proj-timeout",
      sessionId: "sess-timeout",
    });

    runtime.adapter.seedFailure(
      "sess-timeout",
      new DomainError(ERROR_CODES.UPSTREAM_TIMEOUT, "timeout de prueba", { details: { upstream: true } })
    );

    const recovered = await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const status = await readStatus(runtime, "5005");
    assert(status.ok, "getStatus debe ser ok");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.sessionId === "sess-timeout", "binding debe preservarse");
    assert(status.value.recoveryStatus === RECOVERY_STATUS.DEGRADED, "recoveryStatus esperado: degraded");
    assert(status.value.recoveryReason === RECOVERY_REASON.REMOTE_TIMEOUT, "recoveryReason esperado: remote-timeout");
    assert(recovered.chatsInError === 1, "chatsInError esperado: 1");

    return `recoveryStatus=${status.value.recoveryStatus}, recoveryReason=${status.value.recoveryReason}`;
  });
}

async function scenarioS06AuditMetadataPersistedAfterEvaluation(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    const firstNowIso = "2026-01-01T10:00:00.000Z";
    const secondNowIso = "2026-01-01T10:05:00.000Z";

    await seedActiveBinding(runtime, {
      chatId: "5006",
      projectId: "proj-audit",
      sessionId: "sess-audit",
    });

    runtime.adapter.seedSession({
      projectId: "proj-audit",
      sessionId: "sess-audit",
      status: "running",
      taskId: "task-audit-1",
    });

    await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: firstNowIso,
    });

    let status = await readStatus(runtime, "5006");
    assert(status.ok, "getStatus debe ser ok");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.lastReconciledAt === firstNowIso, "timestamp de reconciliación no persistido");

    await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: secondNowIso,
    });

    status = await readStatus(runtime, "5006");
    assert(status.ok, "getStatus debe ser ok (segunda lectura)");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.lastReconciledAt === secondNowIso, "timestamp no se actualizó en segundo boot");

    return `lastReconciledAt ${firstNowIso} -> ${status.value.lastReconciledAt}`;
  });
}

async function scenarioS07NotifyClosureByRemoteAbsence(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    await seedActiveBinding(runtime, {
      chatId: "5007",
      projectId: "proj-notice-close",
      sessionId: "sess-notice-close",
    });

    runtime.adapter.seedFailure(
      "sess-notice-close",
      new DomainError(ERROR_CODES.NOT_FOUND, "session inexistente")
    );

    const recovered = await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const closeNotice = recovered.notices.find((notice) => notice.kind === BOOT_RECOVERY_NOTICE_KIND.SESSION_CLOSED);
    assert(Boolean(closeNotice), "debe generar notice session-closed");
    if (!closeNotice) {
      return "unreachable";
    }

    assert(closeNotice.reason === RECOVERY_REASON.REMOTE_MISSING, "reason esperado: remote-missing");
    assert(closeNotice.chatId === "5007", "chatId notice inválido");

    return `notice kind=${closeNotice.kind}, reason=${closeNotice.reason}`;
  });
}

async function scenarioS08NotifyDegradedStatus(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    await seedActiveBinding(runtime, {
      chatId: "5008",
      projectId: "proj-notice-degraded",
      sessionId: "sess-notice-degraded",
    });

    runtime.adapter.seedFailure(
      "sess-notice-degraded",
      new DomainError(ERROR_CODES.UPSTREAM_5XX, "upstream caído")
    );

    const recovered = await bootRecover(runtime.persistence, {
      adapter: runtime.adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const degradedNotice = recovered.notices.find((notice) => notice.kind === BOOT_RECOVERY_NOTICE_KIND.DEGRADED);
    assert(Boolean(degradedNotice), "debe generar notice degraded");
    if (!degradedNotice) {
      return "unreachable";
    }

    assert(degradedNotice.reason === RECOVERY_REASON.REMOTE_UNAVAILABLE, "reason esperado: remote-unavailable");
    assert(degradedNotice.chatId === "5008", "chatId notice inválido");

    return `notice kind=${degradedNotice.kind}, reason=${degradedNotice.reason}`;
  });
}

async function scenarioS09NotificationFaultIsolation(): Promise<string> {
  return withLocalRuntime(async (runtime) => {
    const fakeBot = new FakeBot();
    const probe: StartupProbe = { checkpoints: [], startBotCalled: false };

    await seedActiveBinding(runtime, {
      chatId: "5009",
      projectId: "proj-fault-isolation",
      sessionId: "sess-fault-isolation",
    });

    runtime.adapter.seedFailure(
      "sess-fault-isolation",
      new DomainError(ERROR_CODES.NOT_FOUND, "session inexistente")
    );
    fakeBot.failSendForChatIds.add(5009);

    await bootstrapApplication({
      loadConfig: () => runtime.config,
      createPersistenceDriver: async () => runtime.persistence,
      createOpenCodeSessionAdapter: () => runtime.adapter,
      bootRecover: async (persistence, options) => {
        probe.checkpoints.push("bootRecover");
        const recoveryOptions = typeof options === "string" ? { nowIso: options } : options ?? {};
        return bootRecover(persistence, { ...recoveryOptions, nowIso: "2026-01-01T10:00:00.000Z" });
      },
      startBot: () => {
        probe.checkpoints.push("startBot");
        probe.startBotCalled = true;
        return fakeBot as unknown as TelegramBot;
      },
      sendBootRecoveryNotices: async (input) => {
        probe.checkpoints.push("sendBootRecoveryNotices:start");
        // Reuse production behavior through dynamic import boundary not needed; emulate by calling message sender path
        const { sendBootRecoveryNotices } = await import("../adapters/telegram/message-sender");
        await sendBootRecoveryNotices(input);
        probe.checkpoints.push("sendBootRecoveryNotices:end");
      },
      sendAsyncSessionNotice: async () => undefined,
      createSessionWebhookReceiver: async () => ({
        callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events",
        host: "127.0.0.1",
        port: 4040,
        close: async () => undefined,
      }),
      createSessionWatcherService: () => ({
        createRegistration: () => ({ callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events", bearerToken: "verification-token" }),
        handleIncomingEvent: async () => ({ statusCode: 202, body: { ok: true } }),
        runWatchdogSweep: async () => undefined,
        restoreAfterRestart: async () => undefined,
        startScheduler: () => undefined,
        stopScheduler: () => undefined,
      }),
    });

    assert(probe.startBotCalled, "startup debe continuar aunque falle el envío de notice");
    assert(fakeBot.messages.length === 0, "el envío al chat fallido no debe persistir mensaje");

    const status = await readStatus(runtime, "5009");
    assert(status.ok, "getStatus debe ser ok");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.recoveryReason === RECOVERY_REASON.REMOTE_MISSING, "resultado de recovery debe persistir pese a fallo Telegram");

    return `checkpoints=${probe.checkpoints.join(" -> ")}`;
  });
}

async function scenarioS10CorruptedLocalStoreCreatesBackupAndReinit(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc5-corrupt-json-"));
  const stateJsonPath = path.join(tempDir, "state.json");

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["5001"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath,
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
    await fs.writeFile(stateJsonPath, "{ this is invalid json", "utf8");

    const driver = await createPersistenceDriver(config);
    await driver.runInTransaction(async (unit) => {
      await unit.bindings.listAll();
      await unit.states.listAll();
      await unit.tasks.listAll();
    });

    const entries = await fs.readdir(tempDir);
    const backupFile = entries.find((entry) => entry.startsWith("state.json.bak."));
    assert(Boolean(backupFile), "debe crear backup del JSON ilegible (.bak.<timestamp>)");

    const currentRaw = await fs.readFile(stateJsonPath, "utf8");
    assert(currentRaw.trim().startsWith("{"), "state.json re-inicializado debe ser JSON válido");

    return `backup=${backupFile ?? "none"}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function scenarioS11StartupAfterControlledReinitReachesOperational(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc5-startup-json-reinit-"));
  const stateJsonPath = path.join(tempDir, "state.json");

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["5001"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath,
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

  const probe: StartupProbe = { checkpoints: [], startBotCalled: false };
  const adapter = new FakeRecoveryAdapter();

  try {
    await fs.writeFile(stateJsonPath, "{ definitely broken json", "utf8");

    await bootstrapApplication({
      loadConfig: () => config,
      createPersistenceDriver: async (cfg) => {
        probe.checkpoints.push("createPersistenceDriver");
        return createPersistenceDriver(cfg);
      },
      createOpenCodeSessionAdapter: () => {
        probe.checkpoints.push("createAdapter");
        return adapter;
      },
      bootRecover: async (persistence, options) => {
        probe.checkpoints.push("bootRecover");
        const recoveryOptions = typeof options === "string" ? { nowIso: options } : options ?? {};
        return bootRecover(persistence, { ...recoveryOptions, nowIso: "2026-01-01T10:00:00.000Z" });
      },
      startBot: () => {
        probe.checkpoints.push("startBot");
        probe.startBotCalled = true;
        return new FakeBot() as unknown as TelegramBot;
      },
      sendBootRecoveryNotices: async () => {
        probe.checkpoints.push("sendNotices");
      },
      sendAsyncSessionNotice: async () => undefined,
      createSessionWebhookReceiver: async () => ({
        callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events",
        host: "127.0.0.1",
        port: 4040,
        close: async () => undefined,
      }),
      createSessionWatcherService: () => ({
        createRegistration: () => ({ callbackUrl: "http://127.0.0.1:4040/webhooks/opencode/events", bearerToken: "verification-token" }),
        handleIncomingEvent: async () => ({ statusCode: 202, body: { ok: true } }),
        runWatchdogSweep: async () => undefined,
        restoreAfterRestart: async () => undefined,
        startScheduler: () => undefined,
        stopScheduler: () => undefined,
      }),
    });

    assert(probe.startBotCalled, "startup debe llegar a startBot luego de reinit controlado");
    const entries = await fs.readdir(tempDir);
    assert(entries.some((entry) => entry.startsWith("state.json.bak.")), "startup debe dejar backup .bak");

    return `startup checkpoints=${probe.checkpoints.join(" -> ")}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function scenarioS12BackwardCompatibleLegacyRecords(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc5-legacy-json-"));
  const stateJsonPath = path.join(tempDir, "state.json");

  const legacyPayload = {
    projects: {
      "proj-legacy": {
        projectId: "proj-legacy",
        alias: "proj-legacy",
        rootPath: "/tmp/proj-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    sessions: {
      "sess-legacy": {
        sessionId: "sess-legacy",
        projectId: "proj-legacy",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    bindings: {
      "5012": {
        chatId: "5012",
        activeProjectId: "proj-legacy",
        activeSessionId: "sess-legacy",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    states: {
      "5012": {
        chatId: "5012",
        mode: "session-linked",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    tasks: {},
    pendingPrompts: {},
  };

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["5012"],
    openCodeUrl: "http://127.0.0.1:0/opencode/query",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath,
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

  const adapter = new FakeRecoveryAdapter();

  try {
    await fs.writeFile(stateJsonPath, JSON.stringify(legacyPayload, null, 2), "utf8");

    const persistence = await createJsonPersistenceDriver(config);
    adapter.seedSession({
      projectId: "proj-legacy",
      sessionId: "sess-legacy",
      status: "running",
      taskId: "task-legacy-1",
    });

    await bootRecover(persistence, {
      adapter,
      remoteReconcileEnabled: true,
      nowIso: "2026-01-01T10:00:00.000Z",
    });

    const useCases = createApplicationUseCases({ persistence, adapter });
    const status = await useCases.getStatus("5012");
    assert(status.ok, "getStatus debe ser ok para registro legacy");
    if (!status.ok) {
      return "unreachable";
    }

    assert(status.value.recoveryStatus === RECOVERY_STATUS.RECOVERED, "registro legacy debe poder recuperar metadata nueva");
    assert(Boolean(status.value.lastReconciledAt), "registro legacy debe setear lastReconciledAt");

    return `legacy recoveryStatus=${status.value.recoveryStatus}`;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runScenario(
  id: string,
  requirement: string,
  scenario: string,
  work: () => Promise<string>
): Promise<ScenarioResult> {
  try {
    const details = await work();
    return { id, requirement, scenario, ok: true, details };
  } catch (error) {
    return {
      id,
      requirement,
      scenario,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatResults(results: readonly ScenarioResult[]): string {
  const lines = [
    "RFC-005 Behavioral Verification",
    "",
    "| ID | Requirement | Scenario | Result | Details |",
    "|---|---|---|---|---|",
  ];

  for (const result of results) {
    lines.push(
      `| ${result.id} | ${result.requirement} | ${result.scenario} | ${result.ok ? "PASS" : "FAIL"} | ${result.details.replace(/\|/gu, "\\|")} |`
    );
  }

  const passed = results.filter((entry) => entry.ok).length;
  lines.push("", `Resumen: ${passed}/${results.length} escenarios PASS.`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const scenarios: ReadonlyArray<{
    readonly id: string;
    readonly requirement: string;
    readonly scenario: string;
    readonly work: () => Promise<string>;
  }> = [
    {
      id: "S01",
      requirement: "Startup Reconciliation Gate",
      scenario: "Full reconciliation before polling",
      work: scenarioS01StartupGateFullReconciliationBeforePolling,
    },
    {
      id: "S02",
      requirement: "Startup Reconciliation Gate",
      scenario: "No active bindings at startup",
      work: scenarioS02NoActiveBindingsStartup,
    },
    {
      id: "S03",
      requirement: "Deterministic Resolution Matrix",
      scenario: "Local active and remote active",
      work: scenarioS03RemoteRunningKeepsActiveBinding,
    },
    {
      id: "S04",
      requirement: "Deterministic Resolution Matrix",
      scenario: "Local active and remote missing/closed",
      work: scenarioS04RemoteMissingOrClosedClosesBinding,
    },
    {
      id: "S05",
      requirement: "Deterministic Resolution Matrix",
      scenario: "Remote check fails transiently",
      work: scenarioS05RemoteTransientFailureMarksDegraded,
    },
    {
      id: "S06",
      requirement: "Reconciliation Audit Fields",
      scenario: "Metadata written after evaluation",
      work: scenarioS06AuditMetadataPersistedAfterEvaluation,
    },
    {
      id: "S07",
      requirement: "User-Facing Recovery Notifications",
      scenario: "Notification for closure by remote absence",
      work: scenarioS07NotifyClosureByRemoteAbsence,
    },
    {
      id: "S08",
      requirement: "User-Facing Recovery Notifications",
      scenario: "Notification for degraded status",
      work: scenarioS08NotifyDegradedStatus,
    },
    {
      id: "S09",
      requirement: "Notification Fault Isolation",
      scenario: "Telegram delivery failure",
      work: scenarioS09NotificationFaultIsolation,
    },
    {
      id: "S10",
      requirement: "Corruption Continuity Policy",
      scenario: "Corrupted local store at startup",
      work: scenarioS10CorruptedLocalStoreCreatesBackupAndReinit,
    },
    {
      id: "S11",
      requirement: "Corruption Continuity Policy",
      scenario: "Startup after controlled reinitialization",
      work: scenarioS11StartupAfterControlledReinitReachesOperational,
    },
    {
      id: "S12",
      requirement: "Backward-Compatible Recovery Fields",
      scenario: "Legacy records without recovery metadata",
      work: scenarioS12BackwardCompatibleLegacyRecords,
    },
  ];

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runScenario(scenario.id, scenario.requirement, scenario.scenario, scenario.work));
  }

  const outputDir = path.resolve("./data");
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "rfc5-boot-recovery-runbook.txt");
  const report = formatResults(results);
  await fs.writeFile(reportPath, report, "utf8");

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    // eslint-disable-next-line no-console
    console.error(report);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(report);
  // eslint-disable-next-line no-console
  console.log(`Runbook RFC5 generado en ${reportPath}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("No pude ejecutar verificación RFC5", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADAPTER_ERROR_CODES,
  AttachLocalLaunchResult,
  LocalTerminalLauncher,
  OpenCodeSessionAdapter,
  Result,
  SessionState,
} from "../application/contracts";
import {
  CONFIRM_DANGEROUS_ACTION_RESULT_STATUS,
  createApplicationUseCases,
} from "../application/use-cases";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { DANGEROUS_ACTION_CONFIRMATION_STATUS } from "../domain/entities";
import { DangerousActionConfirmation } from "../domain/entities";

async function main(): Promise<void> {
  await verifyEnvironmentUnavailableRejects();
  await verifyTmuxMissingRejects();
  await verifyLauncherFallbackPersistsOutcome();
  await verifyRequestedPersistsOutcome();
  console.log("RFC-014 verification passed");
}

async function verifyEnvironmentUnavailableRejects(): Promise<void> {
  const harness = await createHarness({
    hasTmux: true,
    environmentReady: false,
    environmentReason: "no-gui-session",
    launchResult: {
      launcher: "manual-fallback",
      result: "failed",
      tmuxSessionName: "tgoc_sess_demo",
      manualCommand: "wsl.exe bash -lc 'tmux attach -t tgoc_sess_demo'",
      reason: "not-used",
    },
  });

  const result = await harness.confirm();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED);
  assert.equal(result.value.reason, "environment-unavailable");
  assert.equal(result.value.attachLocal, undefined);
}

async function verifyTmuxMissingRejects(): Promise<void> {
  const harness = await createHarness({
    hasTmux: false,
    launchResult: {
      launcher: "manual-fallback",
      result: "failed",
      tmuxSessionName: "tgoc_sess_demo",
      manualCommand: "wsl.exe bash -lc 'tmux attach -t tgoc_sess_demo'",
      reason: "not-used",
    },
  });

  const result = await harness.confirm();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.REJECTED);
  assert.equal(result.value.reason, "tmux-session-missing");
  assert.equal(result.value.attachLocal?.launcher, "manual-fallback");
}

async function verifyLauncherFallbackPersistsOutcome(): Promise<void> {
  const manual = "wsl.exe bash -lc 'tmux attach -t tgoc_sess_demo'";
  const harness = await createHarness({
    hasTmux: true,
    launchResult: {
      launcher: "manual-fallback",
      result: "failed",
      tmuxSessionName: "tgoc_sess_demo",
      manualCommand: manual,
      reason: "launcher-unavailable",
    },
  });

  const result = await harness.confirm();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.CONFIRMED);
  assert.equal(result.value.attachLocal?.result, "failed");

  const saved = await harness.getConfirmation();
  assert.equal(saved?.executionResult, "failed");
  assert.equal(saved?.manualCommand, manual);
}

async function verifyRequestedPersistsOutcome(): Promise<void> {
  const harness = await createHarness({
    hasTmux: true,
    launchResult: {
      launcher: "wt",
      result: "requested",
      tmuxSessionName: "tgoc_sess_demo",
      manualCommand: "wsl.exe bash -lc 'tmux attach -t tgoc_sess_demo'",
    },
  });

  const result = await harness.confirm();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, CONFIRM_DANGEROUS_ACTION_RESULT_STATUS.CONFIRMED);
  assert.equal(result.value.attachLocal?.result, "requested");

  const saved = await harness.getConfirmation();
  assert.equal(saved?.executionResult, "requested");
  assert.equal(saved?.launcher, "wt");
}

async function createHarness(input: {
  readonly hasTmux: boolean;
  readonly environmentReady?: boolean;
  readonly environmentReason?: string;
  readonly launchResult: AttachLocalLaunchResult;
}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc14-"));
  const persistence = await createJsonPersistenceDriver({
    telegramBotToken: "x",
    allowedUserIds: ["42"],
    openCodeUrl: "http://localhost",
    openCodeToken: "x",
    openCodeTimeoutMs: 1000,
    openCodeControlTimeoutMs: 1000,
    openCodeExecTimeoutMs: 1000,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: "json",
    stateDbPath: path.join(tmpDir, "unused.sqlite"),
    stateJsonPath: path.join(tmpDir, "state.json"),
    compatLegacyTextBridge: false,
    compatRunCmdCommands: false,
    bootRemoteReconcile: false,
    chatLockEnabled: true,
    lockWarnWaitMs: 100,
    watcherEnabled: false,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4040,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000,
    watchdogMaxRetryCount: 1,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 1000,
    localHostActionsEnabled: true,
    attachLocalEnabled: true,
    localHostConfirmationTtlMs: 60000,
    localTerminalLaunchTimeoutMs: 1000,
  });

  const launcher: LocalTerminalLauncher = {
    async isEnvironmentReady() {
      return { ok: true };
    },
    async launchAttach() {
      return input.launchResult;
    },
  };

  const useCases = createApplicationUseCases({
    persistence,
    adapter: createFakeAdapter(),
    localTerminalLauncher: launcher,
    hasTmuxSessionBySessionId: async ({ opencodeSessionId }) => ({
      exists: input.hasTmux,
      tmuxSessionName: `tgoc_${opencodeSessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    }),
    localHostOptions: {
      allowedActorIds: ["42"],
      localHostActionsEnabled: true,
      attachLocalEnabled: true,
      localHostConfirmationTtlMs: 60000,
      isLocalHostEnvironmentReady: async () => ({
        ok: input.environmentReady ?? true,
        reason: input.environmentReason,
      }),
    },
  });

  await useCases.selectProject({ chatId: "1001", selector: "proj-demo", rootPath: "/tmp/proj-demo" });
  await useCases.attachSession({ chatId: "1001", sessionId: "sess_demo" });

  const confirmationId = "conf-1";
  await persistence.runInTransaction(async (unit) => {
    await unit.dangerousActionConfirmations?.upsert({
      confirmationId,
      actorId: "42",
      chatId: "1001",
      chatType: "private",
      projectId: "proj-demo",
      sessionId: "sess_demo",
      intent: "attach-local",
      featureFlag: "ENABLE_ATTACH_LOCAL",
      targetEnvironment: "local-terminal",
      status: DANGEROUS_ACTION_CONFIRMATION_STATUS.ACTIVE,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  });

  return {
    confirm: () =>
      useCases.confirmDangerousAction({
        actorId: "42",
        chatId: "1001",
        chatType: "private",
        confirmationId,
      }),
    getConfirmation: async (): Promise<DangerousActionConfirmation | undefined> =>
      persistence.runInTransaction(async (unit) => {
        if (!unit.dangerousActionConfirmations) {
          return undefined;
        }

        return unit.dangerousActionConfirmations.findByConfirmationId(confirmationId);
      }),
  };
}

function createFakeAdapter(): OpenCodeSessionAdapter {
  const okSession = (sessionId: string, projectId: string): Result<SessionState> => ({
    ok: true,
    value: {
      sessionId,
      projectId,
      status: "idle",
    },
  });

  const unsupported = async () => ({
    ok: false,
    error: {
      code: "NOT_IMPLEMENTED",
      message: "not implemented",
    },
  }) as unknown as Result<never>;

  return {
    async resolveProject(input) {
      return { ok: true, value: { canonicalPath: input.rootPath } };
    },
    async createSession() {
      return okSession("sess_new", "proj-demo");
    },
    async attachSession(input) {
      return okSession(input.sessionId, input.projectId);
    },
    async sendMessage() {
      return unsupported();
    },
    async runCommand() {
      return unsupported();
    },
    async getSessionState(input) {
      return okSession(input.sessionId, input.projectId);
    },
    async cancelOrInterrupt() {
      return unsupported();
    },
    async observeSession() {
      return unsupported();
    },
    async submitPromptInput() {
      return unsupported();
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

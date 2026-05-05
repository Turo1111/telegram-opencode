import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { createApplicationUseCases } from "../application/use-cases";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { OpenCodeSessionAdapter, Result, SendResult, SessionState } from "../application/contracts";
import { CliOpenCodeSessionAdapter } from "../infrastructure/opencode-session-adapter";
import { PtyOpenCodeSessionAdapter } from "../infrastructure/opencode-session-adapter";
import { OpenCodeCliError } from "../infrastructure/opencode-cli";
import { createTelegramRouter } from "../adapters/telegram/router";
import { buildHostSessionArgs } from "../infrastructure/opencode-tmux-host";
import {
  formatInvalidModel,
  formatModelActive,
  formatModelUnavailable,
  formatSendSuccess,
} from "../adapters/telegram/templates";

class FakeBot {
  readonly messages: Array<{ chatId: number; text: string; reply_markup?: TelegramBot.SendMessageOptions["reply_markup"] }> = [];

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
    this.messages.push({ chatId, text, reply_markup: options?.reply_markup });
  }

  async answerCallbackQuery(): Promise<void> {
    return;
  }
}

class HarnessAdapter implements OpenCodeSessionAdapter {
  models = ["openai/gpt-5.3-codex", "cursor-acp/gpt-5.3-codex"];
  lastModel?: string;
  degraded = false;
  async resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return { ok: true, value: { canonicalPath: input.rootPath } };
  }
  async createSession(input: { projectId: string }): Promise<Result<SessionState>> { return { ok: true, value: { projectId: input.projectId, sessionId: "sess-1", status: "idle" } }; }
  async attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> { return { ok: true, value: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" } }; }
  async sendMessage(input: { projectId: string; sessionId: string; model?: string }): Promise<Result<SendResult>> { this.lastModel = input.model; return { ok: true, value: { message: "ok", state: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" }, requestedModel: input.model, effectiveModel: input.model } }; }
  async runCommand(input: { projectId: string; sessionId: string; model?: string }): Promise<Result<SendResult>> { return this.sendMessage(input); }
  async getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> { return { ok: true, value: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" } }; }
  async cancelOrInterrupt(): Promise<Result<never>> { return { ok: false, error: new Error("na") as never } as Result<never>; }
  async observeSession(): Promise<Result<never>> { return { ok: false, error: new Error("na") as never } as Result<never>; }
  async submitPromptInput(): Promise<Result<never>> { return { ok: false, error: new Error("na") as never } as Result<never>; }
  async listModels() { if (this.degraded) return { ok: true, value: { ok: false, models: [], fetchedAt: new Date().toISOString(), degraded: { reason: "unavailable", usingCache: false } } } as const; return { ok: true, value: { ok: true, models: this.models.map((id) => ({ id, source: "cli" as const })), fetchedAt: new Date().toISOString() } } as const; }
}

async function main() {
  await verifyRouterModelCommandsAndNotices();
  await verifyPtyAdapterConfigureSessionModelRestartsTmuxHost();
  verifyPtyHostArgsIncludeModel();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc17-"));
  const persistence = await createJsonPersistenceDriver({
    telegramBotToken: "x", allowedUserIds: ["1"], openCodeUrl: "http://localhost", openCodeToken: "x", openCodeTimeoutMs: 1000,
    openCodeControlTimeoutMs: 1000, openCodeExecTimeoutMs: 1000, pollingIntervalMs: 1000, locale: "es", stateDriver: "json",
    stateDbPath: path.join(tmpDir, "unused.sqlite"), stateJsonPath: path.join(tmpDir, "state.json"), compatLegacyTextBridge: false,
    compatRunCmdCommands: false, bootRemoteReconcile: false, chatLockEnabled: true, lockWarnWaitMs: 50, watcherEnabled: false,
    watchdogEnabled: false, webhookHost: "127.0.0.1", webhookPortStart: 4010, webhookPortEnd: 4010, watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000, watchdogMaxRetryCount: 1, humanPromptsEnabled: false, humanPromptLocalTtlMs: 1000,
    localHostActionsEnabled: false, attachLocalEnabled: false, localHostConfirmationTtlMs: 1000, localTerminalLaunchTimeoutMs: 1000,
  });
  const adapter = new HarnessAdapter();
  const useCases = createApplicationUseCases({
    persistence,
    adapter,
    readRuntimeMessages: async () => [
      {
        id: "a-1",
        role: "assistant",
        text: "respuesta",
        info: {
          agent: "build",
          model: {
            providerID: "cursor-acp",
            modelID: "gpt-5.3-codex",
          },
        },
      },
    ],
  });

  await useCases.selectProject({ chatId: "1", selector: "proj-a", rootPath: "/tmp/proj-a" });
  await useCases.attachSession({ chatId: "1", sessionId: "sess-a" });

  const listed = await useCases.listAvailableModels?.("1");
  assert.equal(listed?.ok, true);
  const setOk = await useCases.setActiveModel?.({ chatId: "1", model: "openai/gpt-5.3-codex" });
  assert.equal(setOk?.ok, true);
  const setBad = await useCases.setActiveModel?.({ chatId: "1", model: "bad/model" });
  assert.equal(setBad?.ok, false);
  const send = await useCases.sendText({ chatId: "1", text: "hola" });
  assert.equal(send.ok, true);
  assert.equal(adapter.lastModel, "openai/gpt-5.3-codex");

  const driftSync = await useCases.refreshSessionMetadata?.("1");
  assert.equal(driftSync?.ok, true);
  if (driftSync?.ok) {
    assert.equal(driftSync.value.requestedModel, "openai/gpt-5.3-codex");
    assert.equal(driftSync.value.effectiveModel, "cursor-acp/gpt-5.3-codex");
  }

  adapter.models = ["cursor-acp/gpt-5.3-codex"];
  const sendFallback = await useCases.sendText({ chatId: "1", text: "hola2" });
  assert.equal(sendFallback.ok, true);
  assert.equal(adapter.lastModel, "cursor-acp/gpt-5.3-codex");

  adapter.degraded = true;
  const degraded = await useCases.listAvailableModels?.("1");
  assert.equal(degraded?.ok, true);
  if (degraded?.ok) assert.equal(degraded.value.degraded, "unavailable");

  const degradedSend = await useCases.sendText({ chatId: "1", text: "hola3" });
  assert.equal(degradedSend.ok, true);
  if (degradedSend.ok) {
    assert.equal(degradedSend.value.modelValidationDegraded, "unavailable");
  }

  // Scenario: isolation by chat+project
  await useCases.selectProject({ chatId: "2", selector: "proj-b", rootPath: "/tmp/proj-b" });
  await useCases.attachSession({ chatId: "2", sessionId: "sess-b" });
  adapter.degraded = false;
  adapter.models = ["openai/gpt-5.3-codex", "cursor-acp/gpt-5.3-codex"];
  const setChat2 = await useCases.setActiveModel?.({ chatId: "2", model: "cursor-acp/gpt-5.3-codex" });
  assert.equal(setChat2?.ok, true);
  const activeChat1 = await useCases.getActiveModel?.("1");
  const activeChat2 = await useCases.getActiveModel?.("2");
  assert.equal(activeChat1?.ok, true);
  assert.equal(activeChat2?.ok, true);
  if (activeChat1?.ok && activeChat2?.ok) {
    assert.equal(activeChat1.value, "openai/gpt-5.3-codex");
    assert.equal(activeChat2.value, "cursor-acp/gpt-5.3-codex");
  }

  // Scenario: persistence reload after restart
  const persistenceReload = await createJsonPersistenceDriver({
    telegramBotToken: "x", allowedUserIds: ["1"], openCodeUrl: "http://localhost", openCodeToken: "x", openCodeTimeoutMs: 1000,
    openCodeControlTimeoutMs: 1000, openCodeExecTimeoutMs: 1000, pollingIntervalMs: 1000, locale: "es", stateDriver: "json",
    stateDbPath: path.join(tmpDir, "unused.sqlite"), stateJsonPath: path.join(tmpDir, "state.json"), compatLegacyTextBridge: false,
    compatRunCmdCommands: false, bootRemoteReconcile: false, chatLockEnabled: true, lockWarnWaitMs: 50, watcherEnabled: false,
    watchdogEnabled: false, webhookHost: "127.0.0.1", webhookPortStart: 4010, webhookPortEnd: 4010, watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000, watchdogMaxRetryCount: 1, humanPromptsEnabled: false, humanPromptLocalTtlMs: 1000,
    localHostActionsEnabled: false, attachLocalEnabled: false, localHostConfirmationTtlMs: 1000, localTerminalLaunchTimeoutMs: 1000,
  });
  const useCasesReload = createApplicationUseCases({ persistence: persistenceReload, adapter });
  const reloadedModel = await useCasesReload.getActiveModel?.("1");
  assert.equal(reloadedModel?.ok, true);
  if (reloadedModel?.ok) {
    assert.equal(reloadedModel.value, "openai/gpt-5.3-codex");
  }

  // Scenario: adapter catalog cache TTL + stale fallback disclosure
  let failCatalog = false;
  const cliAdapter = new CliOpenCodeSessionAdapter({ openCodeControlTimeoutMs: 1000 } as never, {
    listSessions: async () => [],
    resolveCanonicalProjectPath: async (value: string) => value,
    runSessionMessage: async () => ({ replyText: "ok" }),
    startSessionMessage: async () => undefined,
    listModels: async () => {
      if (failCatalog) {
        throw new OpenCodeCliError("timeout", "catalog-down");
      }
      return [{ id: "openai/gpt-5.3-codex", label: "GPT-5.3" }];
    },
  });
  const firstCatalog = await cliAdapter.listModels({ chatId: "1", projectId: "proj-a", sessionId: "sess-a" });
  assert.equal(firstCatalog.ok, true);
  if (firstCatalog.ok) {
    assert.equal(firstCatalog.value.ok, true);
  }
  failCatalog = true;
  const fallbackCatalog = await cliAdapter.listModels({ chatId: "1", projectId: "proj-a", sessionId: "sess-a" });
  assert.equal(fallbackCatalog.ok, true);
  if (fallbackCatalog.ok) {
    assert.equal(fallbackCatalog.value.ok, true);
    assert.equal(fallbackCatalog.value.degraded?.usingCache, true);
    assert.equal(fallbackCatalog.value.degraded?.reason, "timeout");
    assert.equal(fallbackCatalog.value.models[0]?.id, "openai/gpt-5.3-codex");
  }

  console.log("RFC-017 verification passed");
}

async function verifyPtyAdapterConfigureSessionModelRestartsTmuxHost(): Promise<void> {
  const ensureCalls: Array<{ sessionId: string; model?: string }> = [];
  const adapter = new PtyOpenCodeSessionAdapter(
    { openCodeControlTimeoutMs: 1000, openCodeExecTimeoutMs: 1000 } as never,
    {
      async listSessions() {
        return [];
      },
      async resolveCanonicalProjectPath(rootPath: string) {
        return rootPath;
      },
    },
    {
      async ensureHostSession(input) {
        ensureCalls.push({ sessionId: input.opencodeSessionId, model: input.model });
      },
      async sendInput() {
        return;
      },
      async interrupt() {
        return;
      },
    }
  );

  await adapter.resolveProject({ projectId: "proj-a", rootPath: "/tmp/proj-a" });
  const configured = await adapter.configureSessionModel({
    projectId: "proj-a",
    sessionId: "sess-a",
    model: "openai/gpt-5.3-codex",
  });
  assert.equal(configured.ok, true);

  const sent = await adapter.sendMessage({
    projectId: "proj-a",
    sessionId: "sess-a",
    message: "hola",
    chatId: "1",
    model: "openai/gpt-5.3-codex",
  });
  assert.equal(sent.ok, true);

  assert.deepEqual(ensureCalls, [
    { sessionId: "sess-a", model: "openai/gpt-5.3-codex" },
    { sessionId: "sess-a", model: undefined },
  ]);
}

function verifyPtyHostArgsIncludeModel(): void {
  const args = buildHostSessionArgs({
    sessionName: "tgoc_sess-a",
    dir: "/tmp/proj-a",
    opencodeSessionId: "sess-a",
    model: "openai/gpt-5.3-codex",
  });

  assert.deepEqual(args, [
    "new-session",
    "-d",
    "-s",
    "tgoc_sess-a",
    "-c",
    "/tmp/proj-a",
    "opencode",
    "--session",
    "sess-a",
    "--model",
    "openai/gpt-5.3-codex",
  ]);
}

async function verifyRouterModelCommandsAndNotices(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createRouterHarnessUseCases();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases: useCases as never,
    compatRunCmdCommands: true,
  });

  const chat = { id: 9101, type: "private" as const };

  await router.handleMessage({ chat, text: "/modelos" } as TelegramBot.Message);
  assert.equal(
    bot.messages.at(-1)?.text,
    "Elegí una suscripción:\n• OpenCode\n• OpenAI\n• GitHub Copilot"
  );
  assert.ok(bot.messages.at(-1)?.reply_markup, "/modelos debe responder con inline keyboard");

  await router.handleMessage({ chat, text: "/modelo" } as TelegramBot.Message);
  assert.equal(bot.messages.at(-1)?.text, formatModelActive("openai/gpt-5.3-codex"));

  await router.handleMessage({ chat, text: "/modelo bad/model" } as TelegramBot.Message);
  assert.equal(bot.messages.at(-1)?.text, formatInvalidModel());

  useCases.__degradedList = true;
  await router.handleMessage({ chat, text: "/modelos" } as TelegramBot.Message);
  assert.equal(
    bot.messages.at(-1)?.text,
    `Elegí una suscripción:\n• OpenCode\n• OpenAI\n• GitHub Copilot\n${formatModelUnavailable("unavailable")}`,
  );
  assert.ok(bot.messages.at(-1)?.reply_markup, "/modelos degradado también debe mantener inline keyboard");

  useCases.__degradedExec = true;
  await router.handleMessage({ chat, text: "hola degradado" } as TelegramBot.Message);
  assert.equal(
    bot.messages.at(-1)?.text,
    formatSendSuccess("respuesta degradada", false, {
      requestedModel: "openai/gpt-5.3-codex",
      effectiveModel: "cursor-acp/gpt-5.3-codex",
      modelValidationDegraded: "unavailable",
    }),
  );
  assert.match(bot.messages.at(-1)?.text ?? "", /Fallback modelo: openai\/gpt-5\.3-codex → cursor-acp\/gpt-5\.3-codex/u);
  assert.match(bot.messages.at(-1)?.text ?? "", /Validación de modelo degradada: unavailable/u);
}

function createRouterHarnessUseCases() {
  return {
    __degradedList: false,
    __degradedExec: false,
    async getStatus() {
      return {
        ok: true as const,
        value: {
          mode: "idle",
          projectId: "proj-a",
          projectAlias: "proj-a",
          sessionId: "sess-a",
          lastError: undefined,
          pendingPrompt: undefined,
        },
      };
    },
    async listAvailableModels() {
      return {
        ok: true as const,
        value: {
          models: ["openai/gpt-5.3-codex", "cursor-acp/gpt-5.3-codex"],
          degraded: this.__degradedList ? "unavailable" : undefined,
        },
      };
    },
    async getActiveModel() {
      return { ok: true as const, value: "openai/gpt-5.3-codex" };
    },
    async setActiveModel(input: { model: string }) {
      if (input.model === "bad/model") {
        return {
          ok: false as const,
          error: {
            code: "VALIDATION_ERROR",
            message: "Modelo no válido",
            details: {},
          },
        };
      }
      return { ok: true as const, value: { activeModel: input.model } };
    },
    async sendText() {
      if (this.__degradedExec) {
        return {
          ok: true as const,
          value: {
            message: "respuesta degradada",
            reply: "respuesta degradada",
            needsAttention: false,
            state: { projectId: "proj-a", sessionId: "sess-a", status: "idle" },
            requestedModel: "openai/gpt-5.3-codex",
            effectiveModel: "cursor-acp/gpt-5.3-codex",
            modelValidationDegraded: "unavailable",
          },
        };
      }
      return {
        ok: true as const,
        value: {
          message: "ok",
          reply: "ok",
          needsAttention: false,
          state: { projectId: "proj-a", sessionId: "sess-a", status: "idle" },
        },
      };
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

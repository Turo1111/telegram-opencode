import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import {
  OpenCodeSessionAdapter,
  Result,
  SendResult,
  SessionState,
} from "../application/contracts";
import { ApplicationUseCases, createApplicationUseCases } from "../application/use-cases";
import { createTelegramRouter } from "../adapters/telegram/router";
import {
  formatAgentActive,
  formatAgentActiveWithSessionReconfigured,
  formatAgentSyncNotice,
  formatDomainError,
  formatInvalidAgent,
  formatRunCommandSuccess,
  formatSendSuccess,
} from "../adapters/telegram/templates";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { SUPPORTED_AGENTS, SupportedAgent } from "../domain/entities";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { buildRunSessionArgs } from "../infrastructure/opencode-cli";
import { PtyOpenCodeSessionAdapter } from "../infrastructure/opencode-session-adapter";
import { buildHostSessionArgs } from "../infrastructure/opencode-tmux-host";
import { Config } from "../config";

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
  readonly sentMessages: Array<{ agent?: SupportedAgent }> = [];
  readonly sentCommands: Array<{ agent?: SupportedAgent }> = [];
  readonly configuredAgents: Array<{ projectId: string; sessionId: string; agent: SupportedAgent }> = [];
  readonly events: string[] = [];

  async resolveProject(input: { projectId: string; rootPath: string }): Promise<Result<{ canonicalPath: string }>> {
    return { ok: true, value: { canonicalPath: input.rootPath } };
  }

  async createSession(input: { projectId: string }): Promise<Result<SessionState>> {
    return { ok: true, value: { projectId: input.projectId, sessionId: "sess-1", status: "idle" } };
  }

  async attachSession(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    return { ok: true, value: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" } };
  }

  async configureSessionAgent(input: {
    projectId: string;
    sessionId: string;
    agent: SupportedAgent;
  }): Promise<Result<{ projectId: string; sessionId: string; agent: SupportedAgent }>> {
    this.events.push("configureSessionAgent");
    this.configuredAgents.push(input);
    return { ok: true, value: input };
  }

  async sendMessage(input: { agent?: SupportedAgent }): Promise<Result<SendResult>> {
    this.events.push("sendMessage");
    this.sentMessages.push({ agent: input.agent });
    return {
      ok: true,
      value: { message: "ok", state: { projectId: "proj-a", sessionId: "sess-a", status: "idle" } },
    };
  }

  async runCommand(input: { agent?: SupportedAgent }): Promise<Result<SendResult>> {
    this.events.push("runCommand");
    this.sentCommands.push({ agent: input.agent });
    return {
      ok: true,
      value: { message: "ok", state: { projectId: "proj-a", sessionId: "sess-a", status: "idle" } },
    };
  }

  async getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    return { ok: true, value: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" } };
  }

  async cancelOrInterrupt(): Promise<Result<never>> {
    return { ok: false, error: new Error("not implemented") as never } as Result<never>;
  }

  async observeSession(): Promise<Result<never>> {
    return { ok: false, error: new Error("not implemented") as never } as Result<never>;
  }

  async submitPromptInput(): Promise<Result<never>> {
    return { ok: false, error: new Error("not implemented") as never } as Result<never>;
  }
}

async function main(): Promise<void> {
  await verifyBusyPolicyForAgenteSet();
  await verifyRouterAgentesListingNoRemoteExecution();
  await verifyRouterAgenteBlankArgBehavesAsStatusQuery();
  await verifyRouterSetAgentPersistenceFailureShowsOperationalError();
  await verifyRouterInvalidAgentExactUxAndNoMutation();
  await verifyRouterSetAgentWithoutProjectExactUx();
  await verifyRouterSetAgentWithoutReconfigureHasNoRestartNote();
  await verifyUseCaseAgentSelectionAndPropagation();
  verifyImmediateExecutionRepliesHideMetadataBlock();
  verifyAgentSyncNoticeRendersMetadata();
  await verifyRouterSetAgentImmediatelyConfiguresActiveSessionWithoutTerminalLaunch();
  await verifyPtyAdapterPassesAgentToTmuxHostOps();
  await verifyPtyAdapterConfigureSessionAgentRestartsTmuxHost();
  await verifyPtyAdapterSkipsRedundantImmediateReconfigureAfterSetAgent();
  verifyCliRunArgsIncludeAgent();
  verifyPtyHostArgsIncludeAgent();
  console.log("RFC-016 verification passed");
}

function verifyImmediateExecutionRepliesHideMetadataBlock(): void {
  const sendReply = formatSendSuccess("ok", false, {
    requestedAgent: "plan",
    requestedModel: "gpt-4.1",
    effectiveAgent: "gentleman",
    effectiveModel: "gpt-5",
  });
  assert.doesNotMatch(sendReply, /🤖 Agente:/u);
  assert.doesNotMatch(sendReply, /🧠 Modelo:/u);

  const runReply = formatRunCommandSuccess({
    projectId: "proj-a",
    sessionId: "sess-a",
    taskId: "task-1",
    message: "Comando enviado ✅",
    needsAttention: false,
    state: { projectId: "proj-a", sessionId: "sess-a", status: "running" },
    requestedAgent: "plan",
    requestedModel: "gpt-4.1",
    effectiveAgent: "gentleman",
    effectiveModel: "gpt-5",
  });
  assert.doesNotMatch(runReply, /🤖 Agente:/u);
  assert.doesNotMatch(runReply, /🧠 Modelo:/u);
}

function verifyAgentSyncNoticeRendersMetadata(): void {
  const rendered = formatAgentSyncNotice({
    changed: true,
    requestedAgent: "plan",
    requestedModel: "gpt-5.3",
    effectiveAgent: "build",
    effectiveModel: "gpt-5.2",
  });

  assert.match(rendered, /Metadata runtime sincronizada/u);
  assert.match(rendered, /🤖 Agente: build/u);
  assert.match(rendered, /🧠 Modelo: gpt-5.2/u);
  assert.match(rendered, /Override agente: plan → build/u);
  assert.match(rendered, /Fallback modelo: gpt-5.3 → gpt-5.2/u);
}

async function verifyBusyPolicyForAgenteSet(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForPolicy();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7001, type: "private" },
    text: "/agente plan",
  } as TelegramBot.Message);

  const firstMessage = bot.messages[0]?.text ?? "";
  assert.match(firstMessage, /Comando bloqueado por tarea en curso/u);
  assert.equal(useCases.__calls.setActiveAgent, 0, "setActiveAgent no debe ejecutarse en busy para /agente <nombre>");
}

async function verifyUseCaseAgentSelectionAndPropagation(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc16-"));
  const adapter = new HarnessAdapter();
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
    lockWarnWaitMs: 50,
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
    localHostActionsEnabled: false,
    attachLocalEnabled: false,
    localHostConfirmationTtlMs: 60000,
    localTerminalLaunchTimeoutMs: 1000,
  });

  const useCases = createApplicationUseCases({
    persistence,
    adapter,
    openCodeDefaultAgent: SUPPORTED_AGENTS.BUILD,
  });

  const setWithoutProject = await useCases.setActiveAgent?.({ chatId: "2001", agent: "plan" });
  assert.equal(setWithoutProject?.ok, false);

  await useCases.selectProject({ chatId: "2001", selector: "proj-a", rootPath: "/tmp/proj-a" });
  await useCases.attachSession({ chatId: "2001", sessionId: "sess-a" });

  const initial = await useCases.getActiveAgent?.("2001");
  assert.equal(initial?.ok, true);
  if (initial?.ok) {
    assert.equal(initial.value, SUPPORTED_AGENTS.BUILD);
  }

  const invalid = await useCases.setActiveAgent?.({ chatId: "2001", agent: "foo" });
  assert.equal(invalid?.ok, false);

  const setPlan = await useCases.setActiveAgent?.({ chatId: "2001", agent: SUPPORTED_AGENTS.PLAN });
  assert.equal(setPlan?.ok, true);
  if (setPlan?.ok) {
    assert.deepEqual(setPlan.value, { activeAgent: SUPPORTED_AGENTS.PLAN, sessionReconfigured: true });
  }
  assert.deepEqual(adapter.configuredAgents.at(-1), {
    projectId: "proj-a",
    sessionId: "sess-a",
    agent: SUPPORTED_AGENTS.PLAN,
  });

  const setGentlemanQuoted = await useCases.setActiveAgent?.({ chatId: "2001", agent: '"gentleman"' });
  assert.equal(setGentlemanQuoted?.ok, true);
  if (setGentlemanQuoted?.ok) {
    assert.deepEqual(setGentlemanQuoted.value, { activeAgent: SUPPORTED_AGENTS.GENTLEMAN, sessionReconfigured: true });
  }

  const afterSet = await useCases.getActiveAgent?.("2001");
  assert.equal(afterSet?.ok, true);
  if (afterSet?.ok) {
    assert.equal(afterSet.value, SUPPORTED_AGENTS.GENTLEMAN);
  }

  const invalidAfterSet = await useCases.setActiveAgent?.({ chatId: "2001", agent: "foo" });
  assert.equal(invalidAfterSet?.ok, false);

  const afterInvalidSet = await useCases.getActiveAgent?.("2001");
  assert.equal(afterInvalidSet?.ok, true);
  if (afterInvalidSet?.ok) {
    assert.equal(afterInvalidSet.value, SUPPORTED_AGENTS.GENTLEMAN);
  }

  const sendResult = await useCases.sendText({ chatId: "2001", text: "hola" });
  assert.equal(sendResult.ok, true);
  assert.equal(adapter.sentMessages.at(-1)?.agent, SUPPORTED_AGENTS.GENTLEMAN);

  const runResult = await useCases.runSessionCommand({ chatId: "2001", command: "status" });
  assert.equal(runResult.ok, true);
  assert.equal(adapter.sentCommands.at(-1)?.agent, SUPPORTED_AGENTS.GENTLEMAN);

  await useCases.selectProject({ chatId: "2001", selector: "proj-b", rootPath: "/tmp/proj-b" });
  await useCases.attachSession({ chatId: "2001", sessionId: "sess-b" });

  const projectB = await useCases.getActiveAgent?.("2001");
  assert.equal(projectB?.ok, true);
  if (projectB?.ok) {
    assert.equal(projectB.value, SUPPORTED_AGENTS.BUILD);
  }

  await useCases.selectProject({ chatId: "2001", selector: "proj-a", rootPath: "/tmp/proj-a" });
  await useCases.attachSession({ chatId: "2001", sessionId: "sess-a" });

  const projectA = await useCases.getActiveAgent?.("2001");
  assert.equal(projectA?.ok, true);
  if (projectA?.ok) {
    assert.equal(projectA.value, SUPPORTED_AGENTS.GENTLEMAN);
  }
}

async function verifyRouterSetAgentImmediatelyConfiguresActiveSessionWithoutTerminalLaunch(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc16-router-configure-"));
  const adapter = new HarnessAdapter();
  const terminalLaunches: string[] = [];
  const persistence = await createJsonPersistenceDriver({
    ...createHarnessConfig(),
    stateDbPath: path.join(tmpDir, "unused.sqlite"),
    stateJsonPath: path.join(tmpDir, "state.json"),
  });
  const useCases = createApplicationUseCases({
    persistence,
    adapter,
    openCodeDefaultAgent: SUPPORTED_AGENTS.BUILD,
    localHostOptions: {
      localHostActionsEnabled: true,
      attachLocalEnabled: true,
      allowedActorIds: ["42"],
    },
    localTerminalLauncher: {
      async isEnvironmentReady() {
        return { ok: true };
      },
      async launchAttach() {
        terminalLaunches.push("launchAttach");
        return {
          launcher: "manual-fallback",
          result: "failed",
          tmuxSessionName: "tgoc_sess-a",
          manualCommand: "tmux attach -t tgoc_sess-a",
          reason: "unexpected-test-launch",
        };
      },
    },
  });

  await useCases.selectProject({ chatId: "7007", selector: "proj-a", rootPath: "/tmp/proj-a" });
  await useCases.attachSession({ chatId: "7007", sessionId: "sess-a" });

  const bot = new FakeBot();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
    attachLocalEnabled: true,
  });

  await router.handleMessage({
    chat: { id: 7007, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Tester" },
    text: "/agente gentleman",
  } as TelegramBot.Message);

  assert.equal(bot.messages.at(-1)?.text, formatAgentActiveWithSessionReconfigured("gentleman", false));
  assert.deepEqual(adapter.configuredAgents, [
    { projectId: "proj-a", sessionId: "sess-a", agent: SUPPORTED_AGENTS.GENTLEMAN },
  ]);
  assert.deepEqual(adapter.events, ["configureSessionAgent"], "/agente debe configurar PTY antes de cualquier envío remoto");
  assert.equal(adapter.sentMessages.length, 0, "/agente no debe ejecutar sendMessage");
  assert.equal(adapter.sentCommands.length, 0, "/agente no debe ejecutar runCommand");
  assert.equal(terminalLaunches.length, 0, "/agente no debe abrir terminal local; eso queda detrás de /attach-local");
}

async function verifyPtyAdapterPassesAgentToTmuxHostOps(): Promise<void> {
  const config = createHarnessConfig();
  const ensureCalls: Array<{ sessionId: string; agent?: SupportedAgent }> = [];
  const sentInputs: string[] = [];
  const adapter = new PtyOpenCodeSessionAdapter(
    config,
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
        ensureCalls.push({ sessionId: input.opencodeSessionId, agent: input.agent });
      },
      async sendInput(input) {
        sentInputs.push(input.input);
      },
      async interrupt() {
        return;
      },
    }
  );

  await adapter.resolveProject({ projectId: "proj-a", rootPath: "/tmp/proj-a" });

  const send = await adapter.sendMessage({
    projectId: "proj-a",
    sessionId: "sess-a",
    message: "hola",
    chatId: "2001",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
  });
  assert.equal(send.ok, true);
  assert.deepEqual(ensureCalls.at(-1), { sessionId: "sess-a", agent: SUPPORTED_AGENTS.GENTLEMAN });
  assert.equal(sentInputs.at(-1), "hola");

  const command = await adapter.runCommand({
    projectId: "proj-a",
    sessionId: "sess-a",
    command: "status",
    chatId: "2001",
    agent: SUPPORTED_AGENTS.PLAN,
  });
  assert.equal(command.ok, true);
  assert.deepEqual(ensureCalls.at(-1), { sessionId: "sess-a", agent: SUPPORTED_AGENTS.PLAN });
  assert.equal(sentInputs.at(-1), "status");
}

async function verifyPtyAdapterConfigureSessionAgentRestartsTmuxHost(): Promise<void> {
  const config = createHarnessConfig();
  const ensureCalls: Array<{ sessionId: string; agent?: SupportedAgent }> = [];
  const sentInputs: string[] = [];
  const adapter = new PtyOpenCodeSessionAdapter(
    config,
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
        ensureCalls.push({ sessionId: input.opencodeSessionId, agent: input.agent });
      },
      async sendInput(input) {
        sentInputs.push(input.input);
      },
      async interrupt() {
        return;
      },
    }
  );

  await adapter.resolveProject({ projectId: "proj-a", rootPath: "/tmp/proj-a" });
  const configured = await adapter.configureSessionAgent({
    projectId: "proj-a",
    sessionId: "sess-a",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
  });

  assert.equal(configured.ok, true);
  assert.deepEqual(ensureCalls, [{ sessionId: "sess-a", agent: SUPPORTED_AGENTS.GENTLEMAN }]);
  assert.deepEqual(sentInputs, [], "configureSessionAgent no debe inyectar texto ni depender de sendMessage");
}

async function verifyPtyAdapterSkipsRedundantImmediateReconfigureAfterSetAgent(): Promise<void> {
  const config = createHarnessConfig();
  const ensureCalls: Array<{ sessionId: string; agent?: SupportedAgent }> = [];
  const adapter = new PtyOpenCodeSessionAdapter(
    config,
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
        ensureCalls.push({ sessionId: input.opencodeSessionId, agent: input.agent });
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
  const configured = await adapter.configureSessionAgent({
    projectId: "proj-a",
    sessionId: "sess-a",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
  });
  assert.equal(configured.ok, true);

  const sent = await adapter.sendMessage({
    projectId: "proj-a",
    sessionId: "sess-a",
    message: "hola",
    chatId: "2001",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
  });
  assert.equal(sent.ok, true);

  assert.deepEqual(ensureCalls, [
    { sessionId: "sess-a", agent: SUPPORTED_AGENTS.GENTLEMAN },
    { sessionId: "sess-a", agent: undefined },
  ]);
}

function verifyCliRunArgsIncludeAgent(): void {
  const args = buildRunSessionArgs({
    sessionId: "sess-a",
    dir: "/tmp/proj-a",
    message: "hola",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
  });

  assert.deepEqual(args, [
    "run",
    "--format",
    "json",
    "--session",
    "sess-a",
    "--dir",
    "/tmp/proj-a",
    "--agent",
    "gentleman",
    "hola",
  ]);

  const defaultArgs = buildRunSessionArgs({
    sessionId: "sess-a",
    dir: "/tmp/proj-a",
    message: "hola",
  });
  assert.deepEqual(defaultArgs, ["run", "--format", "json", "--session", "sess-a", "--dir", "/tmp/proj-a", "hola"]);
}

function verifyPtyHostArgsIncludeAgent(): void {
  const args = buildHostSessionArgs({
    sessionName: "tgoc_sess-a",
    dir: "/tmp/proj-a",
    opencodeSessionId: "sess-a",
    agent: SUPPORTED_AGENTS.GENTLEMAN,
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
    "--agent",
    "gentleman",
  ]);

  const defaultArgs = buildHostSessionArgs({
    sessionName: "tgoc_sess-a",
    dir: "/tmp/proj-a",
    opencodeSessionId: "sess-a",
  });
  assert.deepEqual(defaultArgs, ["new-session", "-d", "-s", "tgoc_sess-a", "-c", "/tmp/proj-a", "opencode", "--session", "sess-a"]);
}

function createHarnessConfig(): Config {
  return {
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
    stateDbPath: ":memory:",
    stateJsonPath: ":memory:",
    compatLegacyTextBridge: false,
    compatRunCmdCommands: false,
    bootRemoteReconcile: false,
    chatLockEnabled: true,
    lockWarnWaitMs: 50,
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
    localHostActionsEnabled: false,
    attachLocalEnabled: false,
    localHostConfirmationTtlMs: 60000,
    localTerminalLaunchTimeoutMs: 1000,
  };
}

async function verifyRouterAgentesListingNoRemoteExecution(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({ activeAgent: SUPPORTED_AGENTS.PLAN });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7002, type: "private" },
    text: "/agentes",
  } as TelegramBot.Message);

  assert.equal(
    bot.messages.at(-1)?.text,
    "Agentes disponibles (activo: plan):\nElegí un botón abajo.\n• build\n• ✅ plan\n• gentleman\n• sdd-orchestrator"
  );
  assert.ok(bot.messages.at(-1)?.reply_markup, "/agentes debe responder con inline keyboard");
  assert.equal(useCases.__calls.sendText, 0, "sendText no debe ejecutarse con /agentes");
  assert.equal(useCases.__calls.runSessionCommand, 0, "runSessionCommand no debe ejecutarse con /agentes");
}

async function verifyRouterAgenteBlankArgBehavesAsStatusQuery(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({ activeAgent: SUPPORTED_AGENTS.PLAN });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7003, type: "private" },
    text: "/agente ",
  } as TelegramBot.Message);

  assert.equal(bot.messages.at(-1)?.text, formatAgentActive("plan"));
  assert.doesNotMatch(bot.messages.at(-1)?.text ?? "", /attach-local/u);
  assert.equal(useCases.__calls.getActiveAgent, 1, "getActiveAgent debe ejecutarse en /agente con argumento vacío");
  assert.equal(useCases.__calls.setActiveAgent, 0, "setActiveAgent no debe ejecutarse en /agente con argumento vacío");
  assert.equal(useCases.__calls.sendText, 0, "sendText no debe ejecutarse en /agente con argumento vacío");
  assert.equal(useCases.__calls.runSessionCommand, 0, "runSessionCommand no debe ejecutarse en /agente con argumento vacío");
}

async function verifyRouterSetAgentPersistenceFailureShowsOperationalError(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({
    activeAgent: SUPPORTED_AGENTS.BUILD,
    failSetWithPersistenceError: true,
  });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7004, type: "private" },
    text: "/agente plan",
  } as TelegramBot.Message);

  const lastMessage = bot.messages.at(-1)?.text ?? "";
  assert.match(lastMessage, /No pude persistir el estado local/u);
  assert.doesNotMatch(lastMessage, /^✅ Agente CONFIGURADO \(Telegram\):/u);
}

async function verifyRouterInvalidAgentExactUxAndNoMutation(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({
    activeAgent: SUPPORTED_AGENTS.BUILD,
    failSetWithInvalidAgent: true,
  });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7005, type: "private" },
    text: "/agente foo",
  } as TelegramBot.Message);

  const expected = formatInvalidAgent([
    SUPPORTED_AGENTS.BUILD,
    SUPPORTED_AGENTS.PLAN,
    SUPPORTED_AGENTS.GENTLEMAN,
    SUPPORTED_AGENTS.SDD_ORCHESTRATOR,
  ]);

  assert.equal(bot.messages.at(-1)?.text, expected);
  assert.equal(useCases.__calls.setActiveAgent, 1, "setActiveAgent debe ejecutarse y rechazar agente inválido");
  assert.equal(useCases.__calls.sendText, 0, "sendText no debe ejecutarse con agente inválido");
  assert.equal(useCases.__calls.runSessionCommand, 0, "runSessionCommand no debe ejecutarse con agente inválido");
}

async function verifyRouterSetAgentWithoutProjectExactUx(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({
    activeAgent: SUPPORTED_AGENTS.BUILD,
    failSetWithoutProject: true,
  });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7006, type: "private" },
    text: "/agente plan",
  } as TelegramBot.Message);

  const expected = formatDomainError(
    new DomainError(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project")
  );

  assert.equal(bot.messages.at(-1)?.text, expected);
  assert.equal(useCases.__calls.setActiveAgent, 1, "setActiveAgent debe ejecutarse y devolver validación sin proyecto");
  assert.doesNotMatch(bot.messages.at(-1)?.text ?? "", /^✅ Agente CONFIGURADO \(Telegram\):/u);
}

async function verifyRouterSetAgentWithoutReconfigureHasNoRestartNote(): Promise<void> {
  const bot = new FakeBot();
  const useCases = createFakeUseCasesForAgentCommandRuntime({ activeAgent: SUPPORTED_AGENTS.BUILD });
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    compatRunCmdCommands: true,
  });

  await router.handleMessage({
    chat: { id: 7008, type: "private" },
    text: "/agente plan",
  } as TelegramBot.Message);

  assert.equal(bot.messages.at(-1)?.text, formatAgentActive("plan"));
  assert.doesNotMatch(bot.messages.at(-1)?.text ?? "", /Reinicié la sesión PTY\/tmux/u);
  assert.equal(useCases.__calls.setActiveAgent, 1, "setActiveAgent debe ejecutarse para cambiar agente");
  assert.equal(useCases.__calls.sendText, 0, "sendText no debe ejecutarse con /agente <nombre>");
  assert.equal(useCases.__calls.runSessionCommand, 0, "runSessionCommand no debe ejecutarse con /agente <nombre>");
}

function createFakeUseCasesForPolicy(): ApplicationUseCases & { __calls: { setActiveAgent: number } } {
  const calls = { setActiveAgent: 0 };
  return {
    __calls: calls,
    async getStatus() {
      return {
        ok: true,
        value: {
          mode: "task-running",
          projectId: "proj-1",
          sessionId: "sess-1",
          activeTaskId: "task-1",
        },
      };
    },
    async listSupportedAgents() {
      return [SUPPORTED_AGENTS.BUILD, SUPPORTED_AGENTS.PLAN, SUPPORTED_AGENTS.GENTLEMAN, SUPPORTED_AGENTS.SDD_ORCHESTRATOR] as const;
    },
    async getActiveAgent() {
      return { ok: true, value: SUPPORTED_AGENTS.BUILD };
    },
    async setActiveAgent() {
      calls.setActiveAgent += 1;
      return { ok: true, value: { activeAgent: SUPPORTED_AGENTS.PLAN, sessionReconfigured: false } };
    },
    async selectProject() { throw new Error("not used"); },
    async attachSession() { throw new Error("not used"); },
    async createSession() { throw new Error("not used"); },
    async sendText() { throw new Error("not used"); },
    async runSessionCommand() { throw new Error("not used"); },
    async submitPendingPrompt() { throw new Error("not used"); },
    async cancelSession() { throw new Error("not used"); },
    async refreshSessionMetadata() { throw new Error("not used"); },
  } as unknown as ApplicationUseCases & { __calls: { setActiveAgent: number } };
}

function createFakeUseCasesForAgentCommandRuntime(input: {
  activeAgent: SupportedAgent;
  failSetWithPersistenceError?: boolean;
  failSetWithInvalidAgent?: boolean;
  failSetWithoutProject?: boolean;
}): ApplicationUseCases & {
  __calls: {
    getActiveAgent: number;
    setActiveAgent: number;
    sendText: number;
    runSessionCommand: number;
  };
} {
  const calls = {
    getActiveAgent: 0,
    setActiveAgent: 0,
    sendText: 0,
    runSessionCommand: 0,
  };

  let activeAgent: SupportedAgent = input.activeAgent;

  return {
    __calls: calls,
    async getStatus() {
      return {
        ok: true,
        value: {
          mode: "idle",
          projectId: "proj-1",
          sessionId: "sess-1",
          activeTaskId: undefined,
        },
      };
    },
    async listSupportedAgents() {
      return [SUPPORTED_AGENTS.BUILD, SUPPORTED_AGENTS.PLAN, SUPPORTED_AGENTS.GENTLEMAN, SUPPORTED_AGENTS.SDD_ORCHESTRATOR] as const;
    },
    async getActiveAgent() {
      calls.getActiveAgent += 1;
      return { ok: true, value: activeAgent };
    },
    async setActiveAgent(inputSet: { chatId: string; agent: string }) {
      calls.setActiveAgent += 1;
      if (input.failSetWithoutProject) {
        return {
          ok: false,
          error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "Primero elegí un proyecto con /project"),
        };
      }
      if (input.failSetWithPersistenceError) {
        return {
          ok: false,
          error: new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "falló persistencia"),
        };
      }
      if (input.failSetWithInvalidAgent) {
        return {
          ok: false,
          error: new DomainError(ERROR_CODES.VALIDATION_ERROR, "Agente no válido"),
        };
      }
      activeAgent = inputSet.agent as SupportedAgent;
      return { ok: true, value: { activeAgent, sessionReconfigured: false } };
    },
    async selectProject() { throw new Error("not used"); },
    async attachSession() { throw new Error("not used"); },
    async createSession() { throw new Error("not used"); },
    async sendText() {
      calls.sendText += 1;
      throw new Error("not used");
    },
    async runSessionCommand() {
      calls.runSessionCommand += 1;
      throw new Error("not used");
    },
    async submitPendingPrompt() { throw new Error("not used"); },
    async cancelSession() { throw new Error("not used"); },
    async refreshSessionMetadata() { throw new Error("not used"); },
  } as unknown as ApplicationUseCases & {
    __calls: {
      getActiveAgent: number;
      setActiveAgent: number;
      sendText: number;
      runSessionCommand: number;
    };
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

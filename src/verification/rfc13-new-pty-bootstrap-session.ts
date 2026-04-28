import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import TelegramBot from "node-telegram-bot-api";
import { createTelegramRouter, TELEGRAM_ROUTER_AUTH_SOURCE, type TelegramRouterAuthContext } from "../adapters/telegram/router";
import { createApplicationUseCases } from "../application/use-cases";
import {
  ADAPTER_ERROR_CODES,
  type BootstrapSessionInput,
  type CancelOrInterruptResult,
  type ObserveSessionResult,
  type OpenCodeSessionAdapter,
  type PersistenceDriver,
  type Result,
  type SendResult,
  type SessionState,
  type SubmitPromptInputResult,
} from "../application/contracts";
import { type Config, OPEN_CODE_ADAPTER_MODE, STATE_DRIVERS } from "../config";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { PROJECT_SESSION_ASSOCIATION, PROJECT_SESSION_INSPECTION_RESULT_KIND } from "../infrastructure/opencode-project-sessions";
import { BOOTSTRAP_RESOLUTION_KIND, resolveBootstrapSessionCandidate } from "../infrastructure/opencode-session-bootstrap";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";

class FakeBot {
  readonly messages: Array<{ readonly chatId: number; readonly text: string; readonly options?: TelegramBot.SendMessageOptions }> = [];
  readonly callbacks: Array<{ readonly id: string; readonly text?: string }> = [];

  async sendMessage(chatId: number, text: string, options?: TelegramBot.SendMessageOptions): Promise<TelegramBot.Message> {
    this.messages.push({ chatId, text, options });
    return { message_id: this.messages.length, chat: { id: chatId, type: "private" } } as TelegramBot.Message;
  }

  async answerCallbackQuery(id: string, options?: TelegramBot.AnswerCallbackQueryOptions): Promise<boolean> {
    this.callbacks.push({ id, text: options?.text });
    return true;
  }
}

class FakeAdapter implements OpenCodeSessionAdapter {
  bootstrapCalls = 0;
  readonly prompts: string[] = [];

  constructor(private readonly bootstrappedSessionId = "sess_new") {}

  async resolveProject(input: { readonly projectId: string; readonly rootPath: string }): Promise<Result<{ readonly canonicalPath: string }>> {
    return ok({ canonicalPath: input.rootPath });
  }

  async bootstrapSession(input: BootstrapSessionInput): Promise<Result<SessionState>> {
    this.bootstrapCalls += 1;
    this.prompts.push(input.initialPrompt);
    assert.equal(input.initialPrompt, "arrancá con este contexto");
    return ok({ projectId: input.projectId, sessionId: this.bootstrappedSessionId, status: "idle" });
  }

  async createSession(input: { readonly projectId: string }): Promise<Result<SessionState>> {
    return ok({ projectId: input.projectId, sessionId: "sess_legacy", status: "idle" });
  }

  async attachSession(input: { readonly projectId: string; readonly sessionId: string }): Promise<Result<SessionState>> {
    return ok({ projectId: input.projectId, sessionId: input.sessionId, status: "idle" });
  }

  async sendMessage(input: { readonly projectId: string; readonly sessionId: string }): Promise<Result<SendResult>> {
    return ok({ message: "ok", state: { projectId: input.projectId, sessionId: input.sessionId, status: "idle" } });
  }

  async runCommand(input: { readonly projectId: string; readonly sessionId: string }): Promise<Result<SendResult>> {
    return this.sendMessage(input);
  }

  async getSessionState(input: { readonly projectId: string; readonly sessionId: string }): Promise<Result<SessionState>> {
    return ok({ projectId: input.projectId, sessionId: input.sessionId, status: "idle" });
  }

  async cancelOrInterrupt(): Promise<Result<CancelOrInterruptResult>> {
    return ok({ status: "accepted", message: "ok" });
  }

  async observeSession(): Promise<Result<ObserveSessionResult>> {
    return ok({ mode: "not-available-yet" });
  }

  async submitPromptInput(): Promise<Result<SubmitPromptInputResult>> {
    return ok({ status: "accepted" });
  }
}

async function verifyPureCandidateResolution(): Promise<void> {
  const projectPath = "/repo/app";
  const resolveCanonicalProjectPathFn = async (target: string) => path.resolve(target);
  const before = [{ id: "sess_old", path: projectPath }];

  const exactOne = await resolveBootstrapSessionCandidate({
    before,
    after: [...before, { id: "sess_new", path: projectPath }],
    projectPath,
    resolveCanonicalProjectPathFn,
  });
  assert.equal(exactOne.kind, BOOTSTRAP_RESOLUTION_KIND.FOUND);

  const zero = await resolveBootstrapSessionCandidate({
    before,
    after: before,
    projectPath,
    resolveCanonicalProjectPathFn,
  });
  assert.equal(zero.kind, BOOTSTRAP_RESOLUTION_KIND.NONE);

  const multiple = await resolveBootstrapSessionCandidate({
    before,
    after: [...before, { id: "sess_a", path: projectPath }, { id: "sess_b", path: path.join(projectPath, "nested") }],
    projectPath,
    resolveCanonicalProjectPathFn,
  });
  assert.equal(multiple.kind, BOOTSTRAP_RESOLUTION_KIND.AMBIGUOUS);

  const mismatch = await resolveBootstrapSessionCandidate({
    before,
    after: [...before, { id: "sess_other", path: "/other/app" }],
    projectPath,
    resolveCanonicalProjectPathFn,
  });
  assert.equal(mismatch.kind, BOOTSTRAP_RESOLUTION_KIND.NONE);

  const nested = await resolveBootstrapSessionCandidate({
    before,
    after: [...before, { id: "sess_nested", path: path.join(projectPath, "packages/pkg") }],
    projectPath,
    resolveCanonicalProjectPathFn,
  });
  assert.equal(nested.kind, BOOTSTRAP_RESOLUTION_KIND.FOUND);
}

async function verifyBootstrapPersistsAndBinds(): Promise<void> {
  await withContext(async ({ adapter, persistence, useCases }) => {
    await seedProject(useCases);
    assert.ok(useCases.bootstrapSessionCandidate);
    const created = await useCases.bootstrapSessionCandidate({
      chatId: "1001",
      initialPrompt: "arrancá con este contexto",
    });
    assert.equal(created.ok, true);
    assert.equal(adapter.bootstrapCalls, 1);

    const state = await persistence.runInTransaction(async (unit) => ({
      session: await unit.sessions.findById("sess_new"),
      binding: await unit.bindings.findByChatId("1001"),
    }));

    assert.equal(state.session?.sessionId, "sess_new");
    assert.equal(state.binding?.activeSessionId, "sess_new");
  });
}

async function verifyRouterNewWithInitialPromptAutoBinds(): Promise<void> {
  await withContext(async ({ adapter, bot, persistence, router, useCases }) => {
    await seedProject(useCases);
    await router.handleMessage(createMessage("1001", "/new arrancá con este contexto"), createAuthContext());

    const firstMessage = bot.messages[0];
    assert.equal(firstMessage?.text.includes("Sesión creada y vinculada"), true);
    assert.equal(firstMessage?.options?.reply_markup, undefined);
    assert.deepEqual(adapter.prompts, ["arrancá con este contexto"]);

    const binding = await persistence.runInTransaction((unit) => unit.bindings.findByChatId("1001"));
    assert.equal(binding?.activeSessionId, "sess_new");
  });
}

async function verifyRejectsNewWithoutArgs(): Promise<void> {
  await withContext(async ({ adapter, bot, router, useCases }) => {
    await seedProject(useCases);
    await router.handleMessage(createMessage("1001", "/new"), createAuthContext());
    assert.equal(adapter.bootstrapCalls, 0);
    assert.equal(bot.messages[0]?.text, "Usá /new &lt;mensaje inicial&gt;");
  });
}

async function withContext(
  work: (input: {
    readonly adapter: FakeAdapter;
    readonly bot: FakeBot;
    readonly persistence: PersistenceDriver;
    readonly useCases: ReturnType<typeof createApplicationUseCases>;
    readonly router: ReturnType<typeof createTelegramRouter>;
  }) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc13-"));
  const config = createVerificationConfig(tempDir);
  const persistence = await createJsonPersistenceDriver(config);
  const adapter = new FakeAdapter();
  const useCases = createApplicationUseCases({ persistence, adapter });
  const bot = new FakeBot();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    persistence,
    compatRunCmdCommands: false,
    openCodeAdapterMode: OPEN_CODE_ADAPTER_MODE.PTY,
    inspectProjectSessionsFn: async (input) => ({
      kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
      projectPath: input.projectPath,
      sessions: [{ sessionId: "sess_new", association: PROJECT_SESSION_ASSOCIATION.MATCH }],
    }),
  });

  try {
    await work({ adapter, bot, persistence, useCases, router });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function createVerificationConfig(tempDir: string): Config {
  return {
    telegramBotToken: "token",
    allowedUserIds: ["42"],
    openCodeUrl: "http://localhost:3000/opencode/query",
    openCodeToken: "token",
    openCodeAdapter: OPEN_CODE_ADAPTER_MODE.PTY,
    openCodeTimeoutMs: 1000,
    openCodeControlTimeoutMs: 1000,
    openCodeExecTimeoutMs: 1000,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath: path.join(tempDir, "state.json"),
    compatLegacyTextBridge: true,
    compatRunCmdCommands: false,
    bootRemoteReconcile: false,
    chatLockEnabled: false,
    lockWarnWaitMs: 100,
    watcherEnabled: false,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4045,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: 1000,
    watchdogMaxRetryCount: 1,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 1000,
  };
}

async function seedProject(useCases: ReturnType<typeof createApplicationUseCases>): Promise<void> {
  const selected = await useCases.selectProject({ chatId: "1001", selector: "proj", rootPath: "/tmp/proj" });
  assert.equal(selected.ok, true);
}

function createAuthContext(): TelegramRouterAuthContext {
  return { authorized: true, actorId: "42", source: TELEGRAM_ROUTER_AUTH_SOURCE.HANDLERS };
}

function createMessage(chatId: string, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(chatId), type: "private" },
    from: { id: 42, is_bot: false, first_name: "Test" },
    text,
  } as TelegramBot.Message;
}

function createCallback(chatId: string, id: string, data: string): TelegramBot.CallbackQuery {
  return {
    id,
    from: { id: 42, is_bot: false, first_name: "Test" },
    chat_instance: "chat-instance",
    data,
    message: {
      message_id: 9,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: "private" },
      text: "callback",
    } as TelegramBot.Message,
  } as TelegramBot.CallbackQuery;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err(code: (typeof ADAPTER_ERROR_CODES)[keyof typeof ADAPTER_ERROR_CODES], message: string): Result<never> {
  return { ok: false, error: new DomainError(ERROR_CODES.VALIDATION_ERROR, message, { details: { adapterCode: code } }) };
}

async function main(): Promise<void> {
  await verifyPureCandidateResolution();
  await verifyBootstrapPersistsAndBinds();
  await verifyRouterNewWithInitialPromptAutoBinds();
  await verifyRejectsNewWithoutArgs();
  console.log("RFC-013 verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

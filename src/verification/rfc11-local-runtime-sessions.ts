import assert from "node:assert/strict";
import TelegramBot from "node-telegram-bot-api";
import {
  ApplicationUseCases,
  CancelSessionOutput,
  RunSessionCommandOutput,
  SelectProjectOutput,
  SendTextOutput,
  SessionOutput,
  StatusOutput,
  SubmitPendingPromptOutput,
  SUBMIT_PENDING_PROMPT_RESULT_STATUS,
} from "../application/use-cases";
import {
  PersistenceDriver,
  PersistenceUnit,
  Result,
} from "../application/contracts";
import { createTelegramRouter } from "../adapters/telegram/router";
import { createCallbackQueryHandler, createMessageHandler } from "../handlers";
import { Config, STATE_DRIVERS } from "../config";
import {
  inspectProjectSessions,
  PROJECT_SESSION_ASSOCIATION,
  PROJECT_SESSION_INSPECTION_RESULT_KIND,
} from "../infrastructure/opencode-project-sessions";
import { PENDING_PROMPT_STATUS, Project } from "../domain/entities";
import { OpenCodeCliSessionListItem, parseOpenCodeCliSessionList } from "../infrastructure/opencode-cli";
import { OPEN_CODE_ADAPTER_MODE } from "../infrastructure/opencode-adapter-mode";

class FakeBot {
  readonly messages: Array<{ readonly chatId: number; readonly text: string; readonly options?: TelegramBot.SendMessageOptions }> = [];
  readonly callbacks: Array<{ readonly id: string; readonly text?: string }> = [];

  async sendMessage(
    chatId: number,
    text: string,
    options?: TelegramBot.SendMessageOptions
  ): Promise<TelegramBot.Message> {
    this.messages.push({ chatId, text, options });
    return { message_id: this.messages.length, chat: { id: chatId, type: "private" } } as TelegramBot.Message;
  }

  async answerCallbackQuery(id: string, options?: TelegramBot.AnswerCallbackQueryOptions): Promise<boolean> {
    this.callbacks.push({ id, text: options?.text });
    return true;
  }
}

class FakeUseCases implements ApplicationUseCases {
  readonly calls = {
    attachSession: 0,
  };

  status: StatusOutput = {
    mode: "idle",
    projectId: "/mnt/d/Proyectos/telegram-opencode",
    projectAlias: "/mnt/d/Proyectos/telegram-opencode",
  };

  async selectProject(_input: { chatId: string; selector: string; rootPath?: string }): Promise<Result<SelectProjectOutput>> {
    return ok({ projectId: "proj-demo", alias: "proj-demo" });
  }

  async attachSession(input: { chatId: string; sessionId: string }): Promise<Result<SessionOutput>> {
    this.calls.attachSession += 1;
    return ok({ projectId: this.status.projectId ?? "proj-demo", sessionId: input.sessionId });
  }

  async createSession(_input: { chatId: string }): Promise<Result<SessionOutput>> {
    return ok({ projectId: "proj-demo", sessionId: "sess-demo" });
  }

  async sendText(_input: { chatId: string; text: string }): Promise<Result<SendTextOutput>> {
    return ok({
      projectId: "proj-demo",
      sessionId: "sess-demo",
      message: "ok",
      needsAttention: false,
      state: { projectId: "proj-demo", sessionId: "sess-demo", status: "idle" },
    });
  }

  async runSessionCommand(_input: { chatId: string; command: string }): Promise<Result<RunSessionCommandOutput>> {
    return ok({
      projectId: "proj-demo",
      sessionId: "sess-demo",
      message: "ok",
      needsAttention: false,
      state: { projectId: "proj-demo", sessionId: "sess-demo", status: "idle" },
    });
  }

  async submitPendingPrompt(_input: {
    chatId: string;
    sessionId: string;
    promptId: string;
    choice?: string;
    text?: string;
    callbackQueryId?: string;
  }): Promise<Result<SubmitPendingPromptOutput>> {
    return ok({
      projectId: "proj-demo",
      sessionId: "sess-demo",
      promptId: "prompt-demo",
      status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT,
      promptStatus: PENDING_PROMPT_STATUS.INVALIDATED,
      reason: "verification",
    });
  }

  async cancelSession(_input: { chatId: string }): Promise<Result<CancelSessionOutput>> {
    return ok({ projectId: "proj-demo", sessionId: "sess-demo", status: "accepted", message: "ok" });
  }

  async getStatus(_chatId: string): Promise<Result<StatusOutput>> {
    return ok(this.status);
  }
}

class FakePersistence implements PersistenceDriver {
  constructor(private readonly project?: Project) {}

  async runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T> {
    const project = this.project;
    return work({
      projects: {
        async findById(projectId: string) {
          return project?.projectId === projectId ? project : undefined;
        },
        async findByAlias(alias: string) {
          return project?.alias === alias ? project : undefined;
        },
        async listAll() {
          return project ? [project] : [];
        },
        async upsert() {},
        async markLastUsed() {},
      },
      sessions: {
        async findById() {
          return undefined;
        },
        async findByProjectId() {
          return [];
        },
        async listAll() {
          return [];
        },
        async upsert() {},
      },
      bindings: {
        async findByChatId() {
          if (!project) {
            return { chatId: "1101", updatedAt: new Date().toISOString() };
          }

          return {
            chatId: "1101",
            activeProjectId: project.projectId,
            updatedAt: new Date().toISOString(),
          };
        },
        async listAll() {
          return [];
        },
        async upsert() {},
      },
      states: {
        async findByChatId() {
          return undefined;
        },
        async listAll() {
          return [];
        },
        async upsert() {},
      },
      tasks: {
        async findById() {
          return undefined;
        },
        async findInProgressBySessionId() {
          return undefined;
        },
        async listAll() {
          return [];
        },
        async upsert() {},
      },
      pendingPrompts: {
        async compareAndSetStatus() {
          return undefined;
        },
        async findByPromptId() {
          return undefined;
        },
        async findActiveBySessionId() {
          return undefined;
        },
        async listAll() {
          return [];
        },
        async upsert() {},
      },
    });
  }
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function createMessage(chatId: string, text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(chatId), type: "private" },
    from: { id: 1, is_bot: false, first_name: "Test" },
    text,
  } as TelegramBot.Message;
}

function createCallback(chatId: string, id: string, data: string): TelegramBot.CallbackQuery {
  return {
    id,
    from: { id: 1, is_bot: false, first_name: "Test" },
    chat_instance: "chat-instance",
    data,
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(chatId), type: "private" },
      text: "callback",
    } as TelegramBot.Message,
  } as TelegramBot.CallbackQuery;
}

async function main(): Promise<void> {
  await verifyCliSessionListParserAcceptsRealJsonShape();
  await verifyInspectProjectSessionsClassifiesCanonicalPaths();
  await verifySesionesRequiresProject();
  await verifySesionesRendersSafeProjectSessions();
  await verifySesionesRendersDebugWhenEmpty();
  await verifySesionAliasRendersSameSessionsFlow();
  await verifySesionGuidanceWhenAliasDisabled();
  await verifySessionPaginationContract();
  await verifySessionPaginationBoundaryNavigation();
  await verifyHandlersShareRouterInstanceForSessionSelectionFlow();
  await verifySelectionThenConfirmationAttachesSession();
  await verifyCancellationKeepsCurrentBinding();
  await verifyConfirmationRevalidatesMissingSession();
  await verifyConfirmationRevalidatesProjectMismatch();
  await verifyHelpAndLegacyCommandsReflectPtyOnlyFlow();

  console.log("RFC-011 PTY session selection verification passed");
}

async function verifyCliSessionListParserAcceptsRealJsonShape(): Promise<void> {
  const sessions = parseOpenCodeCliSessionList(
    JSON.stringify([
      {
        id: "sess-real",
        title: "Feature A",
        updated: "2026-04-25T12:00:00.000Z",
        created: "2026-04-24T08:30:00.000Z",
        projectId: "proj-demo",
        directory: "/mnt/d/Proyectos/telegram-opencode",
      },
    ])
  );

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "sess-real");
  assert.equal(sessions[0]?.title, "Feature A");
  assert.equal(sessions[0]?.path, "/mnt/d/Proyectos/telegram-opencode");
  assert.equal(sessions[0]?.createdAt, "2026-04-24T08:30:00.000Z");
  assert.equal(sessions[0]?.updatedAt, "2026-04-25T12:00:00.000Z");
}

async function verifyInspectProjectSessionsClassifiesCanonicalPaths(): Promise<void> {
  const inspection = await inspectProjectSessions({
    projectPath: "/workspace/project",
    cwd: "/workspace/project",
    timeoutMs: 500,
    cliOps: {
      listSessions: async () => [
        { id: "sess-root", path: "/workspace/project" },
        { id: "sess-child", path: "/workspace/project/packages/bot" },
        { id: "sess-other", path: "/workspace/other" },
        { id: "sess-missing" },
        { id: "sess-bad", path: "/workspace/broken" },
      ] satisfies readonly OpenCodeCliSessionListItem[],
      resolveCanonicalProjectPath: async (inputPath: string) => {
        const canonicalPaths = {
          "/workspace/project": "/workspace/project",
          "/workspace/project/packages/bot": "/workspace/project/packages/bot",
          "/workspace/other": "/workspace/other",
        } as const satisfies Record<string, string>;

        const canonicalPath = canonicalPaths[inputPath as keyof typeof canonicalPaths];
        if (!canonicalPath) {
          throw new Error(`Cannot canonicalize ${inputPath}`);
        }

        return canonicalPath;
      },
    },
  });

  assert.equal(inspection.kind, PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS);
  if (inspection.kind !== PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS) {
    throw new Error("La inspección debía ser exitosa");
  }

  assert.deepEqual(
    inspection.sessions.map((session) => ({
      sessionId: session.sessionId,
      association: session.association,
    })),
    [
      { sessionId: "sess-bad", association: PROJECT_SESSION_ASSOCIATION.UNSAFE },
      { sessionId: "sess-child", association: PROJECT_SESSION_ASSOCIATION.MATCH },
      { sessionId: "sess-missing", association: PROJECT_SESSION_ASSOCIATION.UNSAFE },
      { sessionId: "sess-other", association: PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH },
      { sessionId: "sess-root", association: PROJECT_SESSION_ASSOCIATION.MATCH },
    ]
  );
}

async function verifySesionesRequiresProject(): Promise<void> {
  const bot = new FakeBot();
  const router = createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases: new FakeUseCases(),
    persistence: new FakePersistence(),
    compatRunCmdCommands: false,
  });

  await router.handleMessage(createMessage("1101", "/sesiones"));

  assert.match(bot.messages[0]?.text ?? "", /Primero seleccioná un proyecto con \/project/);
}

async function verifySesionesRendersSafeProjectSessions(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithInspectorFromCliRaw(bot, JSON.stringify([
    {
      id: "sess-root",
      directory: "/mnt/d/Proyectos/telegram-opencode",
      title: "Root",
      updated: "2026-04-25T12:00:00.000Z",
    },
    {
      id: "sess-child",
      directory: "/mnt/d/Proyectos/telegram-opencode/src",
      title: "Feature A",
      updated: "2026-04-25T11:00:00.000Z",
    },
    {
      id: "sess-other",
      directory: "/mnt/d/Proyectos/otro-proyecto",
      title: "Other",
    },
    {
      id: "sess-unsafe",
      title: "Missing directory",
    },
    {
      id: "sess-bad",
      directory: "/mnt/d/Proyectos/invalido",
    },
  ]));

  await router.handleMessage(createMessage("1101", "/sesiones"));

  const rendered = bot.messages[0];
  assert.match(rendered?.text ?? "", /Sesiones del proyecto actual/);
  assert.match(rendered?.text ?? "", /Root/);
  assert.match(rendered?.text ?? "", /Feature A/);
  assert.doesNotMatch(rendered?.text ?? "", /sess-other/);
  assert.doesNotMatch(rendered?.text ?? "", /sess-unsafe/);
  assert.doesNotMatch(rendered?.text ?? "", /sess-bad/);
  const keyboard = rendered?.options?.reply_markup as TelegramBot.InlineKeyboardMarkup | undefined;
  assert.equal(keyboard?.inline_keyboard.length, 2);
  assert.match(readFirstButtonCallbackData(rendered), /^sess:sel:[a-f0-9]{12}$/u);
}

async function verifySesionesRendersDebugWhenEmpty(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithCustomInspector(bot, new FakeUseCases(), async () => ({
    kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
    projectPath: "/mnt/d/Proyectos/telegram-opencode",
    sessions: [
      { sessionId: "sess-other", path: "/mnt/d/Proyectos/otro-proyecto", association: PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH },
      { sessionId: "sess-unsafe", association: PROJECT_SESSION_ASSOCIATION.UNSAFE },
    ],
  }));

  await router.handleMessage(createMessage("1101", "/sesiones"));

  const rendered = bot.messages[0];
  assert.match(rendered?.text ?? "", /No encontré sesiones disponibles/);
  assert.match(rendered?.text ?? "", /Debug vacío \/sesiones/);
  assert.match(rendered?.text ?? "", /rootPath comparado:/);
  assert.match(rendered?.text ?? "", /MATCH=0 PROJECT_MISMATCH=1 UNSAFE=1/);
  assert.match(rendered?.text ?? "", /sess-other \| project-mismatch \| \/mnt\/d\/Proyectos\/otro-proyecto/);
  assert.match(rendered?.text ?? "", /sess-unsafe \| unsafe \| sin path/);
}

async function verifySesionAliasRendersSameSessionsFlow(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithInspectorFromCliRaw(bot, JSON.stringify([
    {
      id: "sess-root",
      directory: "/mnt/d/Proyectos/telegram-opencode",
      title: "Root",
    },
  ]));

  await router.handleMessage(createMessage("1101", "/sesion"));

  const rendered = bot.messages[0];
  assert.match(rendered?.text ?? "", /Sesiones del proyecto actual/);
  assert.match(rendered?.text ?? "", /Root/);
  assert.match(readFirstButtonCallbackData(rendered), /^sess:sel:[a-f0-9]{12}$/u);
}

async function verifySesionGuidanceWhenAliasDisabled(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithSessions(
    bot,
    [{ sessionId: "sess-root", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Root" }],
    new FakeUseCases(),
    { sesionAliasEnabled: false }
  );

  await router.handleMessage(createMessage("1101", "/sesion"));

  const rendered = bot.messages[0];
  assert.match(rendered?.text ?? "", /\/sesion/);
  assert.match(rendered?.text ?? "", /\/sesiones/);
  assert.equal(rendered?.options?.reply_markup, undefined);
}

async function verifySessionPaginationContract(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithSessions(bot, [
    { sessionId: "sess-01", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Uno" },
    { sessionId: "sess-02", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Dos" },
    { sessionId: "sess-03", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Tres" },
    { sessionId: "sess-04", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Cuatro" },
    { sessionId: "sess-05", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Cinco" },
    { sessionId: "sess-06", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Seis" },
    { sessionId: "sess-07", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Siete" },
  ]);

  await router.handleMessage(createMessage("1101", "/sesiones"));
  const firstPage = bot.messages[0];
  assertPageSessionItemCountAtMost(firstPage, 5);
  const firstPagePagerPayloads = readPaginationCallbackData(firstPage);
  assert.ok(firstPagePagerPayloads.length > 0, "Se esperaban controles de paginación sesspg:<page>");
  firstPagePagerPayloads.forEach((payload) => assert.match(payload, /^sesspg:\d+$/u));

  const goNextPayload = firstPagePagerPayloads.find((payload) => payload !== "sesspg:0") ?? firstPagePagerPayloads[0];
  assert.ok(goNextPayload, "No se pudo resolver callback para navegar páginas");

  await router.handleCallbackQuery(createCallback("1101", "cb-pg-1", goNextPayload));
  const secondPage = bot.messages[1];
  assertPageSessionItemCountAtMost(secondPage, 5);
  const secondPagePagerPayloads = readPaginationCallbackData(secondPage);
  assert.ok(secondPagePagerPayloads.length > 0, "Segunda página debe mantener controles de paginación");
  secondPagePagerPayloads.forEach((payload) => assert.match(payload, /^sesspg:\d+$/u));
}

async function verifySessionPaginationBoundaryNavigation(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithSessions(bot, [
    { sessionId: "sess-01", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Uno" },
    { sessionId: "sess-02", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Dos" },
    { sessionId: "sess-03", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Tres" },
    { sessionId: "sess-04", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Cuatro" },
    { sessionId: "sess-05", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Cinco" },
    { sessionId: "sess-06", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Seis" },
  ]);

  await router.handleMessage(createMessage("1101", "/sesiones"));
  await router.handleCallbackQuery(createCallback("1101", "cb-boundary-last", "sesspg:999"));
  const clampedLastPage = bot.messages[1];
  assertPageSessionItemCountAtMost(clampedLastPage, 5);
  assert.match(clampedLastPage?.text ?? "", /Seis/u);

  await router.handleCallbackQuery(createCallback("1101", "cb-boundary-first", "sesspg:0"));
  const clampedFirstPage = bot.messages[2];
  assertPageSessionItemCountAtMost(clampedFirstPage, 5);
  assert.match(clampedFirstPage?.text ?? "", /Uno/u);
}

async function verifySelectionThenConfirmationAttachesSession(): Promise<void> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();
  const sessions = [{ sessionId: "sess-ok", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Feature A" }];
  const router = createRouterWithSessions(bot, sessions, useCases);

  await router.handleMessage(createMessage("1101", "/sesiones"));
  const selectData = readFirstButtonCallbackData(bot.messages[0]);
  await router.handleCallbackQuery(createCallback("1101", "cb-1", selectData));

  assert.match(bot.messages[1]?.text ?? "", /Confirmar vinculación/);
  const confirmData = readFirstButtonCallbackData(bot.messages[1]);

  await router.handleCallbackQuery(createCallback("1101", "cb-2", confirmData));

  assert.equal(useCases.calls.attachSession, 1);
  assert.match(bot.messages[2]?.text ?? "", /Sesión vinculada/);
  assert.match(bot.messages[2]?.text ?? "", /sess-ok/);
}

async function verifyHandlersShareRouterInstanceForSessionSelectionFlow(): Promise<void> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();
  const inspectProjectSessionsFn: typeof inspectProjectSessions = async () => ({
    kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
    projectPath: "/mnt/d/Proyectos/telegram-opencode",
    sessions: [{ sessionId: "sess-ok", association: PROJECT_SESSION_ASSOCIATION.MATCH, title: "Feature A" }],
  });

  const deps = {
    bot: bot as unknown as TelegramBot,
    useCases,
    persistence: new FakePersistence({
      projectId: "/mnt/d/Proyectos/telegram-opencode",
      alias: "/mnt/d/Proyectos/telegram-opencode",
      rootPath: "/mnt/d/Proyectos/telegram-opencode",
      createdAt: new Date().toISOString(),
    }),
    config: createHandlerConfig(),
    inspectProjectSessionsFn,
  } satisfies {
    bot: TelegramBot;
    useCases: FakeUseCases;
    persistence: FakePersistence;
    config: Config;
    inspectProjectSessionsFn: typeof inspectProjectSessions;
  };

  const messageHandler = createMessageHandler(deps);
  const callbackQueryHandler = createCallbackQueryHandler(deps);

  await messageHandler(createMessage("1101", "/sesiones"));
  const selectData = readFirstButtonCallbackData(bot.messages[0]);

  await callbackQueryHandler(createCallback("1101", "cb-handlers-1", selectData));
  assert.match(bot.messages[1]?.text ?? "", /Confirmar vinculación/);

  const confirmData = readFirstButtonCallbackData(bot.messages[1]);
  await callbackQueryHandler(createCallback("1101", "cb-handlers-2", confirmData));

  assert.equal(useCases.calls.attachSession, 1);
  assert.match(bot.messages[2]?.text ?? "", /Sesión vinculada/);
  assert.match(bot.messages[2]?.text ?? "", /sess-ok/);
}

async function verifyCancellationKeepsCurrentBinding(): Promise<void> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();
  const router = createRouterWithSessions(bot, [
    { sessionId: "sess-ok", association: PROJECT_SESSION_ASSOCIATION.MATCH },
  ], useCases);

  await router.handleMessage(createMessage("1101", "/sesiones"));
  await router.handleCallbackQuery(createCallback("1101", "cb-3", readFirstButtonCallbackData(bot.messages[0])));
  const cancelData = readButtonCallbackData(bot.messages[1], 1);

  await router.handleCallbackQuery(createCallback("1101", "cb-4", cancelData));

  assert.equal(useCases.calls.attachSession, 0);
  assert.equal(bot.messages[2]?.text, "ℹ️ Vinculación cancelada. La sesión actual del chat no cambió.");
}

async function verifyConfirmationRevalidatesMissingSession(): Promise<void> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();
  let attempt = 0;
  const router = createRouterWithCustomInspector(bot, useCases, async () => {
    attempt += 1;
    return {
      kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
      projectPath: "/mnt/d/Proyectos/telegram-opencode",
      sessions: attempt === 1
        ? [{ sessionId: "sess-ok", association: PROJECT_SESSION_ASSOCIATION.MATCH }]
        : [],
    };
  });

  await router.handleMessage(createMessage("1101", "/sesiones"));
  await router.handleCallbackQuery(createCallback("1101", "cb-5", readFirstButtonCallbackData(bot.messages[0])));
  await router.handleCallbackQuery(createCallback("1101", "cb-6", readFirstButtonCallbackData(bot.messages[1])));

  assert.equal(bot.messages[2]?.text, "🔴 La sesión seleccionada ya no está disponible. Volvé a ejecutar /sesiones.");
  assert.equal(useCases.calls.attachSession, 0);
}

async function verifyConfirmationRevalidatesProjectMismatch(): Promise<void> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();
  let attempt = 0;
  const router = createRouterWithCustomInspector(bot, useCases, async () => {
    attempt += 1;
    return {
      kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
      projectPath: "/mnt/d/Proyectos/telegram-opencode",
      sessions: [{
        sessionId: "sess-ok",
        association: attempt === 1 ? PROJECT_SESSION_ASSOCIATION.MATCH : PROJECT_SESSION_ASSOCIATION.PROJECT_MISMATCH,
      }],
    };
  });

  await router.handleMessage(createMessage("1101", "/sesiones"));
  await router.handleCallbackQuery(createCallback("1101", "cb-7", readFirstButtonCallbackData(bot.messages[0])));
  await router.handleCallbackQuery(createCallback("1101", "cb-8", readFirstButtonCallbackData(bot.messages[1])));

  assert.equal(bot.messages[2]?.text, "🔴 La sesión seleccionada no coincide con el proyecto activo de este chat.");
  assert.equal(useCases.calls.attachSession, 0);
}

async function verifyHelpAndLegacyCommandsReflectPtyOnlyFlow(): Promise<void> {
  const bot = new FakeBot();
  const router = createRouterWithSessions(bot, [{ sessionId: "sess-ok", association: PROJECT_SESSION_ASSOCIATION.MATCH }]);

  await router.handleMessage(createMessage("1101", "/help"));
  assert.match(bot.messages[0]?.text ?? "", /\/sesiones/);
  assert.doesNotMatch(bot.messages[0]?.text ?? "", /\/new/);

  await router.handleMessage(createMessage("1101", "/new"));
  assert.ok((bot.messages[1]?.text ?? "").length > 0);

  await router.handleMessage(createMessage("1101", "/run ls"));
  assert.ok((bot.messages[2]?.text ?? "").length > 0);
}

function createRouterWithSessions(
  bot: FakeBot,
  sessions: readonly {
    readonly sessionId: string;
    readonly association: (typeof PROJECT_SESSION_ASSOCIATION)[keyof typeof PROJECT_SESSION_ASSOCIATION];
    readonly title?: string;
    readonly updatedAt?: string;
  }[],
  useCases = new FakeUseCases(),
  options?: {
    readonly sesionAliasEnabled?: boolean;
  }
) {
  return createRouterWithCustomInspector(bot, useCases, async () => ({
    kind: PROJECT_SESSION_INSPECTION_RESULT_KIND.SUCCESS,
    projectPath: "/mnt/d/Proyectos/telegram-opencode",
    sessions,
  }), options);
}

function createHandlerConfig(): Config {
  return {
    telegramBotToken: "token",
    allowedUserIds: ["1"],
    openCodeUrl: "http://localhost/opencode/query",
    openCodeToken: "token",
    openCodeAdapter: OPEN_CODE_ADAPTER_MODE.PTY,
    openCodeTimeoutMs: 1_000,
    openCodeControlTimeoutMs: 1_000,
    openCodeExecTimeoutMs: 1_000,
    pollingIntervalMs: 1_500,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "./data/test.sqlite",
    stateJsonPath: "./data/test.json",
    compatLegacyTextBridge: false,
    compatRunCmdCommands: false,
    bootRemoteReconcile: false,
    chatLockEnabled: true,
    lockWarnWaitMs: 1_500,
    watcherEnabled: false,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4_040,
    webhookPortEnd: 4_045,
    watchdogIntervalMs: 15_000,
    watchdogStaleAfterMs: 60_000,
    watchdogMaxRetryCount: 3,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300_000,
  };
}

function createRouterWithInspectorFromCli(
  bot: FakeBot,
  sessions: readonly OpenCodeCliSessionListItem[],
  useCases = new FakeUseCases()
) {
  return createRouterWithCustomInspector(bot, useCases, async () =>
    inspectProjectSessions({
      projectPath: "/mnt/d/Proyectos/telegram-opencode",
      cwd: "/mnt/d/Proyectos/telegram-opencode",
      timeoutMs: 500,
      cliOps: {
        listSessions: async () => sessions,
        resolveCanonicalProjectPath: async (inputPath: string) => {
          const canonicalPaths = {
            "/mnt/d/Proyectos/telegram-opencode": "/mnt/d/Proyectos/telegram-opencode",
            "/mnt/d/Proyectos/telegram-opencode/src": "/mnt/d/Proyectos/telegram-opencode/src",
            "/mnt/d/Proyectos/otro-proyecto": "/mnt/d/Proyectos/otro-proyecto",
          } as const satisfies Record<string, string>;

          const canonicalPath = canonicalPaths[inputPath as keyof typeof canonicalPaths];
          if (!canonicalPath) {
            throw new Error(`Cannot canonicalize ${inputPath}`);
          }

          return canonicalPath;
        },
      },
    })
  );
}

function createRouterWithInspectorFromCliRaw(
  bot: FakeBot,
  raw: string,
  useCases = new FakeUseCases()
) {
  return createRouterWithInspectorFromCli(bot, parseOpenCodeCliSessionList(raw), useCases);
}

function createRouterWithCustomInspector(
  bot: FakeBot,
  useCases: FakeUseCases,
  inspectProjectSessionsFn: typeof inspectProjectSessions,
  options?: {
    readonly sesionAliasEnabled?: boolean;
  }
) {
  return createTelegramRouter({
    bot: bot as unknown as TelegramBot,
    useCases,
    persistence: new FakePersistence({
      projectId: "/mnt/d/Proyectos/telegram-opencode",
      alias: "/mnt/d/Proyectos/telegram-opencode",
      rootPath: "/mnt/d/Proyectos/telegram-opencode",
      createdAt: new Date().toISOString(),
    }),
    compatRunCmdCommands: false,
    inspectProjectSessionsFn,
    sesionAliasEnabled: options?.sesionAliasEnabled,
  });
}

function readFirstButtonCallbackData(message: { readonly options?: TelegramBot.SendMessageOptions } | undefined): string {
  return readButtonCallbackData(message, 0);
}

function readButtonCallbackData(
  message: { readonly options?: TelegramBot.SendMessageOptions } | undefined,
  buttonIndex: number
): string {
  const keyboard = message?.options?.reply_markup as TelegramBot.InlineKeyboardMarkup | undefined;
  const callbackData = keyboard?.inline_keyboard[0]?.[buttonIndex]?.callback_data;
  assert.ok(callbackData, "callback_data requerido para la verificación");
  return callbackData;
}

function readPaginationCallbackData(
  message: { readonly options?: TelegramBot.SendMessageOptions } | undefined
): string[] {
  const keyboard = message?.options?.reply_markup as TelegramBot.InlineKeyboardMarkup | undefined;
  if (!keyboard) {
    return [];
  }

  const result: string[] = [];
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      if (button.callback_data?.startsWith("sesspg:")) {
        result.push(button.callback_data);
      }
    }
  }

  return result;
}

function assertPageSessionItemCountAtMost(
  message: { readonly text: string } | undefined,
  maxPerPage: number
): void {
  const text = message?.text ?? "";
  const lines = text.split("\n").map((line) => line.trim());
  const sessionLines = lines.filter((line) => line.startsWith("• "));
  assert.ok(
    sessionLines.length <= maxPerPage,
    `La página tiene ${sessionLines.length} sesiones; máximo permitido ${maxPerPage}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

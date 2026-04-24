import TelegramBot from "node-telegram-bot-api";
import {
  ApplicationUseCases,
  CancelSessionOutput,
  RunSessionCommandOutput,
  SelectProjectOutput,
  SendTextOutput,
  SubmitPendingPromptOutput,
  SessionOutput,
  SUBMIT_PENDING_PROMPT_RESULT_STATUS,
  StatusOutput,
} from "../application/use-cases";
import { PENDING_PROMPT_STATUS } from "../domain/entities";
import { Result } from "../application/contracts";
import { createTelegramRouter } from "../adapters/telegram/router";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

class FakeBot {
  readonly messages: Array<{ readonly chatId: number; readonly text: string }> = [];

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

class FakeUseCases implements ApplicationUseCases {
  public statusMode: StatusOutput["mode"] = "idle";
  public activeTaskId: string | undefined;
  public selectedProject = "proj-demo";
  public selectedSession = "sess-demo";

  public readonly calls = {
    selectProject: 0,
    createSession: 0,
    cancelSession: 0,
    runSessionCommand: 0,
  };

  async selectProject(_input: { chatId: string; selector: string; rootPath?: string }): Promise<Result<SelectProjectOutput>> {
    this.calls.selectProject += 1;
    return ok({
      projectId: this.selectedProject,
      alias: this.selectedProject,
    });
  }

  async attachSession(_input: { chatId: string; sessionId: string }): Promise<Result<SessionOutput>> {
    return ok({
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
    });
  }

  async createSession(_input: { chatId: string }): Promise<Result<SessionOutput>> {
    this.calls.createSession += 1;
    return ok({
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
    });
  }

  async sendText(_input: { chatId: string; text: string }): Promise<Result<SendTextOutput>> {
    return ok({
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
      message: "ok",
      needsAttention: false,
      state: {
        projectId: this.selectedProject,
        sessionId: this.selectedSession,
        status: "idle",
      },
    });
  }

  async runSessionCommand(_input: { chatId: string; command: string }): Promise<Result<RunSessionCommandOutput>> {
    this.calls.runSessionCommand += 1;
    return ok({
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
      message: "run-ok",
      needsAttention: false,
      state: {
        projectId: this.selectedProject,
        sessionId: this.selectedSession,
        status: "idle",
      },
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
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
      promptId: "prompt-fake",
      status: SUBMIT_PENDING_PROMPT_RESULT_STATUS.IDEMPOTENT,
      promptStatus: PENDING_PROMPT_STATUS.INVALIDATED,
      reason: "fake-use-case",
    });
  }

  async cancelSession(_input: { chatId: string }): Promise<Result<CancelSessionOutput>> {
    this.calls.cancelSession += 1;
    return ok({
      projectId: this.selectedProject,
      sessionId: this.selectedSession,
      status: "accepted",
      message: "cancel accepted",
    });
  }

  async getStatus(_chatId: string): Promise<Result<StatusOutput>> {
    return ok({
      mode: this.statusMode,
      projectId: this.selectedProject,
      projectAlias: this.selectedProject,
      sessionId: this.selectedSession,
      activeTaskId: this.activeTaskId,
    });
  }
}

function ok<T>(value: T): Result<T> {
  return {
    ok: true,
    value,
  };
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

async function runCase(
  id: string,
  scenario: string,
  expected: string,
  run: (ctx: { bot: FakeBot; useCases: FakeUseCases }) => Promise<string>
): Promise<ScenarioResult> {
  const bot = new FakeBot();
  const useCases = new FakeUseCases();

  try {
    const actual = await run({ bot, useCases });
    return { id, scenario, expected, actual, ok: true };
  } catch (error) {
    return {
      id,
      scenario,
      expected,
      actual: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  results.push(
    await runCase("S01", "Busy: /status permitido", "debe responder estado", async ({ bot, useCases }) => {
      useCases.statusMode = "task-running";
      useCases.activeTaskId = "task-1";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9001", "/status"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("Estado actual"), "faltó respuesta de estado en busy");
      return "aceptado";
    })
  );

  results.push(
    await runCase("S02", "Busy: /project sin args permitido", "debe responder proyecto actual", async ({ bot, useCases }) => {
      useCases.statusMode = "task-running";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9002", "/project"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("Proyecto actual"), "faltó respuesta de query de proyecto");
      return "aceptado";
    })
  );

  results.push(
    await runCase("S03", "Busy: /project alpha bloqueado", "debe rechazar por busy", async ({ bot, useCases }) => {
      useCases.statusMode = "task-running";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9003", "/project alpha"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("Comando bloqueado por tarea en curso"), "no bloqueó mutación de proyecto en busy");
      assert(useCases.calls.selectProject === 0, "no debería invocar selectProject en busy");
      return "bloqueado";
    })
  );

  results.push(
    await runCase("S04", "Busy: comando desconocido default-safe", "debe bloquear como execution", async ({ bot, useCases }) => {
      useCases.statusMode = "task-running";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9004", "/foobar"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("Comando bloqueado por tarea en curso"), "unknown no fue bloqueado default-safe");
      return "bloqueado";
    })
  );

  results.push(
    await runCase("S05", "Idle: /project alpha permitido", "debe mutar proyecto", async ({ bot, useCases }) => {
      useCases.statusMode = "idle";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9005", "/project alpha"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("Proyecto seleccionado"), "idle debería permitir mutar proyecto");
      assert(useCases.calls.selectProject === 1, "selectProject debería ejecutarse en idle");
      return "aceptado";
    })
  );

  results.push(
    await runCase("S06", "Idle: /cancel devuelve no-active-task", "debe ser explícito", async ({ bot, useCases }) => {
      useCases.statusMode = "session-linked";
      const router = createTelegramRouter({
        bot: bot as unknown as TelegramBot,
        useCases,
        compatRunCmdCommands: true,
      });
      await router.handleMessage(createMessage("9006", "/cancel"));
      const text = bot.messages[0]?.text ?? "";
      assert(text.includes("No hay tarea activa para cancelar"), "faltó respuesta cancel idle explícita");
      assert(useCases.calls.cancelSession === 0, "cancelSession no debería ejecutarse en idle");
      return "aceptado";
    })
  );

  const lines = [
    "RFC-006 Policy Matrix Verification",
    "",
    "| ID | Scenario | Expected | Actual | Result |",
    "|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.id} | ${result.scenario} | ${result.expected} | ${result.actual.replace(/\|/gu, "\\|")} | ${
          result.ok ? "PASS" : "FAIL"
        } |`
    ),
  ];

  const passed = results.filter((result) => result.ok).length;
  lines.push("", `Resumen: ${passed}/${results.length} escenarios PASS.`);
  const output = lines.join("\n");

  if (passed !== results.length) {
    // eslint-disable-next-line no-console
    console.error(output);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(output);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("No pude ejecutar verificación de policy matrix RFC6", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

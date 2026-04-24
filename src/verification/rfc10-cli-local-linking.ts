import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import TelegramBot from "node-telegram-bot-api";
import { loadConfig, Config, STATE_DRIVERS } from "../config";
import { ApplicationUseCases, createApplicationUseCases } from "../application/use-cases";
import {
  extractOpenCodeCliAssistantReply,
  OPEN_CODE_CLI_ROLE,
  parseOpenCodeCliExport,
  parseOpenCodeCliSessionList,
  resolveCanonicalProjectPath,
} from "../infrastructure/opencode-cli";
import { OPEN_CODE_ADAPTER_MODE, parseOpenCodeAdapterMode } from "../infrastructure/opencode-adapter-mode";
import { CliOpenCodeSessionAdapter, PtyOpenCodeSessionAdapter } from "../infrastructure/opencode-session-adapter";
import { ADAPTER_ERROR_CODES, OpenCodeSessionAdapter, PersistenceDriver, PersistenceUnit } from "../application/contracts";
import { createOpenCodeCliMirrorService } from "../application/opencode-cli-mirror-service";
import { readOpenCodeLocalSessionMessages } from "../infrastructure/opencode-local-store";
import { bootstrapApplication } from "../index";
import { createTelegramRouter } from "../adapters/telegram/router";
import { createMessageHandler } from "../handlers";
import { sanitizeTelegramHtml } from "../adapters/telegram/sanitize";
import { formatOutboundForTelegram } from "../adapters/telegram/format-outbound";
import { sendTelegramText, TELEGRAM_CONTENT_KIND } from "../adapters/telegram/message-sender";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { logger } from "../logger";

async function main(): Promise<void> {
  await verifyAdapterModeParsing();
  await verifyCliConfigLocalOnlyBoot();
  await verifyCliParsers();
  await verifyCliExportSanitizeFallback();
  await verifyCliAdapterBehavior();
  await verifyPtyAdapterBehavior();
  await verifyCliAsyncDispatch();
  await verifyCliProjectGuidanceAndUnsupportedCommands();
  await verifyCliSessionSwitchContinuity();
  await verifyLocalSessionReader();
  await verifyMirrorUsesLocalSessionReaderInPtyMode();
  await verifyMirrorSweepAndDedupe();
  await verifyMirrorFailureIsolation();
  await verifyStartupBranching();
  await verifyTelegramFormatterSubsetAndFallback();
  await verifyTelegramPlainContentBypass();
  await verifyTelegramAmbiguousMarkdownDegradesSafely();
  await verifyTelegramAllowlistSanitization();
  await verifyTelegramHtmlSafeChunking();
  await verifyTelegramNativeContentBypass();
  await verifyLegacyBridgeUsesCentralSender();

  console.log("RFC-010 CLI local linking verification passed");
}

async function verifyTelegramFormatterSubsetAndFallback(): Promise<void> {
  const calls: Array<{ readonly text: string; readonly parseMode?: string }> = [];
  const bot = {
    async sendMessage(_chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
      calls.push({ text, parseMode: options?.parse_mode });
      if (options?.parse_mode === "HTML") {
        throw new Error("can't parse entities");
      }

      return { message_id: calls.length } as TelegramBot.Message;
    },
  } as TelegramBot;

  await sendTelegramText({
    bot,
    chatId: 101,
    text: "# Título\n- item\n**bold** y `code` y [doc](https://example.com)",
    contentKind: TELEGRAM_CONTENT_KIND.MODEL,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.parseMode, "HTML");
  assert.match(calls[0]?.text ?? "", /<b>Título<\/b>/);
  assert.match(calls[0]?.text ?? "", /• item/);
  assert.match(calls[0]?.text ?? "", /<b>bold<\/b>/);
  assert.match(calls[0]?.text ?? "", /<code>code<\/code>/);
  assert.match(calls[0]?.text ?? "", /<a href="https:\/\/example\.com\/">doc<\/a>/);
  assert.equal(calls[1]?.parseMode, undefined);
  assert.doesNotMatch(calls[1]?.text ?? "", /<[^>]+>/);
  assert.match(calls[1]?.text ?? "", /doc: https:\/\/example\.com\//);
}

async function verifyTelegramPlainContentBypass(): Promise<void> {
  const sent: Array<{ readonly text: string; readonly parseMode?: string }> = [];
  const input = "**console**\n_name_with_underscores_\n[doc](https://example.com)";
  const bot = {
    async sendMessage(_chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
      sent.push({ text, parseMode: options?.parse_mode });
      return { message_id: sent.length } as TelegramBot.Message;
    },
  } as TelegramBot;

  assert.equal(
    formatOutboundForTelegram({
      text: input,
      contentKind: TELEGRAM_CONTENT_KIND.PLAIN,
    }),
    input
  );

  await sendTelegramText({
    bot,
    chatId: 202,
    text: input,
    contentKind: TELEGRAM_CONTENT_KIND.PLAIN,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.parseMode, "HTML");
  assert.equal(sent[0]?.text, input);
  assert.doesNotMatch(sent[0]?.text ?? "", /<b>|<i>|<a href=/);
}

async function verifyTelegramAmbiguousMarkdownDegradesSafely(): Promise<void> {
  const sent: Array<{ readonly text: string; readonly parseMode?: string }> = [];
  const bot = {
    async sendMessage(_chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
      sent.push({ text, parseMode: options?.parse_mode });
      return { message_id: sent.length } as TelegramBot.Message;
    },
  } as TelegramBot;

  await sendTelegramText({
    bot,
    chatId: 203,
    text: "Archivo _name_with_underscores_ y _itálica segura_",
    contentKind: TELEGRAM_CONTENT_KIND.MODEL,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.parseMode, "HTML");
  assert.match(sent[0]?.text ?? "", /_name_with_underscores_/);
  assert.match(sent[0]?.text ?? "", /<i>itálica segura<\/i>/);
  assert.doesNotMatch(sent[0]?.text ?? "", /<i>name_with_underscores<\/i>/);
}

async function verifyTelegramAllowlistSanitization(): Promise<void> {
  const sanitized = sanitizeTelegramHtml(
    '<b>ok</b> <script>x</script> <a href="javascript:alert(1)">bad</a> <a href="https://example.com">good</a>'
  );

  assert.match(sanitized, /<b>ok<\/b>/);
  assert.match(sanitized, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(sanitized, /&lt;a href=&quot;javascript:alert\(1\)&quot;&gt;bad<\/a>/);
  assert.match(sanitized, /<a href="https:\/\/example\.com\/">good<\/a>/);
}

async function verifyTelegramHtmlSafeChunking(): Promise<void> {
  const sentMessages: string[] = [];
  const bot = {
    async sendMessage(_chatId: number, text: string) {
      sentMessages.push(text);
      return { message_id: sentMessages.length } as TelegramBot.Message;
    },
  } as TelegramBot;

  const longCodeBlock = `\`\`\`ts\n${"console.log('hola');\n".repeat(450)}\`\`\``;
  await sendTelegramText({
    bot,
    chatId: 101,
    text: longCodeBlock,
    contentKind: TELEGRAM_CONTENT_KIND.MODEL,
  });

  assert.ok(sentMessages.length >= 2);
  assert.match(sentMessages[0] ?? "", /^\(1\/\d+\)/);
  assert.ok(sentMessages.every((message) => !message.includes("<pre>") || message.includes("</pre>")));
}

async function verifyTelegramNativeContentBypass(): Promise<void> {
  const sent: Array<{ readonly text: string; readonly parseMode?: string }> = [];
  const input = "<b>Plantilla nativa</b> **no adaptar** [doc](https://example.com)\n# sin heading";
  const bot = {
    async sendMessage(_chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
      sent.push({ text, parseMode: options?.parse_mode });
      return { message_id: sent.length } as TelegramBot.Message;
    },
  } as TelegramBot;

  await sendTelegramText({
    bot,
    chatId: 204,
    text: input,
    contentKind: TELEGRAM_CONTENT_KIND.TELEGRAM_NATIVE,
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.parseMode, "HTML");
  assert.match(sent[0]?.text ?? "", /<b>Plantilla nativa<\/b>/);
  assert.match(sent[0]?.text ?? "", /\*\*no adaptar\*\*/);
  assert.match(sent[0]?.text ?? "", /\[doc\]\(https:\/\/example\.com\)/);
  assert.match(sent[0]?.text ?? "", /# sin heading/);
  assert.doesNotMatch(sent[0]?.text ?? "", /<a href="https:\/\/example\.com\/">doc<\/a>/);
}

async function verifyLegacyBridgeUsesCentralSender(): Promise<void> {
  const sent: Array<{ readonly text: string; readonly parseMode?: string }> = [];
  const handler = createMessageHandler({
    bot: {
      async sendMessage(_chatId: number, text: string, options?: TelegramBot.SendMessageOptions) {
        sent.push({ text, parseMode: options?.parse_mode });
        return { message_id: sent.length } as TelegramBot.Message;
      },
    } as TelegramBot,
    useCases: {
      async getStatus() {
        return {
          ok: true,
          value: {
            mode: "idle",
            projectId: undefined,
            projectAlias: undefined,
            sessionId: undefined,
            activeTaskId: undefined,
          },
        };
      },
    } as unknown as ApplicationUseCases,
    config: buildConfig({ compatLegacyTextBridge: true }),
    callOpenCodeFn: async () => ({ answer: "**legacy** bridge" }),
  });

  await handler(createTelegramMessage("hola legacy"));

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.parseMode, "HTML");
  assert.match(sent[0]?.text ?? "", /<b>legacy<\/b> bridge/);
}

async function verifyAdapterModeParsing(): Promise<void> {
  assert.equal(parseOpenCodeAdapterMode(undefined), OPEN_CODE_ADAPTER_MODE.HTTP);
  assert.equal(parseOpenCodeAdapterMode(" cli "), OPEN_CODE_ADAPTER_MODE.CLI);
  assert.equal(parseOpenCodeAdapterMode(" pty "), OPEN_CODE_ADAPTER_MODE.PTY);
  assert.throws(() => parseOpenCodeAdapterMode("webhook"), /Invalid value for OPEN_CODE_ADAPTER/);
}

async function verifyCliConfigLocalOnlyBoot(): Promise<void> {
  const originalEnv = { ...process.env };

  try {
    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.ALLOWED_USER_ID = "123456";
    process.env.OPEN_CODE_ADAPTER = OPEN_CODE_ADAPTER_MODE.CLI;
    delete process.env.OPEN_CODE_URL;
    delete process.env.OPEN_CODE_TOKEN;

    const config = loadConfig();
    assert.equal(config.openCodeAdapter, OPEN_CODE_ADAPTER_MODE.CLI);
    assert.equal(config.openCodeUrl, "http://localhost/opencode/query");
    assert.equal(config.openCodeToken, "cli-mode-not-used");

    process.env.OPEN_CODE_ADAPTER = OPEN_CODE_ADAPTER_MODE.PTY;
    const ptyConfig = loadConfig();
    assert.equal(ptyConfig.openCodeAdapter, OPEN_CODE_ADAPTER_MODE.PTY);
    assert.equal(ptyConfig.openCodeUrl, "http://localhost/opencode/query");
    assert.equal(ptyConfig.openCodeToken, "cli-mode-not-used");
  } finally {
    process.env = originalEnv;
  }
}

async function verifyCliParsers(): Promise<void> {
  const sessions = parseOpenCodeCliSessionList(
    JSON.stringify({
      items: [{ session_id: "sess-1", dir: "/workspace/demo", updated_at: "2026-04-21T00:00:00.000Z" }],
    })
  );

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "sess-1");
  assert.equal(sessions[0]?.path, "/workspace/demo");

  const exported = parseOpenCodeCliExport(
    "sess-1",
    JSON.stringify({
      session: {
        messages: [
          { role: "user", content: "hola" },
          { role: "assistant", content: [{ text: "respuesta desde export" }] },
        ],
      },
    })
  );

  assert.equal(exported.messages.length, 2);
  assert.match(exported.messages[1]?.id ?? "", /^assistant-/);
  assert.equal(extractOpenCodeCliAssistantReply(JSON.stringify({ answer: "ok" })), "ok");
}

async function verifyCliExportSanitizeFallback(): Promise<void> {
  const { exportSession } = await import("../infrastructure/opencode-cli");

  const originalSpawn = require("node:child_process").spawn as typeof import("node:child_process").spawn;
  const childProcess = require("node:child_process") as typeof import("node:child_process");

  let callCount = 0;

  childProcess.spawn = ((command: string, args?: readonly string[]) => {
    void command;
    void args;
    callCount += 1;

    const events = new (require("node:events").EventEmitter)();
    const stdout = new (require("node:stream").PassThrough)();
    const stderr = new (require("node:stream").PassThrough)();

    const child = Object.assign(events, {
      stdout,
      stderr,
      kill() {
        return true;
      },
      unref() {
        return undefined;
      },
      once: events.once.bind(events),
      on: events.on.bind(events),
    });

    process.nextTick(() => {
      if (callCount === 1) {
        stderr.write("unknown option '--sanitize'\n");
        stderr.end();
        stdout.end();
        events.emit("close", 1, null);
        return;
      }

      stdout.write(JSON.stringify({ messages: [{ role: "assistant", content: "ok" }] }));
      stdout.end();
      stderr.end();
      events.emit("close", 0, null);
    });

    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;

  try {
    const exported = await exportSession({ sessionId: "sess-fallback", timeoutMs: 3_000 });
    assert.equal(exported.sessionId, "sess-fallback");
    assert.equal(callCount, 2);
  } finally {
    childProcess.spawn = originalSpawn;
  }
}

async function verifyCliAdapterBehavior(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-adapter-"));
  const projectDir = path.join(tempDir, "project-a");
  const otherDir = path.join(tempDir, "project-b");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });

  const adapter = new CliOpenCodeSessionAdapter(buildConfig(), {
    listSessions: async () => [
      {
        id: "sess-a",
        path: projectDir,
        updatedAt: "2026-04-21T00:00:00.000Z",
      },
    ],
    resolveCanonicalProjectPath: async (inputPath: string) => fs.realpath(inputPath),
    runSessionMessage: async (input) => ({ replyText: `reply:${input.dir}:${input.message}` }),
    startSessionMessage: async () => undefined,
  });

  const resolved = await adapter.resolveProject({ projectId: projectDir, rootPath: projectDir });
  assert.equal(resolved.ok, true);

  const attached = await adapter.attachSession({ projectId: projectDir, sessionId: "sess-a" });
  assert.equal(attached.ok, true);

  const state = await adapter.getSessionState({ projectId: projectDir, sessionId: "sess-a" });
  assert.equal(state.ok, true);

  const send = await adapter.sendMessage({
    projectId: projectDir,
    sessionId: "sess-a",
    message: "hola",
    chatId: "1",
  });
  assert.equal(send.ok, true);
  if (send.ok) {
    assert.equal(send.value.message, "");
    assert.match(send.value.reply ?? "", /Mensaje enviado a OpenCode/i);
  }

  const unknown = await adapter.attachSession({ projectId: projectDir, sessionId: "missing" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.error.details?.adapterCode, ADAPTER_ERROR_CODES.SESSION_NOT_FOUND);
  }

  const mismatchingAdapter = new CliOpenCodeSessionAdapter(buildConfig(), {
    listSessions: async () => [{ id: "sess-b", path: otherDir }],
    resolveCanonicalProjectPath: async (inputPath: string) => fs.realpath(inputPath),
    runSessionMessage: async () => ({ replyText: "unused" }),
    startSessionMessage: async () => undefined,
  });
  await mismatchingAdapter.resolveProject({ projectId: projectDir, rootPath: projectDir });
  const mismatch = await mismatchingAdapter.attachSession({ projectId: projectDir, sessionId: "sess-b" });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.equal(mismatch.error.details?.adapterCode, ADAPTER_ERROR_CODES.SESSION_PROJECT_MISMATCH);
  }
}

async function verifyPtyAdapterBehavior(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-pty-"));
  const projectDir = path.join(tempDir, "project-a");
  await fs.mkdir(projectDir, { recursive: true });

  const calls = {
    ensure: [] as string[],
    send: [] as string[],
    interrupt: [] as string[],
  };

  const adapter = new PtyOpenCodeSessionAdapter(
    buildConfig({ openCodeAdapter: OPEN_CODE_ADAPTER_MODE.PTY }),
    {
      listSessions: async () => [{ id: "sess-pty", path: projectDir, updatedAt: "2026-04-21T00:00:00.000Z" }],
      resolveCanonicalProjectPath: async (inputPath: string) => fs.realpath(inputPath),
    },
    {
      ensureHostSession: async ({ opencodeSessionId }) => {
        calls.ensure.push(opencodeSessionId);
      },
      sendInput: async ({ opencodeSessionId, input }) => {
        calls.send.push(`${opencodeSessionId}:${input}`);
      },
      interrupt: async ({ opencodeSessionId }) => {
        calls.interrupt.push(opencodeSessionId);
      },
    }
  );

  const resolved = await adapter.resolveProject({ projectId: projectDir, rootPath: projectDir });
  assert.equal(resolved.ok, true);

  const attached = await adapter.attachSession({ projectId: projectDir, sessionId: "sess-pty" });
  assert.equal(attached.ok, true);
  assert.deepEqual(calls.ensure, ["sess-pty"]);

  const send = await adapter.sendMessage({
    projectId: projectDir,
    sessionId: "sess-pty",
    message: "hola-pty",
    chatId: "101",
  });
  assert.equal(send.ok, true);
  if (send.ok) {
    assert.match(send.value.reply ?? "", /pty\/tmux/i);
    assert.equal(send.value.message, "");
  }

  assert.deepEqual(calls.send, ["sess-pty:hola-pty"]);

  const cancel = await adapter.cancelOrInterrupt({
    projectId: projectDir,
    sessionId: "sess-pty",
    chatId: "101",
  });
  assert.equal(cancel.ok, true);
  if (cancel.ok) {
    assert.equal(cancel.value.status, "accepted");
  }
  assert.deepEqual(calls.interrupt, ["sess-pty"]);
}

async function verifyCliAsyncDispatch(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-async-"));
  const projectDir = path.join(tempDir, "project-a");
  await fs.mkdir(projectDir, { recursive: true });

  const runCalls: Array<{ readonly sessionId: string; readonly message: string }> = [];
  let backgroundResolved = false;
  let releaseBackground: (() => void) | undefined;

  const backgroundRun = async (input: {
    readonly sessionId: string;
    readonly dir: string;
    readonly message: string;
    readonly timeoutMs: number;
  }) => {
    runCalls.push({ sessionId: input.sessionId, message: input.message });
    await new Promise<void>((resolve) => {
      releaseBackground = () => {
        backgroundResolved = true;
        resolve();
      };
    });
    return { replyText: `reply:${input.dir}:${input.message}` };
  };

  const adapter = new CliOpenCodeSessionAdapter(buildConfig(), {
    listSessions: async () => [{ id: "sess-a", path: projectDir }],
    resolveCanonicalProjectPath: async (inputPath: string) => fs.realpath(inputPath),
    runSessionMessage: backgroundRun,
    startSessionMessage: async (input) => {
      void backgroundRun({
        sessionId: input.sessionId,
        dir: input.dir,
        message: input.message,
        timeoutMs: 60_000,
      });
    },
  });

  await adapter.resolveProject({ projectId: projectDir, rootPath: projectDir });

  const sendPromise = adapter.sendMessage({
    projectId: projectDir,
    sessionId: "sess-a",
    message: "hola-async",
    chatId: "1",
  });

  const send = await Promise.race([
    sendPromise,
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 50)),
  ]);

  assert.notEqual(send, "timed-out");
  assert.equal(backgroundResolved, false);
  assert.deepEqual(runCalls, [{ sessionId: "sess-a", message: "hola-async" }]);

  if (send !== "timed-out") {
    assert.equal(send.ok, true);
    if (send.ok) {
      assert.equal(send.value.message, "");
      assert.match(send.value.reply ?? "", /mirror/i);
    }
  }

  releaseBackground?.();
  await sendPromise;
}

async function verifyMirrorSweepAndDedupe(): Promise<void> {
  const bindingsState = {
    items: [{ chatId: "101", activeProjectId: "project-a", activeSessionId: "sess-a" }],
  };
  const sentMessages: string[] = [];
  const exportCursor = new Map<string, number>();
  const transcripts = {
    "sess-a": [
      [{ id: "a-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "baseline", createdAt: "2026-04-21T00:00:00.000Z" }],
      [
        { id: "a-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "baseline", createdAt: "2026-04-21T00:00:00.000Z" },
        { id: "a-2", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "from telegram", createdAt: "2026-04-21T00:00:01.000Z" },
      ],
      [
        { id: "a-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "baseline", createdAt: "2026-04-21T00:00:00.000Z" },
        { id: "a-2", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "from telegram", createdAt: "2026-04-21T00:00:01.000Z" },
        { id: "a-3", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "from pc", createdAt: "2026-04-21T00:00:02.000Z" },
      ],
    ],
    "sess-b": [
      [{ id: "b-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "seed b", createdAt: "2026-04-21T00:00:03.000Z" }],
      [
        { id: "b-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "seed b", createdAt: "2026-04-21T00:00:03.000Z" },
        { id: "b-2", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "pc on b", createdAt: "2026-04-21T00:00:04.000Z" },
      ],
    ],
  } as const;

  const mirror = createOpenCodeCliMirrorService({
    config: buildConfig(),
    persistence: createBindingsOnlyPersistence(bindingsState),
    bot: {} as TelegramBot,
    readLocalSessionMessagesFn: async ({ sessionId }) => {
      const snapshots = transcripts[sessionId as keyof typeof transcripts];
      const cursor = exportCursor.get(sessionId) ?? 0;
      const snapshot = snapshots[Math.min(cursor, snapshots.length - 1)] ?? [];
      exportCursor.set(sessionId, cursor + 1);
      return {
        sessionId,
        messages: snapshot,
      };
    },
    sendTelegramTextFn: async ({ text }) => {
      sentMessages.push(text);
      return undefined;
    },
  });

  await mirror.runSweepNow();
  assert.deepEqual(sentMessages, []);

  mirror.registerTelegramEcho("sess-a", "from telegram");
  await mirror.runSweepNow();
  assert.deepEqual(sentMessages, []);

  await mirror.runSweepNow();
  assert.deepEqual(sentMessages, ["from pc"]);

  bindingsState.items = [{ chatId: "101", activeProjectId: "project-a", activeSessionId: "sess-b" }];
  await mirror.runSweepNow();
  assert.deepEqual(sentMessages, ["from pc"]);

  await mirror.runSweepNow();
  assert.deepEqual(sentMessages, ["from pc", "pc on b"]);
}

async function verifyLocalSessionReader(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-localdb-"));
  const dbPath = path.join(tempDir, "opencode.db");
  await createOpenCodeLocalTestDb(dbPath, [
    {
      id: "msg-user-1",
      sessionId: "sess-local",
      role: OPEN_CODE_CLI_ROLE.USER,
      timeCreated: 1_713_657_600_000,
      parts: [{ id: "prt-user-1", type: "text", text: "hola" }],
    },
    {
      id: "msg-assistant-1",
      sessionId: "sess-local",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_601_000,
      parts: [
        { id: "prt-step", type: "step-start" },
        { id: "prt-synth", type: "text", text: "Called the Read tool", synthetic: true },
        { id: "prt-empty", type: "text", text: "   " },
        { id: "prt-placeholder", type: "text", text: "[redacted:text:prt_secret]" },
        { id: "prt-real-1", type: "text", text: "respuesta real" },
        { id: "prt-real-2", type: "text", text: "segunda parte" },
      ],
    },
    {
      id: "msg-assistant-2",
      sessionId: "sess-local",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_602_000,
      parts: [{ id: "prt-noise", type: "step-start" }],
    },
  ]);

  const exported = await readOpenCodeLocalSessionMessages({
    sessionId: "sess-local",
    dbPath,
  });

  assert.deepEqual(exported.messages, [
    {
      id: "msg-assistant-1",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      text: "respuesta real\n\nsegunda parte",
      createdAt: new Date(1_713_657_601_000).toISOString(),
    },
  ]);
}

async function verifyMirrorUsesLocalSessionReaderInPtyMode(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-mirror-localdb-"));
  const dbPath = path.join(tempDir, "opencode.db");
  await createOpenCodeLocalTestDb(dbPath, [
    {
      id: "msg-base",
      sessionId: "sess-a",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_600_000,
      parts: [{ id: "prt-base", type: "text", text: "baseline" }],
    },
    {
      id: "msg-fresh",
      sessionId: "sess-a",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_601_000,
      parts: [{ id: "prt-fresh", type: "text", text: "respuesta real desde sqlite" }],
    },
  ]);

  const bindingsState = {
    items: [{ chatId: "101", activeProjectId: "project-a", activeSessionId: "sess-a" }],
  };
  const sentMessages: string[] = [];

  const mirror = createOpenCodeCliMirrorService({
    config: buildConfig({ openCodeAdapter: OPEN_CODE_ADAPTER_MODE.PTY }),
    persistence: createBindingsOnlyPersistence(bindingsState),
    bot: {} as TelegramBot,
    openCodeLocalDbPath: dbPath,
    exportSessionFn: async () => ({
      sessionId: "sess-a",
      messages: [
        {
          id: "assistant-redacted",
          role: OPEN_CODE_CLI_ROLE.ASSISTANT,
          text: "[redacted:text:prt_fresh]",
          createdAt: new Date(1_713_657_601_000).toISOString(),
        },
      ],
    }),
    sendTelegramTextFn: async ({ text }) => {
      sentMessages.push(text);
      return undefined;
    },
  });

  await mirror.runSweepNow();
  await createOpenCodeLocalTestDb(dbPath, [
    {
      id: "msg-base",
      sessionId: "sess-a",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_600_000,
      parts: [{ id: "prt-base", type: "text", text: "baseline" }],
    },
    {
      id: "msg-fresh",
      sessionId: "sess-a",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_601_000,
      parts: [{ id: "prt-fresh", type: "text", text: "respuesta real desde sqlite" }],
    },
    {
      id: "msg-latest",
      sessionId: "sess-a",
      role: OPEN_CODE_CLI_ROLE.ASSISTANT,
      timeCreated: 1_713_657_602_000,
      parts: [{ id: "prt-latest", type: "text", text: "nuevo texto visible" }],
    },
  ]);

  await mirror.runSweepNow();

  assert.deepEqual(sentMessages, ["nuevo texto visible"]);
}

async function verifyCliProjectGuidanceAndUnsupportedCommands(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-router-"));
  const projectDir = path.join(tempDir, "project-a");
  const missingProjectDir = path.join(tempDir, "missing-local-path");
  await fs.mkdir(projectDir, { recursive: true });

  const config = buildConfig({
    stateJsonPath: path.join(tempDir, "state.json"),
  });
  const persistence = await createJsonPersistenceDriver(config);
  const sentMessages: string[] = [];

  const adapter = new CliOpenCodeSessionAdapter(config, {
    listSessions: async () => [{ id: "sess-a", path: projectDir }],
    resolveCanonicalProjectPath,
    runSessionMessage: async ({ sessionId, message }) => ({ replyText: `reply:${sessionId}:${message}` }),
    startSessionMessage: async () => undefined,
  });

  const useCases = createApplicationUseCases({
    persistence,
    adapter,
  });

  const router = createTelegramRouter({
    bot: createBotRecorder(sentMessages),
    useCases,
    persistence,
    compatRunCmdCommands: true,
    openCodeAdapterMode: OPEN_CODE_ADAPTER_MODE.CLI,
  });

  await router.handleMessage(createTelegramMessage(`/project ${missingProjectDir}`));
  assert.match(sentMessages[0] ?? "", /ruta local\/WSL válida con \/project (&lt;|<)path_local(&gt;|>)/i);

  await router.handleMessage(createTelegramMessage(`/project ${projectDir}`));
  await router.handleMessage(createTelegramMessage("/session sess-a"));
  await router.handleMessage(createTelegramMessage("hola-cli"));
  assert.match(sentMessages[3] ?? "", /mirror|Te respondo por acá/i);
  await router.handleMessage(createTelegramMessage("/new"));
  assert.match(sentMessages[4] ?? "", /PC\/WSL/i);

  await router.handleMessage(createTelegramMessage("/cancel"));
  assert.match(sentMessages[5] ?? "", /no está disponible \/cancel/i);
  assert.match(sentMessages[5] ?? "", /PC\/WSL/i);
}

async function verifyCliSessionSwitchContinuity(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-opencode-rfc10-switch-"));
  const projectDir = path.join(tempDir, "project-a");
  await fs.mkdir(projectDir, { recursive: true });

  const runCalls: Array<{ readonly sessionId: string; readonly message: string }> = [];
  const config = buildConfig({
    stateJsonPath: path.join(tempDir, "state.json"),
  });
  const persistence = await createJsonPersistenceDriver(config);

  const adapter = new CliOpenCodeSessionAdapter(config, {
    listSessions: async () => [
      { id: "sess-a", path: projectDir, updatedAt: "2026-04-21T00:00:00.000Z" },
      { id: "sess-b", path: projectDir, updatedAt: "2026-04-21T00:01:00.000Z" },
    ],
    resolveCanonicalProjectPath: async (inputPath: string) => fs.realpath(inputPath),
    runSessionMessage: async ({ sessionId, message }) => {
      void sessionId;
      void message;
      return { replyText: "unused" };
    },
    startSessionMessage: async ({ sessionId, message }) => {
      runCalls.push({ sessionId, message });
    },
  });

  const useCases = createApplicationUseCases({
    persistence,
    adapter,
  });

  const selected = await useCases.selectProject({
    chatId: "101",
    selector: projectDir,
    rootPath: projectDir,
  });
  assert.equal(selected.ok, true);

  const attachedA = await useCases.attachSession({ chatId: "101", sessionId: "sess-a" });
  assert.equal(attachedA.ok, true);

  const firstSend = await useCases.sendText({ chatId: "101", text: "hola-a" });
  assert.equal(firstSend.ok, true);
  assert.deepEqual(runCalls[0], { sessionId: "sess-a", message: "hola-a" });

  const attachedB = await useCases.attachSession({ chatId: "101", sessionId: "sess-b" });
  assert.equal(attachedB.ok, true);

  const switchedStatus = await useCases.getStatus("101");
  assert.equal(switchedStatus.ok, true);
  if (switchedStatus.ok) {
    assert.equal(switchedStatus.value.sessionId, "sess-b");
  }

  const secondSend = await useCases.sendText({ chatId: "101", text: "hola-b" });
  assert.equal(secondSend.ok, true);
  assert.deepEqual(runCalls[1], { sessionId: "sess-b", message: "hola-b" });

  const failedSwitch = await useCases.attachSession({ chatId: "101", sessionId: "sess-missing" });
  assert.equal(failedSwitch.ok, false);

  const preservedStatus = await useCases.getStatus("101");
  assert.equal(preservedStatus.ok, true);
  if (preservedStatus.ok) {
    assert.equal(preservedStatus.value.sessionId, "sess-b");
  }

  const thirdSend = await useCases.sendText({ chatId: "101", text: "hola-b-continua" });
  assert.equal(thirdSend.ok, true);
  assert.deepEqual(runCalls[2], { sessionId: "sess-b", message: "hola-b-continua" });
}

async function verifyMirrorFailureIsolation(): Promise<void> {
  const bindingsState = {
    items: [
      { chatId: "101", activeProjectId: "project-a", activeSessionId: "sess-fail" },
      { chatId: "102", activeProjectId: "project-b", activeSessionId: "sess-ok" },
    ],
  };
  const sentMessages: string[] = [];
  const exportCursor = new Map<string, number>();
  const loggedFailures: string[] = [];
  const originalLoggerError = logger.error;

  logger.error = (message: string, meta?: Record<string, unknown>) => {
    if (message === "OpenCode CLI mirror session sync failed" && typeof meta?.sessionId === "string") {
      loggedFailures.push(meta.sessionId);
    }
  };

  try {
    const mirror = createOpenCodeCliMirrorService({
      config: buildConfig(),
      persistence: createBindingsOnlyPersistence(bindingsState),
      bot: {} as TelegramBot,
      readLocalSessionMessagesFn: async ({ sessionId }) => {
        if (sessionId === "sess-fail") {
          throw new Error("simulated local mirror failure");
        }

        const snapshots = [
          [{ id: "ok-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "baseline-ok", createdAt: "2026-04-21T00:00:00.000Z" }],
          [
            { id: "ok-1", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "baseline-ok", createdAt: "2026-04-21T00:00:00.000Z" },
            { id: "ok-2", role: OPEN_CODE_CLI_ROLE.ASSISTANT, text: "fresh-ok", createdAt: "2026-04-21T00:00:01.000Z" },
          ],
        ] as const;
        const cursor = exportCursor.get(sessionId) ?? 0;
        const snapshot = snapshots[Math.min(cursor, snapshots.length - 1)] ?? [];
        exportCursor.set(sessionId, cursor + 1);

        return {
          sessionId,
          messages: snapshot,
        };
      },
      sendTelegramTextFn: async ({ text }) => {
        sentMessages.push(text);
        return undefined;
      },
    });

    await mirror.runSweepNow();
    await mirror.runSweepNow();

    assert.deepEqual(sentMessages, ["fresh-ok"]);
    assert.ok(loggedFailures.includes("sess-fail"));
  } finally {
    logger.error = originalLoggerError;
  }
}

async function verifyStartupBranching(): Promise<void> {
  const cliMetrics = await runBootstrapScenario(OPEN_CODE_ADAPTER_MODE.CLI);
  assert.equal(cliMetrics.receiverCreated, 0);
  assert.equal(cliMetrics.watcherCreated, 0);
  assert.equal(cliMetrics.cliMirrorStarted, 1);
  assert.equal(cliMetrics.watcherRestored, 0);
  assert.equal(cliMetrics.watcherSchedulerStarted, 0);

  const ptyMetrics = await runBootstrapScenario(OPEN_CODE_ADAPTER_MODE.PTY);
  assert.equal(ptyMetrics.receiverCreated, 0);
  assert.equal(ptyMetrics.watcherCreated, 0);
  assert.equal(ptyMetrics.cliMirrorStarted, 1);
  assert.equal(ptyMetrics.watcherRestored, 0);
  assert.equal(ptyMetrics.watcherSchedulerStarted, 0);

  const httpMetrics = await runBootstrapScenario(OPEN_CODE_ADAPTER_MODE.HTTP);
  assert.equal(httpMetrics.receiverCreated, 1);
  assert.equal(httpMetrics.watcherCreated, 1);
  assert.equal(httpMetrics.cliMirrorStarted, 0);
  assert.equal(httpMetrics.watcherRestored, 1);
  assert.equal(httpMetrics.watcherSchedulerStarted, 1);
}

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: "token",
    allowedUserIds: ["123456"],
    openCodeUrl: "http://localhost/opencode/query",
    openCodeToken: "token",
    openCodeAdapter: OPEN_CODE_ADAPTER_MODE.CLI,
    openCodeTimeoutMs: 8_000,
    openCodeControlTimeoutMs: 8_000,
    openCodeExecTimeoutMs: 12_000,
    pollingIntervalMs: 1_500,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: "./tmp/test.sqlite",
    stateJsonPath: "./tmp/test.json",
    compatLegacyTextBridge: false,
    compatRunCmdCommands: true,
    bootRemoteReconcile: false,
    chatLockEnabled: true,
    lockWarnWaitMs: 1_500,
    watcherEnabled: true,
    watchdogEnabled: false,
    webhookHost: "127.0.0.1",
    webhookPortStart: 4040,
    webhookPortEnd: 4045,
    watchdogIntervalMs: 15_000,
    watchdogStaleAfterMs: 60_000,
    watchdogMaxRetryCount: 3,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300_000,
    ...overrides,
  };
}

function createTelegramMessage(text: string): TelegramBot.Message {
  return {
    message_id: 1,
    date: Date.now(),
    chat: {
      id: 101,
      type: "private",
    },
    text,
  } as TelegramBot.Message;
}

function createBotRecorder(sentMessages: string[]): TelegramBot {
  return {
    async sendMessage(_chatId: number, text: string) {
      sentMessages.push(text);
      return { message_id: sentMessages.length } as TelegramBot.Message;
    },
  } as TelegramBot;
}

function createBindingsOnlyPersistence(state: {
  items: Array<{ chatId: string; activeProjectId?: string; activeSessionId?: string }>;
}): PersistenceDriver {
  return {
    async runInTransaction<T>(work: (unit: PersistenceUnit) => Promise<T>): Promise<T> {
      const unit = {
        bindings: {
          async findByChatId(chatId: string) {
            const binding = state.items.find((candidate) => candidate.chatId === chatId);
            if (!binding) {
              return undefined;
            }

            return {
              chatId: binding.chatId,
              activeProjectId: binding.activeProjectId,
              activeSessionId: binding.activeSessionId,
              updatedAt: new Date().toISOString(),
            };
          },
          async listAll() {
            return state.items.map((binding) => ({
              chatId: binding.chatId,
              activeProjectId: binding.activeProjectId,
              activeSessionId: binding.activeSessionId,
              updatedAt: new Date().toISOString(),
            }));
          },
          async upsert() {
            return undefined;
          },
        },
      } satisfies Partial<PersistenceUnit>;

      return work(unit as unknown as PersistenceUnit);
    },
  };
}

async function runBootstrapScenario(mode: Config["openCodeAdapter"]) {
  const metrics = {
    receiverCreated: 0,
    watcherCreated: 0,
    watcherRestored: 0,
    watcherSchedulerStarted: 0,
    cliMirrorStarted: 0,
  };

  const bot = {
    stopPolling: async () => undefined,
  } as TelegramBot;

  const watcher = {
    createRegistration: () => ({
      callbackUrl: "http://127.0.0.1:4040/hook",
      bearerToken: "watcher-token",
    }),
    handleIncomingEvent: async () => ({ statusCode: 200, body: { ok: true } }),
    restoreAfterRestart: async () => {
      metrics.watcherRestored += 1;
    },
    runWatchdogSweep: async () => undefined,
    startScheduler: () => {
      metrics.watcherSchedulerStarted += 1;
    },
    stopScheduler: () => undefined,
  };

  const adapter = createNoopAdapter();

  await bootstrapApplication({
    loadConfig: () => buildConfig({ openCodeAdapter: mode, watcherEnabled: true }),
    createPersistenceDriver: async () => createBindingsOnlyPersistence({ items: [] }),
    createOpenCodeSessionAdapter: () => adapter,
    bootRecover: async () => ({
      recoveredChats: 0,
      chatsInError: 0,
      cleanedBindings: 0,
      notices: [],
      evaluatedBindings: 0,
    }),
    startBot: () => bot,
    sendBootRecoveryNotices: async () => undefined,
    sendAsyncSessionNotice: async () => undefined,
    createSessionWebhookReceiver: async () => {
      metrics.receiverCreated += 1;
      return {
        host: "127.0.0.1",
        port: 4040,
        callbackUrl: "http://127.0.0.1:4040/hook",
        close: async () => undefined,
      };
    },
    createSessionWatcherService: () => {
      metrics.watcherCreated += 1;
      return watcher;
    },
    createOpenCodeCliMirrorService: () => ({
      start() {
        metrics.cliMirrorStarted += 1;
      },
      stop() {},
      registerTelegramEcho() {},
      async runSweepNow() {},
    }),
  });

  return metrics;
}

async function createOpenCodeLocalTestDb(
  dbPath: string,
  messages: ReadonlyArray<{
    readonly id: string;
    readonly sessionId: string;
    readonly role: string;
    readonly timeCreated: number;
    readonly parts: ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly text?: string;
      readonly synthetic?: boolean;
    }>;
  }>
): Promise<void> {
  await fs.rm(dbPath, { force: true });

  const moduleName = "node:sqlite";
  const sqliteModule = (await import(moduleName)) as {
    DatabaseSync?: new (filePath: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(params?: Record<string, unknown>): unknown;
      };
      close(): void;
    };
  };
  const DatabaseCtor = sqliteModule.DatabaseSync;

  if (!DatabaseCtor) {
    throw new Error("node:sqlite DatabaseSync unavailable for RFC-010 verification");
  }

  const db = new DatabaseCtor(dbPath);

  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    const insertMessage = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (:id, :sessionId, :timeCreated, :timeUpdated, :data)`
    );
    const insertPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (:id, :messageId, :sessionId, :timeCreated, :timeUpdated, :data)`
    );

    for (const message of messages) {
      insertMessage.run({
        id: message.id,
        sessionId: message.sessionId,
        timeCreated: message.timeCreated,
        timeUpdated: message.timeCreated,
        data: JSON.stringify({
          role: message.role,
          time: { created: message.timeCreated },
        }),
      });

      for (const [index, part] of message.parts.entries()) {
        insertPart.run({
          id: part.id,
          messageId: message.id,
          sessionId: message.sessionId,
          timeCreated: message.timeCreated + index,
          timeUpdated: message.timeCreated + index,
          data: JSON.stringify({
            type: part.type,
            text: part.text,
            synthetic: part.synthetic,
          }),
        });
      }
    }
  } finally {
    db.close();
  }
}

function createNoopAdapter(): OpenCodeSessionAdapter {
  const unsupported = async () => ({
    ok: false as const,
    error: new DomainError(ERROR_CODES.NOT_FOUND, "unused"),
  });

  return {
    resolveProject: unsupported as OpenCodeSessionAdapter["resolveProject"],
    createSession: unsupported as OpenCodeSessionAdapter["createSession"],
    attachSession: unsupported as OpenCodeSessionAdapter["attachSession"],
    sendMessage: unsupported as OpenCodeSessionAdapter["sendMessage"],
    runCommand: unsupported as OpenCodeSessionAdapter["runCommand"],
    getSessionState: unsupported as OpenCodeSessionAdapter["getSessionState"],
    cancelOrInterrupt: unsupported as OpenCodeSessionAdapter["cancelOrInterrupt"],
    observeSession: unsupported as OpenCodeSessionAdapter["observeSession"],
    submitPromptInput: unsupported as OpenCodeSessionAdapter["submitPromptInput"],
  };
}

void main().catch((error) => {
  console.error("RFC-010 CLI local linking verification failed");
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

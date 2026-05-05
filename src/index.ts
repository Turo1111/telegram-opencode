import { loadConfig } from "./config";
import { logger } from "./logger";
import { startBot } from "./bot";
import { createPersistenceDriver } from "./infrastructure/persistence/factory";
import { bootRecover, createApplicationUseCases } from "./application/use-cases";
import { createOpenCodeSessionAdapter } from "./infrastructure/opencode-session-adapter";
import { sendAsyncSessionNotice, sendBootRecoveryNotices } from "./adapters/telegram/message-sender";
import { createSessionWebhookReceiver } from "./infrastructure/http/session-webhook-receiver";
import { createSessionWatcherService } from "./application/session-watcher-service";
import TelegramBot from "node-telegram-bot-api";
import { OPEN_CODE_ADAPTER_MODE } from "./infrastructure/opencode-adapter-mode";
import { createOpenCodeCliMirrorService } from "./application/opencode-cli-mirror-service";
import { createLocalTerminalLauncher } from "./infrastructure/local-terminal-launcher";
import { hasSessionByOpenCodeSessionId } from "./infrastructure/opencode-tmux-host";
import { exportSession } from "./infrastructure/opencode-cli";
import { readOpenCodeLocalSessionMessages } from "./infrastructure/opencode-local-store";

interface StartupDependencies {
  readonly loadConfig: typeof loadConfig;
  readonly createPersistenceDriver: typeof createPersistenceDriver;
  readonly createOpenCodeSessionAdapter: typeof createOpenCodeSessionAdapter;
  readonly bootRecover: typeof bootRecover;
  readonly startBot: typeof startBot;
  readonly sendBootRecoveryNotices: typeof sendBootRecoveryNotices;
  readonly sendAsyncSessionNotice: typeof sendAsyncSessionNotice;
  readonly createSessionWebhookReceiver: typeof createSessionWebhookReceiver;
  readonly createSessionWatcherService: typeof createSessionWatcherService;
  readonly createOpenCodeCliMirrorService?: typeof createOpenCodeCliMirrorService;
}

const DEFAULT_STARTUP_DEPS: StartupDependencies = {
  loadConfig,
  createPersistenceDriver,
  createOpenCodeSessionAdapter,
  bootRecover,
  startBot,
  sendBootRecoveryNotices,
  sendAsyncSessionNotice,
  createSessionWebhookReceiver,
  createSessionWatcherService,
  createOpenCodeCliMirrorService,
};

export async function bootstrapApplication(deps: StartupDependencies = DEFAULT_STARTUP_DEPS): Promise<void> {
  const config = deps.loadConfig();
  let botRef: TelegramBot | undefined;
  logger.info("Config loaded", {
    locale: config.locale,
    allowedUserCount: config.allowedUserIds.length,
    pollingIntervalMs: config.pollingIntervalMs,
    openCodeTimeoutMs: config.openCodeTimeoutMs,
    stateDriver: config.stateDriver,
    bootRemoteReconcile: config.bootRemoteReconcile,
    watcherEnabled: config.watcherEnabled,
    watchdogEnabled: config.watchdogEnabled,
  });

  const persistence = await deps.createPersistenceDriver(config);
  const adapter = deps.createOpenCodeSessionAdapter(config);
  const recovery = await deps.bootRecover(persistence, {
    adapter,
    remoteReconcileEnabled: config.bootRemoteReconcile,
  });

  const adapterMode = config.openCodeAdapter ?? OPEN_CODE_ADAPTER_MODE.HTTP;
  const isLocalCliLikeMode =
    adapterMode === OPEN_CODE_ADAPTER_MODE.CLI || adapterMode === OPEN_CODE_ADAPTER_MODE.PTY;
  const localTerminalLauncher = createLocalTerminalLauncher({
    timeoutMs: config.localTerminalLaunchTimeoutMs ?? 4000,
  });

  let activeHandler: Parameters<typeof deps.createSessionWebhookReceiver>[0]["onEvent"] = async () => ({
    statusCode: 503,
    body: { ok: false, error: "watcher-not-ready" },
  });

  const receiver = !isLocalCliLikeMode && config.watcherEnabled
    ? await deps.createSessionWebhookReceiver({
        config,
        onEvent: async (auth, event) => activeHandler(auth, event),
      })
    : undefined;

  const watcher = receiver
    ? deps.createSessionWatcherService({
        config,
        persistence,
        adapter,
        readRuntimeMessages: buildRuntimeMessagesReader(config),
        callbackUrl: receiver.callbackUrl,
        notify: async (notice) => {
          if (!botRef) {
            return;
          }

          await deps.sendAsyncSessionNotice({
            bot: botRef,
            notice,
            persistence,
          });
        },
      })
    : undefined;

  if (watcher) {
    activeHandler = watcher.handleIncomingEvent;
  }

  let cliMirror: ReturnType<typeof createOpenCodeCliMirrorService> | undefined;

  const useCases = createApplicationUseCases({
    persistence,
    adapter,
    createWatcherRegistration: watcher?.createRegistration,
    localHostOptions: {
      allowedActorIds: config.allowedUserIds,
      localHostActionsEnabled: config.localHostActionsEnabled,
      attachLocalEnabled: config.attachLocalEnabled,
      localHostConfirmationTtlMs: config.localHostConfirmationTtlMs,
      isLocalHostEnvironmentReady: async () => localTerminalLauncher.isEnvironmentReady(),
    },
    localTerminalLauncher,
    hasTmuxSessionBySessionId: hasSessionByOpenCodeSessionId,
    openCodeDefaultAgent: config.openCodeDefaultAgent,
    readRuntimeMessages: buildRuntimeMessagesReader(config),
    onAssistantMessageProduced: ({ sessionId, message }) => {
      cliMirror?.registerTelegramEcho(sessionId, message);
    },
  });

  logger.info("Persistence boot recovery finished", {
    recoveredChats: recovery.recoveredChats,
    chatsInError: recovery.chatsInError,
    cleanedBindings: recovery.cleanedBindings,
    evaluatedBindings: recovery.evaluatedBindings,
    queuedNotices: recovery.notices.length,
  });

  const bot = deps.startBot({ config, useCases, persistence });
  botRef = bot;

  if (isLocalCliLikeMode) {
    cliMirror = (deps.createOpenCodeCliMirrorService ?? createOpenCodeCliMirrorService)({
      config,
      persistence,
      bot,
    });

    cliMirror.start();

    registerShutdown(bot, watcher, receiver, cliMirror);
  } else {
    registerShutdown(bot, watcher, receiver);
  }

  await deps.sendBootRecoveryNotices({
    bot,
    notices: recovery.notices,
  });

  if (watcher) {
    await watcher.restoreAfterRestart();
    watcher.startScheduler();
  }
}

function buildRuntimeMessagesReader(config: ReturnType<typeof loadConfig>) {
  const adapterMode = config.openCodeAdapter ?? OPEN_CODE_ADAPTER_MODE.HTTP;
  const isLocalCliLikeMode =
    adapterMode === OPEN_CODE_ADAPTER_MODE.CLI || adapterMode === OPEN_CODE_ADAPTER_MODE.PTY;

  if (isLocalCliLikeMode) {
    return async (sessionId: string) => {
      const exported = await readOpenCodeLocalSessionMessages({ sessionId });
      return exported.messages;
    };
  }

  return async (sessionId: string) => {
    const exported = await exportSession({
      sessionId,
      timeoutMs: config.openCodeControlTimeoutMs,
    });
    return exported.messages;
  };
}

async function main() {
  await bootstrapApplication();
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", { reason: String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});

process.on("exit", (code) => {
});

if (require.main === module) {
  main().catch((err) => {
    logger.error("Fatal error", { message: err.message });
    process.exit(1);
  });
}

function registerShutdown(
  bot: TelegramBot,
  watcher: ReturnType<typeof createSessionWatcherService> | undefined,
  receiver: Awaited<ReturnType<typeof createSessionWebhookReceiver>> | undefined,
  cliMirror?: ReturnType<typeof createOpenCodeCliMirrorService>
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("Shutdown requested", { signal });
    watcher?.stopScheduler();
    cliMirror?.stop();

    if (receiver) {
      await receiver.close().catch((error) => {
        logger.error("Webhook receiver close failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    await bot.stopPolling().catch(() => undefined);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OpenCodeSessionAdapter,
  Result,
  SESSION_EVENT_KIND,
  SessionEvent,
  SessionState,
  SendResult,
  ObserveSessionResult,
  CancelOrInterruptResult,
  WebhookAuthContext,
} from "../application/contracts";
import { createSessionWatcherService } from "../application/session-watcher-service";
import { ACTIVE_TASK_STATUS, OPERATIONAL_MODES } from "../domain/entities";
import { DomainError, ERROR_CODES } from "../domain/errors";
import { createJsonPersistenceDriver } from "../infrastructure/persistence/json-store";
import { STATE_DRIVERS, type Config, loadConfig } from "../config";
import {
  createSessionWebhookReceiver,
  type ReceiverHandlerResult,
} from "../infrastructure/http/session-webhook-receiver";

interface ScenarioResult {
  readonly id: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

class VerificationAdapter implements OpenCodeSessionAdapter {
  private readonly states = new Map<string, Result<SessionState>>();

  seed(state: SessionState): void {
    this.states.set(state.sessionId, { ok: true, value: state });
  }

  seedError(sessionId: string, error: DomainError): void {
    this.states.set(sessionId, { ok: false, error });
  }

  async resolveProject(): Promise<Result<{ canonicalPath: string }>> {
    return { ok: true, value: { canonicalPath: "/tmp" } };
  }

  async createSession(): Promise<Result<SessionState>> {
    throw new Error("not used");
  }

  async attachSession(): Promise<Result<SessionState>> {
    throw new Error("not used");
  }

  async sendMessage(): Promise<Result<SendResult>> {
    throw new Error("not used");
  }

  async runCommand(): Promise<Result<SendResult>> {
    throw new Error("not used");
  }

  async getSessionState(input: { projectId: string; sessionId: string }): Promise<Result<SessionState>> {
    const seeded = this.states.get(input.sessionId);
    if (seeded) {
      return seeded;
    }

    return {
      ok: false,
      error: new DomainError(ERROR_CODES.NOT_FOUND, "missing"),
    };
  }

  async cancelOrInterrupt(): Promise<Result<CancelOrInterruptResult>> {
    throw new Error("not used");
  }

  async observeSession(): Promise<Result<ObserveSessionResult>> {
    return { ok: true, value: { mode: "not-available-yet" } };
  }

  async submitPromptInput(): Promise<Result<{ status: "accepted"; message?: string }>> {
    return { ok: true, value: { status: "accepted" } };
  }
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
  run: () => Promise<string>
): Promise<ScenarioResult> {
  try {
    const actual = await run();
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

async function verificationHarness(
  options: {
    readonly webhookPortStart: number;
    readonly webhookPortEnd: number;
    readonly watchdogStaleAfterMs: number;
    readonly watchdogMaxRetryCount: number;
    readonly fixtureName: string;
  },
  run: (ctx: {
    readonly config: Config;
    readonly tempDir: string;
    readonly adapter: VerificationAdapter;
    readonly notices: string[];
    readonly receiver: Awaited<ReturnType<typeof createSessionWebhookReceiver>>;
    readonly watcher: ReturnType<typeof createSessionWatcherService>;
    readonly registration: ReturnType<ReturnType<typeof createSessionWatcherService>["createRegistration"]>;
    readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
  }) => Promise<void>
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${options.fixtureName}-`));
  const notices: string[] = [];
  const adapter = new VerificationAdapter();

  const config: Config = {
    telegramBotToken: "dummy",
    allowedUserIds: ["7001"],
    openCodeUrl: "http://127.0.0.1:3000",
    openCodeToken: "dev-token",
    openCodeTimeoutMs: 250,
    openCodeControlTimeoutMs: 250,
    openCodeExecTimeoutMs: 250,
    pollingIntervalMs: 1000,
    locale: "es",
    stateDriver: STATE_DRIVERS.JSON,
    stateDbPath: path.join(tempDir, "state.sqlite"),
    stateJsonPath: path.join(tempDir, "state.json"),
    compatLegacyTextBridge: false,
    compatRunCmdCommands: true,
    bootRemoteReconcile: true,
    chatLockEnabled: true,
    lockWarnWaitMs: 1500,
    watcherEnabled: true,
    watchdogEnabled: true,
    webhookHost: "127.0.0.1",
    webhookPortStart: options.webhookPortStart,
    webhookPortEnd: options.webhookPortEnd,
    watchdogIntervalMs: 1000,
    watchdogStaleAfterMs: options.watchdogStaleAfterMs,
    watchdogMaxRetryCount: options.watchdogMaxRetryCount,
    humanPromptsEnabled: false,
    humanPromptLocalTtlMs: 300000,
  };

  const persistence = await createJsonPersistenceDriver(config);

  let handler: (auth: WebhookAuthContext, event: SessionEvent) => Promise<ReceiverHandlerResult> = async () => ({
    statusCode: 503,
    body: { ok: false },
  });

  const receiver = await createSessionWebhookReceiver({
    config,
    onEvent: async (auth, event) => handler(auth, event),
  });

  const watcher = createSessionWatcherService({
    config,
    persistence,
    adapter,
    callbackUrl: receiver.callbackUrl,
    notify: async (notice) => {
      notices.push(`${notice.kind}:${notice.sessionId}`);
    },
  });

  handler = watcher.handleIncomingEvent;
  const registration = watcher.createRegistration();

  try {
    await run({
      config,
      tempDir,
      adapter,
      notices,
      receiver,
      watcher,
      registration,
      persistence,
    });
  } finally {
    watcher.stopScheduler();
    await receiver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function seedSessionFixture(input: {
  readonly persistence: Awaited<ReturnType<typeof createJsonPersistenceDriver>>;
  readonly tempDir: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly chatId: string;
  readonly taskId?: string;
  readonly watcherToken?: string;
  readonly watcherCallbackUrl?: string;
  readonly lastObservedAt?: string;
}): Promise<void> {
  await input.persistence.runInTransaction(async (unit) => {
    await unit.projects.upsert({
      projectId: input.projectId,
      alias: input.projectId,
      rootPath: input.tempDir,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await unit.sessions.upsert({
      sessionId: input.sessionId,
      projectId: input.projectId,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      watcherEnabled: true,
      watcherToken: input.watcherToken,
      watcherCallbackUrl: input.watcherCallbackUrl,
      lastObservedAt: input.lastObservedAt,
    });
    await unit.bindings.upsert({
      chatId: input.chatId,
      activeProjectId: input.projectId,
      activeSessionId: input.sessionId,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    if (input.taskId) {
      await unit.states.upsert({
        chatId: input.chatId,
        mode: OPERATIONAL_MODES.TASK_RUNNING,
        activeTaskId: input.taskId,
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await unit.tasks.upsert({
        taskId: input.taskId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        status: ACTIVE_TASK_STATUS.IN_PROGRESS,
        command: "npm test",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      return;
    }

    await unit.states.upsert({
      chatId: input.chatId,
      mode: OPERATIONAL_MODES.SESSION_LINKED,
      activeTaskId: undefined,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
  });
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  results.push(
    await runCase(
      "S01",
      "Port fallback succeeds",
      "receiver binds next free port in configured range",
      async () => {
        await verificationHarness(
          {
            fixtureName: "rfc7-port-fallback",
            webhookPortStart: 4140,
            webhookPortEnd: 4142,
            watchdogStaleAfterMs: 1,
            watchdogMaxRetryCount: 2,
          },
          async ({ config, receiver }) => {
            const fallback = await createSessionWebhookReceiver({
              config,
              onEvent: async () => ({ statusCode: 202, body: { ok: true } }),
            });
            try {
              assert(fallback.port === receiver.port + 1, "fallback did not pick next configured free port");
            } finally {
              await fallback.close();
            }
          }
        );
        return "fallback-port-ok";
      }
    )
  );

  results.push(
    await runCase("S02", "No port available", "creation fails deterministically", async () => {
      await verificationHarness(
        {
          fixtureName: "rfc7-no-port",
          webhookPortStart: 4150,
          webhookPortEnd: 4150,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 2,
        },
        async ({ config }) => {
          let failed = false;
          try {
            await createSessionWebhookReceiver({
              config,
              onEvent: async () => ({ statusCode: 202, body: { ok: true } }),
            });
          } catch (error) {
            failed = true;
            assert(String(error).includes("No webhook receiver port available"), "missing explicit no-port failure");
          }

          assert(failed, "receiver should fail when no port is available");
        }
      );

      return "no-port-fail-fast";
    })
  );

  results.push(
    await runCase(
      "S03",
      "Missing/malformed auth header and wrong token",
      "missing/malformed => 401, wrong token => 403",
      async () => {
        await verificationHarness(
          {
            fixtureName: "rfc7-unauthorized",
          webhookPortStart: 4160,
          webhookPortEnd: 4161,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 2,
        },
        async ({ persistence, tempDir, receiver, registration }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-auth",
            sessionId: "sess-auth",
            chatId: "7001",
            taskId: "task-auth",
            watcherToken: registration.bearerToken,
            watcherCallbackUrl: receiver.callbackUrl,
          });

          const missingHeader = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-auth",
              timestamp: new Date().toISOString(),
            }),
          });

          assert(missingHeader.status === 401, `expected 401 for missing header, got ${missingHeader.status}`);

          const malformedHeader = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${registration.bearerToken} trailing`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-auth",
              timestamp: new Date().toISOString(),
            }),
          });

          assert(malformedHeader.status === 401, `expected 401 for malformed bearer, got ${malformedHeader.status}`);

          const wrongToken = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: "Bearer not-the-session-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-auth",
              timestamp: new Date().toISOString(),
            }),
          });

          assert(wrongToken.status === 403, `expected 403 for invalid token, got ${wrongToken.status}`);
        }
      );

        return "auth-contract-401-403";
      }
    )
  );

  results.push(
    await runCase("S04", "Token replay after terminal", "first terminal 202; replay with old token 403", async () => {
      await verificationHarness(
        {
          fixtureName: "rfc7-terminal-idempotent",
          webhookPortStart: 4170,
          webhookPortEnd: 4171,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 2,
        },
        async ({ persistence, tempDir, receiver, registration, notices }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-terminal",
            sessionId: "sess-terminal",
            chatId: "7002",
            taskId: "task-terminal",
            watcherToken: registration.bearerToken,
            watcherCallbackUrl: receiver.callbackUrl,
          });

          const first = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${registration.bearerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-terminal",
              timestamp: new Date().toISOString(),
            }),
          });

          const replay = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${registration.bearerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-terminal",
              timestamp: new Date().toISOString(),
            }),
          });

          assert(first.status === 202, `first terminal event should be accepted, got ${first.status}`);
          assert(replay.status === 403, `replay should be rejected with 403, got ${replay.status}`);

          const terminalNotices = notices.filter((entry) => entry === "terminal:sess-terminal");
          assert(terminalNotices.length === 1, `expected one terminal notification, got ${terminalNotices.length}`);
        }
      );

      return "terminal-replay-rejected";
    })
  );

  results.push(
    await runCase("S05", "Needs input delivery", "needs-input keeps session non-terminal and notifies", async () => {
      await verificationHarness(
        {
          fixtureName: "rfc7-needs-input",
          webhookPortStart: 4180,
          webhookPortEnd: 4181,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 2,
        },
        async ({ persistence, tempDir, receiver, registration, notices }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-needs-input",
            sessionId: "sess-needs-input",
            chatId: "7003",
            taskId: "task-needs-input",
            watcherToken: registration.bearerToken,
            watcherCallbackUrl: receiver.callbackUrl,
          });

          const response = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${registration.bearerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.NEEDS_INPUT,
              session_id: "sess-needs-input",
              timestamp: new Date().toISOString(),
              data: { summary: "Confirmá deploy" },
            }),
          });

          assert(response.status === 202, `needs-input should be accepted, got ${response.status}`);
          assert(notices.includes("needs-input:sess-needs-input"), "needs-input notice not emitted");

          const session = await persistence.runInTransaction((unit) => unit.sessions.findById("sess-needs-input"));
          assert(session?.terminalCause === undefined, "needs-input should not terminalize the session");
        }
      );

      return "needs-input-ok";
    })
  );

  results.push(
    await runCase("S06", "Silent upstream crash", "watchdog reconciles and releases with terminal notice", async () => {
      await verificationHarness(
        {
          fixtureName: "rfc7-watchdog-recover",
          webhookPortStart: 4190,
          webhookPortEnd: 4191,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 2,
        },
        async ({ persistence, tempDir, receiver, adapter, notices, watcher }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-watchdog",
            sessionId: "sess-watchdog",
            chatId: "7004",
            taskId: "task-watchdog",
            watcherToken: "watchdog-token",
            watcherCallbackUrl: receiver.callbackUrl,
            lastObservedAt: "2026-01-01T00:00:00.000Z",
          });

          adapter.seed({ sessionId: "sess-watchdog", projectId: "proj-watchdog", status: "completed" });

          await watcher.runWatchdogSweep("2026-01-01T00:01:00.000Z");

          const session = await persistence.runInTransaction((unit) => unit.sessions.findById("sess-watchdog"));
          assert(Boolean(session?.terminalCause), "watchdog did not terminalize stale session");
          assert(notices.includes("terminal:sess-watchdog"), "watchdog terminal notice missing");
        }
      );

      return "watchdog-recovered";
    })
  );

  results.push(
    await runCase("S07", "Transient status failure", "retryable polling errors do not terminalize before budget", async () => {
      await verificationHarness(
        {
          fixtureName: "rfc7-watchdog-transient",
          webhookPortStart: 4200,
          webhookPortEnd: 4201,
          watchdogStaleAfterMs: 1,
          watchdogMaxRetryCount: 3,
        },
        async ({ persistence, tempDir, receiver, adapter, watcher }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-transient",
            sessionId: "sess-transient",
            chatId: "7005",
            taskId: "task-transient",
            watcherToken: "transient-token",
            watcherCallbackUrl: receiver.callbackUrl,
            lastObservedAt: "2026-01-01T00:00:00.000Z",
          });

          adapter.seedError(
            "sess-transient",
            new DomainError(ERROR_CODES.UPSTREAM_TIMEOUT, "temporary timeout", {
              details: { retryable: true },
            })
          );

          await watcher.runWatchdogSweep("2026-01-01T00:01:00.000Z");

          const session = await persistence.runInTransaction((unit) => unit.sessions.findById("sess-transient"));
          assert(session?.terminalCause === undefined, "transient failure should not terminalize early");
          assert(session?.watchdogRetryCount === 1, `expected retry count 1, got ${session?.watchdogRetryCount}`);
        }
      );

      return "transient-retry-ok";
    })
  );

  results.push(
    await runCase(
      "S08",
      "Restart reconciliation",
      "restore invalidates token, emits continuity lost, and old token is rejected",
      async () => {
        await verificationHarness(
          {
            fixtureName: "rfc7-restart",
          webhookPortStart: 4210,
          webhookPortEnd: 4211,
          watchdogStaleAfterMs: 60_000,
          watchdogMaxRetryCount: 2,
        },
        async ({ persistence, tempDir, receiver, registration, watcher, notices }) => {
          await seedSessionFixture({
            persistence,
            tempDir,
            projectId: "proj-restart",
            sessionId: "sess-restart",
            chatId: "7006",
            taskId: "task-restart",
            watcherToken: registration.bearerToken,
            watcherCallbackUrl: receiver.callbackUrl,
          });

          await watcher.restoreAfterRestart("2026-01-01T00:02:00.000Z");

          const session = await persistence.runInTransaction((unit) => unit.sessions.findById("sess-restart"));
          assert(session?.watcherToken === undefined, "restart should invalidate prior watcher token");
          assert(notices.includes("continuity-lost:sess-restart"), "restart continuity-lost notice missing");

          const replay = await fetch(receiver.callbackUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${registration.bearerToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event: SESSION_EVENT_KIND.COMPLETED,
              session_id: "sess-restart",
              timestamp: new Date().toISOString(),
            }),
          });

          assert(replay.status === 403, `old token after restart should be rejected with 403, got ${replay.status}`);
        }
      );

        return "restart-token-replay-rejected";
      }
    )
  );

  results.push(
    await runCase("S09", "Config validation", "invalid webhook port range fails fast", async () => {
      const previousStart = process.env.WEBHOOK_PORT_START;
      const previousEnd = process.env.WEBHOOK_PORT_END;
      const previousHost = process.env.WEBHOOK_HOST;
      const previousAllowedUserId = process.env.ALLOWED_USER_ID;

      process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "dummy";
      process.env.ALLOWED_USER_ID = process.env.ALLOWED_USER_ID || "7001";
      process.env.OPEN_CODE_URL = process.env.OPEN_CODE_URL || "http://127.0.0.1:3000";
      process.env.OPEN_CODE_TOKEN = process.env.OPEN_CODE_TOKEN || "dev-token";
      process.env.WEBHOOK_HOST = "127.0.0.1";
      process.env.WEBHOOK_PORT_START = "4300";
      process.env.WEBHOOK_PORT_END = "4200";

      let failed = false;
      try {
        loadConfig();
      } catch (error) {
        failed = true;
        assert(String(error).includes("Invalid webhook port range"), "missing explicit invalid range error");
      } finally {
        if (previousStart === undefined) {
          delete process.env.WEBHOOK_PORT_START;
        } else {
          process.env.WEBHOOK_PORT_START = previousStart;
        }

        if (previousEnd === undefined) {
          delete process.env.WEBHOOK_PORT_END;
        } else {
          process.env.WEBHOOK_PORT_END = previousEnd;
        }

        if (previousHost === undefined) {
          delete process.env.WEBHOOK_HOST;
        } else {
          process.env.WEBHOOK_HOST = previousHost;
        }

        if (previousAllowedUserId === undefined) {
          delete process.env.ALLOWED_USER_ID;
        } else {
          process.env.ALLOWED_USER_ID = previousAllowedUserId;
        }
      }

      assert(failed, "config should fail fast for invalid webhook range");
      return "invalid-config-fails-fast";
    })
  );

  const lines = [
    "RFC-007 Watcher Verification",
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
  console.error("No pude ejecutar verificación RFC7", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

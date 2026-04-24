import axios from "axios";
import {
  ADAPTER_ERROR_CODES,
  AdapterError,
  CancelOrInterruptResult,
  ObserveSessionResult,
  OpenCodeSessionAdapter,
  ResumePromptInput,
  Result,
  SendResult,
  SessionWatcherRegistration,
  SessionState,
  SubmitPromptInputResult,
} from "../application/contracts";
import { mapUpstreamFailureToAdapterError, normalizeRemoteSessionStatus } from "../application/remote-mappers";
import { Config } from "../config";
import { DomainError, ERROR_CODES, mapAdapterErrorToDomainError } from "../domain/errors";
import {
  OpenCodeHttpClient,
  OPEN_CODE_OPERATION_KINDS,
  createOpenCodeHttpClient,
} from "../opencode";
import { logger } from "../logger";
import {
  listSessions,
  OpenCodeCliError,
  resolveCanonicalProjectPath,
  runSessionMessage,
  startSessionMessage,
} from "./opencode-cli";
import { OPEN_CODE_ADAPTER_MODE } from "./opencode-adapter-mode";
import {
  ensureHostSession,
  interrupt,
  OpenCodeTmuxHostError,
  sendInput,
} from "./opencode-tmux-host";

interface ResolveProjectResponse {
  canonicalPath?: string;
  projectId?: string;
}

interface SessionPayloadResponse {
  sessionId?: string;
  projectId?: string;
  status?: string;
  taskId?: string;
  updatedAt?: string;
  needsAttention?: boolean;
  message?: string;
  cancelMode?: string;
}

export class HttpOpenCodeSessionAdapter implements OpenCodeSessionAdapter {
  constructor(private readonly client: OpenCodeHttpClient) {}

  async resolveProject(input: {
    projectId: string;
    rootPath: string;
  }): Promise<Result<{ canonicalPath: string }>> {
    try {
      const payload: ResolveProjectResponse = await this.client.post({
        endpoint: "/opencode/projects/resolve",
        operationName: "resolveProject",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          rootPath: input.rootPath,
        },
      });

      const canonicalPath = payload.canonicalPath ?? input.rootPath;

      if (!canonicalPath.trim()) {
        return err(
          new DomainError(ERROR_CODES.UPSTREAM_5XX, "OpenCode devolvió canonicalPath inválido", {
            details: {
              projectId: input.projectId,
            },
          })
        );
      }

      return ok({ canonicalPath });
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "resolveProject")));
    }
  }

  async createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SessionState>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/create",
        operationName: "createSession",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          rootPath: input.rootPath,
          source: input.source,
          webhookUrl: input.watch?.callbackUrl,
          webhookToken: input.watch?.bearerToken,
        },
      });

      return ok(toSessionState(payload, {
        fallbackProjectId: input.projectId,
        operation: "createSession",
      }));
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "createSession")));
    }
  }

  async attachSession(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SessionState>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/attach",
        operationName: "attachSession",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
        },
      });

      if (payload.projectId && payload.projectId !== input.projectId) {
        return err(mapAdapterResultError(sessionProjectMismatchError(input, payload)));
      }

      return ok(toSessionState(payload, {
        fallbackProjectId: input.projectId,
        fallbackSessionId: input.sessionId,
        operation: "attachSession",
      }));
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "attachSession")));
    }
  }

  async sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/message",
        operationName: "sendMessage",
        operationKind: OPEN_CODE_OPERATION_KINDS.EXECUTION,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
          message: input.message,
          chatId: input.chatId,
          webhookUrl: input.watch?.callbackUrl,
          webhookToken: input.watch?.bearerToken,
        },
      });

      if (payload.projectId && payload.projectId !== input.projectId) {
        return err(mapAdapterResultError(sessionProjectMismatchError(input, payload)));
      }

      const state = toSessionState(payload, {
        fallbackProjectId: input.projectId,
        fallbackSessionId: input.sessionId,
        operation: "sendMessage",
      });

      return ok({
        taskId: payload.taskId,
        reply: payload.message ?? "",
        message: payload.message ?? "",
        needsAttention: payload.needsAttention ?? false,
        status: payload.status ? normalizeRemoteSessionStatus(payload.status) : undefined,
        state,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "sendMessage")));
    }
  }

  async runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/command",
        operationName: "runCommand",
        operationKind: OPEN_CODE_OPERATION_KINDS.EXECUTION,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
          command: input.command,
          chatId: input.chatId,
          webhookUrl: input.watch?.callbackUrl,
          webhookToken: input.watch?.bearerToken,
        },
      });

      if (payload.projectId && payload.projectId !== input.projectId) {
        return err(mapAdapterResultError(sessionProjectMismatchError(input, payload)));
      }

      const state = toSessionState(payload, {
        fallbackProjectId: input.projectId,
        fallbackSessionId: input.sessionId,
        operation: "runCommand",
      });

      return ok({
        taskId: payload.taskId,
        ack: payload.message ?? "",
        message: payload.message ?? "",
        needsAttention: payload.needsAttention ?? false,
        status: payload.status ? normalizeRemoteSessionStatus(payload.status) : undefined,
        state,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "runCommand")));
    }
  }

  async getSessionState(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SessionState>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/state",
        operationName: "getSessionState",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
        },
      });

      if (payload.projectId && payload.projectId !== input.projectId) {
        return err(mapAdapterResultError(sessionProjectMismatchError(input, payload)));
      }

      return ok(toSessionState(payload, {
        fallbackProjectId: input.projectId,
        fallbackSessionId: input.sessionId,
        operation: "getSessionState",
      }));
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "getSessionState")));
    }
  }

  async cancelOrInterrupt(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<CancelOrInterruptResult>> {
    try {
      const payload: SessionPayloadResponse = await this.client.post({
        endpoint: "/opencode/sessions/cancel",
        operationName: "cancelOrInterrupt",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
          chatId: input.chatId,
        },
      });

      if (payload.projectId && payload.projectId !== input.projectId) {
        return err(mapAdapterResultError(sessionProjectMismatchError(input, payload)));
      }

      return ok({
        status: payload.cancelMode === "accepted" ? "accepted" : "cancelled",
        message: payload.message ?? "Cancelación solicitada",
      });
    } catch (error) {
      return err(mapAdapterResultError(mapOpenCodeError(error, "cancelOrInterrupt")));
    }
  }

  async observeSession(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>> {
    return ok({
      mode: "not-available-yet",
    });
  }

  async submitPromptInput(input: ResumePromptInput): Promise<Result<SubmitPromptInputResult>> {
    const normalizedInput = input.input.trim();
    if (!normalizedInput) {
      return err(
        new DomainError(ERROR_CODES.VALIDATION_ERROR, "La respuesta del prompt no puede estar vacía", {
          details: {
            projectId: input.projectId,
            sessionId: input.sessionId,
            promptId: input.promptId,
            source: input.source,
          },
        })
      );
    }

    try {
      const payload: { status?: string; message?: string } = await this.client.post({
        endpoint: "/opencode/sessions/resume-input",
        operationName: "submitPromptInput",
        operationKind: OPEN_CODE_OPERATION_KINDS.CONTROL,
        payload: {
          projectId: input.projectId,
          sessionId: input.sessionId,
          promptId: input.promptId,
          input: normalizedInput,
          source: input.source,
        },
      });

      logger.prompt("OpenCode submitPromptInput accepted", {
        session_id: input.sessionId,
        chat_id: undefined,
        prompt_id: input.promptId,
        event: "submit-prompt-bridge",
        status: payload.status ?? "accepted",
        reason: "http-2xx",
      });

      return ok({
        status: "accepted",
        message: payload.message,
      });
    } catch (error) {
      const mapped = mapOpenCodeError(error, "submitPromptInput");
      logger.prompt("OpenCode submitPromptInput failed", {
        session_id: input.sessionId,
        chat_id: undefined,
        prompt_id: input.promptId,
        event: "submit-prompt-bridge",
        status: "error",
        reason: mapped.code,
      });
      return err(mapAdapterResultError(mapped));
    }
  }
}

export class CliOpenCodeSessionAdapter implements OpenCodeSessionAdapter {
  private readonly projectDirById = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly cliOps: {
      readonly listSessions: typeof listSessions;
      readonly resolveCanonicalProjectPath: typeof resolveCanonicalProjectPath;
      readonly runSessionMessage: typeof runSessionMessage;
      readonly startSessionMessage: typeof startSessionMessage;
    } = {
      listSessions,
      resolveCanonicalProjectPath,
      runSessionMessage,
      startSessionMessage,
    }
  ) {}

  async resolveProject(input: {
    projectId: string;
    rootPath: string;
    }): Promise<Result<{ canonicalPath: string }>> {
    try {
      const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(input.rootPath);
      this.projectDirById.set(input.projectId, canonicalPath);
      return ok({ canonicalPath });
    } catch (error) {
      return err(mapAdapterResultError(mapCliError(error, "resolveProject")));
    }
  }

  async createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SessionState>> {
    return err(
      mapAdapterResultError(
        unsupportedError(
          "createSession",
          "En modo CLI no se pueden crear sesiones desde Telegram. Creá/continuá una sesión desde OpenCode en tu PC/WSL y luego vinculala con /session <id>."
        )
      )
    );
  }

  async attachSession(input: {
    projectId: string;
    sessionId: string;
    }): Promise<Result<SessionState>> {
    try {
      const sessions = await this.cliOps.listSessions(this.config.openCodeControlTimeoutMs);
      const match = sessions.find((item) => item.id === input.sessionId);
      if (!match) {
        return err(
          mapAdapterResultError({
            code: ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
            message: `No encontré la sesión ${input.sessionId} en OpenCode CLI`,
            retryable: false,
            details: {
              operation: "attachSession",
              sessionId: input.sessionId,
            },
          })
        );
      }

      if (match.path) {
        const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(match.path);
        const projectMismatch = this.ensureSessionMatchesActiveProject(input.projectId, canonicalPath, input.sessionId);
        if (projectMismatch) {
          return err(mapAdapterResultError(projectMismatch));
        }

        this.projectDirById.set(input.projectId, canonicalPath);
      }

      return ok({
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "idle",
        updatedAt: match.updatedAt,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapCliError(error, "attachSession")));
    }
  }

  async sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    try {
      const dir = await this.resolveProjectDir(input.projectId);
      await this.cliOps.startSessionMessage({
        sessionId: input.sessionId,
        dir,
        message: input.message,
      });

      return ok({
        message: "",
        reply: "Mensaje enviado a OpenCode. Te respondo por acá cuando llegue la salida del mirror.",
        needsAttention: false,
        state: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: "idle",
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return err(mapAdapterResultError(mapCliError(error, "sendMessage")));
    }
  }

  async runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    return this.sendMessage({
      projectId: input.projectId,
      sessionId: input.sessionId,
      message: input.command,
      chatId: input.chatId,
      watch: input.watch,
    });
  }

  async getSessionState(input: {
    projectId: string;
    sessionId: string;
    }): Promise<Result<SessionState>> {
    try {
      const sessions = await this.cliOps.listSessions(this.config.openCodeControlTimeoutMs);
      const match = sessions.find((item) => item.id === input.sessionId);

      if (!match) {
        return err(
          mapAdapterResultError({
            code: ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
            message: `No encontré la sesión ${input.sessionId} en OpenCode CLI`,
            retryable: false,
            details: {
              operation: "getSessionState",
              sessionId: input.sessionId,
            },
          })
        );
      }

      if (match.path) {
        const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(match.path);
        const projectMismatch = this.ensureSessionMatchesActiveProject(input.projectId, canonicalPath, input.sessionId);
        if (projectMismatch) {
          return err(mapAdapterResultError(projectMismatch));
        }

        this.projectDirById.set(input.projectId, canonicalPath);
      }

      return ok({
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "idle",
        updatedAt: match.updatedAt,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapCliError(error, "getSessionState")));
    }
  }

  async cancelOrInterrupt(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<CancelOrInterruptResult>> {
    return err(
      mapAdapterResultError(
        unsupportedError(
          "cancelOrInterrupt",
          "En modo CLI no está disponible /cancel. Gestioná la interrupción desde tu terminal OpenCode en PC/WSL."
        )
      )
    );
  }

  async observeSession(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>> {
    return ok({
      mode: "not-available-yet",
    });
  }

  async submitPromptInput(input: ResumePromptInput): Promise<Result<SubmitPromptInputResult>> {
    return err(
      mapAdapterResultError(
        unsupportedError(
          "submitPromptInput",
          "En modo CLI la continuación de prompts interactivos se hace desde OpenCode en PC/WSL."
        )
      )
    );
  }

  private async resolveProjectDir(projectId: string): Promise<string> {
    const cached = this.projectDirById.get(projectId);
    if (cached) {
      return cached;
    }

    try {
      const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(projectId);
      this.projectDirById.set(projectId, canonicalPath);
      return canonicalPath;
    } catch {
      throw unsupportedError(
        "sendMessage",
        "No tengo un directorio válido para esta sesión en modo CLI. Reasociá el proyecto con /project <path_local> y luego /session <id>."
      );
    }
  }

  private ensureSessionMatchesActiveProject(
    projectId: string,
    canonicalSessionPath: string,
    sessionId: string
  ): AdapterError | undefined {
    const activeProjectPath = this.projectDirById.get(projectId);
    if (!activeProjectPath || activeProjectPath === canonicalSessionPath) {
      return undefined;
    }

    return sessionProjectMismatchError(
      {
        projectId,
        sessionId,
      },
      {
        projectId: canonicalSessionPath,
      }
    );
  }
}

export class PtyOpenCodeSessionAdapter implements OpenCodeSessionAdapter {
  private readonly projectDirById = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly cliOps: {
      readonly listSessions: typeof listSessions;
      readonly resolveCanonicalProjectPath: typeof resolveCanonicalProjectPath;
    } = {
      listSessions,
      resolveCanonicalProjectPath,
    },
    private readonly tmuxHostOps: {
      readonly ensureHostSession: typeof ensureHostSession;
      readonly sendInput: typeof sendInput;
      readonly interrupt: typeof interrupt;
    } = {
      ensureHostSession,
      sendInput,
      interrupt,
    }
  ) {}

  async resolveProject(input: {
    projectId: string;
    rootPath: string;
  }): Promise<Result<{ canonicalPath: string }>> {
    try {
      const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(input.rootPath);
      this.projectDirById.set(input.projectId, canonicalPath);
      return ok({ canonicalPath });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "resolveProject")));
    }
  }

  async createSession(input: {
    projectId: string;
    rootPath: string;
    source: "telegram";
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SessionState>> {
    return err(
      mapAdapterResultError(
        unsupportedError(
          "createSession",
          "En modo PTY no se pueden crear sesiones desde Telegram. Creá/continuá una sesión desde OpenCode en tu PC/WSL y luego vinculala con /session <id>."
        )
      )
    );
  }

  async attachSession(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SessionState>> {
    try {
      const sessions = await this.cliOps.listSessions(this.config.openCodeControlTimeoutMs);
      const match = sessions.find((item) => item.id === input.sessionId);
      if (!match) {
        return err(
          mapAdapterResultError({
            code: ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
            message: `No encontré la sesión ${input.sessionId} en OpenCode CLI`,
            retryable: false,
            details: {
              operation: "attachSession",
              sessionId: input.sessionId,
            },
          })
        );
      }

      const canonicalPath = await this.resolveAndValidateSessionPath(input, match.path);

      await this.tmuxHostOps.ensureHostSession({
        opencodeSessionId: input.sessionId,
        dir: canonicalPath,
        timeoutMs: this.config.openCodeControlTimeoutMs,
      });

      return ok({
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "idle",
        updatedAt: match.updatedAt,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "attachSession")));
    }
  }

  async sendMessage(input: {
    projectId: string;
    sessionId: string;
    message: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    try {
      await this.ensureSessionHostReady({
        projectId: input.projectId,
        sessionId: input.sessionId,
      });

      await this.tmuxHostOps.sendInput({
        opencodeSessionId: input.sessionId,
        input: input.message,
        timeoutMs: this.config.openCodeExecTimeoutMs,
      });

      return ok({
        message: "",
        reply:
          "Mensaje inyectado en sesión PTY/tmux. Te respondo por acá cuando llegue la salida del mirror.",
        needsAttention: false,
        state: {
          sessionId: input.sessionId,
          projectId: input.projectId,
          status: "idle",
          updatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "sendMessage")));
    }
  }

  async runCommand(input: {
    projectId: string;
    sessionId: string;
    command: string;
    chatId: string;
    watch?: SessionWatcherRegistration;
  }): Promise<Result<SendResult>> {
    return this.sendMessage({
      projectId: input.projectId,
      sessionId: input.sessionId,
      message: input.command,
      chatId: input.chatId,
      watch: input.watch,
    });
  }

  async getSessionState(input: {
    projectId: string;
    sessionId: string;
  }): Promise<Result<SessionState>> {
    try {
      const sessions = await this.cliOps.listSessions(this.config.openCodeControlTimeoutMs);
      const match = sessions.find((item) => item.id === input.sessionId);
      if (!match) {
        return err(
          mapAdapterResultError({
            code: ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
            message: `No encontré la sesión ${input.sessionId} en OpenCode CLI`,
            retryable: false,
            details: {
              operation: "getSessionState",
              sessionId: input.sessionId,
            },
          })
        );
      }

      await this.resolveAndValidateSessionPath(input, match.path);

      return ok({
        sessionId: input.sessionId,
        projectId: input.projectId,
        status: "idle",
        updatedAt: match.updatedAt,
      });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "getSessionState")));
    }
  }

  async cancelOrInterrupt(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<CancelOrInterruptResult>> {
    try {
      await this.ensureSessionHostReady({
        projectId: input.projectId,
        sessionId: input.sessionId,
      });

      await this.tmuxHostOps.interrupt({
        opencodeSessionId: input.sessionId,
        timeoutMs: this.config.openCodeControlTimeoutMs,
      });

      return ok({
        status: "accepted",
        message: "Interrupción enviada a la sesión PTY/tmux.",
      });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "cancelOrInterrupt")));
    }
  }

  async observeSession(input: {
    projectId: string;
    sessionId: string;
    chatId: string;
  }): Promise<Result<ObserveSessionResult>> {
    return ok({ mode: "not-available-yet" });
  }

  async submitPromptInput(input: ResumePromptInput): Promise<Result<SubmitPromptInputResult>> {
    const normalizedInput = input.input.trim();
    if (!normalizedInput) {
      return err(
        new DomainError(ERROR_CODES.VALIDATION_ERROR, "La respuesta del prompt no puede estar vacía", {
          details: {
            projectId: input.projectId,
            sessionId: input.sessionId,
            promptId: input.promptId,
            source: input.source,
          },
        })
      );
    }

    try {
      await this.ensureSessionHostReady({
        projectId: input.projectId,
        sessionId: input.sessionId,
      });

      await this.tmuxHostOps.sendInput({
        opencodeSessionId: input.sessionId,
        input: normalizedInput,
        timeoutMs: this.config.openCodeExecTimeoutMs,
      });

      return ok({
        status: "accepted",
        message: "Input enviado a la sesión PTY/tmux.",
      });
    } catch (error) {
      return err(mapAdapterResultError(mapPtyError(error, "submitPromptInput")));
    }
  }

  private async resolveProjectDir(projectId: string): Promise<string> {
    const cached = this.projectDirById.get(projectId);
    if (cached) {
      return cached;
    }

    try {
      const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(projectId);
      this.projectDirById.set(projectId, canonicalPath);
      return canonicalPath;
    } catch {
      throw unsupportedError(
        "sendMessage",
        "No tengo un directorio válido para esta sesión en modo PTY. Reasociá el proyecto con /project <path_local> y luego /session <id>."
      );
    }
  }

  private async ensureSessionHostReady(input: { projectId: string; sessionId: string }): Promise<void> {
    const dir = await this.resolveProjectDir(input.projectId);
    await this.tmuxHostOps.ensureHostSession({
      opencodeSessionId: input.sessionId,
      dir,
      timeoutMs: this.config.openCodeControlTimeoutMs,
    });
  }

  private async resolveAndValidateSessionPath(
    input: { projectId: string; sessionId: string },
    sessionPath: string | undefined
  ): Promise<string> {
    if (!sessionPath) {
      return this.resolveProjectDir(input.projectId);
    }

    const canonicalPath = await this.cliOps.resolveCanonicalProjectPath(sessionPath);
    const projectMismatch = this.ensureSessionMatchesActiveProject(
      input.projectId,
      canonicalPath,
      input.sessionId
    );
    if (projectMismatch) {
      throw projectMismatch;
    }

    this.projectDirById.set(input.projectId, canonicalPath);
    return canonicalPath;
  }

  private ensureSessionMatchesActiveProject(
    projectId: string,
    canonicalSessionPath: string,
    sessionId: string
  ): AdapterError | undefined {
    const activeProjectPath = this.projectDirById.get(projectId);
    if (!activeProjectPath || activeProjectPath === canonicalSessionPath) {
      return undefined;
    }

    return sessionProjectMismatchError(
      {
        projectId,
        sessionId,
      },
      {
        projectId: canonicalSessionPath,
      }
    );
  }
}

export function createOpenCodeSessionAdapter(config: Config): OpenCodeSessionAdapter {
  if ((config.openCodeAdapter ?? OPEN_CODE_ADAPTER_MODE.HTTP) === OPEN_CODE_ADAPTER_MODE.CLI) {
    return new CliOpenCodeSessionAdapter(config);
  }

  if ((config.openCodeAdapter ?? OPEN_CODE_ADAPTER_MODE.HTTP) === OPEN_CODE_ADAPTER_MODE.PTY) {
    return new PtyOpenCodeSessionAdapter(config);
  }

  const client = createOpenCodeHttpClient(config);
  return new HttpOpenCodeSessionAdapter(client);
}

function toSessionState(
  payload: SessionPayloadResponse,
  options: {
    fallbackProjectId: string;
    fallbackSessionId?: string;
    operation: string;
  }
): SessionState {
  const sessionId = payload.sessionId ?? options.fallbackSessionId;
  if (!sessionId) {
    throw new DomainError(ERROR_CODES.UPSTREAM_5XX, "OpenCode devolvió sessionId vacío", {
      details: { operation: options.operation },
    });
  }

  const projectId = payload.projectId ?? options.fallbackProjectId;
  const status = normalizeRemoteSessionStatus(payload.status);

  return {
    sessionId,
    projectId,
    status,
    taskId: payload.taskId,
    updatedAt: payload.updatedAt,
  };
}

function sessionProjectMismatchError(
  input: { projectId: string; sessionId: string },
  payload: SessionPayloadResponse
): AdapterError {
  return {
    code: ADAPTER_ERROR_CODES.SESSION_PROJECT_MISMATCH,
    message: "La sesión no coincide con el proyecto activo",
    retryable: false,
    details: {
      expectedProjectId: input.projectId,
      actualProjectId: payload.projectId,
      sessionId: input.sessionId,
    },
  };
}

function mapOpenCodeError(error: unknown, operation: string): AdapterError {
  if (error instanceof DomainError) {
    return {
      code: ADAPTER_ERROR_CODES.UNKNOWN,
      message: error.message,
      retryable: false,
      details: {
        operation,
        domainCode: error.code,
      },
      cause: error,
    };
  }

  if (!axios.isAxiosError(error)) {
    return {
      code: ADAPTER_ERROR_CODES.UNAVAILABLE,
      message: `Falla inesperada en OpenCode (${operation})`,
      retryable: true,
      cause: error,
      details: { operation },
    };
  }

  const status = error.response?.status;
  const upstreamCode = extractUpstreamCode(error.response?.data);

  const normalizedCode = normalizeUpstreamErrorCode(upstreamCode);

  return mapUpstreamFailureToAdapterError({
    operation,
    status,
    transportCode: error.code,
    upstreamCode: normalizedCode,
    cause: error,
  });
}

function normalizeUpstreamErrorCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }

  if (code === "NOT_FOUND") {
    return ADAPTER_ERROR_CODES.SESSION_NOT_FOUND;
  }

  if (code === "UPSTREAM_TIMEOUT") {
    return ADAPTER_ERROR_CODES.TIMEOUT;
  }

  if (code === "UPSTREAM_5XX") {
    return ADAPTER_ERROR_CODES.UNAVAILABLE;
  }

  if (code === "VALIDATION_ERROR") {
    return ADAPTER_ERROR_CODES.UNKNOWN;
  }

  return code;
}

function mapAdapterResultError(adapterError: {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}): DomainError {
  return mapAdapterErrorToDomainError({
    code: adapterError.code,
    message: adapterError.message,
    retryable: adapterError.retryable,
    details: adapterError.details,
    cause: adapterError.cause,
  });
}

function extractUpstreamCode(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }

  const typedData = data as Record<string, unknown>;
  const code = typedData.code;
  return typeof code === "string" ? code : undefined;
}

function mapCliError(error: unknown, operation: string): AdapterError {
  if (isAdapterError(error)) {
    return error;
  }

  if (error instanceof OpenCodeCliError) {
    if (error.kind === "not-installed") {
      return {
        code: ADAPTER_ERROR_CODES.UNAVAILABLE,
        message: error.message,
        retryable: false,
        details: {
          operation,
          ...(error.details ?? {}),
        },
        cause: error,
      };
    }

    if (error.kind === "timeout") {
      return {
        code: ADAPTER_ERROR_CODES.TIMEOUT,
        message: error.message,
        retryable: true,
        details: {
          operation,
          ...(error.details ?? {}),
        },
        cause: error,
      };
    }

    return {
      code: ADAPTER_ERROR_CODES.UNKNOWN,
      message: error.message,
      retryable: false,
      details: {
        operation,
        ...(error.details ?? {}),
      },
      cause: error,
    };
  }

  return {
    code: ADAPTER_ERROR_CODES.UNKNOWN,
    message: `Falla inesperada en OpenCode CLI (${operation})`,
    retryable: false,
    details: { operation },
    cause: error,
  };
}

function mapPtyError(error: unknown, operation: string): AdapterError {
  if (isAdapterError(error)) {
    return error;
  }

  if (error instanceof OpenCodeTmuxHostError) {
    if (error.kind === "not-installed") {
      return {
        code: ADAPTER_ERROR_CODES.UNAVAILABLE,
        message: error.message,
        retryable: false,
        details: {
          operation,
          ...(error.details ?? {}),
        },
        cause: error,
      };
    }

    if (error.kind === "timeout") {
      return {
        code: ADAPTER_ERROR_CODES.TIMEOUT,
        message: error.message,
        retryable: true,
        details: {
          operation,
          ...(error.details ?? {}),
        },
        cause: error,
      };
    }

    if (error.kind === "session-missing") {
      return {
        code: ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
        message: error.message,
        retryable: false,
        details: {
          operation,
          ...(error.details ?? {}),
        },
        cause: error,
      };
    }

    return {
      code: ADAPTER_ERROR_CODES.UNKNOWN,
      message: error.message,
      retryable: false,
      details: {
        operation,
        ...(error.details ?? {}),
      },
      cause: error,
    };
  }

  return mapCliError(error, operation);
}

function unsupportedError(operation: string, guidance: string): AdapterError {
  return {
    code: ADAPTER_ERROR_CODES.UNSUPPORTED,
    message: guidance,
    retryable: false,
    details: {
      operation,
      guidance,
    },
  };
}

function isAdapterError(value: unknown): value is AdapterError {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AdapterError>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err<T>(error: DomainError): Result<T> {
  return { ok: false, error };
}

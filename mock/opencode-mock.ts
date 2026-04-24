import http from "http";

const PORT = Number(process.env.MOCK_PORT || 3000);
const EXPECTED_TOKEN = process.env.OPEN_CODE_TOKEN || "dev-token";

const MOCK_FIXTURE_CODES = {
  UNSUPPORTED: "UNSUPPORTED",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
  RECOVERY_RUNNING: "RECOVERY_RUNNING",
  RECOVERY_COMPLETED: "RECOVERY_COMPLETED",
  RECOVERY_NOT_FOUND: "RECOVERY_NOT_FOUND",
  RECOVERY_TRANSIENT_ERROR: "RECOVERY_TRANSIENT_ERROR",
} as const;

type MockFixtureCode = (typeof MOCK_FIXTURE_CODES)[keyof typeof MOCK_FIXTURE_CODES];
type SessionStatus = "linked" | "running" | "needs-attention" | "idle" | "completed" | "unknown";

interface MockSession {
  sessionId: string;
  projectId: string;
  status: SessionStatus;
  taskId?: string;
  updatedAt: string;
  webhookUrl?: string;
  webhookToken?: string;
  silentCrash?: boolean;
}

interface FixtureMatch {
  readonly matched: true;
  readonly code: MockFixtureCode;
}

interface NoFixtureMatch {
  readonly matched: false;
}

type FixtureResolution = FixtureMatch | NoFixtureMatch;

const sessions = new Map<string, MockSession>();
const projectCanonicalPath = new Map<string, string>();
let taskCounter = 0;

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const auth = req.headers["authorization"];
  if (!auth || auth !== `Bearer ${EXPECTED_TOKEN}`) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = parseBody(raw);
      const route = req.url || "";

      if (route === "/opencode/query") {
        handleLegacyQuery(body, res);
        return;
      }

      if (route === "/opencode/projects/resolve") {
        handleResolveProject(body, res);
        return;
      }

      if (route === "/opencode/sessions/create") {
        handleCreateSession(body, res);
        return;
      }

      if (route === "/opencode/sessions/attach") {
        handleAttachSession(body, res);
        return;
      }

      if (route === "/opencode/sessions/message") {
        handleSessionMessage(body, res);
        return;
      }

      if (route === "/opencode/sessions/command") {
        handleSessionCommand(body, res);
        return;
      }

      if (route === "/opencode/sessions/state") {
        handleSessionState(body, res);
        return;
      }

      if (route === "/opencode/sessions/cancel") {
        handleSessionCancel(body, res);
        return;
      }

      if (route === "/opencode/sessions/observe") {
        handleSessionObserve(body, res);
        return;
      }

      writeJson(res, 404, { error: "Not found" });
    } catch (err) {
      writeJson(res, 400, { error: "Invalid JSON" });
    }
  });
});

function parseBody(raw: string): Record<string, unknown> {
  if (!raw) return {};

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as Record<string, unknown>;
}

function handleLegacyQuery(body: Record<string, unknown>, res: http.ServerResponse): void {
  const prompt = asString(body.prompt);
  if (!prompt.trim()) {
    writeJson(res, 400, { error: "prompt is required" });
    return;
  }

  writeJson(res, 200, {
    answer: `Respuesta mock: ${prompt}`,
    model: "mock",
    latencyMs: 1,
  });
}

function handleResolveProject(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "resolveProject");
    return;
  }

  const projectId = asString(body.projectId);
  const rootPath = asString(body.rootPath);

  if (!projectId.trim() || !rootPath.trim()) {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      error: "projectId y rootPath son requeridos",
    });
    return;
  }

  const canonicalPath = normalizePath(rootPath);
  projectCanonicalPath.set(projectId, canonicalPath);

  writeJson(res, 200, {
    projectId,
    canonicalPath,
  });
}

function handleCreateSession(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "createSession");
    return;
  }

  const projectId = asString(body.projectId);
  const rootPath = asString(body.rootPath);

  if (!projectId.trim() || !rootPath.trim()) {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      error: "projectId y rootPath son requeridos",
    });
    return;
  }

  const now = new Date().toISOString();
  const sessionId = `sess-${Date.now().toString(36)}`;
  const status = resolveRequestedStatus(body) ?? "linked";

  const session: MockSession = {
    sessionId,
    projectId,
    status,
    updatedAt: now,
    taskId: status === "running" ? nextTaskId() : undefined,
    webhookUrl: asOptionalString(body.webhookUrl),
    webhookToken: asOptionalString(body.webhookToken),
    silentCrash: body.forceSilentCrash === true,
  };

  sessions.set(sessionId, session);

  writeJson(res, 200, {
    sessionId: session.sessionId,
    projectId: session.projectId,
    status: session.status,
    taskId: session.taskId,
    updatedAt: session.updatedAt,
  });
}

function handleAttachSession(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "attachSession");
    return;
  }

  const projectId = asString(body.projectId);
  const sessionId = asString(body.sessionId);

  if (!projectId.trim() || !sessionId.trim()) {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      error: "projectId y sessionId son requeridos",
    });
    return;
  }

  if (body.forceNotFound === true) {
    writeJson(res, 404, {
      code: "SESSION_NOT_FOUND",
      error: "Session not found",
    });
    return;
  }

  const existing = sessions.get(sessionId);
  if (!existing) {
    writeJson(res, 404, {
      code: "SESSION_NOT_FOUND",
      error: "Session not found",
    });
    return;
  }

  if (body.forceMismatch === true || existing.projectId !== projectId) {
    writeJson(res, 409, {
      code: "SESSION_PROJECT_MISMATCH",
      error: "Session does not belong to project",
      projectId: existing.projectId,
      sessionId: existing.sessionId,
    });
    return;
  }

  const updated: MockSession = {
    ...existing,
    status: resolveRequestedStatus(body) ?? existing.status,
    updatedAt: new Date().toISOString(),
  };

  sessions.set(sessionId, updated);
  writeJson(res, 200, {
    sessionId: updated.sessionId,
    projectId: updated.projectId,
    status: updated.status,
    taskId: updated.taskId,
    updatedAt: updated.updatedAt,
  });
}

function handleSessionMessage(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "sendMessage");
    return;
  }

  const validation = validateSessionOperationInput(body);
  if (!validation.ok) {
    writeJson(res, validation.status, validation.payload);
    return;
  }

  const { session, message } = validation;
  const needsAttention = body.forceNeedsAttention === true;
  const running = body.forceRunning === true;
  const nextStatus: SessionStatus = needsAttention ? "needs-attention" : running ? "running" : "linked";

  const taskId = nextStatus === "running" ? nextTaskId() : undefined;
  const updated: MockSession = {
    ...session,
    status: nextStatus,
    taskId,
    updatedAt: new Date().toISOString(),
    webhookUrl: asOptionalString(body.webhookUrl) ?? session.webhookUrl,
    webhookToken: asOptionalString(body.webhookToken) ?? session.webhookToken,
    silentCrash: body.forceSilentCrash === true ? true : session.silentCrash,
  };
  sessions.set(session.sessionId, updated);

   scheduleWebhookForSession(updated, body, message);

  writeJson(res, 200, {
    sessionId: updated.sessionId,
    projectId: updated.projectId,
    status: updated.status,
    taskId: updated.taskId,
    needsAttention,
    message: `Respuesta mock sesión: ${message}`,
    updatedAt: updated.updatedAt,
  });
}

function handleSessionCommand(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "runCommand");
    return;
  }

  const command = asString(body.command);
  if (!command.trim()) {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      error: "command es requerido",
    });
    return;
  }

  const payload = {
    ...body,
    message: command,
    forceRunning: body.forceRunning ?? true,
  };

  handleSessionMessage(payload, res);
}

function handleSessionState(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "getSessionState");
    return;
  }

  const projectId = asString(body.projectId);
  const sessionId = asString(body.sessionId);

  if (!projectId.trim() || !sessionId.trim()) {
    writeJson(res, 400, {
      code: "VALIDATION_ERROR",
      error: "projectId y sessionId son requeridos",
    });
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    writeJson(res, 404, {
      code: "SESSION_NOT_FOUND",
      error: "Session not found",
    });
    return;
  }

  if (session.silentCrash) {
    writeJson(res, 404, {
      code: "SESSION_NOT_FOUND",
      error: "Session not found",
    });
    return;
  }

  if (body.forceMismatch === true || session.projectId !== projectId) {
    writeJson(res, 409, {
      code: "SESSION_PROJECT_MISMATCH",
      error: "Session does not belong to project",
      projectId: session.projectId,
      sessionId: session.sessionId,
    });
    return;
  }

  const status = resolveRequestedStatus(body) ?? session.status;
  const updated: MockSession = {
    ...session,
    status,
    updatedAt: new Date().toISOString(),
  };

  if (status !== "running") {
    updated.taskId = undefined;
  } else if (!updated.taskId) {
    updated.taskId = nextTaskId();
  }

  sessions.set(sessionId, updated);

  writeJson(res, 200, {
    sessionId: updated.sessionId,
    projectId: updated.projectId,
    status: updated.status,
    taskId: updated.taskId,
    updatedAt: updated.updatedAt,
  });
}

function handleSessionCancel(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    if (fixture.code === MOCK_FIXTURE_CODES.UNSUPPORTED) {
      writeJson(res, 404, {
        error: "Cancel not available",
      });
      return;
    }

    applyFixture(fixture.code, res, "cancelOrInterrupt");
    return;
  }

  const validation = validateCancelOrObserveInput(body);
  if (!validation.ok) {
    writeJson(res, validation.status, validation.payload);
    return;
  }

  const { session } = validation;
  const updated: MockSession = {
    ...session,
    status: "idle",
    taskId: undefined,
    updatedAt: new Date().toISOString(),
  };

  sessions.set(session.sessionId, updated);
  writeJson(res, 200, {
    sessionId: updated.sessionId,
    projectId: updated.projectId,
    status: updated.status,
    updatedAt: updated.updatedAt,
    cancelMode: "accepted",
  });
}

function handleSessionObserve(body: Record<string, unknown>, res: http.ServerResponse): void {
  const fixture = resolveFixture(body);
  if (fixture.matched) {
    applyFixture(fixture.code, res, "observeSession");
    return;
  }

  const validation = validateCancelOrObserveInput(body);
  if (!validation.ok) {
    writeJson(res, validation.status, validation.payload);
    return;
  }

  writeJson(res, 200, {
    mode: "not-available-yet",
    sessionId: validation.session.sessionId,
    projectId: validation.session.projectId,
    observedAt: new Date().toISOString(),
  });
}

function scheduleWebhookForSession(
  session: MockSession,
  body: Record<string, unknown>,
  message: string
): void {
  if (!session.webhookUrl || !session.webhookToken || session.silentCrash) {
    return;
  }

  const webhookDelayMs = asNumber(body.webhookDelayMs) ?? 25;
  const shouldFail = body.forceWebhookFailure === true;
  const needsInput = body.forceNeedsAttention === true;

  if (session.status === "running") {
    queueWebhook(session, {
      event: "SESSION_STARTED",
      session_id: session.sessionId,
      project_id: session.projectId,
      timestamp: new Date().toISOString(),
      data: {
        summary: `Task ${session.taskId ?? "n/d"} iniciada para: ${message}`,
      },
    }, webhookDelayMs);

    queueWebhook(session, {
      event: shouldFail ? "SESSION_FAILED" : "SESSION_COMPLETED",
      session_id: session.sessionId,
      project_id: session.projectId,
      timestamp: new Date().toISOString(),
      data: {
        summary: shouldFail ? `Mock falló ejecutando: ${message}` : `Mock completó: ${message}`,
      },
    }, webhookDelayMs + 25);
    return;
  }

  if (needsInput) {
    queueWebhook(session, {
      event: "SESSION_NEEDS_INPUT",
      session_id: session.sessionId,
      project_id: session.projectId,
      timestamp: new Date().toISOString(),
      data: {
        summary: `Mock requiere confirmación para: ${message}`,
      },
    }, webhookDelayMs);
  }
}

function queueWebhook(session: MockSession, payload: Record<string, unknown>, delayMs: number): void {
  if (!session.webhookUrl || !session.webhookToken) {
    return;
  }

  setTimeout(() => {
    void sendWebhook(session.webhookUrl!, session.webhookToken!, payload);
  }, delayMs);
}

async function sendWebhook(url: string, token: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("mock webhook delivery failed", error);
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validateSessionOperationInput(body: Record<string, unknown>):
  | {
      ok: true;
      session: MockSession;
      message: string;
    }
  | {
      ok: false;
      status: 400 | 404 | 409;
      payload: Record<string, unknown>;
    } {
  const projectId = asString(body.projectId);
  const sessionId = asString(body.sessionId);
  const message = asString(body.message);

  if (!projectId.trim() || !sessionId.trim()) {
    return {
      ok: false,
      status: 400,
      payload: {
        code: "VALIDATION_ERROR",
        error: "projectId y sessionId son requeridos",
      },
    };
  }

  if (!message.trim()) {
    return {
      ok: false,
      status: 400,
      payload: {
        code: "VALIDATION_ERROR",
        error: "message es requerido",
      },
    };
  }

  if (body.forceNotFound === true) {
    return {
      ok: false,
      status: 404,
      payload: {
        code: "SESSION_NOT_FOUND",
        error: "Session not found",
      },
    };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return {
      ok: false,
      status: 404,
      payload: {
        code: "SESSION_NOT_FOUND",
        error: "Session not found",
      },
    };
  }

  if (body.forceMismatch === true || session.projectId !== projectId) {
    return {
      ok: false,
      status: 409,
      payload: {
        code: "SESSION_PROJECT_MISMATCH",
        error: "Session does not belong to project",
        projectId: session.projectId,
        sessionId: session.sessionId,
      },
    };
  }

  return {
    ok: true,
    session,
    message,
  };
}

function validateCancelOrObserveInput(body: Record<string, unknown>):
  | {
      ok: true;
      session: MockSession;
    }
  | {
      ok: false;
      status: 400 | 404 | 409;
      payload: Record<string, unknown>;
    } {
  const projectId = asString(body.projectId);
  const sessionId = asString(body.sessionId);

  if (!projectId.trim() || !sessionId.trim()) {
    return {
      ok: false,
      status: 400,
      payload: {
        code: "VALIDATION_ERROR",
        error: "projectId y sessionId son requeridos",
      },
    };
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return {
      ok: false,
      status: 404,
      payload: {
        code: "SESSION_NOT_FOUND",
        error: "Session not found",
      },
    };
  }

  if (body.forceMismatch === true || session.projectId !== projectId) {
    return {
      ok: false,
      status: 409,
      payload: {
        code: "SESSION_PROJECT_MISMATCH",
        error: "Session does not belong to project",
        projectId: session.projectId,
        sessionId: session.sessionId,
      },
    };
  }

  return {
    ok: true,
    session,
  };
}

function resolveFixture(body: Record<string, unknown>): FixtureResolution {
  const rawFixture = asString(body.fixture).trim().toUpperCase();
  if (!rawFixture) {
    return { matched: false };
  }

  const fixture = Object.values(MOCK_FIXTURE_CODES).find((code) => code === rawFixture);
  if (!fixture) {
    return { matched: false };
  }

  return {
    matched: true,
    code: fixture,
  };
}

function applyFixture(fixture: MockFixtureCode, res: http.ServerResponse, operation: string): void {
  if (fixture === MOCK_FIXTURE_CODES.RECOVERY_RUNNING) {
    writeJson(res, 200, {
      sessionId: "sess-recovery-running",
      projectId: "proj-recovery",
      status: "running",
      taskId: "task-recovery-1",
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.RECOVERY_COMPLETED) {
    writeJson(res, 200, {
      sessionId: "sess-recovery-completed",
      projectId: "proj-recovery",
      status: "completed",
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.RECOVERY_NOT_FOUND) {
    writeJson(res, 404, {
      code: "SESSION_NOT_FOUND",
      error: `Recovery fixture not found (${operation})`,
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.RECOVERY_TRANSIENT_ERROR) {
    writeJson(res, 503, {
      code: "UNAVAILABLE",
      error: `Recovery transient error (${operation})`,
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.UNSUPPORTED) {
    writeJson(res, 501, {
      code: MOCK_FIXTURE_CODES.UNSUPPORTED,
      error: `Operation unsupported in mock (${operation})`,
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.UNAVAILABLE) {
    writeJson(res, 503, {
      code: MOCK_FIXTURE_CODES.UNAVAILABLE,
      error: `Mock backend unavailable (${operation})`,
    });
    return;
  }

  if (fixture === MOCK_FIXTURE_CODES.TIMEOUT) {
    setTimeout(() => {
      writeJson(res, 504, {
        code: MOCK_FIXTURE_CODES.TIMEOUT,
        error: `Mock timeout fixture (${operation})`,
      });
    }, 1200);
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "/";
  return trimmed.replace(/\\/gu, "/");
}

function resolveRequestedStatus(body: Record<string, unknown>): SessionStatus | undefined {
  const raw = asString(body.forceStatus).trim().toLowerCase();
  if (!raw) return undefined;

  if (
    raw === "linked" ||
    raw === "running" ||
    raw === "needs-attention" ||
    raw === "idle" ||
    raw === "completed" ||
    raw === "unknown"
  ) {
    return raw;
  }

  return undefined;
}

function nextTaskId(): string {
  taskCounter += 1;
  return `task-${taskCounter}`;
}

function writeJson(res: http.ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `OpenCode mock running on http://localhost:${PORT} (legacy: /opencode/query, sessions: create/attach/message/command/state/cancel/observe, fixtures: UNSUPPORTED|TIMEOUT|UNAVAILABLE|RECOVERY_RUNNING|RECOVERY_COMPLETED|RECOVERY_NOT_FOUND|RECOVERY_TRANSIENT_ERROR)`
  );
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(
      `El puerto ${PORT} ya está en uso. Cerrá la instancia previa del mock o cambiá el puerto antes de volver a iniciar.`
    );
    process.exit(1);
  }

  throw error;
});

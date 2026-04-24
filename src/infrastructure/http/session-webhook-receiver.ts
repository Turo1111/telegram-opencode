import http from "node:http";
import { AddressInfo } from "node:net";
import { Config } from "../../config";
import {
  SESSION_EVENT_KIND,
  SessionEvent,
  SessionNeedsInputData,
  WebhookAuthContext,
} from "../../application/contracts";
import { PROMPT_TYPE } from "../../domain/entities";
import { logger } from "../../logger";

export interface SessionWebhookReceiverDeps {
  readonly config: Config;
  readonly onEvent: (auth: WebhookAuthContext, event: SessionEvent) => Promise<ReceiverHandlerResult>;
}

export interface ReceiverHandlerResult {
  readonly statusCode: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface SessionWebhookReceiver {
  readonly callbackUrl: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function createSessionWebhookReceiver(
  deps: SessionWebhookReceiverDeps
): Promise<SessionWebhookReceiver> {
  assertLoopbackWebhookHost(deps.config.webhookHost);
  let lastError: unknown;

  for (let port = deps.config.webhookPortStart; port <= deps.config.webhookPortEnd; port += 1) {
    try {
      return await listenOnPort(deps, port);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `No webhook receiver port available in range ${deps.config.webhookPortStart}-${deps.config.webhookPortEnd}: ${String(lastError)}`
  );
}

async function listenOnPort(deps: SessionWebhookReceiverDeps, port: number): Promise<SessionWebhookReceiver> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/opencode/events") {
      respond(res, 404, { error: "Not found" });
      return;
    }

    const bearer = extractBearerToken(req.headers.authorization);
    if (!bearer.ok) {
      respond(res, 401, { error: "Missing bearer token" });
      return;
    }

    try {
      const event = await readEventPayload(req);
      const result = await deps.onEvent(
        {
          bearerToken: bearer.token,
          remoteAddress: req.socket.remoteAddress,
        },
        event
      );
      respond(res, result.statusCode, result.body);
    } catch (error) {
      respond(res, 400, {
        error: error instanceof Error ? error.message : "Invalid payload",
      });
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, deps.config.webhookHost, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Webhook receiver address unavailable");
  }

  const callbackUrl = `http://${deps.config.webhookHost}:${address.port}/webhooks/opencode/events`;
  logger.info("Webhook receiver ready", {
    host: deps.config.webhookHost,
    port: address.port,
    callbackUrl,
  });

  return {
    callbackUrl,
    host: deps.config.webhookHost,
    port: (address as AddressInfo).port,
    async close() {
      if (typeof (server as http.Server & { closeIdleConnections?: () => void }).closeIdleConnections === "function") {
        (server as http.Server & { closeIdleConnections: () => void }).closeIdleConnections();
      }

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });

        for (const socket of sockets) {
          socket.end();
          socket.unref();
        }
      });
    },
  };
}

async function readEventPayload(req: http.IncomingMessage): Promise<SessionEvent> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

  const event = typeof payload.event === "string" ? payload.event : payload.kind;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : payload.sessionId;
  const projectId = typeof payload.project_id === "string" ? payload.project_id : payload.projectId;
  const occurredAt =
    typeof payload.timestamp === "string"
      ? payload.timestamp
      : typeof payload.occurredAt === "string"
        ? payload.occurredAt
        : new Date().toISOString();
  const data =
    typeof event === "string" && isRecord(payload.data)
      ? normalizeEventData(event, payload.data)
      : isRecord(payload.data)
        ? payload.data
        : undefined;

  if (typeof event !== "string" || !event.trim()) {
    throw new Error("event is required");
  }

  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw new Error("sessionId is required");
  }

  return {
    kind: event as SessionEvent["kind"],
    sessionId,
    projectId: typeof projectId === "string" && projectId.trim() ? projectId : undefined,
    occurredAt,
    data,
  };
}

function normalizeEventData(
  eventKind: string,
  data: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (eventKind !== SESSION_EVENT_KIND.NEEDS_INPUT) {
    return data;
  }

  const normalizedNeedsInput = normalizeNeedsInputData(data);
  if (!normalizedNeedsInput) {
    return data;
  }

  return {
    ...data,
    promptId: normalizedNeedsInput.promptId,
    promptType: normalizedNeedsInput.promptType,
    message: normalizedNeedsInput.message,
    options: normalizedNeedsInput.options,
    expiresAt: normalizedNeedsInput.expiresAt,
  };
}

function normalizeNeedsInputData(data: Readonly<Record<string, unknown>>): SessionNeedsInputData | undefined {
  const promptId = readString(data.promptId) ?? readString(data.prompt_id);
  const promptType = readString(data.promptType) ?? readString(data.prompt_type);
  const message = readString(data.message) ?? readString(data.summary);
  const options = readStringArray(data.options);
  const expiresAt = readString(data.expiresAt) ?? readString(data.expires_at);

  if (!promptId || !promptType || !message) {
    return undefined;
  }

  const promptTypeNormalized = normalizePromptType(promptType);
  if (!promptTypeNormalized) {
    return undefined;
  }

  return {
    promptId,
    promptType: promptTypeNormalized,
    message,
    options,
    expiresAt,
  };
}

function normalizePromptType(value: string): SessionNeedsInputData["promptType"] | undefined {
  const normalized = value.toLowerCase();
  if (normalized === PROMPT_TYPE.BOOLEAN) {
    return PROMPT_TYPE.BOOLEAN;
  }

  if (normalized === PROMPT_TYPE.OPTIONS) {
    return PROMPT_TYPE.OPTIONS;
  }

  if (normalized === PROMPT_TYPE.TEXT) {
    return PROMPT_TYPE.TEXT;
  }

  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length > 0 ? entries : undefined;
}

function respond(res: http.ServerResponse, statusCode: number, body: Readonly<Record<string, unknown>>): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function extractBearerToken(header: string | undefined):
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false } {
  if (typeof header !== "string") {
    return { ok: false };
  }

  const match = /^Bearer\s+([^\s]+)$/u.exec(header.trim());
  if (!match) {
    return { ok: false };
  }

  return { ok: true, token: match[1] };
}

function assertLoopbackWebhookHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (loopbackHosts.has(normalized)) {
    return;
  }

  throw new Error(`Invalid loopback host for WEBHOOK_HOST: ${host}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

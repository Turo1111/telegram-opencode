import axios from "axios";
import { Config } from "./config";
import { logger } from "./logger";

export interface OpenCodeResponse {
  answer: string;
  tokensUsed?: number;
  model?: string;
  latencyMs?: number;
}

export interface OpenCodeRequest {
  prompt: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCodeHttpRequest {
  endpoint?: string;
  payload: Record<string, unknown>;
  operationName?: string;
  operationKind?: OpenCodeOperationKind;
}

export interface OpenCodeHttpClient {
  post<T>(request: OpenCodeHttpRequest): Promise<T>;
}

export const OPEN_CODE_OPERATION_KINDS = {
  CONTROL: "control",
  EXECUTION: "execution",
} as const;

export type OpenCodeOperationKind =
  (typeof OPEN_CODE_OPERATION_KINDS)[keyof typeof OPEN_CODE_OPERATION_KINDS];

function shouldRetry(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return true; // timeout
  const status = error.response?.status;
  return typeof status === "number" && status >= 500;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callOpenCode(
  config: Config,
  request: OpenCodeRequest
): Promise<OpenCodeResponse> {
  const client = createOpenCodeHttpClient(config);

  const payload = {
    prompt: request.prompt,
    userId: request.userId,
    locale: config.locale,
    metadata: request.metadata,
  };

  return client.post<OpenCodeResponse>({
    payload,
    operationName: "legacyQuery",
    operationKind: OPEN_CODE_OPERATION_KINDS.EXECUTION,
  });
}

export function createOpenCodeHttpClient(config: Config): OpenCodeHttpClient {
  return {
    post: async <T>(request: OpenCodeHttpRequest) => {
      const endpoint = resolveEndpoint(config, request.endpoint);
      return postWithShortRetry<T>(
        config,
        endpoint,
        request.payload,
        request.operationName ?? request.endpoint ?? "unknown-operation",
        request.operationKind
      );
    },
  };
}

function resolveEndpoint(config: Config, endpoint?: string): string {
  if (!endpoint) {
    return config.openCodeUrl;
  }

  if (isAbsoluteHttpUrl(endpoint)) {
    return endpoint;
  }

  const base = new URL(config.openCodeUrl);
  const origin = `${base.protocol}//${base.host}`;
  return new URL(endpoint, origin).toString();
}

function isAbsoluteHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

async function postWithShortRetry<T>(
  config: Config,
  endpoint: string,
  payload: Record<string, unknown>,
  operationName: string,
  operationKind?: OpenCodeOperationKind
): Promise<T> {
  const maxAttempts = 2;
  const backoffMs = 300;
  const timeoutMs = resolveTimeoutMs(config, operationKind);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const response = await axios.post<T>(endpoint, payload, {
        headers: {
          Authorization: `Bearer ${config.openCodeToken}`,
          "Content-Type": "application/json",
        },
        timeout: timeoutMs,
      });

      const latency = Date.now() - started;
      logger.info("OpenCode response", {
        latencyMs: latency,
        status: response.status,
        attempt,
        endpoint,
        operationName,
        operationKind: operationKind ?? OPEN_CODE_OPERATION_KINDS.CONTROL,
        timeoutMs,
      });
      return response.data;
    } catch (error) {
      const latency = Date.now() - started;
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      logger.error("OpenCode call failed", {
        latencyMs: latency,
        status,
        attempt,
        endpoint,
        operationName,
        operationKind: operationKind ?? OPEN_CODE_OPERATION_KINDS.CONTROL,
        timeoutMs,
      });

      const canRetry = attempt < maxAttempts && shouldRetry(error);
      if (!canRetry) {
        throw error;
      }

      await wait(backoffMs);
    }
  }

  throw new Error(`OpenCode call failed after retries (${operationName})`);
}

function resolveTimeoutMs(config: Config, operationKind?: OpenCodeOperationKind): number {
  if (operationKind === OPEN_CODE_OPERATION_KINDS.EXECUTION) {
    return config.openCodeExecTimeoutMs;
  }

  if (operationKind === OPEN_CODE_OPERATION_KINDS.CONTROL) {
    return config.openCodeControlTimeoutMs;
  }

  return config.openCodeTimeoutMs;
}

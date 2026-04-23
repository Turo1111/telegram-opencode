import {
  ADAPTER_ERROR_CODES,
  AdapterError,
  REMOTE_SESSION_STATUS,
  RemoteSessionStatus,
} from "./contracts";
import { OPERATIONAL_MODES, OperationalMode } from "../domain/entities";

export interface UpstreamAdapterErrorInput {
  readonly operation: string;
  readonly status?: number;
  readonly transportCode?: string;
  readonly upstreamCode?: string;
  readonly cause?: unknown;
}

export function normalizeRemoteSessionStatus(value?: string): RemoteSessionStatus {
  switch (value) {
    case REMOTE_SESSION_STATUS.RUNNING:
      return REMOTE_SESSION_STATUS.RUNNING;
    case REMOTE_SESSION_STATUS.NEEDS_ATTENTION:
      return REMOTE_SESSION_STATUS.NEEDS_ATTENTION;
    case REMOTE_SESSION_STATUS.COMPLETED:
      return REMOTE_SESSION_STATUS.COMPLETED;
    case REMOTE_SESSION_STATUS.UNKNOWN:
      return REMOTE_SESSION_STATUS.UNKNOWN;
    case "linked":
    case REMOTE_SESSION_STATUS.IDLE:
      return REMOTE_SESSION_STATUS.IDLE;
    default:
      return REMOTE_SESSION_STATUS.UNKNOWN;
  }
}

export function mapRemoteStatusToOperationalMode(status: RemoteSessionStatus): OperationalMode {
  if (status === REMOTE_SESSION_STATUS.RUNNING) {
    return OPERATIONAL_MODES.TASK_RUNNING;
  }

  if (status === REMOTE_SESSION_STATUS.NEEDS_ATTENTION) {
    return OPERATIONAL_MODES.NEEDS_ATTENTION;
  }

  return OPERATIONAL_MODES.SESSION_LINKED;
}

export function mapUpstreamFailureToAdapterError(input: UpstreamAdapterErrorInput): AdapterError {
  if (input.transportCode === "ECONNABORTED" || input.transportCode === "ETIMEDOUT") {
    return {
      code: ADAPTER_ERROR_CODES.TIMEOUT,
      message: "OpenCode no respondió a tiempo",
      retryable: true,
      details: {
        operation: input.operation,
        status: input.status,
        transportCode: input.transportCode,
      },
      cause: input.cause,
    };
  }

  if (input.upstreamCode === ADAPTER_ERROR_CODES.PROJECT_NOT_FOUND) {
    return {
      code: ADAPTER_ERROR_CODES.PROJECT_NOT_FOUND,
      message: "Proyecto no encontrado en OpenCode",
      retryable: false,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  if (
    input.operation === "cancelOrInterrupt" &&
    input.status === 404 &&
    input.upstreamCode === undefined
  ) {
    return {
      code: ADAPTER_ERROR_CODES.UNSUPPORTED,
      message: "Cancel/interrupt no está disponible en este backend",
      retryable: false,
      details: { operation: input.operation, status: input.status },
      cause: input.cause,
    };
  }

  if (input.status === 404 || input.upstreamCode === ADAPTER_ERROR_CODES.SESSION_NOT_FOUND) {
    const isProjectLookupOperation = input.operation === "resolveProject" || input.operation === "createSession";

    return {
      code: isProjectLookupOperation ? ADAPTER_ERROR_CODES.PROJECT_NOT_FOUND : ADAPTER_ERROR_CODES.SESSION_NOT_FOUND,
      message: isProjectLookupOperation ? "Proyecto no encontrado en OpenCode" : "Sesión no encontrada en OpenCode",
      retryable: false,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  if (input.upstreamCode === ADAPTER_ERROR_CODES.SESSION_PROJECT_MISMATCH) {
    return {
      code: ADAPTER_ERROR_CODES.SESSION_PROJECT_MISMATCH,
      message: "La sesión no pertenece al proyecto activo",
      retryable: false,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  if (input.status === 409 || input.upstreamCode === ADAPTER_ERROR_CODES.TASK_RUNNING) {
    return {
      code: ADAPTER_ERROR_CODES.TASK_RUNNING,
      message: "Hay una tarea activa en OpenCode",
      retryable: false,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  if (input.upstreamCode === ADAPTER_ERROR_CODES.UNSUPPORTED) {
    return {
      code: ADAPTER_ERROR_CODES.UNSUPPORTED,
      message: "Operación no soportada por OpenCode",
      retryable: false,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  if (typeof input.status === "number" && input.status >= 500) {
    return {
      code: ADAPTER_ERROR_CODES.UNAVAILABLE,
      message: "OpenCode devolvió un error del servidor",
      retryable: true,
      details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
      cause: input.cause,
    };
  }

  return {
    code: ADAPTER_ERROR_CODES.UNKNOWN,
    message: "Error no clasificado al comunicarse con OpenCode",
    retryable: false,
    details: { operation: input.operation, status: input.status, upstreamCode: input.upstreamCode },
    cause: input.cause,
  };
}

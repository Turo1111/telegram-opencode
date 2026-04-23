export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT_ACTIVE_TASK: "CONFLICT_ACTIVE_TASK",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_5XX: "UPSTREAM_5XX",
  PERSISTENCE_ERROR: "PERSISTENCE_ERROR",
  INCONSISTENT_BINDING: "INCONSISTENT_BINDING",
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_PROJECT_MISMATCH: "SESSION_PROJECT_MISMATCH",
  TASK_RUNNING: "TASK_RUNNING",
  TIMEOUT: "TIMEOUT",
  UNAVAILABLE: "UNAVAILABLE",
  UNSUPPORTED: "UNSUPPORTED",
  UNKNOWN: "UNKNOWN",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface DomainErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options?: DomainErrorOptions) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isErrorCode(value: string): value is ErrorCode {
  return value in ERROR_CODES;
}

export function asDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;

  return new DomainError(ERROR_CODES.PERSISTENCE_ERROR, "Unexpected non-domain error", {
    cause: error,
  });
}

interface AdapterErrorLike {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export function mapAdapterErrorToDomainError(error: AdapterErrorLike): DomainError {
  if (error.code === ERROR_CODES.PROJECT_NOT_FOUND || error.code === ERROR_CODES.SESSION_NOT_FOUND) {
    return new DomainError(ERROR_CODES.NOT_FOUND, error.message, {
      cause: error.cause,
      details: {
        ...(error.details ?? {}),
        adapterCode: error.code,
        retryable: error.retryable,
      },
    });
  }

  if (error.code === ERROR_CODES.SESSION_PROJECT_MISMATCH) {
    return new DomainError(ERROR_CODES.VALIDATION_ERROR, error.message, {
      cause: error.cause,
      details: {
        ...(error.details ?? {}),
        adapterCode: error.code,
        retryable: error.retryable,
      },
    });
  }

  if (error.code === ERROR_CODES.TASK_RUNNING) {
    return new DomainError(ERROR_CODES.CONFLICT_ACTIVE_TASK, error.message, {
      cause: error.cause,
      details: {
        ...(error.details ?? {}),
        adapterCode: error.code,
        retryable: error.retryable,
      },
    });
  }

  if (error.code === ERROR_CODES.TIMEOUT) {
    return new DomainError(ERROR_CODES.UPSTREAM_TIMEOUT, error.message, {
      cause: error.cause,
      details: {
        ...(error.details ?? {}),
        adapterCode: error.code,
        retryable: error.retryable,
      },
    });
  }

  if (error.code === ERROR_CODES.UNAVAILABLE) {
    return new DomainError(ERROR_CODES.UPSTREAM_5XX, error.message, {
      cause: error.cause,
      details: {
        ...(error.details ?? {}),
        adapterCode: error.code,
        retryable: error.retryable,
      },
    });
  }

  return new DomainError(ERROR_CODES.VALIDATION_ERROR, error.message, {
    cause: error.cause,
    details: {
      ...(error.details ?? {}),
      adapterCode: error.code,
      retryable: error.retryable,
    },
  });
}

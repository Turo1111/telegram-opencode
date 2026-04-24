type Level = "info" | "error";

export const LOCK_OUTCOME = {
  ACQUIRED_IMMEDIATE: "acquired-immediate",
  ACQUIRED_AFTER_WAIT: "acquired-after-wait",
  RELEASED_SUCCESS: "released-success",
  RELEASED_ERROR: "released-error",
} as const;

export type LockOutcome = (typeof LOCK_OUTCOME)[keyof typeof LOCK_OUTCOME];

export interface PromptLogMeta {
  readonly session_id?: string;
  readonly chat_id?: string;
  readonly prompt_id?: string;
  readonly event: string;
  readonly status: string;
  readonly reason?: string;
  readonly [key: string]: unknown;
}

function format(level: Level, message: string, meta?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const metaString = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaString}`;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    console.log(format("info", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    console.error(format("error", message, meta));
  },
  lock(
    message: string,
    meta: {
      readonly chatId: string;
      readonly waitMs: number;
      readonly heldMs: number;
      readonly queueDepth: number;
      readonly outcome: LockOutcome;
    }
  ) {
    console.log(format("info", message, meta));
  },
  prompt(message: string, meta: PromptLogMeta) {
    console.log(format("info", message, meta));
  },
};

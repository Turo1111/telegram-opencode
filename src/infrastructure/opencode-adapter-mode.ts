export const OPEN_CODE_ADAPTER_MODE = {
  HTTP: "http",
  CLI: "cli",
  PTY: "pty",
} as const;

export type OpenCodeAdapterMode =
  (typeof OPEN_CODE_ADAPTER_MODE)[keyof typeof OPEN_CODE_ADAPTER_MODE];

export function parseOpenCodeAdapterMode(rawValue: string | undefined): OpenCodeAdapterMode {
  const normalized = rawValue?.trim().toLowerCase() ?? OPEN_CODE_ADAPTER_MODE.HTTP;

  if (
    normalized === OPEN_CODE_ADAPTER_MODE.HTTP ||
    normalized === OPEN_CODE_ADAPTER_MODE.CLI ||
    normalized === OPEN_CODE_ADAPTER_MODE.PTY
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid value for OPEN_CODE_ADAPTER: ${rawValue}. Allowed: ${OPEN_CODE_ADAPTER_MODE.HTTP}, ${OPEN_CODE_ADAPTER_MODE.CLI}, ${OPEN_CODE_ADAPTER_MODE.PTY}`
  );
}

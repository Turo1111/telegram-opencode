const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const INVALID_TELEGRAM_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

export function sanitizeTelegramHtml(input: string): string {
  const normalized = normalizeInput(input);
  return normalized.replace(/[&<>"']/gu, (char) => HTML_ESCAPE_MAP[char as keyof typeof HTML_ESCAPE_MAP]);
}

function normalizeInput(input: string): string {
  return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(INVALID_TELEGRAM_CHARS, "");
}

const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
} as const;

const INVALID_TELEGRAM_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ALLOWED_TELEGRAM_HTML_TAG_PATTERN = /<\/?(?:b|i|code|pre)>|<a\s+href="[^"]+">|<\/a>/gu;

interface SanitizedToken {
  readonly key: string;
  readonly value: string;
}

export function sanitizeTelegramHtml(input: string): string {
  const normalized = normalizeInput(input);
  const preservedTokens: SanitizedToken[] = [];
  const withoutAllowedTags = normalized.replace(ALLOWED_TELEGRAM_HTML_TAG_PATTERN, (match) => {
    const sanitizedTag = sanitizeAllowedTelegramTag(match);
    if (!sanitizedTag) {
      return match;
    }

    const key = `__tg_html_${preservedTokens.length}__`;
    preservedTokens.push({ key, value: sanitizedTag });
    return key;
  });

  const escaped = withoutAllowedTags.replace(/[&<>"']/gu, (char) => HTML_ESCAPE_MAP[char as keyof typeof HTML_ESCAPE_MAP]);
  return preservedTokens.reduce((result, token) => result.split(token.key).join(token.value), escaped);
}

function normalizeInput(input: string): string {
  return input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").replace(INVALID_TELEGRAM_CHARS, "");
}

function sanitizeAllowedTelegramTag(tag: string): string | undefined {
  const lowerTag = tag.toLowerCase();
  if (["<b>", "</b>", "<i>", "</i>", "<code>", "</code>", "<pre>", "</pre>", "</a>"].includes(lowerTag)) {
    return lowerTag;
  }

  const hrefMatch = tag.match(/^<a\s+href="([^"]+)">$/u);
  if (!hrefMatch) {
    return undefined;
  }

  const href = normalizeTelegramHref(hrefMatch[1] ?? "");
  if (!href) {
    return undefined;
  }

  return `<a href="${escapeHtmlAttribute(href)}">`;
}

function normalizeTelegramHref(input: string): string | undefined {
  const candidate = input.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function escapeHtmlAttribute(input: string): string {
  return input.replace(/[&<>"']/gu, (char) => HTML_ESCAPE_MAP[char as keyof typeof HTML_ESCAPE_MAP]);
}

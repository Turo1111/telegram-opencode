const TELEGRAM_OUTBOUND_CONTENT_KIND = {
  MODEL: "model",
  TELEGRAM_NATIVE: "telegram-native",
  PLAIN: "plain",
} as const;

export const TELEGRAM_OUTBOUND_TOKEN = TELEGRAM_OUTBOUND_CONTENT_KIND;

export type TelegramOutboundContentKind =
  (typeof TELEGRAM_OUTBOUND_CONTENT_KIND)[keyof typeof TELEGRAM_OUTBOUND_CONTENT_KIND];

interface FormatOutboundForTelegramInput {
  readonly text: string;
  readonly contentKind: TelegramOutboundContentKind;
}

interface HtmlTokenEntry {
  readonly key: string;
  readonly value: string;
}

const HEADING_PATTERN = /^(#{1,3})\s+(.+)$/u;
const UNORDERED_LIST_PATTERN = /^\s*[-*]\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^\s*(\d+)\.\s+(.+)$/u;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/gu;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/gu;
const BOLD_PATTERN = /(\*\*|__)(?=\S)([^\n]*?\S)\1/gu;
const ITALIC_ASTERISK_PATTERN = /(^|[^*\w])\*(?!\s)([^*\n]+?\S)\*(?!\*)/gu;
const ITALIC_UNDERSCORE_PATTERN = /(^|[^\w])_(?!\s)([^_\n]+?\S)_(?!\w)/gu;
const FENCED_CODE_BLOCK_PATTERN = /```(?:[a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/gu;
const MAX_FORMATTED_PRE_LENGTH = 1_500;
const BLANK_LINES_PATTERN = /\n{3,}/gu;

export function formatOutboundForTelegram(input: FormatOutboundForTelegramInput): string {
  const normalized = normalizeTelegramWhitespace(input.text);
  if (input.contentKind !== TELEGRAM_OUTBOUND_CONTENT_KIND.MODEL) {
    return normalized;
  }

  const tokenStore: HtmlTokenEntry[] = [];
  let formatted = replaceFencedCodeBlocks(normalized, tokenStore);
  formatted = normalizeLineSemantics(formatted);
  formatted = replaceMarkdownLinks(formatted, tokenStore);
  formatted = formatted.replace(INLINE_CODE_PATTERN, (_match, content: string) => {
    return pushHtmlToken(tokenStore, `<code>${content}</code>`);
  });
  formatted = formatted.replace(BOLD_PATTERN, (_match, _delimiter: string, content: string) => {
    return pushHtmlToken(tokenStore, `<b>${content}</b>`);
  });
  formatted = formatted.replace(ITALIC_ASTERISK_PATTERN, (_match, prefix: string, content: string) => {
    return `${prefix}${pushHtmlToken(tokenStore, `<i>${content}</i>`)}`;
  });
  formatted = formatted.replace(ITALIC_UNDERSCORE_PATTERN, (_match, prefix: string, content: string) => {
    return `${prefix}${pushHtmlToken(tokenStore, `<i>${content}</i>`)}`;
  });

  return restoreHtmlTokens(formatted, tokenStore);
}

export function normalizeTelegramWhitespace(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/gu, ""))
    .join("\n")
    .replace(BLANK_LINES_PATTERN, "\n\n")
    .trim();
}

export function stripTelegramHtmlToPlainText(input: string): string {
  return decodeTelegramEntities(
    normalizeTelegramWhitespace(
      input
        .replace(/<a\s+href="([^"]+)">([\s\S]*?)<\/a>/gu, (_match, href: string, label: string) => {
          const normalizedLabel = stripTelegramHtmlToPlainText(label);
          return normalizedLabel ? `${normalizedLabel}: ${href}` : href;
        })
        .replace(/<\/?(?:b|i|code)>/gu, "")
        .replace(/<pre>/gu, "\n")
        .replace(/<\/pre>/gu, "\n")
        .replace(/<[^>]+>/gu, "")
    )
  );
}

function replaceFencedCodeBlocks(text: string, tokenStore: HtmlTokenEntry[]): string {
  return text.replace(FENCED_CODE_BLOCK_PATTERN, (_match, content: string) => {
    const normalizedContent = normalizeTelegramWhitespace(content);
    if (!normalizedContent) {
      return "";
    }

    if (normalizedContent.length > MAX_FORMATTED_PRE_LENGTH) {
      return normalizedContent;
    }

    return pushHtmlToken(tokenStore, `<pre>${normalizedContent}</pre>`);
  });
}

function normalizeLineSemantics(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(HEADING_PATTERN);
      if (headingMatch) {
        return `<b>${headingMatch[2]?.trim() ?? ""}</b>`;
      }

      const unorderedMatch = line.match(UNORDERED_LIST_PATTERN);
      if (unorderedMatch) {
        return `• ${unorderedMatch[1]?.trim() ?? ""}`;
      }

      const orderedMatch = line.match(ORDERED_LIST_PATTERN);
      if (orderedMatch) {
        return `${orderedMatch[1]}. ${orderedMatch[2]?.trim() ?? ""}`;
      }

      return line;
    })
    .join("\n");
}

function replaceMarkdownLinks(text: string, tokenStore: HtmlTokenEntry[]): string {
  return text.replace(MARKDOWN_LINK_PATTERN, (_match, label: string, href: string) => {
    const normalizedHref = normalizeTelegramHref(href);
    if (!normalizedHref) {
      const normalizedLabel = label.trim();
      const normalizedSource = href.trim();
      return normalizedLabel ? `${normalizedLabel}: ${normalizedSource}` : normalizedSource;
    }

    return pushHtmlToken(tokenStore, `<a href="${normalizedHref}">${label}</a>`);
  });
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

function pushHtmlToken(tokenStore: HtmlTokenEntry[], value: string): string {
  const key = `\uE000${tokenStore.length}\uE001`;
  tokenStore.push({ key, value });
  return key;
}

function restoreHtmlTokens(text: string, tokenStore: readonly HtmlTokenEntry[]): string {
  return tokenStore.reduce((result, entry) => result.split(entry.key).join(entry.value), text);
}

function decodeTelegramEntities(input: string): string {
  return input
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, "&");
}

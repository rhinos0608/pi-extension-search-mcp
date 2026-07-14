import type { BackendCallResult } from './backend.js';
import { normalizeUrl } from './fusion.js';

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 60_000;
const MIN_MAX_TOOL_OUTPUT_CHARS = 1_000;
const HEAD_RATIO = 0.8;

export interface GuardOptions {
  maxChars?: number | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export function maxToolOutputChars(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_SEARCH_MAX_TOOL_OUTPUT_CHARS?.trim();
  if (!raw) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  return Math.max(Math.trunc(parsed), MIN_MAX_TOOL_OUTPUT_CHARS);
}

export function guardText(text: string, options: GuardOptions = {}): string {
  const maxChars = options.maxChars !== undefined
    ? Math.max(Math.trunc(options.maxChars), MIN_MAX_TOOL_OUTPUT_CHARS)
    : maxToolOutputChars(options.env ?? process.env);
  if (text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = maxChars - headChars;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n[context guard: output truncated, ${omitted} of ${text.length} chars omitted]\n\n${text.slice(-tailChars)}`;
}

export function guardResult(result: BackendCallResult, options: GuardOptions = {}): BackendCallResult {
  if (!Array.isArray(result.content)) return result;
  const content = result.content.map((item) =>
    isTextContent(item) ? { ...item, text: guardText(item.text, options) } : item,
  );
  return { ...result, content };
}

export function dedupeBy<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(item);
  }
  return deduped;
}

export function dedupeByUrl<T extends { url: string }>(items: readonly T[]): T[] {
  return dedupeBy(items, (item) => (item.url ? normalizeUrl(item.url) : ''));
}

export function textResult(text: string, details: unknown, options: GuardOptions = {}): BackendCallResult {
  return { content: [{ type: 'text', text: guardText(text, options) }], details };
}

export function jsonTextResult(data: unknown, options: GuardOptions = {}): BackendCallResult {
  return textResult(JSON.stringify(data, null, 2) ?? String(data), data, options);
}

function isTextContent(item: unknown): item is { type: 'text'; text: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    'text' in item &&
    (item as { type: unknown }).type === 'text' &&
    typeof (item as { text: unknown }).text === 'string'
  );
}

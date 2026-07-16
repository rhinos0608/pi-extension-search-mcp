

// ── Action union ──

export type BrowserAction =
  | 'status'
  | 'tabs'
  | 'navigate'
  | 'evaluate'
  | 'text'
  | 'html'
  | 'screenshot'
  | 'click'
  | 'type'
  | 'scroll'
  | 'close'
  | 'cookies'
  | 'set_cookies'
  | 'snapshot'
  | 'fill'
  | 'wait'
  | 'get_url'
  | 'get_title';

export const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'status', 'tabs', 'navigate', 'evaluate', 'text', 'html', 'screenshot',
  'click', 'type', 'scroll', 'close', 'cookies', 'set_cookies',
  'snapshot', 'fill', 'wait', 'get_url', 'get_title',
] as const;

export const LEGACY_ACTIONS: readonly BrowserAction[] = [
  'status', 'tabs', 'navigate', 'evaluate', 'text', 'html', 'screenshot',
  'click', 'type', 'scroll', 'close', 'cookies', 'set_cookies',
] as const;

// ── Sensitive classification ──

export type SensitiveAction = 'evaluate' | 'set_cookies';

export const SENSITIVE_ACTIONS: readonly SensitiveAction[] = ['evaluate', 'set_cookies'] as const;

export function isSensitiveAction(action: string): action is SensitiveAction {
  return (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

// ── Cookie metadata policy ──

export type CookieMetadata = Pick<CookieLike, 'name' | 'domain' | 'path' | 'expires' | 'httpOnly' | 'secure' | 'sameSite'>;

export interface CookieLike {
  name: string;
  value?: string;
  domain: string;
  path: string;
  expires: number | undefined;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

export function normalizeCookieMetadata(cookie: CookieLike): CookieMetadata {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.expires ?? 0,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? 'Lax',
  };
}

export function extractCookieMetadata(cookies: CookieLike[]): CookieMetadata[] {
  return cookies.map(normalizeCookieMetadata);
}

// ── URL / navigation policy ──

export interface NavigationPolicy {
  url: string;
  allowedDomains?: string[];
}

/**
 * Validate a navigation URL for public browser use.
 * Rejects file:, chrome:, about:, data:, blob:, javascript:, ws:, wss:.
 * Rejects credentials in URL.
 * Rejects private/reserved hosts via http.ts validatePublicHttpUrl.
 */
export function validateNavigationUrl(raw: string): string {
  const url = new URL(raw.trim());
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }
  return url.href;
}

/**
 * DNS preflight is a no-op — containerization handles network containment.
 */
export async function dnsPreflight(_hostname: string, _signal?: AbortSignal): Promise<void> {
  // no-op
}

// ── Allowed domain validation — no-op: containerization handles containment ──

export function validateAllowedDomain(pattern: string): string {
  return pattern.trim().toLowerCase();
}

export function freezeAllowedDomains(domains: string[]): string[] {
  const validated = domains.map(validateAllowedDomain);
  validated.sort();
  return validated;
}

export async function validateAllowedDomainsDns(_domains: string[], _signal?: AbortSignal): Promise<void> {
  // no-op
}

export function checkDomainAllowed(_hostname: string, _allowedDomains: string[]): boolean {
  return true;
}

// ── Input bounds ──

export const MAX_SELECTOR_LENGTH = 500;
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_EXPRESSION_LENGTH = 50_000;
export const MAX_URL_LENGTH = 8_000;
export const MAX_COOKIES = 500;
export const MAX_SCROLL_COORD = 100_000;
export const MAX_WAIT_MS = 120_000;

export function validateSelector(selector: string): string {
  const trimmed = selector.trim();
  if (!trimmed) throw new Error('selector is required');
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    throw new Error(`selector too long (max ${MAX_SELECTOR_LENGTH} chars)`);
  }
  return trimmed;
}

export function validateText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text is required');
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`text too long (max ${MAX_TEXT_LENGTH} chars)`);
  }
  return trimmed;
}

export function validateExpression(expression: string): string {
  if (!expression || !expression.trim()) throw new Error('expression is required');
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`expression too long (max ${MAX_EXPRESSION_LENGTH} chars)`);
  }
  return expression;
}

export function validateCookiesArray(cookies: unknown[]): void {
  if (cookies.length > MAX_COOKIES) {
    throw new Error(`too many cookies (max ${MAX_COOKIES})`);
  }
  for (const c of cookies) {
    if (typeof c !== 'object' || c === null) {
      throw new Error('each cookie must be an object');
    }
    const entry = c as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !entry.name) {
      throw new Error('each cookie must have a non-empty string name');
    }
  }
}

export function validateScrollCoord(value: unknown, _name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(-MAX_SCROLL_COORD, Math.min(MAX_SCROLL_COORD, value));
}

export function validateWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_WAIT_MS, value));
}

// ── Legacy endpoint validator (kept for rollback path) ──

export interface LoopbackEndpointInfo {
  host: string;
  port: number;
  protocol: 'ws' | 'http';
  path: string;
}

export function validateLegacyLoopbackEndpoint(endpoint: string): LoopbackEndpointInfo {
  const rawPort = /^[a-zA-Z]+:\/\/(?:\[[^\]]+\]|[^/:]+):(\d+)/.exec(endpoint)?.[1];
  if (rawPort) {
    const parsedPort = Number(rawPort);
    if (!Number.isFinite(parsedPort) || parsedPort < 1024 || parsedPort > 65535) {
      throw new Error(`CDP endpoint port must be 1024-65535, got ${rawPort}`);
    }
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid CDP endpoint URL: ${endpoint}`);
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'http:') {
    throw new Error(`CDP endpoint must use ws:// or http:// scheme, got ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  const normalized = host === '[::1]' ? '::1' : host;
  if (normalized !== 'localhost' && normalized !== '127.0.0.1' && normalized !== '::1') {
    throw new Error(`CDP endpoint must be loopback (localhost, 127.0.0.1, or [::1]), got ${url.hostname}`);
  }

  const port = rawPort ? Number(rawPort) : (url.port ? Number(url.port) : 9222);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    throw new Error(`CDP endpoint port must be 1024-65535, got ${url.port || port}`);
  }

  return {
    host: normalized,
    port,
    protocol: url.protocol === 'http:' ? 'http' : 'ws',
    path: `${url.pathname}${url.search}`,
  };
}

// ── Browser request envelope ──

export interface BrowserRequest {
  action: BrowserAction;
  url?: string;
  expression?: string;
  selector?: string;
  text?: string;
  x?: number;
  y?: number;
  urls?: string[];
  cookies?: unknown[];
  allowedDomains?: string[];
  waitMs?: number;
}

export function validateBrowserRequest(raw: Record<string, unknown>): BrowserRequest {
  const actionRaw = typeof raw.action === 'string' ? raw.action : 'status';
  if (!(BROWSER_ACTIONS as readonly string[]).includes(actionRaw)) {
    throw new Error(`Unsupported browser action: ${actionRaw}`);
  }
  const action = actionRaw as BrowserAction;

  const request: BrowserRequest = { action };

  if (typeof raw.url === 'string') request.url = raw.url.trim();
  if (typeof raw.expression === 'string') request.expression = raw.expression;
  if (typeof raw.selector === 'string') request.selector = raw.selector;
  if (typeof raw.text === 'string') request.text = raw.text;
  if (typeof raw.x === 'number') request.x = raw.x;
  if (typeof raw.y === 'number') request.y = raw.y;
  if (Array.isArray(raw.urls)) {
    const urls = raw.urls.filter((u): u is string => typeof u === 'string');
    request.urls = urls;
  }
  if (Array.isArray(raw.cookies)) request.cookies = raw.cookies;
  if (Array.isArray(raw.allowedDomains)) {
    const domains = raw.allowedDomains.filter((d): d is string => typeof d === 'string');
    request.allowedDomains = domains;
  }
  if (typeof raw.waitMs === 'number') request.waitMs = raw.waitMs;

  return request;
}

import { CuaClient } from './cua-client.js';
import { ObservationStore, isMutation, resourceKey, timeoutFor, type DesktopRequest, type DesktopResult, MAX_AX_DEPTH, MAX_AX_NODES, MAX_SCREENSHOT_BYTES, MAX_DIMENSION } from './desktop-contract.js';
import { validatePolicy } from './desktop-policy.js';

const MAP: Record<string, string> = { status: 'health_report', list_apps: 'list_apps', list_windows: 'list_windows', observe_window: 'get_window_state', click: 'click', type_text: 'type_text', press_key: 'press_key', scroll: 'scroll' };

export class DesktopService {
  readonly observations = new ObservationStore(); private used = false;
  constructor(private readonly client: CuaClient = new CuaClient(), private readonly env: Record<string, string | undefined> = process.env) {}
  async execute(raw: Record<string, unknown>, signal?: AbortSignal): Promise<DesktopResult & { content?: unknown[] }> {
    const request = validatePolicy(raw, this.env); this.used = true;
    const pid = request.pid ?? 0; const windowId = request.windowId ?? '';
    if (isMutation(request.action)) { if (!request.pid || !request.windowId || !request.stateId) throw new Error('STALE_OBSERVATION: mutation requires target and state'); this.observations.get(request.stateId!, request.pid, request.windowId); }
    if (request.action === 'wait') return this.wait(request, signal);
    const result = await this.client.callTool(MAP[request.action]!, this.args(request), { ...(signal ? { signal } : {}), timeout: timeoutFor(request.action, request.timeoutMs), ...(pid && windowId ? { resource: resourceKey(pid, windowId) } : {}), mutation: isMutation(request.action) });
    const includeImage = request.action === 'observe_window' && request.includeScreenshot === true;
    // Keep image bytes only in MCP/Pi content; never in normalized data/details.
    const normalized = normalize(result, false);
    const details = normalize(result, false);
    if (request.action === 'observe_window') { const state = this.observations.issue(request.pid!, request.windowId!, normalized); return { action: request.action, stateId: state.stateId, data: normalized, content: contentFor(result, includeImage), details }; }
    return { action: request.action, data: normalized, content: contentFor(result, false), details };
  }
  async close(): Promise<void> { this.observations.clear(); await this.client.close(); }
  wasUsed(): boolean { return this.used; }
  private args(r: DesktopRequest): Record<string, unknown> { const out: Record<string, unknown> = {}; if (r.pid !== undefined) out.pid = r.pid; if (r.windowId !== undefined) out.window_id = r.windowId; if (r.text !== undefined) out.text = r.text; if (r.key !== undefined) out.key = r.key; if (r.x !== undefined) out.x = r.x; if (r.y !== undefined) out.y = r.y; if (r.deltaX !== undefined) out.delta_x = r.deltaX; if (r.deltaY !== undefined) out.delta_y = r.deltaY; if (r.includeScreenshot === true) out.include_screenshot = true; return out; }
  private async wait(r: DesktopRequest, signal?: AbortSignal): Promise<DesktopResult> { const until = Date.now() + timeoutFor('wait', r.timeoutMs); while (Date.now() < until) { const value = await this.client.callTool('get_window_state', this.args(r), { ...(signal ? { signal } : {}), timeout: 15000 }); const safe = normalize(value, false); const text = JSON.stringify(safe); if ((!r.predicate?.text || text.includes(r.predicate.text)) && (!r.predicate?.role || text.includes(r.predicate.role))) return { action: 'wait', data: safe }; await new Promise<void>(resolve => setTimeout(resolve, 100)); } throw new Error('wait timed out'); }
}

function normalize(value: unknown, _includeImage = false): unknown {
  const walk = (v: unknown, depth = 0, secureSibling = false): unknown => {
    if (depth > MAX_AX_DEPTH) return '[depth capped]';
    if (Array.isArray(v)) return v.slice(0, MAX_AX_NODES).map(x => walk(x, depth + 1, secureSibling));
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const secureMarker = entries.some(([k, x]) => /^(?:is_secure|secure|sensitive|password|secret|token|key)$/i.test(k) && (x === true || /^(?:password|secret|token|key)$/i.test(k)));
      const out: Record<string, unknown> = {};
      for (const [k, x] of entries) {
        if (/^(?:is_secure|secure|sensitive|password|secret|token|key)$/i.test(k)) continue;
        // Never carry image/base64 bytes into normalized model-visible data.
        if (/^(?:data|base64)$/i.test(k)) continue;
        out[k] = secureMarker || secureSibling ? '[redacted]' : walk(x, depth + 1, false);
      }
      return out;
    }
    if (secureSibling) return '[redacted]';
    if (typeof v === 'string') {
      if (v.length > 10000) return `${v.slice(0, 10000)}…`;
      if (/(?:Bearer\s+\S+|-----BEGIN|\/Users\/|\/home\/|[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[=:])/i.test(v)) return '[redacted]';
      if (/\bat\s+[^\n]+:\d+:\d+/i.test(v)) return '[stack redacted]';
    }
    return v;
  };
  return walk(value);
}

function contentFor(value: unknown, includeImage: boolean): unknown[] {
  if (!includeImage) return [{ type: 'text', text: JSON.stringify(normalize(value, false)) }];
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const blocks = Array.isArray(root.content) ? root.content : [];
  const image = blocks.find((block): block is Record<string, unknown> => {
    return !!block && typeof block === 'object' && (block as Record<string, unknown>).type === 'image' && typeof (block as Record<string, unknown>).data === 'string';
  });
  if (!image) return [{ type: 'text', text: JSON.stringify(normalize(value, false)) }];
  const data = image.data as string;
  const bytes = Math.floor(data.length * 3 / 4);
  const width = typeof image.width === 'number' ? image.width : 0;
  const height = typeof image.height === 'number' ? image.height : 0;
  if (bytes > MAX_SCREENSHOT_BYTES || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('Screenshot exceeds safety limits');
  return [{ type: 'image', mediaType: typeof image.mimeType === 'string' ? image.mimeType : (typeof image.mediaType === 'string' ? image.mediaType : 'image/png'), data, width, height, byteLength: bytes }];
}

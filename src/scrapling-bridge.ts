import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePublicHttpUrl, fetchText as realFetchText } from './http.js';

// ── Constants ──

const DEFAULT_PYTHON_PATH = 'python3';
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const SIGKILL_AFTER_MS = 5_000;

// ── Embedded Python script ──
// Reads JSON commands from stdin, writes JSON responses to stdout.
// Commands: {"action":"fetch|health|close",...}
// Responses: {"ok":true|false,...}

const PYTHON_SCRIPT = `import sys, json

def _write(data):
    sys.stdout.write(json.dumps(data) + "\\n")
    sys.stdout.flush()

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as e:
            _write({"ok": False, "error": "Invalid JSON: " + str(e)})
            continue

        action = cmd.get("action", "")

        if action == "fetch":
            try:
                from scrapling.fetchers import Fetcher, DynamicFetcher, StealthyFetcher
                url = cmd["url"]
                fetcher_name = cmd.get("fetcher", "stealthy")
                timeout = cmd.get("timeout", 30000)
                proxy = cmd.get("proxy")

                fetcher_kwargs = {}
                if proxy:
                    fetcher_kwargs["proxy"] = proxy

                if fetcher_name == "dynamic":
                    fetcher = DynamicFetcher(**fetcher_kwargs)
                elif fetcher_name == "fetcher":
                    fetcher = Fetcher(**fetcher_kwargs)
                else:
                    fetcher = StealthyFetcher(**fetcher_kwargs)

                result = fetcher.get(url, timeout=timeout)
                _write({
                    "ok": True,
                    "url": getattr(result, 'url', url),
                    "title": getattr(result, 'title', ''),
                    "content": getattr(result, 'content', ''),
                    "status_code": getattr(result, 'status_code', 200),
                    "content_type": getattr(result, 'content_type', ''),
                })
            except Exception as e:
                _write({"ok": False, "error": f"{type(e).__name__}: {e}"})

        elif action == "health":
            try:
                import scrapling
                _write({
                    "ok": True,
                    "scrapling_version": getattr(scrapling, '__version__', 'unknown'),
                    "python_version": sys.version.split()[0],
                })
            except ImportError:
                _write({"ok": False, "error": "scrapling not installed"})
            except Exception as e:
                _write({"ok": False, "error": f"{type(e).__name__}: {e}"})

        elif action == "close":
            break

    sys.exit(0)

if __name__ == "__main__":
    main()
`;

// ── Public Interfaces (spec) ──

export interface ScraplingBridgeOptions {
  pythonPath?: string;
  fetcher?: 'fetcher' | 'dynamic' | 'stealthy';
  solveCloudflare?: boolean;
  proxy?: string;
  fetchTimeout?: number;
  signal?: AbortSignal;
}

export interface ScraplingFetchResult {
  url: string;
  title: string;
  content: string;
  statusCode?: number;
  contentType?: string;
}

export interface ScraplingHealthStatus {
  available: boolean;
  pythonVersion?: string;
  scraplingVersion?: string;
  error?: string;
}

// ── ScraplingBridge ──

export class ScraplingBridge {
  private static _scriptDir: string | undefined;
  private static _scriptPath: string | undefined;

  private readonly options: {
    pythonPath: string;
    fetcher: 'fetcher' | 'dynamic' | 'stealthy';
    solveCloudflare: boolean;
    proxy: string | undefined;
    fetchTimeout: number;
  };
  private readonly _enabled: boolean;
  private readonly _signal: AbortSignal | undefined;
  private readonly _spawn: typeof spawn;
  private readonly _fetchTextFallback: typeof realFetchText;

  private _child: ChildProcess | undefined;
  private _buffer = '';
  private _pendingResolve: ((value: Record<string, unknown>) => void) | null = null;
  private _pendingReject: ((reason: unknown) => void) | null = null;
  private _closed = false;
  private _commandMutex: Promise<void> = Promise.resolve();
  private _healthCache: ScraplingHealthStatus | undefined;

  // Track registered listeners for cleanup on restart
  private _onChildData: ((chunk: Buffer) => void) | undefined;
  private _onChildExit: ((code: number | null, signal: string | null) => void) | undefined;
  private _onChildError: ((err: Error) => void) | undefined;

  constructor(options?: ScraplingBridgeOptions) {
    const env = process.env;
    // Auto-detect: always enabled unless explicitly disabled
    const envEnabled = env.PI_SEARCH_SCRAPLING_ENABLED;
    this._enabled = envEnabled === undefined || (envEnabled !== '0' && envEnabled !== 'false' && envEnabled !== '');

    this.options = {
      pythonPath: options?.pythonPath ?? env.PI_SEARCH_SCRAPLING_PYTHON_PATH ?? DEFAULT_PYTHON_PATH,
      fetcher: options?.fetcher ?? 'stealthy',
      solveCloudflare: options?.solveCloudflare ?? true,
      proxy: options?.proxy ?? env.PI_SEARCH_SCRAPLING_PROXY ?? undefined,
      fetchTimeout: options?.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT_MS,
    };

    this._signal = options?.signal;
    this._spawn = (options as Record<string, unknown>)?._spawn as typeof spawn | undefined ?? spawn;
    this._fetchTextFallback = (options as Record<string, unknown>)?._fetchText as typeof realFetchText | undefined ?? realFetchText;

    if (this._signal) {
      if (this._signal.aborted) {
        this._closed = true;
      } else {
        this._signal.addEventListener('abort', () => {
          if (this._pendingReject) {
            const reject = this._pendingReject;
            this._pendingResolve = null;
            this._pendingReject = null;
            reject(new DOMException('Aborted', 'AbortError'));
          }
          this.close().catch(() => { /* swallow */ });
        }, { once: true });
      }
    }
  }

  // ── Public API ──

  async fetch(url: string): Promise<ScraplingFetchResult> {
    if (this._closed) throw new Error('ScraplingBridge is closed');

    const validatedUrl = validatePublicHttpUrl(url);

    if (!this._enabled) {
      return this.fallbackFetch(validatedUrl);
    }

    const scriptPath = ScraplingBridge.ensureScript();
    await this.ensureProcess(scriptPath);

    // Try with one restart
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await this.sendCommand({
          action: 'fetch',
          url: validatedUrl,
          fetcher: this.options.fetcher,
          solve_cloudflare: this.options.solveCloudflare,
          proxy: this.options.proxy ?? null,
          timeout: this.options.fetchTimeout,
        });

        if (response.ok === true) {
          return {
            url: String(response.url ?? validatedUrl),
            title: String(response.title ?? ''),
            content: String(response.content ?? ''),
            ...(response.status_code !== undefined && response.status_code !== null
              ? { statusCode: Number(response.status_code) }
              : {}),
            ...(response.content_type ? { contentType: String(response.content_type) } : {}),
          };
        }

        // Error response from Python — restart and retry
        if (attempt === 2) break;
        await this.restartProcess(scriptPath);
      } catch {
        // Process error / crash — restart and retry
        if (attempt === 2) break;
        await this.restartProcess(scriptPath);
      }
    }

    // Fall back to plain HTTP fetch
    return this.fallbackFetch(validatedUrl);
  }

  async health(): Promise<ScraplingHealthStatus> {
    if (this._healthCache) return this._healthCache;

    if (!this._enabled) {
      this._healthCache = { available: false };
      return this._healthCache;
    }

    const scriptPath = ScraplingBridge.ensureScript();
    let result: ScraplingHealthStatus;

    try {
      const parsed = await this.oneShotCommand(scriptPath, { action: 'health' });
      if (parsed.ok === true) {
        result = {
          available: true,
          ...(parsed.python_version ? { pythonVersion: String(parsed.python_version) } : {}),
          ...(parsed.scrapling_version ? { scraplingVersion: String(parsed.scrapling_version) } : {}),
        };
      } else {
        result = {
          available: false,
          error: parsed.error ? String(parsed.error) : 'Health check returned error',
        };
      }
    } catch (err) {
      result = {
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this._healthCache = result;
    return result;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    const child = this._child;
    if (!child) return;

    this._child = undefined;
    this.clearPending('Bridge closed');

    // Send close command if stdin is writable
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write(JSON.stringify({ action: 'close' }) + '\n');
      }
    } catch { /* swallow */ }

    // SIGTERM, then SIGKILL after timeout
    try {
      child.kill('SIGTERM');
    } catch { /* swallow */ }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* swallow */ }
        resolve();
      }, SIGKILL_AFTER_MS);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      // Also resolve if already exited
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  // ── Private helpers ──

  private async ensureProcess(scriptPath: string): Promise<void> {
    if (this._child && !this._child.killed) return;
    this.spawnProcess(scriptPath);
  }

  private spawnProcess(scriptPath: string): void {
    // Detach old listeners if any
    this.detachChildListeners();

    const child = this._spawn(this.options.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this._child = child;

    // Buffer stdout and resolve pending command responses
    const onData = (chunk: Buffer) => {
      this._buffer += chunk.toString();
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          const resolve = this._pendingResolve;
          if (resolve) {
            this._pendingResolve = null;
            this._pendingReject = null;
            resolve(parsed);
          }
        } catch {
          // Invalid JSON line — ignore
        }
      }
    };

    // Process exit before response received
    const onExit = () => {
      this._child = undefined;
      if (this._pendingReject) {
        const reject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(new Error('Subprocess exited unexpectedly'));
      }
    };

    // Spawn error (ENOENT, etc.)
    const onError = (err: Error) => {
      this._child = undefined;
      if (this._pendingReject) {
        const reject = this._pendingReject;
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(err);
      }
    };

    this._onChildData = onData;
    this._onChildExit = onExit;
    this._onChildError = onError;

    if (child.stdout) child.stdout.on('data', onData);
    child.on('exit', onExit);
    child.once('error', onError);
  }

  private detachChildListeners(): void {
    const child = this._child;
    if (!child) return;
    if (child.stdout && this._onChildData) child.stdout.removeListener('data', this._onChildData);
    if (this._onChildExit) child.removeListener('exit', this._onChildExit);
    if (this._onChildError) child.removeListener('error', this._onChildError);
    this._onChildData = undefined;
    this._onChildExit = undefined;
    this._onChildError = undefined;
  }

  private killChild(): void {
    const child = this._child;
    if (!child) return;
    this.detachChildListeners();
    this._child = undefined;
    try { child.kill('SIGKILL'); } catch { /* swallow */ }
  }

  private async restartProcess(scriptPath: string): Promise<void> {
    this.killChild();
    // Brief yield to let OS release resources
    await new Promise((r) => setImmediate(r));
    this.spawnProcess(scriptPath);
  }

  private sendCommand(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = this._commandMutex.then(() => this._doSendCommand(data));
    this._commandMutex = result.then(() => {}, () => {});
    return result;
  }

  private _doSendCommand(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = this._child;
      if (!child || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        reject(new Error('Subprocess not available'));
        return;
      }

      this._pendingResolve = resolve;
      this._pendingReject = reject;

      try {
        child.stdin.write(JSON.stringify(data) + '\n');
      } catch (err) {
        this._pendingResolve = null;
        this._pendingReject = null;
        reject(err);
      }
    });
  }

  private oneShotCommand(scriptPath: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = this._spawn(this.options.pythonPath, [scriptPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      let buffer = '';
      let responded = false;
      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          try { child.kill('SIGKILL'); } catch { /* swallow */ }
          reject(new Error('One-shot command timed out'));
        }
      }, this.options.fetchTimeout);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (!responded) {
              responded = true;
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch { /* ignore */ }
        }
      };

      const onExit = () => {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(new Error('One-shot subprocess exited without response'));
        }
      };

      child.stdout?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', (err) => {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        child.stdin?.write(JSON.stringify(data) + '\n');
        child.stdin?.end();
      } catch (err) {
        if (!responded) {
          responded = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  private async fallbackFetch(url: string): Promise<ScraplingFetchResult> {
    const content = await this._fetchTextFallback(url);
    return { url, title: '', content };
  }

  private clearPending(reason: string): void {
    if (this._pendingReject) {
      const reject = this._pendingReject;
      this._pendingResolve = null;
      this._pendingReject = null;
      reject(new Error(reason));
    }
    this._pendingResolve = null;
    this._pendingReject = null;
  }

  // ── Static script management ──

  private static ensureScript(): string {
    if (!ScraplingBridge._scriptPath) {
      const dir = mkdtempSync(join(tmpdir(), 'scrapling-bridge-'));
      const filePath = join(dir, '_bridge.py');
      writeFileSync(filePath, PYTHON_SCRIPT, 'utf-8');
      ScraplingBridge._scriptDir = dir;
      ScraplingBridge._scriptPath = filePath;

      // Cleanup on process exit
      process.once('exit', () => {
        ScraplingBridge.cleanupScript();
      });
    }
    return ScraplingBridge._scriptPath;
  }

  private static cleanupScript(): void {
    if (ScraplingBridge._scriptDir) {
      try { rmSync(ScraplingBridge._scriptDir, { recursive: true, force: true }); } catch { /* swallow */ }
      ScraplingBridge._scriptDir = undefined;
      ScraplingBridge._scriptPath = undefined;
    }
  }
}

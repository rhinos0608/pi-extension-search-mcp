import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from './backend.js';

interface CliEnvelope {
  ok: boolean;
  data?: BackendCallResult;
  error?: {
    code: string;
    message: string;
  };
}

export class CliSearchBackend implements SearchBackend {
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'),
  ) {}

  async callTool(name: string, args: Record<string, unknown>, options: BackendCallOptions = {}): Promise<BackendCallResult> {
    const envelope = await this.run(['call', name, JSON.stringify(args)], options.signal);
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'CLI backend failed');
    if (!envelope.data) throw new Error('CLI backend returned no data.');
    return envelope.data;
  }

  async close(): Promise<void> {}

  private run(args: string[], signal?: AbortSignal): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', this.cliPath, ...args], {
        env: buildCliEnvironment(this.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        const output = Buffer.concat(stdout).toString('utf8');
        const diagnostics = Buffer.concat(stderr).toString('utf8').trim();
        let parsed: CliEnvelope;
        try {
          parsed = JSON.parse(output) as CliEnvelope;
        } catch (error) {
          reject(new Error(`CLI backend returned invalid JSON: ${String(error)}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        if (code !== 0 && parsed.ok) {
          reject(new Error(`CLI backend exited with code ${code ?? 1}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        resolve(parsed);
      });
    });
  }
}

function buildCliEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'NODE_OPTIONS',
    'GITHUB_TOKEN',
    'SEARCH_BACKEND',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key]]] : [])),
  );
}

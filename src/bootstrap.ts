import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { BackendCallResult } from './backend.js';

export type SetupAction = 'status' | 'plan' | 'install_core' | 'install_all' | 'install_channels';

interface SetupOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface BootstrapState {
  version: 1;
  ranAt: string;
  mode: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const STATE_PATH = join(homedir(), '.pi-extension-search', 'bootstrap.json');
const INSTALL_DOC_URL = 'https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md';
const OPENCLI_EXTENSION_URL = 'https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk';

const platformPlan = [
  { platform: 'web', ready: 'Read any webpage', unlock: '—', setup: 'No configuration required' },
  { platform: 'youtube', ready: 'Subtitle extraction + video search', unlock: '—', setup: 'Install yt-dlp; Node/Deno JS runtime recommended' },
  { platform: 'rss', ready: 'Read RSS/Atom', unlock: '—', setup: 'No configuration required' },
  { platform: 'search', ready: 'Basic native search', unlock: 'Full semantic search', setup: 'Optional Exa/mcporter path from Agent-Reach' },
  { platform: 'github', ready: 'Public repos + search', unlock: 'Private repos, Issues/PRs, forks', setup: 'Run gh auth login or provide GITHUB_TOKEN' },
  { platform: 'twitter', ready: 'Read single tweet where backend supports it', unlock: 'Search, timelines, articles', setup: 'twitter-cli with TWITTER_AUTH_TOKEN/TWITTER_CT0 or OpenCLI + Chrome login' },
  { platform: 'bilibili', ready: 'Search + video details via bili-cli', unlock: 'Subtitles via OpenCLI', setup: 'Install bili-cli; OpenCLI for subtitles' },
  { platform: 'reddit', ready: '—', unlock: 'Search + posts/comments', setup: 'OpenCLI + Chrome login or rdt-cli + cookie; no zero-config path' },
  { platform: 'facebook', ready: '—', unlock: 'Search, profiles, feed, groups', setup: 'OpenCLI desktop + Chrome login' },
  { platform: 'instagram', ready: '—', unlock: 'User search, profiles, posts, explore', setup: 'OpenCLI desktop + Chrome login' },
  { platform: 'xiaohongshu', ready: '—', unlock: 'Search, notes, comments', setup: 'OpenCLI desktop + Chrome login; xiaohongshu-mcp QR on servers' },
  { platform: 'linkedin', ready: 'Public pages via Jina Reader', unlock: 'Profiles, companies, jobs', setup: 'linkedin-scraper-mcp with browser login' },
  { platform: 'v2ex', ready: 'Hot/node topics, details, replies, users', unlock: '—', setup: 'No configuration required' },
  { platform: 'xueqiu', ready: 'Stock quotes/search/hot lists', unlock: 'Logged-in content', setup: 'Configure Xueqiu cookies from browser' },
  { platform: 'xiaoyuzhou', ready: '—', unlock: 'Podcast transcription', setup: 'Groq or OpenAI Whisper key' },
];

export async function ensureFirstStartBootstrap(env: Record<string, string | undefined> = process.env): Promise<void> {
  const mode = env.PI_SEARCH_BOOTSTRAP ?? 'check';
  if (mode === 'off' || mode === '0' || mode === 'false') return;
  if (await hasState()) return;

  try {
    const result = await runBootstrapMode(mode, env);
    await safeWriteState({
      version: 1,
      ranAt: new Date().toISOString(),
      mode,
      status: result.status,
      message: result.message,
    });
  } catch (error) {
    await safeWriteState({
      version: 1,
      ranAt: new Date().toISOString(),
      mode,
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function callSetupTool(args: Record<string, unknown>, options: SetupOptions = {}): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action as SetupAction : 'status';
  switch (action) {
    case 'status':
      return setupStatus();
    case 'plan':
      return jsonTextResult({ installDoc: INSTALL_DOC_URL, opencliExtension: OPENCLI_EXTENSION_URL, platforms: platformPlan });
    case 'install_core':
      return runAgentReachInstall(['install', '--env=auto'], options);
    case 'install_all':
      return runAgentReachInstall(['install', '--env=auto', '--channels=all'], options);
    case 'install_channels': {
      const channels = requireString(args.channels, 'channels');
      return runAgentReachInstall(['install', '--env=auto', `--channels=${channels}`], options);
    }
    default:
      throw new Error(`Unsupported reach_setup action: ${action}`);
  }
}

async function setupStatus(): Promise<BackendCallResult> {
  const state = await readState();
  return jsonTextResult({
    firstStart: state,
    installDoc: INSTALL_DOC_URL,
    opencliExtension: OPENCLI_EXTENSION_URL,
    safety: [
      'First start defaults to check-only. It does not install packages, read cookies, or log into platforms.',
      'Set PI_SEARCH_BOOTSTRAP=install_core or install_all only when you explicitly want startup package installation.',
      'OpenCLI Chrome extension install, browser login, cookie export, QR login, and API keys always require user action.',
    ],
  });
}

async function runBootstrapMode(mode: string, env: Record<string, string | undefined>): Promise<{ status: BootstrapState['status']; message: string }> {
  const installArgs = bootstrapInstallArgs(mode);
  if (installArgs) {
    if (env.PI_SEARCH_ALLOW_INSTALL !== '1') {
      return { status: 'warn', message: `Bootstrap install blocked. Set PI_SEARCH_ALLOW_INSTALL=1 to run: agent-reach ${installArgs.join(' ')}` };
    }
    const result = await runCommand('agent-reach', installArgs, { env }, 300_000);
    return commandStatus(result, `agent-reach ${installArgs.join(' ')}`);
  }

  const result = await runCommand('agent-reach', ['doctor', '--json'], { env }, 60_000);
  if (result.code === 127) {
    return { status: 'warn', message: `agent-reach not installed. Install guide: ${INSTALL_DOC_URL}` };
  }
  return commandStatus(result, 'agent-reach doctor --json');
}

export function bootstrapInstallArgs(mode: string): string[] | undefined {
  if (mode === 'safe') return ['install', '--env=auto', '--safe'];
  if (mode === 'install_core') return ['install', '--env=auto'];
  if (mode === 'install_all' || mode === 'install-all') return ['install', '--env=auto', '--channels=all'];
  return undefined;
}

async function runAgentReachInstall(args: string[], options: SetupOptions): Promise<BackendCallResult> {
  if (options.env?.PI_SEARCH_ALLOW_INSTALL !== '1') {
    return jsonTextResult({
      status: 'blocked',
      message: 'Package installation is disabled by default. Set PI_SEARCH_ALLOW_INSTALL=1, then rerun reach_setup.',
      command: `agent-reach ${args.join(' ')}`,
      installDoc: INSTALL_DOC_URL,
    });
  }

  const result = await runCommand('agent-reach', args, options, 600_000);
  const status = commandStatus(result, `agent-reach ${args.join(' ')}`);
  return textResult([status.message, result.stdout, result.stderr].filter(Boolean).join('\n\n'), { status, stdout: result.stdout, stderr: result.stderr });
}

function commandStatus(result: CommandResult, command: string): { status: BootstrapState['status']; message: string } {
  if (result.code === 0) return { status: 'ok', message: `${command} completed.` };
  if (result.code === 127) return { status: 'warn', message: `${command} unavailable. Install Agent Reach first: ${INSTALL_DOC_URL}` };
  return { status: 'error', message: `${command} failed with exit ${result.code}: ${tail(result.stderr || result.stdout)}` };
}

async function runCommand(command: string, args: string[], options: SetupOptions, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env: setupEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const abort = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-1_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1_000_000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr });
    });
  });
}

function setupEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'GITHUB_TOKEN', 'GH_TOKEN', 'GROQ_API_KEY', 'OPENAI_API_KEY',
    'BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY', 'YOUTUBE_API_KEY',
    'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT',
    'CRAWL4AI_BASE_URL', 'CRAWL4AI_API_TOKEN', 'DEEP_RESEARCH_BASE_URL', 'DEEP_RESEARCH_API_TOKEN',
    'TWITTER_AUTH_TOKEN', 'TWITTER_CT0', 'OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN',
    'PI_SEARCH_ALLOW_INSTALL', 'PI_SEARCH_BOOTSTRAP',
  ];
  return Object.fromEntries(allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key] as string]] : [])));
}

async function hasState(): Promise<boolean> {
  try {
    await readFile(STATE_PATH, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function readState(): Promise<BootstrapState | null> {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8')) as BootstrapState;
  } catch {
    return null;
  }
}

async function safeWriteState(state: BootstrapState): Promise<void> {
  try {
    await writeState(state);
  } catch {
    // Startup bootstrap must never prevent extension registration.
  }
}

async function writeState(state: BootstrapState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function jsonTextResult(data: unknown): BackendCallResult {
  return textResult(JSON.stringify(data, null, 2), data);
}

function textResult(text: string, details: unknown): BackendCallResult {
  return { content: [{ type: 'text', text }], details };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function tail(text: string): string {
  const cleaned = text.trim();
  return cleaned.length > 1000 ? cleaned.slice(-1000) : cleaned;
}

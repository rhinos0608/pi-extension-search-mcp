import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { BackendCallResult } from './backend.js';
import { callSetupTool } from './bootstrap.js';
import { browser } from './browser-tools.js';
import { fetchJson as boundedFetchJson, fetchText as boundedFetchText, validatePublicHttpUrl } from './http.js';
import { cookieAuthEnvironment } from './cookie-jar.js';
import { authForChannel } from './providers.js';
import { dedupeBy, guardResult, jsonTextResult, textResult } from './tool-output.js';

export type ReachToolName = 'reach_status' | 'reach_setup' | 'social' | 'video' | 'feeds' | 'media' | 'browser';

interface ReachToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ExternalCandidate {
  name: string;
  command: string;
  probeArgs: string[];
  args(action: string, input: Record<string, unknown>): string[];
  setup: string;
}

interface ChannelDefinition {
  name: string;
  family: 'social' | 'media' | 'web' | 'dev' | 'research' | 'browser';
  description: string;
  tier: 0 | 1 | 2;
  backends: Array<{ name: string; type: 'native' | 'external'; command?: string; setup?: string }>;
}

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;
const USER_AGENT = 'pi-extension-search/0.1';

const channels: ChannelDefinition[] = [
  { name: 'web', family: 'web', description: 'Public web search and page reading', tier: 0, backends: [{ name: 'native-fetch', type: 'native' }] },
  { name: 'github', family: 'dev', description: 'GitHub repositories, files, trees, search, trending', tier: 0, backends: [{ name: 'github-api', type: 'native' }] },
  { name: 'research', family: 'research', description: 'Academic, public-data, and community sources', tier: 0, backends: [{ name: 'native-public-apis', type: 'native' }] },
  { name: 'rss', family: 'media', description: 'RSS and Atom feed reading', tier: 0, backends: [{ name: 'native-rss-atom', type: 'native' }] },
  { name: 'v2ex', family: 'social', description: 'V2EX topics, nodes, replies, and users', tier: 0, backends: [{ name: 'v2ex-public-api', type: 'native' }] },
  { name: 'twitter', family: 'social', description: 'Twitter/X tweets, search, users, and timelines', tier: 1, backends: [{ name: 'twitter-cli', type: 'external', command: 'twitter', setup: 'pipx install twitter-cli' }, { name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'reddit', family: 'social', description: 'Reddit posts, comments, subreddits, and search', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }, { name: 'rdt-cli', type: 'external', command: 'rdt', setup: "pipx install 'git+https://github.com/public-clis/rdt-cli.git' && rdt login" }] },
  { name: 'xiaohongshu', family: 'social', description: 'XiaoHongShu search, notes, comments, feed, and users', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }, { name: 'xhs-cli', type: 'external', command: 'xhs', setup: 'Install xhs-cli; OpenCLI preferred for new installs' }] },
  { name: 'facebook', family: 'social', description: 'Facebook search, profiles, feed, and groups', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'instagram', family: 'social', description: 'Instagram user search, profiles, posts, explore, and saved', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'youtube', family: 'media', description: 'YouTube search, metadata, and subtitles via yt-dlp', tier: 1, backends: [{ name: 'yt-dlp', type: 'external', command: 'yt-dlp', setup: 'pip install yt-dlp' }] },
  { name: 'bilibili', family: 'media', description: 'Bilibili search, hot videos, details, and subtitles', tier: 1, backends: [{ name: 'bili-cli', type: 'external', command: 'bili', setup: 'Install bili-cli' }, { name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI for subtitles' }] },
  { name: 'browser', family: 'browser', description: 'Browser automation via CDP: navigate, evaluate, screenshot, click, type, scroll, tabs, cookies', tier: 0, backends: [{ name: 'cdp', type: 'native' }] },
];

export async function callReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions = {},
): Promise<BackendCallResult | undefined> {
  const result = await dispatchReachTool(name, args, options);
  return result ? guardResult(result, { env: options.env }) : undefined;
}

async function dispatchReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<BackendCallResult | undefined> {
  switch (name as ReachToolName) {
    case 'reach_status':
      return reachStatus(args, options);
    case 'reach_setup':
      return callSetupTool(args, options);
    case 'social':
      return social(args, options);
    case 'video':
      return video(args, options);
    case 'feeds':
      return feeds(args, options);
    case 'media':
      if (args.platform === 'rss' || args.action === 'feed') {
        return feeds({ url: args.url, limit: args.limit ?? 20 }, options);
      }
      return video(args, options);
    case 'browser':
      return browser(args, options);
    default:
      return undefined;
  }
}

async function reachStatus(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const family = typeof args.family === 'string' ? args.family : undefined;
  const selected = family ? channels.filter((channel) => channel.family === family) : channels;
  const env = options.env ?? process.env;
  const results = await Promise.all(selected.map((channel) => inspectChannel(channel, options)));
  const usable = results.filter((item) => item.status === 'ok').length;
  const channelsWithAuth = results.map((r) => {
    const name = typeof r.name === 'string' ? r.name : '';
    const auth = authForChannel(name, env);
    return { ...r, auth: auth ?? { configured: false, keyNames: [], loginFlow: 'unknown', cookieDomains: [], risk: 'low' } };
  });
  return jsonTextResult({ usable, total: results.length, channels: channelsWithAuth });
}

async function inspectChannel(channel: ChannelDefinition, options: ReachToolOptions): Promise<Record<string, unknown>> {
  try {
    const native = channel.backends.find((backend) => backend.type === 'native');
    if (native) {
      return { ...channel, status: 'ok', active_backend: native.name };
    }

    const candidates = orderedBackendMetadata(channel, options.env ?? process.env);
    const warnings: Array<{ backend: string; message: string }> = [];
    for (const candidate of candidates) {
      const probe = await runCommand(candidate.command ?? '', probeArgs(candidate.name), options, 8_000);
      if (probe.code === 0) return { ...channel, status: 'ok', active_backend: candidate.name };
      if (probe.code !== 127) warnings.push({ backend: candidate.name, message: tail(sanitizeExternalOutput(probe.stderr || probe.stdout)) });
    }
    if (warnings[0]) return { ...channel, status: 'warn', active_backend: warnings[0].backend, message: warnings[0].message };
    return { ...channel, status: 'off', active_backend: null, message: setupMessage(channel) };
  } catch (error) {
    return { ...channel, status: 'error', active_backend: null, message: error instanceof Error ? error.message : String(error) };
  }
}

async function social(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const platform = platformOrInfer(args, ['twitter', 'reddit', 'v2ex', 'xiaohongshu', 'facebook', 'instagram']);
  if (platform === 'v2ex') return v2ex(args, options);

  const requestedAction = typeof args.action === 'string' ? args.action : 'search';
  const filter = requestedAction === 'feed' ? hotPopularFilter(args.filter) : undefined;
  const action = socialFeedAction(platform, requestedAction, filter);
  const candidates = socialCandidates(platform);
  const result = await runFirstUsable(platform, candidates, action, args, options);
  return textResult(result.stdout || result.stderr, { platform, action, ...(filter ? { filter } : {}), backend: result.backend, stdout: result.stdout, stderr: result.stderr });
}

function socialFeedAction(platform: string, action: string, filter: 'hot' | 'popular' | undefined): string {
  if (action !== 'feed' || !filter) return action;
  if (platform === 'reddit') return filter;
  if (platform === 'xiaohongshu' && filter === 'hot') return 'hot';
  if (platform === 'twitter') return action;
  throw new Error(`${platform} feed does not support ${filter} filter`);
}

function hotPopularFilter(value: unknown): 'hot' | 'popular' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('filter must be hot or popular');
  const normalized = value.toLowerCase();
  if (normalized === 'hot' || normalized === 'popular') return normalized;
  throw new Error('filter must be hot or popular');
}

async function video(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const platform = platformOrInfer(args, ['youtube', 'bilibili']);
  const action = typeof args.action === 'string' ? args.action : (args.url ? 'details' : 'search');

  if (platform === 'youtube' && action === 'transcript') return youtubeTranscript(args, options);

  const candidates = videoCandidates(platform);
  const result = await runFirstUsable(platform, candidates, action, args, options);
  const text = result.stdout || result.stderr;
  return textResult(text, { platform, action, backend: result.backend, stdout: result.stdout, stderr: result.stderr });
}

async function feeds(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const url = requireString(args.url, 'url');
  const limit = numberOrDefault(args.limit, 20);
  const xml = await fetchText(url, options.signal);
  const items = dedupeBy(parseFeedItems(xml), (item) => item.url || item.title).slice(0, limit);
  const text = items.length
    ? items.map((item, index) => `## ${index + 1}. ${item.title}\n${item.url}\n${item.summary ?? ''}`).join('\n\n')
    : `No feed entries found for: ${url}`;
  return textResult(text, { url, items });
}

async function v2ex(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'hot';
  const limit = numberOrDefault(args.limit, 20);
  let data: unknown;

  switch (action) {
    case 'hot':
      data = (await fetchJson('https://www.v2ex.com/api/topics/hot.json', options.signal) as unknown[]).slice(0, limit);
      break;
    case 'node': {
      const node = requireString(args.node ?? args.nodeName, 'node');
      data = (await fetchJson(`https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(node)}&page=1`, options.signal) as unknown[]).slice(0, limit);
      break;
    }
    case 'topic': {
      const id = requireString(args.id ?? topicIdFromUrl(args.url), 'id');
      const topic = await fetchJson(`https://www.v2ex.com/api/topics/show.json?id=${encodeURIComponent(id)}`, options.signal);
      const replies = await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(id)}&page=1`, options.signal);
      data = { topic, replies: Array.isArray(replies) ? replies.slice(0, limit) : replies };
      break;
    }
    case 'replies': {
      const id = requireString(args.id ?? topicIdFromUrl(args.url), 'id');
      data = (await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(id)}&page=1`, options.signal) as unknown[]).slice(0, limit);
      break;
    }
    case 'user': {
      const username = requireString(args.user ?? args.username, 'user');
      data = await fetchJson(`https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(username)}`, options.signal);
      break;
    }
    default:
      throw new Error(`Unsupported v2ex action: ${action}`);
  }

  return jsonTextResult({ platform: 'v2ex', action, data });
}

async function youtubeTranscript(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const url = requireString(args.url, 'url');
  const lang = typeof args.language === 'string' ? args.language : 'en.*';
  const dir = await mkdtemp(join(tmpdir(), 'pi-extension-search-ytdlp-'));
  try {
    const candidate = youtubeCandidate();
    const command = await runFirstUsable('youtube', [candidate], 'transcript', { ...args, language: lang, outputDir: dir }, options);
    const files = (await readdir(dir)).filter((file) => file.endsWith('.vtt') || file.endsWith('.srt'));
    if (!files.length) throw new Error(`yt-dlp completed but wrote no subtitle files. stderr: ${tail(command.stderr)}`);
    const content = await readFile(join(dir, files[0] ?? ''), 'utf8');
    const cleaned = cleanSubtitleText(content);
    return textResult(cleaned, { platform: 'youtube', action: 'transcript', backend: command.backend, url, language: lang, content: cleaned });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function socialCandidates(platform: string): ExternalCandidate[] {
  switch (platform) {
    case 'twitter':
      return [twitterCandidate(), openCliCandidate('twitter')];
    case 'reddit':
      return [openCliCandidate('reddit'), rdtCandidate()];
    case 'xiaohongshu':
      return [openCliCandidate('xiaohongshu'), xhsCandidate()];
    case 'facebook':
      return [openCliCandidate('facebook')];
    case 'instagram':
      return [openCliCandidate('instagram')];
    default:
      throw new Error(`Unsupported social platform: ${platform}`);
  }
}

function videoCandidates(platform: string): ExternalCandidate[] {
  switch (platform) {
    case 'youtube':
      return [youtubeCandidate()];
    case 'bilibili':
      return [biliCandidate(), openCliCandidate('bilibili')];
    default:
      throw new Error(`Unsupported video platform: ${platform}`);
  }
}

function twitterCandidate(): ExternalCandidate {
  return {
    name: 'twitter-cli',
    command: 'twitter',
    probeArgs: ['status'],
    setup: 'pipx install twitter-cli; set TWITTER_AUTH_TOKEN and TWITTER_CT0 if needed',
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '-n', limit];
        case 'read':
        case 'tweet': return ['tweet', publicUrlOrId(input)];
        case 'article': return ['article', publicUrlOrId(input)];
        case 'user': return ['user', requireString(input.user ?? input.username, 'user')];
        case 'user_posts': return ['user-posts', requireString(input.user ?? input.username, 'user'), '-n', limit];
        case 'feed': return ['feed', '-n', limit, ...(hotPopularFilter(input.filter) ? ['--filter'] : [])];
        default: throw new Error(`Unsupported twitter action: ${action}`);
      }
    },
  };
}

function openCliCandidate(platform: string): ExternalCandidate {
  return {
    name: 'OpenCLI',
    command: 'opencli',
    probeArgs: ['--help'],
    setup: `Install OpenCLI and login to ${platform} in Chrome`,
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      const base = [platform];
      switch (platform) {
        case 'twitter':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read' || action === 'tweet') return [...base, 'tweet', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'article') return [...base, 'article', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'user_posts') return [...base, 'user-posts', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          if (action === 'user') return [...base, 'user', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          break;
        case 'reddit':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read') return [...base, 'read', publicUrlOrId(input, 'id or url'), '-f', 'yaml'];
          if (action === 'feed') return [...base, 'home', '--limit', limit, '-f', 'yaml'];
          if (action === 'subreddit') return [...base, 'subreddit', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
          if (action === 'hot' || action === 'popular') return [...base, action, '--limit', limit, '-f', 'yaml'];
          if (action === 'subreddit_info') return [...base, 'subreddit-info', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
          break;
        case 'xiaohongshu':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read' || action === 'note') return [...base, 'note', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'comments') return [...base, 'comments', requireString(input.id, 'id'), '-f', 'yaml'];
          if (action === 'feed') return [...base, 'feed', '--limit', limit, '-f', 'yaml'];
          if (action === 'user') return [...base, 'user', requireString(input.user ?? input.userId, 'user'), '-f', 'yaml'];
          break;
        case 'facebook':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'profile') return [...base, 'profile', requireString(input.user ?? input.id, 'user or id'), '-f', 'yaml'];
          if (action === 'feed' || action === 'groups') return [...base, action, '--limit', limit, '-f', 'yaml'];
          break;
        case 'instagram':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'profile') return [...base, 'profile', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          if (action === 'user') return [...base, 'user', requireString(input.user ?? input.username, 'user'), '--limit', limit, '-f', 'yaml'];
          if (action === 'explore' || action === 'saved') return [...base, action, '--limit', limit, '-f', 'yaml'];
          break;
        case 'bilibili':
          if (action === 'transcript' || action === 'subtitle') return [...base, 'subtitle', publicUrlOrId(input)];
          break;
      }
      throw new Error(`Unsupported ${platform} action for OpenCLI: ${action}`);
    },
  };
}

function rdtCandidate(): ExternalCandidate {
  return {
    name: 'rdt-cli',
    command: 'rdt',
    probeArgs: ['status', '--json'],
    setup: "pipx install 'git+https://github.com/public-clis/rdt-cli.git' && rdt login",
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '--limit', limit];
        case 'read': return ['read', publicUrlOrId(input, 'id or url')];
        case 'feed': return ['feed', '--limit', limit];
        case 'subreddit': return ['sub', requireString(input.subreddit, 'subreddit'), '--limit', limit];
        case 'popular': return ['popular', '--limit', limit];
        case 'all': return ['all', '--limit', limit];
        default: throw new Error(`Unsupported rdt action: ${action}`);
      }
    },
  };
}

function xhsCandidate(): ExternalCandidate {
  return {
    name: 'xhs-cli',
    command: 'xhs',
    probeArgs: ['--help'],
    setup: 'Install xhs-cli; OpenCLI preferred for new installs',
    args(action, input) {
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query')];
        case 'read':
        case 'note': return ['read', publicUrlOrId(input)];
        case 'comments': return ['comments', publicUrlOrId(input)];
        case 'hot': return ['hot'];
        case 'feed': return ['feed'];
        default: throw new Error(`Unsupported xhs action: ${action}`);
      }
    },
  };
}

function youtubeCandidate(): ExternalCandidate {
  return {
    name: 'yt-dlp',
    command: 'yt-dlp',
    probeArgs: ['--version'],
    setup: 'pip install yt-dlp; install node or deno for YouTube JS challenge handling',
    args(action, input) {
      switch (action) {
        case 'search': return [`ytsearch${numberOrDefault(input.limit, 10)}:${requireString(input.query, 'query')}`, '--dump-json', '--flat-playlist'];
        case 'details': return ['--dump-json', '--skip-download', validatePublicHttpUrl(requireString(input.url, 'url'))];
        case 'transcript': return ['--skip-download', '--write-sub', '--write-auto-sub', '--sub-langs', String(input.language ?? 'en.*'), '--sub-format', 'vtt', '-o', `${requireString(input.outputDir, 'outputDir')}/%(id)s.%(ext)s`, validatePublicHttpUrl(requireString(input.url, 'url'))];
        default: throw new Error(`Unsupported youtube action: ${action}`);
      }
    },
  };
}

function biliCandidate(): ExternalCandidate {
  return {
    name: 'bili-cli',
    command: 'bili',
    probeArgs: ['--help'],
    setup: 'Install bili-cli. Do not use yt-dlp for Bilibili; current anti-bot blocks it.',
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '--type', 'video', '-n', limit];
        case 'hot': return ['hot', '-n', limit];
        case 'details':
        case 'video': return ['video', publicUrlOrId(input)];
        default: throw new Error(`Unsupported bili action: ${action}`);
      }
    },
  };
}

const SECRET_PATTERNS = [
  /Authorization:\s*(Bearer|token|Basic)\s+\S+/gi,
  /Set-Cookie:\s*\S+/gi,
  /Cookie:\s*\S+/gi,
  /(TWITTER_COOKIE|REDDIT_COOKIE|XHS_COOKIE|XIAOHONGSHU_COOKIE|BILIBILI_COOKIE|XUEQIU_COOKIE)[=:]\s*[^\n\r]+/gi,
  /(TWITTER_AUTH_TOKEN|TWITTER_CT0|BILIBILI_SESSDATA|BILIBILI_CSRF|GITHUB_TOKEN|GH_TOKEN|BRAVE_API_KEY|EXA_API_KEY|TAVILY_API_KEY|OPENCLI_TOKEN|REDDIT_CLIENT_SECRET|YOUTUBE_API_KEY|LISTENNOTES_API_KEY|PRODUCTHUNT_API_TOKEN|PATENTSVIEW_API_KEY|CRAWL4AI_API_TOKEN|DEEP_RESEARCH_API_TOKEN|SEARCH_LLM_API_TOKEN|EMBEDDING_SIDECAR_API_TOKEN|OPENAI_API_KEY|GROQ_API_KEY)[=:]\s*\S+/gi,
  /api[Kk]ey["']?\s*[:=]\s*["']?\S+/gi,
  /api_?key\s*[:=]\s*\S+/gi,
];

export function sanitizeExternalOutput(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      const sep = match.search(/[=:]\s*/);
      return sep >= 0 ? match.slice(0, sep + 1) + '***' : '***';
    });
  }
  return sanitized;
}

async function runFirstUsable(
  platform: string,
  candidates: ExternalCandidate[],
  action: string,
  input: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<CommandResult & { backend: string }> {
  const ordered = orderCandidates(platform, candidates, options.env ?? process.env);
  const failures: string[] = [];

  for (const candidate of ordered) {
    let commandArgs: string[];
    try {
      commandArgs = candidate.args(action, input);
    } catch (error) {
      failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const result = await runCommand(candidate.command, commandArgs, options, COMMAND_TIMEOUT_MS);
    if (result.code === 127) {
      failures.push(`${candidate.name}: not installed (${candidate.setup})`);
      continue;
    }
    if (result.code === 0) return { ...result, stdout: sanitizeExternalOutput(result.stdout), stderr: sanitizeExternalOutput(result.stderr), backend: candidate.name };
    failures.push(`${candidate.name}: exit ${result.code}: ${tail(sanitizeExternalOutput(result.stderr || result.stdout))}`);
  }

  throw new Error(`No usable ${platform} backend. ${failures.join('; ')}`);
}

async function runCommand(command: string, args: string[], options: ReachToolOptions, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      env: externalEnvironment(command, options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
    };
    const timer = setTimeout(terminate, timeoutMs);
    options.signal?.addEventListener('abort', terminate, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', terminate);
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', terminate);
      resolve({ code, stdout, stderr });
    });
  });
}

function orderedBackendMetadata(channel: ChannelDefinition, env: Record<string, string | undefined>): ChannelDefinition['backends'] {
  return orderByOverride(channel.name, channel.backends, env);
}

function orderCandidates(platform: string, candidates: ExternalCandidate[], env: Record<string, string | undefined>): ExternalCandidate[] {
  return orderByOverride(platform, candidates, env);
}

function orderByOverride<T extends { name: string }>(platform: string, candidates: T[], env: Record<string, string | undefined>): T[] {
  const override = env[`${platform.toUpperCase()}_BACKEND`] ?? env[`PI_SEARCH_${platform.toUpperCase()}_BACKEND`];
  if (!override) return candidates;
  const normalized = override.toLowerCase();
  const index = candidates.findIndex((candidate) => {
    const name = candidate.name.toLowerCase();
    return name === normalized || (normalized.length >= 3 && name.startsWith(normalized));
  });
  if (index < 0) return candidates;
  const ordered = [...candidates];
  ordered.unshift(...ordered.splice(index, 1));
  return ordered;
}

function probeArgs(backendName: string): string[] {
  if (backendName === 'twitter-cli') return ['status'];
  if (backendName === 'rdt-cli') return ['status', '--json'];
  if (backendName === 'yt-dlp') return ['--version'];
  return ['--help'];
}

function setupMessage(channel: ChannelDefinition): string {
  return channel.backends.map((backend) => `${backend.name}: ${backend.setup ?? 'built in'}`).join('; ');
}

function platformOrInfer(args: Record<string, unknown>, allowed: string[]): string {
  if (typeof args.platform === 'string' && allowed.includes(args.platform)) return args.platform;
  if (typeof args.url === 'string') {
    const host = safeHost(args.url);
    const inferred = [
      ['twitter', ['twitter.com', 'x.com']],
      ['reddit', ['reddit.com', 'redd.it']],
      ['v2ex', ['v2ex.com']],
      ['xiaohongshu', ['xiaohongshu.com', 'xhslink.com']],
      ['facebook', ['facebook.com', 'fb.com']],
      ['instagram', ['instagram.com']],
      ['youtube', ['youtube.com', 'youtu.be']],
      ['bilibili', ['bilibili.com', 'b23.tv']],
    ].find(([, hosts]) => (hosts as string[]).some((hostPart) => host.includes(hostPart)))?.[0];
    if (typeof inferred === 'string' && allowed.includes(inferred)) return inferred;
  }
  throw new Error(`platform is required. Expected one of: ${allowed.join(', ')}`);
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function topicIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /\/t\/(\d+)/.exec(value)?.[1];
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return boundedFetchJson(url, { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return boundedFetchText(url, { 'User-Agent': USER_AGENT }, signal);
}

function parseFeedItems(xml: string): Array<{ title: string; url: string; summary?: string | undefined }> {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlText(item, ['link']) ?? firstXmlText(item, ['guid']) ?? '',
      summary: firstXmlText(item, ['description', 'summary', 'content:encoded']),
    };
  });
  const atomItems = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlAttribute(item, 'link', 'href') ?? firstXmlText(item, ['id']) ?? '',
      summary: firstXmlText(item, ['summary', 'content']),
    };
  });
  return [...rssItems, ...atomItems].filter((item) => item.title || item.url);
}

function firstXmlText(xml: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = new RegExp(`<${tag.replace(':', '\\:')}[^>]*>([\\s\\S]*?)<\\/${tag.replace(':', '\\:')}>`, 'i').exec(xml);
    if (match?.[1]) return cleanXml(match[1]);
  }
  return undefined;
}

function firstXmlAttribute(xml: string, tag: string, attribute: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]+)"[^>]*>`, 'i').exec(xml);
  return match?.[1] ? cleanXml(match[1]) : undefined;
}

function cleanXml(text: string): string {
  return cleanText(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '));
}

function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSubtitleText(text: string): string {
  return text
    .replace(/^WEBVTT[\s\S]*?(?=\n\n)/, '')
    .replace(/^\d+$/gm, '')
    .replace(/^\d{2}:\d{2}:\d{2}[\s\S]*?$/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function publicUrlOrId(input: Record<string, unknown>, name = 'url or id'): string {
  if (typeof input.url === 'string') return validatePublicHttpUrl(input.url);
  return requireString(input.id, name);
}

function externalEnvironment(command: string, env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'GITHUB_TOKEN', 'GH_TOKEN', 'BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY',
    'REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT', 'YOUTUBE_API_KEY',
    'SEARXNG_BASE_URL', 'NITTER_BASE_URL', 'LISTENNOTES_API_KEY', 'PRODUCTHUNT_API_TOKEN',
    'PATENTSVIEW_API_KEY', 'CRAWL4AI_BASE_URL', 'CRAWL4AI_API_TOKEN',
    'DEEP_RESEARCH_BASE_URL', 'DEEP_RESEARCH_WORKER_BASE_URL', 'DEEP_RESEARCH_API_TOKEN',
    'DEEP_RESEARCH_MODEL', 'DEEP_RESEARCH_WORKER_MODEL',
    ...(command === 'twitter' ? ['TWITTER_AUTH_TOKEN', 'TWITTER_CT0', 'TWITTER_COOKIE'] : []),
    ...(command === 'rdt' ? ['REDDIT_COOKIE'] : []),
    ...(command === 'xhs' ? ['XHS_COOKIE', 'XIAOHONGSHU_COOKIE'] : []),
    ...(command === 'bili' ? ['BILIBILI_SESSDATA', 'BILIBILI_CSRF', 'BILIBILI_COOKIE'] : []),
    ...(command === 'opencli' ? ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN'] : []),
  ];
  const base = Object.fromEntries(allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key] as string]] : [])));
  return { ...cookieEnvironmentForCommand(command, env), ...base };
}

function cookieEnvironmentForCommand(command: string, env: Record<string, string | undefined>): Record<string, string> {
  if (command === 'twitter') return cookieAuthEnvironment('twitter', env);
  if (command === 'rdt') return cookieAuthEnvironment('reddit', env);
  if (command === 'xhs') return cookieAuthEnvironment('xiaohongshu', env);
  if (command === 'bili') return cookieAuthEnvironment('bilibili', env);
  return {};
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function tail(text: string): string {
  const cleaned = text.trim();
  return cleaned.length > 1000 ? cleaned.slice(-1000) : cleaned;
}

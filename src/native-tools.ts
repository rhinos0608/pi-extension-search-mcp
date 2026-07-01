import type { BackendCallResult } from './backend.js';

type NativeToolName = 'web_search' | 'semantic_crawl' | 'agentic_browse' | 'browse' | 'research' | 'research_sources' | 'github';

interface NativeToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface WebResult {
  title: string;
  url: string;
  snippet?: string | undefined;
}

const MAX_FETCH_CHARS = 1_000_000;

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions = {},
): Promise<BackendCallResult> {
  switch (name as NativeToolName) {
    case 'web_search':
      return webSearch(args, options);
    case 'semantic_crawl':
      return semanticCrawl(args, options);
    case 'agentic_browse':
      return agenticBrowse(args, options);
    case 'browse':
      return agenticBrowse({ action: 'read', ...args }, options);
    case 'research':
      return research(args, options);
    case 'research_sources':
      return research({ action: 'academic', ...args }, options);
    case 'github':
      return github(args, options);
    default:
      throw new Error(`Unsupported native tool: ${name}`);
  }
}

async function webSearch(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const query = requireString(args.query, 'query');
  const limit = numberOrDefault(args.limit, 8);
  const results = await searchDuckDuckGo(query, limit, options.signal);
  return textResult(formatWebResults(query, results), { query, results });
}

async function semanticCrawl(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const query = requireString(args.query, 'query');
  const topK = numberOrDefault(args.topK, 8);
  const maxPages = numberOrDefault(args.maxPages, 10);
  const source = asRecord(args.source);
  const urls = await semanticSourceUrls(source, query, maxPages, options.signal);
  const chunks: Array<{ url: string; title: string; content: string; score: number }> = [];

  for (const url of urls.slice(0, maxPages)) {
    try {
      const page = await fetchReadablePage(url, options.signal);
      for (const content of chunkText(page.content)) {
        chunks.push({ url: page.url, title: page.title, content, score: scoreText(content, query) });
      }
    } catch {
      // Ignore individual crawl failures; search/crawl tools should return partial evidence.
    }
  }

  const ranked = chunks.sort((a, b) => b.score - a.score).slice(0, topK);
  const text = ranked.length
    ? ranked.map((chunk, index) => `## ${index + 1}. ${chunk.title || chunk.url}\n${chunk.url}\n\n${chunk.content}`).join('\n\n')
    : `No crawl results for: ${query}`;

  return textResult(text, { query, results: ranked });
}

async function agenticBrowse(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'read';
  if (action !== 'read' && action !== 'browse') {
    throw new Error(`Native agentic_browse only supports read and browse actions, got: ${action}`);
  }

  const url = requireString(args.url, 'url');
  const maxChars = numberOrDefault(args.maxChars, 12000);
  const page = await fetchReadablePage(url, options.signal);
  const content = page.content.slice(0, maxChars);

  return textResult(content, {
    url: page.url,
    title: page.title,
    content,
    wordCount: wordCount(content),
    truncated: page.content.length > maxChars,
  });
}

async function research(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'academic';
  if (action !== 'academic') throw new Error(`Native research only supports academic action, got: ${action}`);

  const query = requireString(args.query, 'query');
  const source = typeof args.source === 'string' ? args.source : 'all';
  const limit = numberOrDefault(args.limit, 12);
  const results = await researchResults(query, source, limit, options.signal);
  const text = results.length
    ? results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet ?? ''}`).join('\n\n')
    : `No research results for: ${query}`;

  return textResult(text, { query, source, results });
}

async function github(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = requireString(args.action, 'action');
  const env = options.env ?? process.env;

  switch (action) {
    case 'repo':
      return githubRepo(args, env, options.signal);
    case 'file':
      return githubFile(args, env, options.signal);
    case 'list_dir':
      return githubFile(args, env, options.signal);
    case 'tree':
      return githubTree(args, env, options.signal);
    case 'search':
      return githubSearch(args, env, options.signal);
    case 'trending':
      return githubTrending(args, options.signal);
    case 'code_search':
      return githubCodeSearch(args, env, options.signal);
    default:
      throw new Error(`Unsupported github action: ${action}`);
  }
}

async function githubRepo(args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<BackendCallResult> {
  const repo = parseRepoArgs(args);
  const metadata = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, env, signal);
  const includeReadme = args.includeReadme !== false;
  let readme: unknown = null;
  if (includeReadme) {
    try {
      readme = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}/readme`, env, signal);
    } catch {
      readme = null;
    }
  }
  return jsonTextResult({ metadata, readme });
}

async function githubFile(args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<BackendCallResult> {
  const repo = parseRepoArgs(args);
  const path = typeof args.path === 'string' ? args.path.replace(/^\/+/, '') : '';
  const branch = typeof args.branch === 'string' ? args.branch : undefined;
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`);
  if (branch) url.searchParams.set('ref', branch);
  const data = await githubJson(url.href, env, signal);
  return jsonTextResult(data);
}

async function githubTree(args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<BackendCallResult> {
  const repo = parseRepoArgs(args);
  const ref = typeof args.branch === 'string' ? args.branch : typeof args.ref === 'string' ? args.ref : 'HEAD';
  const url = new URL(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(ref)}`);
  if (args.recursive === true) url.searchParams.set('recursive', '1');
  const data = await githubJson(url.href, env, signal);
  return jsonTextResult(data);
}

async function githubSearch(args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<BackendCallResult> {
  const query = requireString(args.query, 'query');
  const repo = optionalRepo(args);
  const language = typeof args.language === 'string' ? ` language:${args.language}` : '';
  const q = `${query}${repo ? ` repo:${repo.owner}/${repo.repo}` : ''}${language}`;
  const url = new URL('https://api.github.com/search/code');
  url.searchParams.set('q', q);
  url.searchParams.set('per_page', String(Math.min(numberOrDefault(args.topK ?? args.limit, 10), 50)));
  const data = await githubJson(url.href, env, signal);
  return jsonTextResult(data);
}

async function githubCodeSearch(args: Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<BackendCallResult> {
  return githubSearch({ ...args, query: args.query ?? '' }, env, signal);
}

async function githubTrending(args: Record<string, unknown>, signal?: AbortSignal): Promise<BackendCallResult> {
  const since = typeof args.since === 'string' ? args.since : 'daily';
  const html = await fetchText(`https://github.com/trending?since=${encodeURIComponent(since)}`, signal);
  const results = [...html.matchAll(/<h2[^>]*>\s*<a[^>]*href="\/([^\"]+)"[^>]*>/g)]
    .slice(0, numberOrDefault(args.limit, 10))
    .map((match) => ({ repository: match[1]?.replace(/\s/g, ''), url: `https://github.com/${match[1]?.replace(/\s/g, '')}` }));
  return jsonTextResult({ since, results });
}

async function semanticSourceUrls(source: Record<string, unknown>, query: string, maxPages: number, signal?: AbortSignal): Promise<string[]> {
  if (source.type === 'url' && typeof source.url === 'string') return [source.url];
  const searchQuery = typeof source.query === 'string' ? source.query : query;
  const results = await searchDuckDuckGo(searchQuery, maxPages, signal);
  return results.map((result) => result.url).filter(Boolean);
}

async function researchResults(query: string, source: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const tasks: Array<Promise<WebResult[]>> = [];
  if (source === 'all' || source === 'wikipedia' || source === 'wikidata') tasks.push(searchWikipedia(query, limit, signal));
  if (source === 'all' || source === 'arxiv') tasks.push(searchArxiv(query, limit, signal));
  if (source === 'all' || source === 'crossref') tasks.push(searchCrossref(query, limit, signal));
  if (source === 'all' || source === 'hackernews') tasks.push(searchHackerNews(query, limit, signal));
  if (tasks.length === 0) tasks.push(searchDuckDuckGo(`${source} ${query}`, limit, signal));
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : [])).slice(0, limit);
}

async function searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://api.duckduckgo.com/');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  const data = await fetchJson(url.href, signal) as Record<string, unknown>;
  const related = flattenDuckDuckGoTopics(data.RelatedTopics).slice(0, limit);
  const heading = typeof data.Heading === 'string' ? data.Heading : '';
  const abstractUrl = typeof data.AbstractURL === 'string' ? data.AbstractURL : '';
  const abstractText = typeof data.AbstractText === 'string' ? data.AbstractText : '';
  const results = [
    ...(abstractUrl ? [{ title: heading || query, url: abstractUrl, snippet: abstractText }] : []),
    ...related,
  ].slice(0, limit);
  return results.length ? results : searchDuckDuckGoHtml(query, limit, signal);
}

async function searchDuckDuckGoHtml(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const html = await fetchText(url.href, signal);
  return [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => ({
      title: stripHtml(match[2] ?? ''),
      url: decodeDuckDuckGoUrl(match[1] ?? ''),
      snippet: stripHtml(match[3] ?? ''),
    }))
    .filter((result) => result.url)
    .slice(0, limit);
}

async function searchWikipedia(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.searchParams.set('action', 'opensearch');
  url.searchParams.set('search', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('namespace', '0');
  url.searchParams.set('format', 'json');
  const data = await fetchJson(url.href, signal) as unknown[];
  const titles = Array.isArray(data[1]) ? data[1] as string[] : [];
  const snippets = Array.isArray(data[2]) ? data[2] as string[] : [];
  const urls = Array.isArray(data[3]) ? data[3] as string[] : [];
  return titles.map((title, index) => ({ title, snippet: snippets[index], url: urls[index] ?? '' })).filter((item) => item.url);
}

async function searchArxiv(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://export.arxiv.org/api/query');
  url.searchParams.set('search_query', `all:${query}`);
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(limit));
  const xml = await fetchText(url.href, signal);
  return [...xml.matchAll(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<id>(.*?)<\/id>[\s\S]*?<summary>([\s\S]*?)<\/summary>/g)]
    .map((match) => ({ title: cleanText(match[1] ?? ''), url: cleanText(match[2] ?? ''), snippet: cleanText(match[3] ?? '') }))
    .slice(0, limit);
}

async function searchCrossref(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(limit));
  const data = await fetchJson(url.href, signal) as { message?: { items?: Array<Record<string, unknown>> } };
  return (data.message?.items ?? []).map((item) => {
    const title = Array.isArray(item.title) && typeof item.title[0] === 'string' ? item.title[0] : 'Untitled';
    const doi = typeof item.DOI === 'string' ? item.DOI : '';
    const urlValue = typeof item.URL === 'string' ? item.URL : doi ? `https://doi.org/${doi}` : '';
    return { title, url: urlValue, snippet: doi };
  }).filter((item) => item.url);
}

async function searchHackerNews(query: string, limit: number, signal?: AbortSignal): Promise<WebResult[]> {
  const url = new URL('https://hn.algolia.com/api/v1/search');
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', String(limit));
  const data = await fetchJson(url.href, signal) as { hits?: Array<Record<string, unknown>> };
  return (data.hits ?? []).map((hit) => ({
    title: typeof hit.title === 'string' ? hit.title : 'Untitled',
    url: typeof hit.url === 'string' ? hit.url : `https://news.ycombinator.com/item?id=${String(hit.objectID ?? '')}`,
    snippet: `HN points: ${String(hit.points ?? 0)}`,
  }));
}

async function fetchReadablePage(rawUrl: string, signal?: AbortSignal): Promise<{ url: string; title: string; content: string }> {
  const url = validatePublicHttpUrl(rawUrl);
  const html = await fetchText(url, signal);
  const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
  return { url, title, content: stripHtml(html) };
}

async function githubJson(url: string, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'pi-extension-search',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const response = await fetch(url, fetchInit(headers, signal));
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(validatePublicHttpUrl(url), fetchInit({ 'User-Agent': 'pi-extension-search' }, signal));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(validatePublicHttpUrl(url), fetchInit({ 'User-Agent': 'pi-extension-search' }, signal));
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.text()).slice(0, MAX_FETCH_CHARS);
}

function fetchInit(headers: Record<string, string>, signal: AbortSignal | undefined): RequestInit {
  return {
    headers,
    ...(signal ? { signal } : {}),
  };
}

function validatePublicHttpUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  const host = url.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host === '169.254.169.254' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new Error(`Disallowed private or local host: ${host}`);
  }
  return url.href;
}

function stripHtml(html: string): string {
  return cleanText(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '));
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

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 2000) chunks.push(text.slice(index, index + 2000));
  return chunks;
}

function scoreText(text: string, query: string): number {
  const lower = text.toLowerCase();
  return query.toLowerCase().split(/\W+/).filter(Boolean).reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function decodeDuckDuckGoUrl(raw: string): string {
  const decoded = raw.replace(/&amp;/g, '&');
  try {
    const url = new URL(decoded, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') ?? url.href;
  } catch {
    return decoded;
  }
}

function flattenDuckDuckGoTopics(value: unknown): WebResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (Array.isArray(record.Topics)) return flattenDuckDuckGoTopics(record.Topics);
    const text = typeof record.Text === 'string' ? record.Text : '';
    const url = typeof record.FirstURL === 'string' ? record.FirstURL : '';
    return url ? [{ title: text.split(' - ')[0] ?? text, url, snippet: text }] : [];
  });
}

function formatWebResults(query: string, results: WebResult[]): string {
  if (results.length === 0) return `No web results for: ${query}`;
  return results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet ?? ''}`).join('\n\n');
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

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function parseRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } {
  const parsed = optionalRepo(args);
  if (!parsed) throw new Error('owner/repo or repository is required');
  return parsed;
}

function optionalRepo(args: Record<string, unknown>): { owner: string; repo: string } | undefined {
  if (typeof args.repository === 'string') {
    const cleaned = args.repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
    const [owner, repo] = cleaned.split('/');
    if (owner && repo) return { owner, repo };
  }
  if (typeof args.owner === 'string' && typeof args.repo === 'string') return { owner: args.owner, repo: args.repo };
  return undefined;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

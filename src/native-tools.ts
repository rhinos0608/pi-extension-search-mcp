import type { BackendCallResult } from './backend.js';
import { fetchInit, fetchJson, fetchText, safeResponseJson, safeResponseText, unsafeFetchJson, validatePublicHttpUrl } from './http.js';
import { normalizeUrl, rrfMerge } from './fusion.js';
import { retryWithBackoff } from './retry.js';
import { dedupeBy, dedupeByUrl, guardResult, jsonTextResult, textResult } from './tool-output.js';
import { callReachTool } from './reach-tools.js';

type NativeToolName = 'web_search' | 'semantic_crawl' | 'fetch' | 'agentic_browse' | 'browse' | 'research' | 'research_sources' | 'github';

interface NativeToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface WebResult {
  title: string;
  url: string;
  snippet?: string | undefined;
  source?: string | undefined;
  rrfScore?: number | undefined;
}

interface WebSearchBackend {
  name: string;
  configured: (env: Record<string, string | undefined>) => boolean;
  search: (query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<WebResult[]>;
}

const WEB_SEARCH_LIMIT_MAX = 20;
const RESEARCH_LIMIT_MAX = 30;
const SEMANTIC_TOP_K_MAX = 20;
const SEMANTIC_MAX_PAGES_MAX = 25;

const SEARCH_BACKENDS: WebSearchBackend[] = [
  { name: 'duckduckgo', configured: () => true, search: (query, limit, _env, signal) => searchDuckDuckGo(query, limit, signal) },
  { name: 'searxng', configured: (env) => Boolean(env.SEARXNG_BASE_URL?.trim()), search: searchSearxng },
  { name: 'brave', configured: (env) => Boolean(env.BRAVE_API_KEY?.trim()), search: searchBrave },
  { name: 'exa', configured: (env) => Boolean(env.EXA_API_KEY?.trim()), search: searchExa },
  { name: 'tavily', configured: (env) => Boolean(env.TAVILY_API_KEY?.trim()), search: searchTavily },
  { name: 'ollama-search', configured: (env) => Boolean((env.OLLAMA_SEARCH_BASE_URL ?? env.SEARCH_OLLAMA_BASE_URL)?.trim()), search: searchOllama },
];

const CATEGORY_HINTS: Record<string, string> = {
  company: 'official website leadership funding product pricing',
  'research paper': 'paper arxiv doi citation pdf',
  news: 'latest news report analysis',
  pdf: 'filetype:pdf',
  github: 'site:github.com repository source code',
  tweet: 'site:x.com OR site:twitter.com tweet thread',
  'personal site': 'personal website blog about',
  people: 'profile biography linkedin personal site',
  'financial report': 'annual report 10-k investor relations earnings',
};

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions = {},
): Promise<BackendCallResult> {
  const reachResult = await callReachTool(name, args, options);
  if (reachResult) return reachResult;

  return guardResult(await dispatchNativeTool(name, args, options), { env: options.env });
}

async function dispatchNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions,
): Promise<BackendCallResult> {
  switch (name as NativeToolName) {
    case 'web_search':
      return webSearch(args, options);
    case 'semantic_crawl':
      return semanticCrawl(args, options);
    case 'fetch':
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
  const category = typeof args.category === 'string' ? args.category : undefined;
  const effectiveQuery = category && CATEGORY_HINTS[category] ? `${query} ${CATEGORY_HINTS[category]}` : query;
  const limit = clampedNumber(args.limit, 8, 1, WEB_SEARCH_LIMIT_MAX);
  const env = options.env ?? process.env;
  const requested = parseBackendOverride(env.PI_SEARCH_WEB_BACKENDS ?? env.SEARCH_WEB_BACKENDS);
  const unknownBackends = requested.filter((name) => !SEARCH_BACKENDS.some((backend) => backend.name === name));
  if (unknownBackends.length > 0) {
    throw new Error(`No known web search backends requested: ${unknownBackends.join(', ')}`);
  }
  const candidates = requested.length
    ? SEARCH_BACKENDS.filter((backend) => requested.includes(backend.name))
    : SEARCH_BACKENDS;
  const backends = candidates.filter((backend) => backend.configured(env));
  if (requested.length > 0 && backends.length === 0) {
    throw new Error(`Requested web search backends are not configured: ${requested.join(', ')}`);
  }
  const failures: Array<{ backend: string; error: string }> = [];

  const settled = await Promise.allSettled(backends.map(async (backend) => {
    const results = await retryWithBackoff<WebResult[]>(
      () => backend.search(effectiveQuery, limit, env, options.signal),
      { maxAttempts: backend.name === 'duckduckgo' ? 1 : 2 },
    );
    return { backend: backend.name, results: results.map((result) => ({ ...result, source: result.source ?? backend.name })) };
  }));

  const rankings: WebResult[][] = [];
  const servedBackends: string[] = [];
  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') {
      servedBackends.push(item.value.backend);
      rankings.push(item.value.results);
      return;
    }
    failures.push({ backend: backends[index]?.name ?? 'unknown', error: item.reason instanceof Error ? item.reason.message : String(item.reason) });
  });

  const fused = rrfMerge(rankings, { keyFn: (result) => normalizeUrl(result.url) })
    .slice(0, limit)
    .map(({ item, rrfScore }) => ({ ...item, rrfScore, title: item.title || item.url, snippet: item.snippet ?? '', source: item.source ?? 'unknown' }));

  if (fused.length === 0 && failures.length > 0) {
    throw new Error(`All web search backends failed: ${failures.map((failure) => `${failure.backend}: ${failure.error}`).join('; ')}`);
  }

  return textResult(formatWebResults(query, fused), {
    query,
    effectiveQuery,
    category,
    results: fused,
    fusion: { method: 'rrf', backends: servedBackends, failures, configuredBackends: backends.map((backend) => backend.name) },
  });
}

async function semanticCrawl(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const query = requireString(args.query, 'query');
  const topK = clampedNumber(args.topK, 8, 1, SEMANTIC_TOP_K_MAX);
  const maxPages = clampedNumber(args.maxPages, 10, 1, SEMANTIC_MAX_PAGES_MAX);
  const source = asRecord(args.source);
  const urls = dedupeBy(await semanticSourceUrls(source, query, maxPages, options.signal), normalizeUrl);
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

  const ranked = dedupeBy(chunks, (chunk) => chunk.content).sort((a, b) => b.score - a.score).slice(0, topK);
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
  const limit = clampedNumber(args.limit, 12, 1, RESEARCH_LIMIT_MAX);
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
  return dedupeByUrl(settled.flatMap((item) => (item.status === 'fulfilled' ? item.value : []))).slice(0, limit);
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

async function searchSearxng(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const baseUrl = env.SEARXNG_BASE_URL?.trim();
  if (!baseUrl) return [];
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('safesearch', '1');
  const data = await unsafeFetchJson(url.href, { Accept: 'application/json' }, signal) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.content, ''),
    source: 'searxng',
  })).filter((result) => result.url);
}

async function searchBrave(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.BRAVE_API_KEY?.trim();
  if (!apiKey) return [];
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(limit, 20)));
  const data = await fetchJson(url.href, { Accept: 'application/json', 'X-Subscription-Token': apiKey }, signal) as { web?: { results?: Array<Record<string, unknown>> } };
  return (data.web?.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.description, ''),
    source: 'brave',
  })).filter((result) => result.url);
}

async function searchExa(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.EXA_API_KEY?.trim();
  if (!apiKey) return [];
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    body: JSON.stringify({ query, numResults: limit, type: 'auto', useAutoprompt: true, contents: { text: true, highlights: true, summary: true } }),
    ...fetchInit({ Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': apiKey }, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Exa`);
  const data = await safeResponseJson(response, 'https://api.exa.ai/search') as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.summary, stringField(result.text, '')),
    source: 'exa',
  })).filter((result) => result.url);
}

async function searchTavily(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey) return [];
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    body: JSON.stringify({ query, max_results: Math.min(limit, 20), search_depth: 'basic', include_answer: 'basic', include_raw_content: false, include_images: false }),
    ...fetchInit({ Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Tavily`);
  const data = await safeResponseJson(response, 'https://api.tavily.com/search') as { answer?: string; results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result, index) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: index === 0 && data.answer ? `${data.answer}\n\n${stringField(result.content, '')}` : stringField(result.content, ''),
    source: 'tavily',
  })).filter((result) => result.url);
}

async function searchOllama(query: string, limit: number, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<WebResult[]> {
  const baseUrl = (env.OLLAMA_SEARCH_BASE_URL ?? env.SEARCH_OLLAMA_BASE_URL)?.trim();
  if (!baseUrl) return [];
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const apiKey = (env.OLLAMA_SEARCH_API_KEY ?? env.SEARCH_OLLAMA_API_KEY)?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const searchUrl = `${baseUrl.replace(/\/+$/, '')}/api/experimental/web_search`;
  const response = await fetch(searchUrl, {
    method: 'POST',
    body: JSON.stringify({ query, max_results: limit }),
    ...fetchInit(headers, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Ollama search`);
  const data = await safeResponseJson(response, searchUrl) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).slice(0, limit).map((result) => ({
    title: stringField(result.title, 'Untitled'),
    url: stringField(result.url, ''),
    snippet: stringField(result.content, ''),
    source: 'ollama-search',
  })).filter((result) => result.url);
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
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${await safeResponseText(response, url, 4_000)}`);
  return safeResponseJson(response, url);
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(numberOrDefault(value, fallback)), min), max);
}

function parseBackendOverride(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean) ?? [];
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
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

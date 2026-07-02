import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { createSearchBackend, resultToText, type SearchBackend } from './backend.js';
import { normalizeProviderPayload } from './payload.js';
import { registerGitHubTool } from './github.js';

const searchCategoryNames = [
  'company',
  'research paper',
  'news',
  'pdf',
  'github',
  'tweet',
  'personal site',
  'people',
  'financial report',
] as const;

const researchSources = [
  'all',
  'arxiv',
  'semantic_scholar',
  'openalex',
  'crossref',
  'pubmed',
  'wikipedia',
  'hackernews',
  'stackoverflow',
  'datacite',
  'ror',
  'gdelt',
  'wikidata',
] as const;

const reachFamilies = ['social', 'video', 'feeds', 'web', 'dev', 'research'] as const;
const socialPlatforms = ['twitter', 'reddit', 'v2ex', 'xiaohongshu', 'facebook', 'instagram'] as const;
const videoPlatforms = ['youtube', 'bilibili'] as const;

export default function (pi: ExtensionAPI): void {
  const client = createSearchBackend(process.env);

  pi.on('session_shutdown', () => {
    void client.close();
  });

  pi.on('before_provider_request', (event) => {
    event.payload = normalizeProviderPayload(event.payload);
  });

  registerGitHubTool(pi, client);
  registerExpansionTools(pi, client);

  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web via search-mcp and return collated source findings.',
    promptSnippet: 'Search the public web for current sources and citations.',
    promptGuidelines: ['Use web_search when broad source discovery is needed before deeper retrieval.'],
    parameters: Type.Object({
      query: Type.String({ description: 'Search query.' }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: 'Maximum results, default 8.' })),
      category: Type.Optional(StringEnum(searchCategoryNames)),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'web_search', {
        query: params.query,
        limit: params.limit ?? 8,
        resultFormat: 'collated',
        ...(params.category ? { category: params.category } : {}),
      }, signal, 120_000);
    },
  });

  pi.registerTool({
    name: 'semantic_crawl',
    label: 'Semantic Crawl',
    description: 'Crawl a URL or web-search-derived corpus with search-mcp semantic retrieval.',
    promptSnippet: 'Retrieve semantically relevant passages from a target URL or discovered source corpus.',
    promptGuidelines: ['Use semantic_crawl after web_search identifies a target source or domain.'],
    parameters: Type.Object({
      query: Type.String({ description: 'Question or retrieval query.' }),
      url: Type.Optional(Type.String({ description: 'Specific URL to crawl. Preferred when known.' })),
      searchQuery: Type.Optional(Type.String({ description: 'Discovery query when no URL is known.' })),
      topK: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: 'Relevant chunks to return, default 8.' })),
      maxPages: Type.Optional(Type.Number({ minimum: 1, maximum: 25, description: 'Maximum pages to crawl, default 10.' })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const source = buildSemanticSource(params.url, params.searchQuery);

      return callSearchMcpTool(client, 'semantic_crawl', {
        source,
        query: params.query,
        topK: params.topK ?? 8,
        maxPages: params.maxPages ?? 10,
        maxDepth: source.type === 'url' ? 1 : 0,
      }, signal, 300_000);
    },
  });

  pi.registerTool({
    name: 'browse',
    label: 'Browse',
    description: 'Fetch a URL and return its readable text content.',
    promptSnippet: 'Read the content of a web page by URL.',
    promptGuidelines: ['Use browse to read a specific URL and extract its text content.'],
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch.' }),
      maxChars: Type.Optional(Type.Number({ minimum: 1, maximum: 50000, description: 'Maximum characters to return, default 12000.' })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'agentic_browse', buildBrowseArgs(params), signal, 120_000);
    },
  });

  pi.registerTool({
    name: 'research_sources',
    label: 'Research Sources',
    description: 'Search academic, public-data, Wikipedia, Hacker News, and Stack Overflow sources through search-mcp.',
    promptSnippet: 'Search scholarly, technical, public-data, and community sources.',
    promptGuidelines: ['Use research_sources when the user needs research literature, technical discussions, or public knowledge sources.'],
    parameters: Type.Object({
      query: Type.String({ description: 'Research query.' }),
      source: Type.Optional(StringEnum(researchSources)),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30, description: 'Maximum results, default 12.' })),
      yearFrom: Type.Optional(Type.Number({ minimum: 1900, maximum: 2099, description: 'Earliest publication year.' })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'research', {
        action: 'academic',
        query: params.query,
        source: params.source ?? 'all',
        limit: params.limit ?? 12,
        ...(params.yearFrom ? { yearFrom: params.yearFrom } : {}),
      }, signal, 120_000);
    },
  });
}

async function callSearchMcpTool(
  client: SearchBackend,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  timeout?: number,
): Promise<AgentToolResult<unknown>> {
  const result = await client.callTool(name, args, {
    ...(signal ? { signal } : {}),
    ...(timeout ? { timeout } : {}),
  });

  return {
    content: [{ type: 'text', text: resultToText(result) }],
    details: result,
  };
}

function registerExpansionTools(pi: ExtensionAPI, client: SearchBackend): void {
  pi.registerTool({
    name: 'reach_status',
    label: 'Reach Status',
    description: 'Inspect native and external internet capability channels, ordered backends, and active backend health.',
    promptSnippet: 'Check which internet capability channels and external backends are available.',
    promptGuidelines: ['Run reach_status before using login-backed social/video platforms or when a backend fails.'],
    parameters: Type.Object({
      family: Type.Optional(StringEnum(reachFamilies)),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'reach_status', {
        ...(params.family ? { family: params.family } : {}),
      }, signal, 60_000);
    },
  });

  pi.registerTool({
    name: 'social',
    label: 'Social',
    description: 'Read and search social/community platforms using native public APIs or ordered external backends.',
    promptSnippet: 'Search/read Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, and Instagram.',
    promptGuidelines: [
      'Use social for platform-specific public discussion research.',
      'Run reach_status first for login-backed platforms; V2EX is zero-config native.',
      'Prefer read-only actions; do not post, like, comment, or mutate accounts.',
    ],
    parameters: Type.Object({
      platform: Type.Optional(StringEnum(socialPlatforms)),
      action: Type.Optional(Type.String({ description: 'Platform action, e.g. search, read, user, user_posts, feed, hot, popular, subreddit, node, topic, replies, comments.' })),
      query: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      user: Type.Optional(Type.String()),
      username: Type.Optional(Type.String()),
      subreddit: Type.Optional(Type.String()),
      node: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'social', params, signal, 180_000);
    },
  });

  pi.registerTool({
    name: 'video',
    label: 'Video',
    description: 'Search/read video platforms and extract metadata or subtitles through ordered backends.',
    promptSnippet: 'Use YouTube or Bilibili backends for video metadata, search, and subtitles.',
    promptGuidelines: [
      'Use video for YouTube metadata/subtitles and Bilibili search/details/subtitles.',
      'Do not use yt-dlp for Bilibili; bili-cli/OpenCLI backends are preferred.',
    ],
    parameters: Type.Object({
      platform: Type.Optional(StringEnum(videoPlatforms)),
      action: Type.Optional(Type.String({ description: 'search, details, transcript, hot, video, subtitle.' })),
      query: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      language: Type.Optional(Type.String({ description: 'Subtitle language pattern for YouTube transcript, default en.*.' })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'video', params, signal, 300_000);
    },
  });

  pi.registerTool({
    name: 'feeds',
    label: 'Feeds',
    description: 'Read RSS or Atom feeds and return recent entries.',
    promptSnippet: 'Read RSS/Atom subscriptions and summarize recent entries.',
    promptGuidelines: ['Use feeds for RSS/Atom URLs instead of generic browse.'],
    parameters: Type.Object({
      url: Type.String({ description: 'RSS or Atom feed URL.' }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: 'Maximum entries, default 20.' })),
    }),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      return callSearchMcpTool(client, 'feeds', params, signal, 120_000);
    },
  });
}

export function buildBrowseArgs(params: { url: string; maxChars?: number }): Record<string, unknown> {
  return {
    action: 'read',
    url: params.url,
    maxChars: params.maxChars ?? 12000,
  };
}

export function buildSemanticSource(url: string | undefined, searchQuery: string | undefined): Record<string, unknown> {
  if (url?.trim()) return { type: 'url', url: url.trim() };
  if (searchQuery?.trim()) return { type: 'search', query: searchQuery.trim(), maxSeedUrls: 8 };

  throw new Error('Provide either url or searchQuery.');
}

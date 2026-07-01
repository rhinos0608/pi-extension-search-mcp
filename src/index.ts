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

export default function (pi: ExtensionAPI): void {
  const client = createSearchBackend(process.env);

  pi.on('session_shutdown', () => {
    void client.close();
  });

  pi.on('before_provider_request', (event) => {
    event.payload = normalizeProviderPayload(event.payload);
  });

  registerGitHubTool(pi, client);

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
      }, signal);
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
      return callSearchMcpTool(client, 'agentic_browse', buildBrowseArgs(params), signal);
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
      }, signal);
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

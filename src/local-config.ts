import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_SEARCH_MCP_CONFIG_PATH = '/Users/rhinesharar/search-mcp/config.json';

type JsonObject = Record<string, unknown>;

const mappings: Array<[string, string]> = [
  ['brave.apiKey', 'BRAVE_API_KEY'],
  ['exa.apiKey', 'EXA_API_KEY'],
  ['tavily.apiKey', 'TAVILY_API_KEY'],
  ['github.token', 'GITHUB_TOKEN'],
  ['reddit.clientId', 'REDDIT_CLIENT_ID'],
  ['reddit.clientSecret', 'REDDIT_CLIENT_SECRET'],
  ['reddit.userAgent', 'REDDIT_USER_AGENT'],
  ['youtube.apiKey', 'YOUTUBE_API_KEY'],
  ['searxng.baseUrl', 'SEARXNG_BASE_URL'],
  ['nitter.baseUrl', 'NITTER_BASE_URL'],
  ['listennotes.apiKey', 'LISTENNOTES_API_KEY'],
  ['producthunt.apiToken', 'PRODUCTHUNT_API_TOKEN'],
  ['patentsview.apiKey', 'PATENTSVIEW_API_KEY'],
  ['crawl4ai.baseUrl', 'CRAWL4AI_BASE_URL'],
  ['crawl4ai.apiToken', 'CRAWL4AI_API_TOKEN'],
  ['deepResearch.baseUrl', 'DEEP_RESEARCH_BASE_URL'],
  ['deepResearch.workerBaseUrl', 'DEEP_RESEARCH_WORKER_BASE_URL'],
  ['deepResearch.apiToken', 'DEEP_RESEARCH_API_TOKEN'],
  ['deepResearch.model', 'DEEP_RESEARCH_MODEL'],
  ['deepResearch.workerModel', 'DEEP_RESEARCH_WORKER_MODEL'],
  ['embeddingSidecar.provider', 'EMBEDDING_SIDECAR_PROVIDER'],
  ['embeddingSidecar.baseUrl', 'EMBEDDING_SIDECAR_BASE_URL'],
  ['embeddingSidecar.apiToken', 'EMBEDDING_SIDECAR_API_TOKEN'],
  ['embeddingSidecar.dimensions', 'EMBEDDING_SIDECAR_DIMENSIONS'],
  ['embeddingSidecar.codeModel', 'EMBEDDING_SIDECAR_CODE_MODEL'],
  ['llm.provider', 'SEARCH_LLM_PROVIDER'],
  ['llm.apiToken', 'SEARCH_LLM_API_TOKEN'],
  ['llm.baseUrl', 'SEARCH_LLM_BASE_URL'],
  ['ollamaSearch.baseUrl', 'OLLAMA_SEARCH_BASE_URL'],
  ['ollamaSearch.apiKey', 'OLLAMA_SEARCH_API_KEY'],
  ['browser.executablePath', 'BROWSER_EXECUTABLE_PATH'],
  ['browser.proxyServer', 'BROWSER_PROXY_SERVER'],
  ['browser.cdpEndpoint', 'BROWSER_CDP_ENDPOINT'],
  ['browser.profileDir', 'BROWSER_PROFILE_DIR'],
];

export function loadSearchMcpEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const configPath = env.SEARCH_MCP_CONFIG_PATH?.trim() || DEFAULT_SEARCH_MCP_CONFIG_PATH;
  const config = readJsonConfig(configPath);
  if (!config) return env;

  const merged: Record<string, string | undefined> = { ...env, SEARCH_MCP_CONFIG_PATH: configPath };
  for (const [path, key] of mappings) {
    if (merged[key]) continue;
    const value = valueAtPath(config, path);
    if (isUsableScalar(value)) merged[key] = String(value);
  }
  return merged;
}

export function loadedConfigSummary(env: Record<string, string | undefined>): { path: string; loaded: boolean; mappedKeys: string[] } {
  const configPath = env.SEARCH_MCP_CONFIG_PATH?.trim() || DEFAULT_SEARCH_MCP_CONFIG_PATH;
  const config = readJsonConfig(configPath);
  if (!config) return { path: configPath, loaded: false, mappedKeys: [] };
  return {
    path: configPath,
    loaded: true,
    mappedKeys: mappings.flatMap(([path, key]) => (isUsableScalar(valueAtPath(config, path)) ? [key] : [])),
  };
}

function readJsonConfig(path: string): JsonObject | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

function valueAtPath(root: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    return (current as JsonObject)[segment];
  }, root);
}

function isUsableScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 && trimmed !== 'null' && trimmed !== 'undefined';
  }
  return typeof value === 'number' || typeof value === 'boolean';
}

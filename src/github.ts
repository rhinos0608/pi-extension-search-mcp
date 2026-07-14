import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { resultToText, type SearchBackend } from './backend.js';
import { guardText } from './tool-output.js';

const githubActions = [
  'repo',
  'file',
  'list_dir',
  'tree',
  'search',
  'trending',
  'code_search',
] as const;

export function registerGitHubTool(pi: ExtensionAPI, client: SearchBackend, env?: Record<string, string | undefined>): void {
  pi.registerTool({
    name: 'github',
    label: 'GitHub',
    description:
      'Work with GitHub repositories, files, directory trees, code search, trending repos, ' +
      'and semantic code search. Choose the `action` field to select what to do: ' +
      '`repo` for metadata + README, `file` for reading a known file, `list_dir` for listing a ' +
      'directory, `tree` for full tree listing, ' +
      '`search` for GitHub code search (routes to semantic code search when repo is specified), ' +
      '`trending` for trending repos (no auth needed), ' +
      'and `code_search` for AST-aware semantic code retrieval using embeddings and tree-sitter.',
    promptSnippet:
      'Query or explore GitHub repositories, files, and codebases with optional semantic ranking.',
    promptGuidelines: [
      'Use github with action=repo to understand what a repository is about.',
      'Use action=file or action=list_dir to read specific files or browse directories.',
      'Use action=search to find code across GitHub or within a specific repo.',
      'Use action=code_search for deep semantic code search within a repository (requires EMBEDDING_SIDECAR_BASE_URL).',
      'Use action=trending to discover currently popular repositories.',
    ],
    parameters: Type.Object({
      action: StringEnum(githubActions, {
        description:
          'github action: repo, file, list_dir, tree, search, trending, code_search',
      }),

      // -- repo / file / list_dir / tree / code_search --
      owner: Type.Optional(Type.String({
        description: 'GitHub username or organisation.',
      })),
      repo: Type.Optional(Type.String({
        description: 'Repository name (owner/repo form also accepted for code_search).',
      })),
      repository: Type.Optional(Type.String({
        description:
          'Repository as "owner/repo" string or GitHub URL. Alternative to owner+repo fields.',
      })),

      // -- file --
      path: Type.Optional(Type.String({
        description: 'File or directory path within the repo.',
      })),
      branch: Type.Optional(Type.String({
        description: 'Git ref (branch, tag, or commit SHA).',
      })),

      // -- file: raw content options --
      raw: Type.Optional(Type.Boolean({
        description: 'true = decoded UTF-8 text (default); false = base64.',
      })),
      offset: Type.Optional(Type.Number({
        description: 'Line offset (0-based). Requires raw=true.',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Maximum lines to return (file) or max items (tree/list_dir).',
      })),
      byteOffset: Type.Optional(Type.Number({
        description: 'Byte offset (0-based) via Range header. Requires raw=true.',
      })),
      byteLimit: Type.Optional(Type.Number({
        description: 'Maximum bytes via Range header. Requires raw=true.',
      })),

      // -- tree --
      recursive: Type.Optional(Type.Boolean({
        description: 'Return full recursive tree (default false).',
      })),
      includeMonorepo: Type.Optional(Type.Boolean({
        description: 'Auto-detect monorepo structure. Defaults true when path is empty.',
      })),

      // -- repo: include readme --
      includeReadme: Type.Optional(Type.Boolean({
        description: 'Fetch and include the raw README content (default true).',
      })),

      // -- search --
      query: Type.Optional(Type.String({
        description: 'Search term (GitHub code-search syntax) or semantic query.',
      })),
      language: Type.Optional(Type.String({
        description: 'Filter by language (e.g. "typescript", "python").',
      })),

      // -- trending --
      since: Type.Optional(StringEnum(['daily', 'weekly', 'monthly'], {
        description: 'Time window for trending: daily | weekly | monthly.',
      })),

      // -- code_search --
      ref: Type.Optional(Type.String({
        description: 'Git ref, branch, tag, or commit SHA.',
      })),
      maxFiles: Type.Optional(Type.Number({
        description: 'Max files to collect (1-500, default 100).',
      })),
      fileFilter: Type.Optional(Type.Array(Type.String(), {
        description: 'Path prefixes, substrings, or * globs to keep.',
      })),
      topK: Type.Optional(Type.Number({
        description: 'Number of code results to return (1-50, default 10).',
      })),
      profile: Type.Optional(StringEnum([
        'balanced',
        'lexical-heavy',
        'semantic-heavy',
        'high-precision',
        'fast',
        'precision',
        'recall',
      ], {
        description: 'Retrieval profile for code_search (default lexical-heavy).',
      })),
      includeContext: Type.Optional(Type.Boolean({
        description: 'Include source code text in code_search results (default false).',
      })),
    }),

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const { action, ...rest } = params;

      const args: Record<string, unknown> = { action };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) {
          args[key] = value;
        }
      }

      const result = await client.callTool('github', args, {
        ...(signal ? { signal } : {}),
        timeout: 300_000,
      });

      return {
        content: [{ type: 'text', text: guardText(resultToText(result), { env }) }],
        details: result,
      };
    },
  });
}

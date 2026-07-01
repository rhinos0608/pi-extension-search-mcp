# Local Recon: pi-extension-search-mcp

## Summary

Thin Pi extension wrapping `search-mcp` MCP server via stdio. Five tools: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github` — all delegate to an external MCP process. No local git repo. No uncommitted changes found. Project is clean, small, and tightly scoped.

## Files Retrieved

1. **`package.json`** (lines 1-27) — Package manifest: `@search-mcp/pi-extension` v0.1.0, ESM, Pi extension entry `./src/index.ts`, deps on `pi-ai`, `pi-coding-agent`, `@modelcontextprotocol/sdk`, `typebox`.
2. **`tsconfig.json`** (lines 1-26) — Strict TS config: ES2022 target, NodeNext module, strict mode, no unchecked index access.
3. **`src/index.ts`** (lines 1-165) — Main extension entry. Registers 5 tools + lifecycle hooks (`session_shutdown`, `before_provider_request`). Entry point for Pi.
4. **`src/mcp-client.ts`** (lines 1-135) — MCP client wrapper: `SearchMcpClient` class, `buildServerParameters`, `resultToText`, helpers.
5. **`src/github.ts`** (lines 1-158) — `github` tool definition with 7 action types and extensive parameter schema.
6. **`src/payload.ts`** (lines 1-32) — `normalizeProviderPayload` for instruction format normalization.
7. **`test/mcp-client.test.ts`** (lines 1-42) — 4 tests for `buildServerParameters` and `resultToText`.
8. **`test/index.test.ts`** (lines 1-20) — 2 tests for `buildBrowseArgs`.
9. **`test/payload.test.ts`** (lines 1-22) — 3 tests for `normalizeProviderPayload`.
10. **`README.md`** (lines 1-44) — Usage docs, env var overrides (`SEARCH_MCP_COMMAND`, `SEARCH_MCP_ARGS_JSON`, `SEARCH_MCP_CWD`).
11. **`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`** — `ExtensionAPI` interface (line 808) and `ToolDefinition` (line 335). Core extension API contract.
12. **`.gitignore`** (lines 1-2) — `node_modules/` and `dist/`.

## Key Code

### Extension entry (`src/index.ts`, lines 36-131)

```ts
export default function (pi: ExtensionAPI): void {
  const client = new SearchMcpClient(buildServerParameters(process.env));
  pi.on('session_shutdown', () => { void client.close(); });
  pi.on('before_provider_request', (event) => normalizeProviderPayload(event.payload));
  registerGitHubTool(pi, client);
  // registers: web_search, semantic_crawl, browse, research_sources
}
```

All tools delegate to `callSearchMcpTool()` (line 133) which calls `client.callTool()` and maps result to `AgentToolResult`.

### MCP client (`src/mcp-client.ts`, lines 44-94)

`SearchMcpClient` wraps `@modelcontextprotocol/sdk`:
- Lazy singleton connection via `connect()` / `createConnection()` (line 72-93)
- Spawns `search-mcp` binary as stdio subprocess via `StdioClientTransport`
- Default binary: `/Users/rhinesharar/.pi/agent/bin/search-mcp` (hardcoded, line 7)
- `callTool()` timeout defaults to 120s, configurable per call
- `close()` tears down transport and clears connection state

### ExtensionAPI contract (`types.d.ts`, lines 808-840)

```ts
interface ExtensionAPI {
  on(event: "session_shutdown" | "session_start" | "before_provider_request" | ...): void;
  registerTool<TParams, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>): void;
  // also: registerCommand, registerShortcut, registerFlag, sendMessage, exec, ...
}
```

### ToolDefinition (`types.d.ts`, lines 335-366)

```ts
interface ToolDefinition<TParams, TDetails, TState> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TSchema;  // TypeBox schema
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
  // optional: renderShell, prepareArguments, executionMode, renderCall, renderResult
}
```

### Tests

- `test/mcp-client.test.ts` — 4 tests: defaults, JSON args, invalid JSON, text serialization
- `test/index.test.ts` — 2 tests: `buildBrowseArgs` with/without maxChars
- `test/payload.test.ts` — 3 tests: string instructions preserved, object→text, array joined
- **No tests for actual tool execution, error paths, or MCP server interactions**
- **No integration/end-to-end tests**

## Architecture

```
┌─────────────┐     stdio transport      ┌─────────────┐
│  Pi Agent    │◄──────────────────────►│  search-mcp  │
│  (extension) │    MCP protocol         │  (binary)    │
└──────┬──────┘                          └─────────────┘
       │
       ├── src/index.ts          (default export, 5 tools)
       ├── src/mcp-client.ts     (SearchMcpClient wrapper)
       ├── src/github.ts         (github tool registration)
       └── src/payload.ts        (instruction normalization)
```

Data flow:
1. Pi loads extension via `package.json` → `"pi": { "extensions": ["./src/index.ts"] }`
2. Extension constructor creates `SearchMcpClient`, spawns `search-mcp` as child process
3. Each tool call routes through `callSearchMcpTool()` → `client.callTool()` → MCP SDK → stdio → `search-mcp`
4. Results formatted via `resultToText()` (text content items joined, others JSON-serialized)

## Constraints & Risks

| # | Constraint / Risk | File:Line | Severity |
|---|---|---|---|
| 1 | **Hardcoded binary path**: `DEFAULT_SEARCH_MCP_COMMAND` = `/Users/rhinesharar/.pi/agent/bin/search-mcp`. Non-portable. Breaks on other machines. | `src/mcp-client.ts:7` | **blocker** |
| 2 | **MCP dependency**: Entire extension is a thin proxy. If `search-mcp` binary is missing, crashes, or changes protocol, all tools break. No graceful degradation. | `src/mcp-client.ts:72-93` | high |
| 3 | **No error handling per tool**: `callSearchMcpTool` has no try/catch. If MCP call throws, unhandled rejection propagates to Pi. | `src/index.ts:133-149` | medium |
| 4 | **No test coverage for execution paths**: Tests only cover parameter building. Zero coverage for `callSearchMcpTool`, error recovery, or lifecycle shutdown. | `test/*` | medium |
| 5 | **No `dist/` directory**: tsconfig includes it but no build script. Extension runs via tsx (`node --import tsx`). Less production-grade. | `tsconfig.json:24` / `package.json:8` | low |
| 6 | **Connection state not resilient**: If `search-mcp` disconnects mid-session, `SearchMcpClient` doesn't reconnect. Subsequent calls fail. | `src/mcp-client.ts:72-84` | medium |
| 7 | **`close()` race**: `session_shutdown` handler calls `client.close()` with `void` (fire-and-forget). No await. Shutdown may not complete before process exit. | `src/index.ts:39-41` | low |
| 8 | **Env var injection surface**: `SEARCH_MCP_ARGS_JSON` parsed as JSON with no sanitization beyond "must be string array". Could pass malicious args. | `src/mcp-client.ts:96-111` | low |
| 9 | **No Windows support**: Hardcoded path assumes Unix filesystem. StdioClientTransport works cross-platform but path prevents it. | `src/mcp-client.ts:7` | low |
| 10 | **TypeBox v1 vs v1.2.11**: `pi-coding-agent` depends on `typebox@1.1.38` while project uses `typebox@^1.2.11`. Could cause type conflicts. | `package.json:15` | low |

## Migration Considerations (MCP-wrapper → self-contained CLI extension)

Moving from MCP-wrapper to self-contained CLI-based Pi extension means:

1. **Replace `SearchMcpClient`** with direct Node.js code (fetch web pages, call search APIs, crawl URLs, interact with GitHub API directly). Eliminates the external binary dependency.

2. **Keep Pi extension entry point** (`src/index.ts` default export) — this is the Pi contract. Only the tool `execute()` bodies change.

3. **Remove dependencies**: `@modelcontextprotocol/sdk`, `typebox` (if not needed elsewhere). Keep `@earendil-works/pi-ai` for `StringEnum`, `@earendil-works/pi-coding-agent` for `ExtensionAPI`/`AgentToolResult`.

4. **Tool signatures can stay the same** — parameters, labels, descriptions, promptGuidelines can remain unchanged. Only execution logic changes.

5. **Event hooks stay**: `session_shutdown` cleanup still needed (close HTTP clients, etc.). `before_provider_request` normalization still useful.

6. **Testing scope expands**: Need real tests for web fetching, GitHub API calls, search logic (with mocking/recording).

7. **No more hardcoded binary path** — eliminate the blocker.

## Start Here

**`src/index.ts`** — Entry point. Read first to understand the 5 tool registrations and how they delegate to MCP client. Then `src/mcp-client.ts` for the proxy layer to replace.

## Residual Risks

1. **Blocker**: Hardcoded `/Users/rhinesharar/.pi/agent/bin/search-mcp` path in `src/mcp-client.ts:7`.
2. No test coverage for execution paths.
3. No error handling in `callSearchMcpTool()`.
4. Connection is not resilient to MCP server failures.
5. No integration tests against real `search-mcp`.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings with file paths, line numbers, and severity ratings provided for all 10 identified constraints/risks. Architecture diagram, data flow, and migration considerations documented."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "find . -maxdepth 3 -not -path './.git/*' -not -path './node_modules/*'",
      "result": "passed",
      "summary": "Mapped project structure: 4 src files, 3 test files, package.json, tsconfig.json, README.md"
    },
    {
      "command": "npx tsc --noEmit",
      "result": "passed",
      "summary": "TypeScript compilation: no errors"
    },
    {
      "command": "npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @modelcontextprotocol/sdk",
      "result": "passed",
      "summary": "Dependency tree: pi-ai@0.79.4, pi-coding-agent@0.79.4, @modelcontextprotocol/sdk@1.29.0"
    }
  ],
  "validationOutput": [
    "Not a git repository — no staged/unstaged changes to inspect. Smart-edit-undo files present but schema doesn't expose filePath. No dist/ directory. No research/ directory existed prior to this run."
  ],
  "residualRisks": [
    "blocker: src/mcp-client.ts:7 - hardcoded absolute path to search-mcp binary",
    "No test coverage for tool execution paths",
    "No error handling in callSearchMcpTool()",
    "Connection not resilient to MCP server failure",
    "No integration/end-to-end tests"
  ],
  "noStagedFiles": true,
  "diffSummary": "No git repository — cannot compute diff. All source files are clean with no pending modifications detected.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 - DEFAULT_SEARCH_MCP_COMMAND hardcoded to /Users/rhinesharar/.pi/agent/bin/search-mcp",
    "high: src/mcp-client.ts:72-93 - entire extension depends on external binary with no graceful degradation",
    "medium: src/index.ts:133-149 - callSearchMcpTool has no try/catch for MCP errors",
    "medium: test/* - zero tests for actual tool execution or error paths",
    "medium: src/mcp-client.ts:72-84 - connection not resilient to MCP server disconnection"
  ],
  "manualNotes": "Project is a thin MCP-wrapping Pi extension. Migration to self-contained CLI extension requires replacing SearchMcpClient with direct HTTP API calls while keeping the Pi entry point and tool registration patterns unchanged. Hardcoded binary path is the primary blocker."
}
```

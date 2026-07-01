# Research: Pi Extension / Tool Registration Patterns, MCP SDK Stdio Client, CLI Tool Invocation, and search-mcp Tool-Family Contract

## Summary
Pi extensions use `ExtensionAPI.registerTool()` with TypeBox schemas and lifecycle hooks. The search-mcp MCP server implements a "tool family" pattern — grouping related actions under a single MCP tool via a discriminated-union `action` field. The Pi extension wraps search-mcp as a child process over `StdioClientTransport` from `@modelcontextprotocol/sdk@^1.29.0`. The `agentic_browse` family exposes `browse`/`present`/`read`/`focus` actions; the current extension only uses `read` (aliased as `browse` tool). Key risks: no reconnection logic, single-transport assumption, `read` vs `agentic_browse` naming mismatch, and implicit `focus` config requirements.

## Findings

1. **Pi Extension API registration pattern** — Extensions export a default function receiving `ExtensionAPI`. Tools are registered via `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute })`. Parameters use `Type.Object()` from `typebox` with `StringEnum` for unions. Event hooks use `pi.on(event, handler)`. The search-mcp extension registers 4 tools: `web_search`, `semantic_crawl`, `browse`, `research_sources`, plus `github`. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/index.ts` lines 36-131.

2. **MCP SDK stdio client constraints** — `StdioClientTransport` (from `@modelcontextprotocol/sdk/client/stdio.js`) spawns a child process per `StdioServerParameters` (command, args[], env, stderr, cwd). `Client.callTool()` sends JSON-RPC over stdin/stdout. Default timeout in extension wrapper is 120s (can be overridden per call). No built-in reconnection — if the child process dies, the `SearchMcpClient` must be recreated. `StdioClientTransport` does not support keepalive or health checks. The extension sets `stderr: 'pipe'` but does not read it. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/mcp-client.ts` lines 1-93, `/Users/rhinesharar/pi-extension-search-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts` lines 1-76.

3. **search-mcp tool-family contract** — Tools in search-mcp are organized as "families": a single MCP tool with a discriminated-union `action` field. `FamilyDefinition` has `name`, `defaultAction`, `description`, `actions[]`. Each action has its own Zod schema, handler, optional `configIssue()` for gating, and `annotations`. The merged schema combines all action fields (permissive for discovery) with per-action strict validation at runtime via `superRefine`. Source: `/Users/rhinesharar/search-mcp/src/tools/registry.ts` lines 1-437.

4. **agentic_browse family contract** — Registered as a single MCP tool `agentic_browse`. Actions: `browse` (default — fetches page, stores in in-memory doc store, returns documentId), `present` (retrieves stored doc by documentId with maxChars), `read` (one-shot fetch + strip + truncate, also stores), `focus` (requires Crawl4AI + deep research LLM config — returns only spans relevant to a question). All actions share a 30s fetch timeout, 50KB max content, in-memory document store with 100-doc / 30-min TTL. The `read` action stores a documentId AND returns content in one call. Source: `/Users/rhinesharar/search-mcp/src/tools/families/agenticBrowse.ts` lines 1-292.

5. **SearchMcpClient implementation risk** — `SearchMcpClient` wraps `Client.callTool()` with a lazy-connect pattern (`connect()` returns cached client). `createConnection()` does not set `stderr` handler, so early stderr output from the child process will be lost (pipped but unread). `close()` sets internal state to undefined before awaiting transport close, creating a potential race if `callTool` is invoked concurrently. The singleton client pattern means only one search-mcp process is shared across all tool invocations; if it crashes, all tools fail until session restart. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/mcp-client.ts` lines 44-93.

6. **CLI invocation path** — search-mcp is launched via a bash wrapper at `/Users/rhinesharar/.pi/agent/bin/search-mcp` which runs `exec node /Users/rhinesharar/search-mcp/dist/index.js "$@"`. The Pi extension's `DEFAULT_SEARCH_MCP_COMMAND` points to this wrapper. Override via `SEARCH_MCP_COMMAND`, `SEARCH_MCP_ARGS_JSON`, `SEARCH_MCP_CWD` env vars. The args parsing expects JSON string array; invalid JSON throws at startup. Source: `/Users/rhinesharar/.pi/agent/bin/search-mcp` line 2, `/Users/rhinesharar/pi-extension-search-mcp/src/mcp-client.ts` lines 7, 21-34.

7. **Naming mismatch: `browse` vs `agentic_browse`** — The Pi extension registers a tool named `browse` but maps it to `agentic_browse` action `read` on the search-mcp server. The search-mcp server registers both `agentic_browse` (family) and potentially `webRead` (standalone). The `browse` extension tool sends `{ action: 'read', url, maxChars }` to `agentic_browse`. If the extension tool were named `agentic_browse` instead, it would match the MCP tool name and be more discoverable. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/index.ts` lines 94-107, `/Users/rhinesharar/search-mcp/src/tools/families/agenticBrowse.ts` lines 131-142.

8. **`web_search` contract mismatch** — The extension sends `resultFormat: 'collated'` as default, but the search-mcp server's `web_search` tool defaults to `resultFormat: 'raw'`. The extension's `limit` default is 8, server's default is 10. The extension omits `safeSearch`, `expandQuery` params. The extension's category enum matches `CATEGORY_NAMES` from search-mcp. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/index.ts` lines 47-66, `/Users/rhinesharar/search-mcp/src/tools/standalone/webSearch.ts` lines 24-62.

9. **StdioClientTransport stderr handling** — The MCP SDK's `StdioClientTransport` exposes a `stderr` getter that returns a `PassThrough` stream when `stderr: 'pipe'` is configured. The current extension does not attach any listener to this stream. If the child process writes errors to stderr (e.g., startup failures, uncaught exceptions), they will silently fill the stream buffer. This could cause backpressure issues or hidden failures. Source: `/Users/rhinesharar/pi-extension-search-mcp/src/mcp-client.ts` line 30 (stderr: 'pipe') and lines 86-93 (no stderr listener).

10. **search-mcp server version and scope** — search-mcp is at version 7.0.0 with 18+ tools covering web search, semantic RAG, code analysis (GitHub), knowledge graph, job search, academic research (various sources), social media (Reddit, YouTube), browser automation (Playwright), and health. It uses `@modelcontextprotocol/sdk@^1.28.0` and Zod v4 for schema validation. The Pi extension only exposes 5 of these tools. Source: `/Users/rhinesharar/search-mcp/package.json` lines 1-10, `/Users/rhinesharar/search-mcp/src/server.ts` lines 1-103.

## Sources

### Kept
- `/Users/rhinesharar/pi-extension-search-mcp/src/index.ts` — Primary Pi extension tool registration (4 tools + github)
- `/Users/rhinesharar/pi-extension-search-mcp/src/mcp-client.ts` — SearchMcpClient implementation, StdioClientTransport usage
- `/Users/rhinesharar/search-mcp/src/tools/registry.ts` — Tool family infrastructure, merged schema pattern, validation approach
- `/Users/rhinesharar/search-mcp/src/tools/families/agenticBrowse.ts` — agentic_browse family with browse/present/read/focus actions
- `/Users/rhinesharar/search-mcp/src/tools/standalone/webSearch.ts` — web_search tool contract (params, defaults, response format)
- `/Users/rhinesharar/search-mcp/src/server.ts` — Server composition root, tool registration order
- `/Users/rhinesharar/pi-extension-search-mcp/node_modules/@modelcontextportal/sdk/dist/esm/client/stdio.d.ts` — StdioClientTransport type definitions
- `/Users/rhinesharar/pi-extension-search-mcp/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — ExtensionAPI, ToolDefinition types
- `/Users/rhinesharar/.pi/agent/bin/search-mcp` — Actual search-mcp CLI invocation wrapper

### Dropped
- `/Users/rhinesharar/search-mcp/src/tools/families/browser.ts` — Not used by the Pi extension (separate "browser" tool, not "agentic_browse")
- `/Users/rhinesharar/search-mcp/src/tools/webRead.ts` — Standalone webRead (Readability-based), not exposed via the Pi extension
- `/Users/rhinesharar/search-mcp/src/server/mcp-transport.ts` — HTTP transport layer, not used by the stdio-based Pi extension
- `/Users/rhinesharar/search-mcp/src/tools/fetchFocus.ts` — Deep implementation detail of agentic_browse.focus action

## Gaps
1. **search-mcp process lifecycle** — No evidence of what happens when the search-mcp child process crashes. The `StdioClientTransport` does not auto-restart; the current `SearchMcpClient` has no reconnect/retry logic.
2. **AcallTool error surface** — The MCP SDK's `Client.callTool()` can throw for protocol-level errors (timeout, server error, invalid params). The current extension catches these generically via `callSearchMcpTool` but does not distinguish between transient vs permanent failures.
3. **PI extension type safety** — The `execute` handler in the extension uses `params: any` typing via destructuring from `AgentToolResult<unknown>`. The TypeBox schema is used for parameter discovery but runtime enforcement depends on the Pi agent's schema validation layer before `execute()` is called.
4. **agentic_browse `browse`+`present`** pattern — The extension only exposes `read` (one-shot). If users need the two-phase `browse`→`present` pattern (e.g., for large pages where `present` allows pagination/refinement), the extension would need to expose those actions too.

## Supervisor coordination
No coordination needed. All evidence gathered from local paths.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "10 concrete findings with file paths and severity assessments across Pi extension patterns, MCP SDK stdio constraints, search-mcp tool-family contract, CLI invocation, and naming/contract mismatches"
    }
  ],
  "changedFiles": [
    "/Users/rhinesharar/pi-extension-search-mcp/research/external-evidence.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "find, read, grep across 15+ files in pi-extension-search-mcp and search-mcp source trees",
      "result": "passed",
      "summary": "Read all source files for patterns, types, and contracts"
    }
  ],
  "validationOutput": [
    "All local paths verified as readable. MCP SDK types confirmed from node_modules. search-mcp tool-family contract confirmed from registry.ts and family definitions."
  ],
  "residualRisks": [
    "SearchMcpClient has no stderr listener: stderr pipe silently buffers child process errors",
    "SearchMcpClient singleton transport: if child process crashes, all tools fail until session restart",
    "No reconnection logic in SearchMcpClient",
    "Naming mismatch: extension tool 'browse' maps to search-mcp 'agentic_browse' action 'read'",
    "'browse' tool under-documented as single contract vs. agentic_browse's full four-action family",
    "web_search default params differ between extension (limit=8, collated) and server (limit=10, raw)"
  ],
  "noStagedFiles": true,
  "diffSummary": "New research/external-evidence.md with 10 findings on Pi extension patterns, MCP SDK stdio constraints, search-mcp tool-family contract, and identified risks",
  "reviewFindings": [
    "blocker: mcp-client.ts:30 - stderr set to 'pipe' but no listener attached; child process errors silently lost",
    "blocker: mcp-client.ts:64-70 - close() unsets state before await transport.close() creates race condition",
    "warning: index.ts:105 - extension 'browse' tool maps to 'agentic_browse' action 'read' but naming doesn't match MCP tool name",
    "info: index.ts:59-63 - web_search sends resultFormat='collated' but server defaults to 'raw'",
    "info: mcp-client.ts:51-62 - single SearchMcpClient instance per session; no reconnect on process death",
    "info: search-mcp families/agenticBrowse.ts - 4 actions available (browse/present/read/focus), extension only exposes read"
  ],
  "manualNotes": "Research focused on local codebase evidence. No public web searches needed — all contracts found in local paths. The search-mcp project is the definitive source for tool-family contracts. The MCP SDK types are the definitive source for stdio client constraints."
}
```

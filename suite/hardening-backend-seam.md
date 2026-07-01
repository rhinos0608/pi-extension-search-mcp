# Hardening Suite 1/5 — Backend Seam Review

**Date:** 2026-07-02
**Scope:** Read-only analysis of proposed `SearchBackend` seam design and alternatives.
**Files reviewed:** `src/mcp-client.ts`, `src/index.ts`, `src/github.ts`, `src/payload.ts`, `test/*.test.ts`, `package.json`, `tsconfig.json`, `research/strategy-context.md`, `research/external-evidence.md`, `research/oracle-consultation.md`, `suite/issues-architecture.md`

---

## 1. Current State

`SearchMcpClient` (concrete class, `src/mcp-client.ts:44`) is accepted directly in:

| Location | Coupling |
|----------|----------|
| `src/index.ts:37` | Construction: `new SearchMcpClient(buildServerParameters(process.env))` |
| `src/index.ts:133-134` | Parameter type of `callSearchMcpTool(client: SearchMcpClient, ...)` |
| `src/github.ts:16` | Parameter type of `registerGitHubTool(pi, client: SearchMcpClient)` |
| `src/github.ts:146` | Call site: `client.callTool('github', args, ...)` |

There is no interface. Every `execute()` handler in the extension is coupled to the MCP stdio transport. Zero tool execution paths can be tested without spawning a live `search-mcp` subprocess.

---

## 2. Proposed `SearchBackend` Seam (from `research/strategy-context.md`)

The prior strategy analysis proposes:

```typescript
// src/backend.ts
export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
  close(): Promise<void>;
}
```

With backend selection:
```
SEARCH_MCP_BASE_URL set? → HttpSearchBackend (no subprocess)
SEARCH_MCP_COMMAND set?  → McpSearchBackend (custom binary)
(default)                → McpSearchBackend (search-mcp on PATH)
```

---

## 3. Alternative Designs Evaluated

### Design A — Thin `callTool` interface (proposed)

```typescript
export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: BackendCallOptions): Promise<BackendCallResult>;
  close(): Promise<void>;
}
```

**Pros:** Minimal surface. Exact match to current call sites (`src/index.ts:140`, `src/github.ts:146`). Zero behavioral change to introduce. `McpSearchBackend` implementing it changes only type annotations at call sites.
**Cons:** `name: string` remains untyped. A misspelled tool name like `'web-search'` instead of `'web_search'` is a runtime error, not a compile error.
**Verdict:** Correct first step. Add typed names as a follow-on once the seam is stable.

---

### Design B — Literal union on `name`

```typescript
export type BackendToolName =
  | 'web_search'
  | 'semantic_crawl'
  | 'agentic_browse'
  | 'research'
  | 'github';

export interface SearchBackend {
  callTool(name: BackendToolName, args: Record<string, unknown>, options?: BackendCallOptions): Promise<BackendCallResult>;
  close(): Promise<void>;
}
```

**Pros:** Tool name typos become compile errors. Matches `callSearchMcpTool` improvement noted in `suite/issues-architecture.md:110-128`.
**Cons:** Couples the interface to the search-mcp tool namespace. If an `HttpSearchBackend` or local backend uses different method names internally, the union forces a mapping layer in every implementation. This is an implementation detail leaking into the seam.
**Verdict:** Worth adding to `callSearchMcpTool`'s `name` parameter (internal helper), not to the interface itself. The interface should be backend-agnostic.

---

### Design C — Per-tool methods

```typescript
export interface SearchBackend {
  webSearch(args: WebSearchArgs, options?: BackendCallOptions): Promise<BackendCallResult>;
  semanticCrawl(args: SemanticCrawlArgs, options?: BackendCallOptions): Promise<BackendCallResult>;
  browse(args: BrowseArgs, options?: BackendCallOptions): Promise<BackendCallResult>;
  research(args: ResearchArgs, options?: BackendCallOptions): Promise<BackendCallResult>;
  github(args: GithubArgs, options?: BackendCallOptions): Promise<BackendCallResult>;
  close(): Promise<void>;
}
```

**Pros:** Full type safety per tool. Enables per-tool divergence between backends (e.g., `HttpSearchBackend.github` could call GitHub API directly without going through any MCP layer).
**Cons:** Five new arg types needed before first commit. `McpSearchBackend` implementation becomes verbose boilerplate — each method just calls `client.callTool(toolName, args, options)`. Requires up-front decision on whether `GithubArgs` is the union of all 20+ params or split per action. This is the right shape for the end state but has high surface area now.
**Verdict:** Correct target architecture after github.ts is split per action (see `suite/issues-architecture.md` Finding 3). Premature today.

---

### Design D — Factory function only, no explicit backend type

```typescript
// No interface. Just a factory:
export function createSearchClient(env: SearchMcpEnvironment): SearchMcpClient | HttpSearchClient;
```

**Pros:** Simplest to write.
**Cons:** Returns a union type, not a structural interface. Callers must widen to the intersection or use type guards. No polymorphism. No fake injection in tests. Defeats the purpose.
**Verdict:** Anti-pattern. Rejected.

---

## 4. Recommended Interface

**Use Design A** with the following precision additions:

```typescript
// src/backend.ts

export interface BackendCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface BackendCallResult {
  content?: unknown;
  [key: string]: unknown;
}

export interface SearchBackend {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: BackendCallOptions,
  ): Promise<BackendCallResult>;
  close(): Promise<void>;
}
```

**Naming rationale:** `BackendCallOptions` and `BackendCallResult` (not `SearchMcpCallOptions`/`SearchMcpCallResult`) because the interface must not imply MCP transport. The current names in `mcp-client.ts:11-19` are correct for the MCP implementation class; the interface names should be transport-neutral.

**`resultToText` placement:** Keep in `mcp-client.ts` (or move to a shared `src/result.ts`). It must NOT be on the `SearchBackend` interface — it is a presentation concern, not a transport contract. Both `callSearchMcpTool` and `github.ts` use it; that is correct.

**Factory:**

```typescript
// src/backend.ts
export function createSearchBackend(env: SearchMcpEnvironment): SearchBackend {
  if (env.SEARCH_MCP_BASE_URL?.trim()) {
    return new HttpSearchBackend(env);  // future
  }
  return new McpSearchBackend(buildServerParameters(env));
}
```

Selection logic lives in the factory, not in `src/index.ts`. `src/index.ts` calls `createSearchBackend(process.env)` once.

**`McpSearchBackend` shape:**

```typescript
// src/mcp-client.ts (rename class only; public API unchanged)
export class McpSearchBackend implements SearchBackend {
  // existing SearchMcpClient implementation unchanged
}
```

Renaming `SearchMcpClient` → `McpSearchBackend` is optional at this milestone; what matters is that the class implements the interface so callers can be typed against `SearchBackend`.

---

## 5. Tests to Add

Once the seam exists, these tests become possible and should be written:

### 5a. Factory tests (`test/backend.test.ts`)

```
✓ createSearchBackend({}) → McpSearchBackend instance
✓ createSearchBackend({ SEARCH_MCP_BASE_URL: 'http://...' }) → HttpSearchBackend (when implemented)
✓ McpSearchBackend implements SearchBackend (structural type check via assignment)
```

### 5b. Fake backend for each tool (`test/index.test.ts` extension)

A fake backend implementing `SearchBackend`:

```typescript
class FakeSearchBackend implements SearchBackend {
  calls: Array<{ name: string; args: Record<string, unknown>; options?: BackendCallOptions }> = [];
  async callTool(name, args, options) { this.calls.push({ name, args, options }); return { content: [] }; }
  async close() {}
}
```

Tests to add per tool:

| Tool | Args to verify | File |
|------|---------------|------|
| `web_search` | `query`, `limit: 8`, `resultFormat: 'collated'`; category omitted when not provided | `test/index.test.ts` |
| `web_search` with category | `category` included in forwarded args | `test/index.test.ts` |
| `semantic_crawl` with `url` | `source: { type: 'url', url }`, `topK: 8`, `maxPages: 10`, `maxDepth: 1` | `test/index.test.ts` |
| `semantic_crawl` with `searchQuery` | `source: { type: 'search', query, maxSeedUrls: 8 }`, `maxDepth: 0` | `test/index.test.ts` |
| `semantic_crawl` with neither | throws `'Provide either url or searchQuery'` | `test/index.test.ts` |
| `browse` | `callTool('agentic_browse', { action: 'read', url, maxChars: 12000 })` | `test/index.test.ts` |
| `research_sources` | `action: 'academic'`, `source: 'all'`, `limit: 12`; no `yearFrom` when absent | `test/index.test.ts` |
| `github action=repo` | `action: 'repo'` forwarded; undefined params stripped | `test/github.test.ts` |
| `github action=code_search` | `profile`, `fileFilter`, `maxFiles` forwarded when set | `test/github.test.ts` |

### 5c. `buildSemanticSource` export (`test/index.test.ts`)

`buildSemanticSource` (`src/index.ts:159`) has 3 code paths (url, searchQuery, throw) but is unexported. Export it and test all 3 branches. The throw path has zero coverage today.

### 5d. Reconnection test (`test/mcp-client.test.ts` extension)

Once `McpSearchBackend` listens to `transport.onclose` to clear `this.client`:

```
✓ after transport close event fires, next callTool re-establishes connection (not stale client)
```

This requires a lightweight mock of `StdioClientTransport` or extracting the reconnection behavior into a testable unit.

---

## 6. Anti-patterns to Avoid

### AP-1: Transport types leaking through the interface (HIGH)
Do not include `StdioServerParameters`, `StdioClientTransport`, `Client`, or any `@modelcontextprotocol/sdk` type in the `SearchBackend` interface or `BackendCallOptions`/`BackendCallResult`. If they appear, callers transitively depend on the MCP SDK even when using an HTTP backend.

### AP-2: Absorbing `resultToText` into the interface (HIGH)
`resultToText` is a presentation helper. Placing it on `SearchBackend` would force every implementation (HTTP, fake, future) to produce `SearchMcpCallResult`-shaped output. Keep it as a standalone function next to call sites.

### AP-3: Sync factory hiding async initialization failure (MEDIUM)
`createSearchBackend(env)` is correctly synchronous — `McpSearchBackend` uses lazy-connect. Do not change this to an `async` factory that performs a startup health check, because the lazy pattern is what allows the extension to register tools before the transport is needed. If a health check is added, do it in a `session_start` hook, not in the factory.

### AP-4: Naming the interface after the transport (`SearchMcpBackend`) (MEDIUM)
The interface name must not contain "Mcp". `SearchMcpBackend` suggests MCP is the only possible transport, defeating the abstraction. Use `SearchBackend`.

### AP-5: Coupling `BackendCallResult` to MCP SDK's call result type (MEDIUM)
The MCP SDK's `CallToolResult` type (from `@modelcontextprotocol/sdk`) should not be the return type of `SearchBackend.callTool`. `BackendCallResult` is intentionally a structural subset: `{ content?: unknown; [key: string]: unknown }`. `McpSearchBackend.callTool` returns the SDK result which structurally satisfies this type — no explicit casting needed.

### AP-6: Splitting github.ts before the seam exists (LOW)
The oracle consultation (`research/oracle-consultation.md`) correctly warns against implementing multiple changes at once. The backend seam must exist and tests must be green before splitting `github.ts` into per-action registrations. Splitting first without the seam means execute() paths remain untestable.

### AP-7: Adding `HttpSearchBackend` before Q1 is answered (LOW)
`research/strategy-context.md:186` notes that whether `search-mcp` exposes an HTTP endpoint is unresolved (Q1). Do not implement `HttpSearchBackend` until this is confirmed. The factory can reference it with a future-safe stub (`throw new Error('HTTP backend not yet implemented')`) to make the env-var routing testable without committing to the implementation.

---

## 7. Findings Summary

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| F1 | **blocker** | `src/index.ts:133` + `src/github.ts:16` | `SearchMcpClient` accepted as concrete type; no seam; all execute() paths untestable |
| F2 | **blocker** | `src/mcp-client.ts:7` | `DEFAULT_SEARCH_MCP_COMMAND` hardcoded to machine-specific absolute path; breaks portability and CI |
| F3 | **high** | `src/mcp-client.ts:72-83` | `connect()` caches `this.client` with no `onclose` listener; stale client after subprocess crash means all tools fail silently until session restart |
| F4 | **high** | `src/mcp-client.ts:86-93` | `stderr: 'pipe'` set (`mcp-client.ts:30`) but no listener attached; subprocess errors silently buffer and can cause backpressure |
| F5 | **medium** | `src/index.ts:37` | Client constructed at load time with no startup validation; misconfigured binary path surfaces only mid-conversation |
| F6 | **medium** | `src/index.ts:133` | `callSearchMcpTool` `name` parameter is `string`; tool name typos are runtime errors |
| F7 | **medium** | `src/index.ts:159` | `buildSemanticSource` is unexported; throw path has zero test coverage |
| F8 | **low** | `src/github.ts:37-133` | 20+ parameters flattened into one optional union for 8 distinct actions; no action-level type enforcement |
| F9 | **low** | `package.json:4` + `README.md:3` | Description says "three tools"; code registers five |

---

## 8. Recommended Execution Order

1. **Add `SearchBackend` interface + factory** (`src/backend.ts`) — zero behavioral change; make `McpSearchBackend` implement it; update `src/index.ts:37` and `src/github.ts:16` to accept `SearchBackend`. Tests: factory selection, structural type check.
2. **Add fake backend tests** covering all `execute()` paths (see §5b). Green tests are the validation gate for step 1.
3. **Fix hardcoded path** (`src/mcp-client.ts:7` → `'search-mcp'`) only after verifying Pi installer adds its bin dir to PATH, or `SEARCH_MCP_COMMAND` override is documented in README as the required workaround.
4. **Export and test `buildSemanticSource`** (§5c) — 30-min quick win.
5. **Add reconnection logic** in `McpSearchBackend` (§5d) — once tests cover it.
6. **`HttpSearchBackend`** only after Q1 (HTTP endpoint existence) is answered.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Nine findings with file paths and severity: F1 blocker (src/index.ts:133, src/github.ts:16 — no seam), F2 blocker (src/mcp-client.ts:7 — hardcoded path), F3 high (src/mcp-client.ts:72-83 — no reconnection), F4 high (src/mcp-client.ts:86-93 — unread stderr), F5 medium (src/index.ts:37 — deferred init), F6 medium (src/index.ts:133 — untyped name), F7 medium (src/index.ts:159 — unexported buildSemanticSource), F8 low (src/github.ts:37-133 — flat param union), F9 low (package.json:4 — stale description). Recommended interface, four alternative designs evaluated, tests specified, seven anti-patterns documented."
    }
  ],
  "changedFiles": [
    "suite/hardening-backend-seam.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "find /Users/rhinesharar/pi-extension-search-mcp -type f | sort",
      "result": "passed",
      "summary": "Mapped full project structure; identified src/, test/, suite/, research/ directories and all source files"
    }
  ],
  "validationOutput": [
    "src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp' (hardcoded absolute path confirmed)",
    "src/index.ts:37 — new SearchMcpClient(buildServerParameters(process.env)) uses concrete type, no interface",
    "src/index.ts:133 — callSearchMcpTool accepts SearchMcpClient directly, name typed as string",
    "src/github.ts:16 — registerGitHubTool(pi, client: SearchMcpClient) uses concrete type",
    "src/mcp-client.ts:72-83 — connect() caches this.client, no onclose listener",
    "src/mcp-client.ts:30 — stderr: 'pipe' set; no listener attached in createConnection() lines 86-93",
    "src/index.ts:159 — buildSemanticSource not exported; 3 code paths, 0 tests",
    "test files cover only: buildBrowseArgs, buildServerParameters, resultToText, normalizeProviderPayload; zero execute() path coverage confirmed",
    "plan.md and progress.md do not exist; analysis based on direct source inspection and research artifacts"
  ],
  "residualRisks": [
    "Q1 unresolved: whether search-mcp v7 exposes HTTP transport — affects HttpSearchBackend viability",
    "Q2 unresolved: whether search-mcp is on npm — affects whether 'search-mcp' PATH default is safe in CI",
    "Changing default command (F2 fix) must be verified against Pi installer PATH before shipping",
    "github.ts action-splitting (F8 fix) is a breaking change for external callers and should follow, not precede, the seam",
    "McpSearchBackend reconnection (F3 fix) requires testing with a mock transport; StdioClientTransport close-event API must be verified against SDK version 1.29.0"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/hardening-backend-seam.md (new file). No source files modified.",
  "reviewFindings": [
    "blocker: src/index.ts:133 + src/github.ts:16 — SearchMcpClient used as concrete type everywhere; no backend seam; all execute() paths untestable without live subprocess",
    "blocker: src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND hardcoded to /Users/rhinesharar/.pi/agent/bin/search-mcp",
    "high: src/mcp-client.ts:72-83 — no onclose listener; stale this.client after subprocess crash causes silent failures",
    "high: src/mcp-client.ts:86-93 — stderr piped but unread; child process errors silently buffer",
    "medium: src/index.ts:37 — no startup validation; misconfiguration surfaces only when tool is first called",
    "medium: src/index.ts:133 — callSearchMcpTool name parameter is untyped string",
    "medium: src/index.ts:159 — buildSemanticSource unexported; throw path has zero test coverage",
    "low: src/github.ts:37-133 — 20+ params in flat optional union for 8 distinct actions; no per-action type enforcement",
    "low: package.json:4 — description says three tools; five are registered"
  ],
  "manualNotes": "The recommended SearchBackend interface (Design A) is correct for Milestone 1. It requires changes only to type annotations at call sites — no behavioral change. The factory function in src/backend.ts is the right home for backend selection logic. HttpSearchBackend should not be implemented until Q1 (HTTP endpoint existence) is confirmed. The most important unlock from this seam is test coverage of execute() paths via FakeSearchBackend injection."
}
```

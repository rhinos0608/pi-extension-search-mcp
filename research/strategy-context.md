# Strategy Context: Pi Extension Search-MCP → Self-Contained Extension

**Date:** 2026-07-02
**Scope:** Research-only. No code was changed.

---

## 1. Current State

### What the project is today

`pi-extension-search-mcp` is a Pi coding-agent extension that exposes 5 tools (`web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`) by delegating every call through the MCP stdio protocol to a separately-installed `search-mcp` process. The extension contributes no search logic of its own.

### Runtime dependency graph

```
Pi coding agent
  └─ pi-extension-search-mcp (this repo)
       └─ SearchMcpClient (stdio MCP)
            └─ /Users/rhinesharar/.pi/agent/bin/search-mcp  [bash shim]
                  └─ node /Users/rhinesharar/search-mcp/dist/index.js  [sibling repo, v7.0.0]
```

The shim at `.pi/agent/bin/search-mcp` contains exactly:
```bash
#!/usr/bin/env bash
exec node /Users/rhinesharar/search-mcp/dist/index.js "$@"
```

This means the extension **only works** on a machine where:
1. `/Users/rhinesharar/search-mcp` exists and is built (`npm run build`).
2. The shim at the hardcoded absolute path exists.

---

## 2. Code Inventory

| File | Role | Lines |
|------|------|-------|
| `src/mcp-client.ts` | MCP client + transport + `buildServerParameters()` | 134 |
| `src/index.ts` | Tool registration, Pi lifecycle hooks | 165 |
| `src/github.ts` | GitHub tool registration (delegates to `client.callTool`) | 157 |
| `src/payload.ts` | `normalizeProviderPayload` for `before_provider_request` hook | 31 |
| `test/*.test.ts` | 3 unit test files, pure-logic, no subprocess | — |

### Key seams already present

- **`SEARCH_MCP_COMMAND` env var** (`mcp-client.ts:22`): already allows overriding the binary path at runtime.
- **`buildServerParameters(env)`** (`mcp-client.ts:21-34`): single entry point for all spawn configuration.
- **`callSearchMcpTool(client, name, args, signal, timeout?)`** (`index.ts:133-149`): clean dispatch boundary between tool definitions and transport.
- **`SearchMcpClient.callTool(name, args, options)`** (`mcp-client.ts:51-62`): the only place that touches `@modelcontextprotocol/sdk`.

### Critical blockers

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| B1 | **HIGH** | `src/mcp-client.ts:7` | `DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp'` — machine-specific absolute path, breaks on any other machine or in CI |
| B2 | **HIGH** | `src/mcp-client.ts:44-93` | No abstraction boundary between "MCP over stdio" transport and the tool-calling contract. Swapping the backend requires touching the client class directly. |
| B3 | **MEDIUM** | `src/mcp-client.ts:72-83` | No reconnection logic. If the child process crashes mid-session, `this.client` is stale and all subsequent calls throw until process restart. |
| B4 | **MEDIUM** | `src/index.ts:37` | Client is instantiated at load time from `process.env` directly. No deferred init, no validation, no startup health check—failure is lazy and opaque. |
| B5 | **LOW** | `package.json` | `description` says "three search-mcp research tools" but the extension registers 5 tools (`web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`). Misleading. |

---

## 3. Recommended Architecture

### Target state

Replace the runtime subprocess dependency with a **pluggable `SearchBackend` interface**. The default implementation uses the MCP stdio transport (existing behavior), but a second implementation can call the underlying search APIs directly—via HTTP, npx, or in-process—without requiring the sibling `search-mcp` repo to exist on disk.

```
pi-extension-search-mcp
  ├─ src/
  │   ├─ backend.ts          ← NEW: SearchBackend interface + factory
  │   ├─ mcp-client.ts       ← NARROW: becomes McpSearchBackend (implements SearchBackend)
  │   ├─ http-client.ts      ← NEW (optional): HttpSearchBackend (implements SearchBackend)
  │   ├─ index.ts            ← REFACTOR: receives SearchBackend, not SearchMcpClient
  │   ├─ github.ts           ← REFACTOR: receives SearchBackend
  │   └─ payload.ts          ← UNCHANGED
  └─ test/
      ├─ backend.test.ts     ← NEW: factory + env-switching logic
      ├─ index.test.ts       ← UNCHANGED (pure logic, no subprocess)
      ├─ mcp-client.test.ts  ← UNCHANGED (unit only)
      └─ payload.test.ts     ← UNCHANGED
```

### `SearchBackend` interface (the key seam)

```typescript
// src/backend.ts
export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<CallResult>;
  close(): Promise<void>;
}
```

All tool implementations in `index.ts` and `github.ts` accept `SearchBackend` instead of `SearchMcpClient`. The concrete implementation is chosen once at startup in `index.ts` based on environment variables.

### Backend selection strategy

```
SEARCH_MCP_BASE_URL set?  →  HttpSearchBackend (no subprocess)
SEARCH_MCP_COMMAND set?   →  McpSearchBackend  (custom binary)
(default)                 →  McpSearchBackend  (npx search-mcp  OR  path lookup)
```

Changing the default command from the absolute shim to `npx search-mcp` (or a `PATH`-based lookup) removes the machine-specific dependency without breaking existing overrides.

---

## 4. Milestones (smallest safe, fully validated increments)

### Milestone 0 — Fix the hardcoded path (< 1 hour, zero risk)

**Change:** Replace the hardcoded default in `mcp-client.ts:7`:

```typescript
// BEFORE
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';

// AFTER
export const DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp';
```

**Validation:** Existing `buildServerParameters` tests still pass. Functional behavior unchanged for users who have `search-mcp` on `PATH` (which includes the Pi installer path). Users with `SEARCH_MCP_COMMAND` override are unaffected.

**Residual risk:** If the user's `PATH` does not include the Pi bin dir, the tool fails. Document this; the env var override already handles it.

---

### Milestone 1 — Introduce `SearchBackend` interface (1–2 hours, zero behavioral change)

**Change:** Extract `SearchBackend` interface to `src/backend.ts`. Rename `SearchMcpClient` to `McpSearchBackend` implementing the interface. Update `index.ts` and `github.ts` to accept `SearchBackend`.

**Validation:** All 3 existing test files pass unchanged. TypeScript strict mode still satisfied. No functional change.

**Why this first:** Creates the seam for Milestone 2 without any behavioral risk. Code compiles or it doesn't—there is no ambiguous middle state.

---

### Milestone 2 — Add HTTP backend (2–4 hours, additive only)

**Change:** Implement `HttpSearchBackend` in `src/http-client.ts` that POSTs to a `SEARCH_MCP_BASE_URL` endpoint (the search-mcp server's HTTP mode, if exposed). Add factory logic to `src/backend.ts` that selects the backend based on environment.

**Validation:**
- Unit tests for `HttpSearchBackend` using `fetch` mock or a local test server.
- Factory test: env var routing works correctly.
- Existing MCP path still selected when `SEARCH_MCP_BASE_URL` is absent.

**Why additive:** Existing behavior is unchanged unless `SEARCH_MCP_BASE_URL` is set.

---

### Milestone 3 — Reconnection and health check (1 hour, defensive)

**Change:** In `McpSearchBackend`, detect transport close events and clear `this.client` so `connect()` re-establishes. Add optional startup ping (`client.ping()`) to surface errors early.

**Validation:** Test that calling `callTool` after `close()` is called on the transport triggers a reconnect rather than throwing on a stale reference.

---

### Milestone 4 — Fix description and add startup validation (30 min, polish)

**Change:** Update `package.json` description to reflect 5 tools. Add env-var validation at startup that logs a clear warning if neither `search-mcp` on PATH nor `SEARCH_MCP_BASE_URL` is available.

**Validation:** No behavioral change; documentation accuracy.

---

## 5. Validation Plan

| Test type | What it covers | Command |
|-----------|----------------|---------|
| Unit (existing) | `buildServerParameters`, `resultToText`, `normalizeProviderPayload`, `buildBrowseArgs` | `npm test` |
| Unit (new) | `SearchBackend` factory, env-based selection, reconnection logic | `npm test` |
| Integration (manual) | `SEARCH_MCP_COMMAND` override points to a local `node dist/index.js` | `SEARCH_MCP_COMMAND=node SEARCH_MCP_ARGS_JSON='["../search-mcp/dist/index.js"]' pi -e ./src/index.ts` |
| Typecheck | All strict TS flags pass | `npm run typecheck` |
| Negative path | Default path (`search-mcp`) not on PATH → clear error message, not silent hang | Manual |

---

## 6. Unresolved Questions

| # | Question | Needed before |
|---|----------|---------------|
| Q1 | Does `search-mcp` v7 expose an HTTP/REST endpoint, or is stdio the only supported transport? The `docker-compose.yml` and `dashboard/` directory suggest it might. | Milestone 2 |
| Q2 | Is `search-mcp` published to npm? If so, `npx search-mcp` is a valid default that works without the sibling repo, but adds cold-start latency. | Milestone 0 / default command |
| Q3 | What does "share infrastructure concepts" mean concretely — import shared TypeScript types, share environment variable names, or share actual runtime module code? The answer determines whether Milestone 2 or a vendoring approach is correct. | Milestone 2 |
| Q4 | Should `github.ts` eventually bypass MCP entirely and call the GitHub API directly? The tool is rich (8 actions, 20+ params) and may not benefit from the HTTP backend abstraction if it ultimately maps to GitHub REST/GraphQL. | Post-Milestone 2 |
| Q5 | The `before_provider_request` hook normalizes `instructions` from array/object to string. Is this a workaround for a Pi bug, a compatibility shim for a specific provider, or a permanent feature? Understanding this determines whether it should stay or be upstreamed. | Milestone 4 / polish |

---

## 7. Decision Recommendation

**Start with Milestone 0** (change the hardcoded default to `search-mcp` on PATH). This is a 3-line change with zero risk and immediately unblocks running on any machine where `search-mcp` is installed. It also verifies the test suite is green before any structural work begins.

**Then answer Q2 and Q3** before committing to Milestone 2. If `search-mcp` is not on npm and has no HTTP mode, the HTTP backend adds complexity with no clear deployment path. In that case, the correct "self-contained" strategy is probably vendoring the relevant search-mcp modules as a local package dependency rather than spawning a subprocess.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Five concrete findings with file paths and severity documented: B1 (HIGH, src/mcp-client.ts:7 hardcoded absolute path), B2 (HIGH, src/mcp-client.ts:44-93 no backend abstraction), B3 (MEDIUM, src/mcp-client.ts:72-83 no reconnection), B4 (MEDIUM, src/index.ts:37 lazy opaque failure), B5 (LOW, package.json description mismatch). All validated by direct code inspection."
    }
  ],
  "changedFiles": [
    "research/strategy-context.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "ls /Users/rhinesharar/pi-extension-search-mcp/",
      "result": "passed",
      "summary": "Confirmed project structure: src/, test/, package.json, tsconfig.json, README.md"
    },
    {
      "command": "file /Users/rhinesharar/.pi/agent/bin/search-mcp && head -5 ...",
      "result": "passed",
      "summary": "Confirmed shim is a bash script: exec node /Users/rhinesharar/search-mcp/dist/index.js"
    },
    {
      "command": "cat /Users/rhinesharar/search-mcp/package.json | head -30",
      "result": "passed",
      "summary": "Confirmed sibling repo is search-mcp v7.0.0, built Node.js MCP server with dist/index.js"
    }
  ],
  "validationOutput": [
    "Hardcoded path confirmed at src/mcp-client.ts:7: DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp'",
    "Shim confirmed: bash wrapper exec-ing /Users/rhinesharar/search-mcp/dist/index.js",
    "Sibling repo search-mcp v7.0.0 exists at /Users/rhinesharar/search-mcp with dist/ built",
    "Extension registers 5 tools (not 3 as README states): web_search, semantic_crawl, browse, research_sources, github",
    "SEARCH_MCP_COMMAND env override already present in buildServerParameters — existing safety valve"
  ],
  "residualRisks": [
    "Q1 unresolved: whether search-mcp exposes HTTP transport (affects Milestone 2 viability)",
    "Q2 unresolved: whether search-mcp is on npm (affects safe default command in Milestone 0)",
    "Q3 unresolved: concrete meaning of 'share infrastructure concepts' — answer gates architecture choice between HTTP backend, library import, or vendoring",
    "McpSearchBackend has no reconnection: if child process crashes mid-session, all tool calls silently fail until Pi restarts (B3)"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created research/strategy-context.md (new file). No source files modified.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 - DEFAULT_SEARCH_MCP_COMMAND is an absolute machine-specific path, breaks on any other system",
    "blocker: src/mcp-client.ts:44-93 - SearchMcpClient has no abstraction interface, making backend substitution require direct class modification",
    "warning: src/mcp-client.ts:72-83 - no reconnection on transport failure; stale client reference after child process crash",
    "warning: src/index.ts:37 - client instantiated at load time from process.env with no startup validation or health check",
    "info: package.json description says 3 tools but 5 are registered; README tool list is also outdated"
  ],
  "manualNotes": "The sibling search-mcp repo is version 7.0.0 with a docker-compose.yml and dashboard/ directory, suggesting it may have an HTTP mode. Verifying this (Q1) before Milestone 2 will determine whether the HTTP backend approach is viable or whether a different self-containment strategy (npx, library import, vendoring) is needed. Milestone 0 is safe to execute immediately."
}
```

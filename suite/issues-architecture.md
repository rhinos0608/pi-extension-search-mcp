# Architecture Findings: pi-extension-search-mcp

**Date:** 2026-07-02
**Scope:** Read-only analysis. No source files modified.

---

## Summary

This is a ~500-line Pi extension that registers 5 tools by delegating every call through MCP stdio to an external `search-mcp` process. The extension contributes zero search logic of its own. All architectural risk stems from this pure-delegation design: there is no backend seam, no interface abstraction, and the transport is locked to a machine-specific binary.

---

## Module Inventory

| File | Role | Lines | Depth Assessment |
|------|------|-------|-----------------|
| `src/mcp-client.ts` | Connection management, `buildServerParameters`, `resultToText`, `SearchMcpClient` class | 134 | Moderate depth — connection dedup and retry are behind a `callTool` interface, but the class is concrete with no seam |
| `src/index.ts` | Extension entry, 4 tool registrations (`web_search`, `semantic_crawl`, `browse`, `research_sources`), lifecycle hooks | 165 | Shallow — tool `execute` bodies are thin wrappers, `callSearchMcpTool` helper barely earns its interface |
| `src/github.ts` | `github` tool registration (8 actions, 20+ params) | 157 | Shallow — sole behavior is schema definition and `client.callTool` delegation; action-level dispatch leaks through param union |
| `src/payload.ts` | `normalizeProviderPayload` for `before_provider_request` hook | 31 | Appropriately deep for its size — 3 code paths behind 1-line interface |

---

## Prioritized Findings

### 1. [HIGH] No backend seam — `SearchMcpClient` is accepted as a concrete type everywhere

**Files:** `src/index.ts:37`, `src/index.ts:58-65`, `src/github.ts:16`, `src/github.ts:146`

**Problem:** Both `index.ts` and `github.ts` accept `SearchMcpClient` directly (concrete class, not an interface). Every `execute()` handler is coupled to the MCP stdio transport. There is no way to inject a fake, a stub, or an HTTP backend without editing the class itself.

**Deletion test:** If you delete `SearchMcpClient`, complexity doesn't concentrate — it disperses into callers. The class earns its keep on connection management, but it provides no *seam*: one adapter = hypothetical seam, not a real one. A real seam requires an interface.

**Consequence:** Every tool `execute()` path in the codebase is untestable without spawning a real `search-mcp` process. The test suite tests only pure helper functions (`buildBrowseArgs`, `buildServerParameters`, `resultToText`, `normalizeProviderPayload`). Zero coverage of actual tool execution logic.

**Solution:** Extract a `SearchBackend` interface with `callTool` and `close`. `SearchMcpClient` becomes `McpSearchBackend` implementing it. `index.ts` and `github.ts` accept `SearchBackend`. No behavioral change; unlocks fake injection in tests and alternative backends at startup.

**Benefits (locality + leverage):** All future backend decisions (HTTP mode, reconnection, auth) are contained behind the interface. Tests can inject a fake backend and verify parameter shaping in each `execute()` body.

---

### 2. [HIGH] Hardcoded machine-specific default path

**File:** `src/mcp-client.ts:7`

```typescript
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```

**Problem:** This absolute path is compiled into the module. The extension cannot run on any machine other than the one it was developed on — no CI, no collaborator, no fresh install. The `SEARCH_MCP_COMMAND` env var provides an override, but it requires users to know to use it before anything works.

**Deletion test:** Delete the constant and substitute `'search-mcp'`. No complexity appears elsewhere. This line provides zero leverage — it is pure machine coupling.

**Solution:** Change default to `'search-mcp'` (PATH lookup) or `'npx search-mcp'` (portable install-free). The override mechanism already exists.

**Benefits:** Portability. CI can run. Other developers can clone and use without configuration.

---

### 3. [HIGH] `github.ts` action dispatch has no action-level parameter shaping

**File:** `src/github.ts:37-133` (parameters schema), `src/github.ts:135-155` (execute)

**Problem:** The `github` tool has 8 distinct actions (`repo`, `file`, `list_dir`, `tree`, `search`, `trending`, `code_search`) but all 20+ parameters are flattened into a single optional union. The `execute()` handler strips undefined values and forwards the whole object to `client.callTool`.

This means:
- A caller passing `action: 'trending'` with `profile: 'semantic-heavy'` (a `code_search`-only param) gets no error at any level.
- The type system provides no per-action parameter contracts.
- Documentation of which params apply to which actions lives only in JSDoc description strings.

**Deletion test:** Delete `github.ts` and inline the tool registration in `index.ts`. Nothing is lost except 157 lines of schema. The module earns its keep on *size* but not on *depth* — its interface is almost as complex as its implementation.

**Solution:** Either (a) split into per-action tool registrations (`github_repo`, `github_file`, etc.) so each has a typed parameter schema, or (b) introduce an action-keyed discriminated union type with per-action param validation in `execute()`. Option (a) is the deeper module because each action tool has a small, precise interface.

**Benefits (locality):** Breaking changes to action-specific params are caught at compile time. Per-action tests can verify the exact args forwarded to the backend.

---

### 4. [MEDIUM] No reconnection on transport failure

**File:** `src/mcp-client.ts:72-83`

**Problem:** `SearchMcpClient.connect()` stores `this.client` on first connection. It is never cleared on transport failure. If the `search-mcp` child process crashes mid-session, `this.client` holds a stale reference. All subsequent `callTool` invocations will throw opaque errors (or hang) until the Pi process is restarted.

The `@modelcontextprotocol/sdk` `StdioClientTransport` fires close events that could be used to reset `this.client = undefined`, triggering a reconnect on the next call. This seam is unused.

**Solution:** Listen to `transport.onclose` (or equivalent SDK event) and set `this.client = undefined`. The existing `connect()` guard handles the re-establishment automatically.

**Benefits:** Session resilience. A transient subprocess crash does not require a Pi restart.

---

### 5. [MEDIUM] Deferred initialization with no startup validation

**File:** `src/index.ts:37`

```typescript
const client = new SearchMcpClient(buildServerParameters(process.env));
```

**Problem:** `SearchMcpClient` constructor stores parameters only — no connection is attempted at load time. A misconfigured `SEARCH_MCP_COMMAND` (wrong path, missing binary) surfaces only when a user calls a tool, producing a cryptic subprocess error rather than a clear startup diagnostic.

**Solution:** After creating the client, attempt a lightweight ping or log a startup warning if the binary is not resolvable. The `session_shutdown` hook already exists — a symmetric `session_start` health check would close the feedback loop.

**Benefits (locality):** Misconfiguration is caught at extension load, not mid-conversation.

---

### 6. [MEDIUM] `callSearchMcpTool` is a shallow helper with an untyped tool name

**File:** `src/index.ts:133-149`

```typescript
async function callSearchMcpTool(
  client: SearchMcpClient,
  name: string,          // ← untyped: any string is accepted
  args: Record<string, unknown>,
  ...
```

**Problem:** The `name` parameter accepts any string. There is no compile-time guarantee that callers pass a valid backend tool name. If a tool name changes in the `search-mcp` backend, this breaks silently at runtime. The function provides negligible leverage — it is one line of `client.callTool` plus result shaping.

**Deletion test:** Delete `callSearchMcpTool`. Each `execute()` body would call `client.callTool` directly — almost no complexity reappears. The function is worth keeping only if its name type is tightened.

**Solution:** Type `name` as a string literal union of valid backend tool names. Combined with the `SearchBackend` interface (Finding 1), this gives type-safe dispatch at the only call site.

**Benefits:** Typos in tool names become compile errors.

---

### 7. [LOW] `buildSemanticSource` is unexported and untested

**File:** `src/index.ts:159-164`

**Problem:** `buildSemanticSource` has 3 code paths (url branch, searchQuery branch, throw). It is a module-level function but not exported, so it cannot be imported by tests. The test file for `index.ts` imports only `buildBrowseArgs`. The throw path (`neither url nor searchQuery provided`) has zero test coverage.

**Solution:** Export `buildSemanticSource` and add unit tests covering all 3 branches, especially the throw path.

**Benefits:** The existing pattern (`buildBrowseArgs` is exported and tested) shows the right shape. Applying it here is consistent.

---

### 8. [LOW] `payload.ts` normalization context is undocumented

**File:** `src/payload.ts`, `src/index.ts:43`

**Problem:** `normalizeProviderPayload` is a well-written, well-tested module. But why it exists is undocumented: is it a workaround for a Pi framework bug, a compatibility shim for a specific LLM provider, or a permanent feature? If it's a workaround, it should be documented with a link to the issue so it can be removed when resolved. If it's permanent, it may belong in the Pi framework itself.

**Solution:** Add a single comment in `payload.ts` explaining the motivation. No code change needed.

---

## Refactor Candidates (Prioritized)

| Priority | Candidate | Files Affected | Risk | Effort |
|----------|-----------|---------------|------|--------|
| 1 | Extract `SearchBackend` interface; rename `SearchMcpClient` → `McpSearchBackend` | `src/mcp-client.ts`, `src/index.ts`, `src/github.ts` | Zero behavioral change | 1–2 hours |
| 2 | Fix hardcoded default path → `'search-mcp'` | `src/mcp-client.ts:7` | Trivial | < 5 min |
| 3 | Add reconnection logic in `McpSearchBackend` | `src/mcp-client.ts` | Additive only | 1 hour |
| 4 | Export and test `buildSemanticSource` | `src/index.ts`, `test/index.test.ts` | Zero behavioral change | 30 min |
| 5 | Split `github` tool into per-action registrations OR discriminated union | `src/github.ts` | Breaking API surface for callers | 2–4 hours |
| 6 | Add startup health check / validation | `src/index.ts` | Additive only | 1 hour |
| 7 | Tighten `callSearchMcpTool` name to string literal union | `src/index.ts` | Additive (compile-time only) | 30 min |
| 8 | Document `payload.ts` motivation | `src/payload.ts` | None | < 5 min |

---

## Migration Risks

1. **No test coverage for execute paths**: Any refactor of tool registration or backend wiring is unverifiable without manual integration testing. Candidate 1 (backend seam) creates the precondition for fixing this.
2. **`github.ts` param union is a leaky public contract**: Splitting actions (Candidate 5) is a breaking change for any caller that passes a combined action+params object. Requires coordination if callers exist outside this repo.
3. **Machine-specific path is likely relied on in production**: The Pi installer at `/Users/rhinesharar/.pi/agent/bin/search-mcp` is what actually works today. Changing the default to `search-mcp` (PATH lookup) only works if the Pi installer adds its bin dir to PATH. This should be verified before shipping Candidate 2.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only analysis: no source files modified. Eight prioritized architecture findings produced with file paths, line numbers, deletion-test reasoning, solutions, and benefit statements in architecture glossary terms. Output written to suite/issues-architecture.md only."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Findings independently verifiable by reading: src/mcp-client.ts:7 (hardcoded path), src/mcp-client.ts:44-93 (no interface seam), src/mcp-client.ts:72-83 (no reconnect), src/index.ts:37 (deferred init), src/index.ts:133-149 (untyped name), src/index.ts:159-164 (unexported buildSemanticSource), src/github.ts:135-155 (flat param union). Test gap confirmed by reviewing all three test files: only pure helpers are tested, zero execute-path coverage."
    }
  ],
  "changedFiles": [
    "suite/issues-architecture.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read src/index.ts src/github.ts src/mcp-client.ts src/payload.ts",
      "result": "passed",
      "summary": "All four source files read in full"
    },
    {
      "command": "read test/index.test.ts test/mcp-client.test.ts test/payload.test.ts",
      "result": "passed",
      "summary": "All three test files read; confirmed zero execute-path test coverage"
    },
    {
      "command": "read package.json README.md research/strategy-context.md",
      "result": "passed",
      "summary": "Read project metadata and prior strategy analysis for context"
    }
  ],
  "validationOutput": [
    "src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND is a hardcoded absolute path to a machine-local bash shim",
    "src/index.ts:37 — SearchMcpClient instantiated with concrete type, no interface, no seam",
    "src/github.ts:16 and :146 — SearchMcpClient accepted as concrete parameter type",
    "src/mcp-client.ts:72-83 — connect() uses this.client with no transport-close listener",
    "src/index.ts:133 — callSearchMcpTool name param typed as string, not literal union",
    "src/index.ts:159 — buildSemanticSource is not exported, has 3 code paths, 0 tests",
    "All three test files cover only: buildBrowseArgs, buildServerParameters, resultToText, normalizeProviderPayload — zero coverage of tool execute() handlers"
  ],
  "residualRisks": [
    "Machine-specific path (mcp-client.ts:7) is the current working default; changing it to PATH lookup must be verified against Pi installer PATH configuration before shipping",
    "github.ts action-splitting (Candidate 5) is a breaking change for any external callers passing action+param combos",
    "No integration tests exist: backend seam refactor (Candidate 1) cannot be fully validated without manual subprocess invocation"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/issues-architecture.md (new file). No source files modified.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 - hardcoded absolute machine-specific path breaks portability",
    "blocker: src/index.ts:37 + src/github.ts:16 - concrete SearchMcpClient type accepted everywhere; no seam; all execute() paths untestable",
    "warning: src/mcp-client.ts:72-83 - no reconnection on transport failure; stale client after subprocess crash",
    "warning: src/index.ts:37 - deferred lazy init with no startup health check",
    "warning: src/github.ts:37-133 - all 20+ github params are a flat optional union for 8 distinct actions; no action-level type enforcement",
    "info: src/index.ts:133 - callSearchMcpTool name is untyped string",
    "info: src/index.ts:159 - buildSemanticSource unexported, untested",
    "info: src/payload.ts - motivation undocumented; unclear if workaround or permanent feature"
  ],
  "manualNotes": "plan.md and progress.md do not exist in the working directory; analysis based entirely on direct source inspection. The research/strategy-context.md file from a prior session contains overlapping findings (B1-B5) and a migration plan. The current report extends that analysis with the architecture deepening lens: deletion tests, depth assessments, and the github.ts action-dispatch finding (Finding 3) which was not covered in the prior research."
}
```

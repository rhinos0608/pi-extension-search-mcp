# Hardening Suite 3/5 — Future-Work Saving Investments

**Date:** 2026-07-02
**Scope:** Read-only analysis. No source files modified.
**Purpose:** Identify small investments that prevent repeated work across future development cycles.

---

## Context

The codebase is a ~500-line Pi extension (`src/index.ts`, `src/github.ts`, `src/mcp-client.ts`, `src/payload.ts`) that delegates all search calls to an external `search-mcp` stdio subprocess via the MCP protocol. The test suite has 9 passing tests covering only pure helper functions — zero coverage of tool execution paths.

Prior suite reports (issues-architecture.md, issues-tests.md, issues-runtime.md, issues-security.md, issues-docs-package.md) document specific bugs and defects. This report focuses on **structural investments** — things to build once that prevent repeated discovery of the same gaps, unblock future work, and reduce manual testing burden.

---

## Prioritized Investments

### INV-1 [CRITICAL] — Fake backend + `SearchBackend` interface

**Files affected:** `src/mcp-client.ts`, `src/index.ts`, `src/github.ts`, `test/` (new shared helper)
**Effort:** ~2 hours
**Saves:** Every future feature or bug fix that touches tool execution currently requires spawning a real `search-mcp` subprocess. Without this seam, all such work falls back to manual end-to-end testing. This will be rediscovered on every test sprint.

**What to build:**
```typescript
// src/backend.ts (new file)
export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: SearchMcpCallOptions): Promise<SearchMcpCallResult>;
  close(): Promise<void>;
}
```

```typescript
// test/fake-backend.ts (new file)
export class FakeSearchBackend implements SearchBackend {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  nextResult: SearchMcpCallResult = { content: [{ type: 'text', text: 'ok' }] };
  nextError?: Error;

  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (this.nextError) throw this.nextError;
    return this.nextResult;
  }
  async close() {}
}
```

**Wire-up:** Change `src/index.ts:37` and `src/github.ts:16` to accept `SearchBackend` instead of `SearchMcpClient`. `SearchMcpClient` implements `SearchBackend`.

**Why this is the highest-leverage investment:** It unlocks approximately 8 currently-blocked tests (P3, P7, P8 from issues-tests.md), all future `execute()` path coverage, and the `github` args-stripping test. Without it, every future test author must either spawn a subprocess or re-invent a mock.

---

### INV-2 [HIGH] — Export `buildSemanticSource` + add its 5 missing tests

**Files affected:** `src/index.ts:159`, `test/index.test.ts`
**Effort:** 30 minutes
**Saves:** This gap will be rediscovered each time tests are extended. The function has 3 code paths (url branch, searchQuery branch, throw) and zero tests. The pattern already exists for `buildBrowseArgs` — applying it here is consistent.

**What to build:**
- Change `function buildSemanticSource` → `export function buildSemanticSource` at `src/index.ts:159`
- Add to `test/index.test.ts`:
  - `buildSemanticSource with url returns { type: 'url', url }`
  - `buildSemanticSource with searchQuery returns { type: 'search', query, maxSeedUrls: 8 }`
  - `buildSemanticSource with url AND searchQuery prefers url`
  - `buildSemanticSource with whitespace-only url falls through to searchQuery`
  - `buildSemanticSource with neither throws`

**Why this saves work:** The throw path (`neither url nor searchQuery`) is the only input-validation guard in the entire `semantic_crawl` tool. Until it has a test, any refactor of this function silently risks breaking the guard. This is pure-function territory — no seam needed, addable right now.

---

### INV-3 [HIGH] — MCP tool name contract snapshot

**Files affected:** new `src/tool-names.ts`, `src/index.ts:59,84,105,122`, `src/github.ts:146`
**Effort:** 30 minutes
**Saves:** The backend tool names (`web_search`, `semantic_crawl`, `agentic_browse`, `research`, `github`) are string literals scattered across `callSearchMcpTool` call sites. If `search-mcp` renames any tool, there is no compile-time or test-time detection. This breakage will be discovered at runtime, in production, mid-conversation.

**What to build:**
```typescript
// src/tool-names.ts (new file)
export const BACKEND_TOOLS = {
  WEB_SEARCH:      'web_search',
  SEMANTIC_CRAWL:  'semantic_crawl',
  BROWSE:          'agentic_browse',
  RESEARCH:        'research',
  GITHUB:          'github',
} as const;

export type BackendToolName = typeof BACKEND_TOOLS[keyof typeof BACKEND_TOOLS];
```

Replace all string literals at call sites with `BACKEND_TOOLS.*`. Tighten `callSearchMcpTool`'s `name` parameter from `string` to `BackendToolName` (addresses architecture finding #6 / `src/index.ts:133`).

**Why this saves work:** A single rename in `tool-names.ts` propagates everywhere. Without this, a `search-mcp` API change requires hunting all string occurrences across multiple files with no compiler guidance.

---

### INV-4 [HIGH] — Shared MCP result fixtures in `test/fixtures.ts`

**Files affected:** new `test/fixtures.ts`, `test/mcp-client.test.ts`, `test/index.test.ts`
**Effort:** 45 minutes
**Saves:** Currently each test file builds its own inline fixture objects for MCP responses. As tests grow (P2, P3, P8 from issues-tests.md), each new test file will re-define the same shapes — text content, non-text content, empty content, non-array content, error response. This is already creating divergence between `test/mcp-client.test.ts` (has mixed text+image fixture) and `test/index.test.ts` (has no result fixtures at all).

**What to build:**
```typescript
// test/fixtures.ts (new file)
import type { SearchMcpCallResult } from '../src/mcp-client.js';

export const FIXTURES = {
  textResult: (text: string): SearchMcpCallResult => ({
    content: [{ type: 'text', text }],
  }),
  mixedResult: (): SearchMcpCallResult => ({
    content: [
      { type: 'text', text: 'alpha' },
      { type: 'image', mimeType: 'image/png', data: 'abc' },
    ],
  }),
  emptyResult: (): SearchMcpCallResult => ({ content: [] }),
  nonArrayResult: (): SearchMcpCallResult => ({ content: 'not-an-array', extra: true }),
  errorResult: (message: string): SearchMcpCallResult => ({ error: message }),
};
```

**Why this saves work:** Every test for `resultToText`, `callSearchMcpTool`, and the `FakeSearchBackend` will need canonical MCP result shapes. Building them once prevents per-file drift. When `search-mcp` changes its result schema, one file needs updating.

---

### INV-5 [MEDIUM] — Shared `toAgentToolResult` result adapter

**Files affected:** `src/index.ts:145-148`, `src/github.ts:151-154`
**Effort:** 20 minutes
**Saves:** The result-shaping pattern:
```typescript
return {
  content: [{ type: 'text', text: resultToText(result) }],
  details: result,
};
```
is duplicated verbatim in `callSearchMcpTool` (`src/index.ts:145-148`) and in the `github` tool's `execute()` block (`src/github.ts:151-154`). Every future tool registration will copy this pattern again. When the `AgentToolResult` shape changes (e.g., adding a `metadata` field, changing `details` type), it will require fixing every copy.

**What to build:**
```typescript
// In src/mcp-client.ts (alongside resultToText)
export function toAgentToolResult(result: SearchMcpCallResult): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: resultToText(result) }],
    details: result,
  };
}
```

Replace both inline occurrences with `toAgentToolResult(result)`.

**Why this saves work:** Each new tool registration uses this adapter instead of inlining the pattern. The `AgentToolResult` shape is defined in the Pi SDK, which can change independently of this repo — a single fix point is critical.

---

### INV-6 [MEDIUM] — `normalizeProviderPayload` motivation comment

**Files affected:** `src/payload.ts:1`
**Effort:** 5 minutes
**Saves:** `normalizeProviderPayload` is called in `src/index.ts:43` as a `before_provider_request` hook. The function is well-written and well-tested, but why it exists is not documented. Each future developer who reads this code must independently determine: is this a workaround for a Pi framework bug? A compatibility shim for a specific LLM provider? A permanent feature? This question will be asked repeatedly.

**What to add:**
```typescript
// Normalizes non-string `instructions` values to strings before provider dispatch.
// Required because some Pi SDK versions pass instructions as objects or arrays
// rather than the string the provider API expects.
export function normalizeProviderPayload(payload: unknown): unknown {
```

**Why this saves work:** One sentence stops a recurring code-archaeology cycle. If the Pi framework fixes the root cause, the comment provides the removal signal.

---

### INV-7 [MEDIUM] — Fix README tool names (B2 + B3 from issues-docs-package.md)

**Files affected:** `README.md`
**Effort:** 10 minutes
**Saves:** README currently lists `research_web_search` and `research_semantic_crawl` as tool names. Actual names in source are `web_search` and `semantic_crawl`. The `browse` and `github` tools are not documented at all. Every operator or new contributor who reads the README before running the extension will try the wrong tool names and file a bug or ask a question.

**What to fix:**
- Line 7-8: `research_web_search` → `web_search`, `research_semantic_crawl` → `semantic_crawl`
- Add entries for `browse` and `github` tools
- This is a confirmed factual error (B2, B3 in issues-docs-package.md), not a style preference

**Why this saves work:** Documentation bugs compound — every operator, every demo, every onboarding session hits the same wrong names. The fix is 4 lines.

---

## Summary Table

| Priority | Investment | Files | Effort | Blocked Work Unlocked |
|----------|-----------|-------|--------|----------------------|
| INV-1 | `SearchBackend` interface + `FakeSearchBackend` | `src/backend.ts` (new), `test/fake-backend.ts` (new), `src/mcp-client.ts`, `src/index.ts`, `src/github.ts` | ~2 hours | ~8 blocked tests, all future execute() coverage, GitHub args test |
| INV-2 | Export `buildSemanticSource` + 5 tests | `src/index.ts:159`, `test/index.test.ts` | 30 min | 5 immediately-addable tests, throw-path validation |
| INV-3 | MCP tool name contract snapshot | `src/tool-names.ts` (new), `src/index.ts`, `src/github.ts` | 30 min | Compile-time backend tool name drift detection |
| INV-4 | Shared MCP result fixtures | `test/fixtures.ts` (new), `test/mcp-client.test.ts`, `test/index.test.ts` | 45 min | Prevents per-file fixture divergence as tests grow |
| INV-5 | `toAgentToolResult` shared adapter | `src/mcp-client.ts`, `src/index.ts:145`, `src/github.ts:151` | 20 min | Single fix point for AgentToolResult shape changes |
| INV-6 | `payload.ts` motivation comment | `src/payload.ts:1` | 5 min | Stops recurring "why does this exist?" archaeology |
| INV-7 | Fix README tool names | `README.md` | 10 min | Stops operator confusion on every first-use |

**Total estimated effort: ~4.5 hours** to prevent an estimated 10–15 hours of repeated discovery and manual testing across future development cycles.

---

## Dependency Order

```
INV-2  (no dependencies — addable now)
INV-3  (no dependencies — addable now)
INV-6  (no dependencies — addable now)
INV-7  (no dependencies — addable now)
INV-5  (no dependencies — addable now, but more useful after INV-1)
INV-1  (no code dependencies, but is a prerequisite for INV-4's full value)
INV-4  (most useful after INV-1 creates test demand for fixture objects)
```

INV-2, INV-3, INV-6, INV-7 can be done in any order with no coordination. INV-1 is the gate that unlocks the largest block of future test work.

---

## What This Does NOT Cover

These investments are scoped to **preventing repeated work**. The following are bugs or defects that require immediate fixes, not future-proofing — they are documented in the prior suite reports:

- F-01/F-03/F-04: subprocess lifecycle races (`issues-runtime.md`)
- SEC-01: full `process.env` forwarded to subprocess (`issues-security.md`)
- SEC-02: unvalidated URLs in browse/crawl tools (`issues-security.md`)
- SEC-03: 4 HIGH npm audit vulnerabilities (`issues-docs-package.md`)

Those are correctness issues, not infrastructure investments.

---

## Residual Risks

1. **INV-1 backend interface** is a behavioral-neutral refactor, but it requires touching `src/index.ts`, `src/github.ts`, and `src/mcp-client.ts` simultaneously — any partial application leaves the type system in an inconsistent state. Should be done as a single atomic commit.
2. **INV-3 tool names** only catches drift if `BackendToolName` type is used at call sites — requires enforcing the type on `callSearchMcpTool`'s `name` parameter. If `callSearchMcpTool` stays typed as `string`, the constant file adds documentation value but no compile-time safety.
3. **INV-4 fixtures** have value only as tests scale past ~15 total. At the current test count (9), the ROI is marginal — build after INV-1 creates demand.

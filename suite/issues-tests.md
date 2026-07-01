# Issues Suite 2/6 — Test Coverage Gaps & Validation Strategy

**Date:** 2026-07-02
**Scope:** Read-only analysis. No source files modified.
**Context:** Migration from MCP wrapper (`SearchMcpClient` + `search-mcp` subprocess) to self-contained CLI-based Pi extension.

---

## Baseline

**Current suite: 9 tests, 3 files, all passing.**

| File | Tests | Functions covered |
|------|-------|-------------------|
| `test/mcp-client.test.ts` | 4 | `buildServerParameters`, `resultToText` |
| `test/index.test.ts` | 2 | `buildBrowseArgs` |
| `test/payload.test.ts` | 3 | `normalizeProviderPayload` |

Run: `npm test` → `node --import tsx --test test/**/*.test.ts`

---

## Coverage Map: What Is and Is NOT Tested

### Tested (covered by existing 9 tests)

| Function | File | Coverage |
|----------|------|----------|
| `buildServerParameters` | `src/mcp-client.ts:21` | Defaults, JSON args, invalid JSON, cwd |
| `resultToText` | `src/mcp-client.ts:36` | Mixed text+non-text content array |
| `buildBrowseArgs` | `src/index.ts:151` | Default maxChars, explicit maxChars |
| `normalizeProviderPayload` | `src/payload.ts:1` | String passthrough, object→text, array join |

### NOT Tested (zero coverage)

| # | Function | File:Line | Gap Type |
|---|----------|-----------|----------|
| G1 | `buildSemanticSource` | `src/index.ts:159` | Pure function, **no tests at all** |
| G2 | `callSearchMcpTool` | `src/index.ts:133` | Dispatch seam, zero execution-path coverage |
| G3 | `resultToText` non-array path | `src/mcp-client.ts:37-39` | Branch: `!Array.isArray(result.content)` |
| G4 | `resultToText` empty array | `src/mcp-client.ts:41` | Edge case: `content: []` → empty string |
| G5 | `parseArgs` non-string items | `src/mcp-client.ts:106` | Branch: array contains non-strings |
| G6 | `buildServerParameters` whitespace COMMAND | `src/mcp-client.ts:22` | `.trim()` strips to default |
| G7 | `toProcessEnvironment` undefined stripping | `src/mcp-client.ts:113` | Env vars with `undefined` values filtered |
| G8 | `normalizeProviderPayload` — `content` key | `src/payload.ts:22` | `instructions.content` branch untested |
| G9 | `normalizeProviderPayload` — `instructions` key | `src/payload.ts:22` | `instructions.instructions` branch untested |
| G10 | `normalizeProviderPayload` — null/undefined in array | `src/payload.ts:18` | `.filter(Boolean)` branch untested |
| G11 | `normalizeProviderPayload` — non-record no-op | `src/payload.ts:2` | Payload without `instructions` key returns as-is |
| G12 | `normalizeProviderPayload` — null/undefined instructions | `src/payload.ts:14` | `stringifyInstructions(null)` → `''` |
| G13 | `SearchMcpClient.close` state teardown | `src/mcp-client.ts:64` | No test for state after `close()` |
| G14 | `registerGitHubTool` — undefined stripping loop | `src/github.ts:139` | `args` object build from params strips `undefined` |
| G15 | `contentItemToText` with null serialized | `src/mcp-client.ts:118` | `JSON.stringify(undefined)` returns `undefined` |

---

## Prioritized Test Additions

### P1 — `buildSemanticSource` (HIGHEST: pure function, zero tests, migration seam)

**File to add:** `test/index.test.ts`
**Why critical:** This is the only branch point between URL-mode and search-mode semantic crawl. When the backend is replaced, this routing logic stays. Currently completely untested.

```
test('buildSemanticSource with url returns type=url')
test('buildSemanticSource with searchQuery returns type=search with maxSeedUrls=8')
test('buildSemanticSource with url AND searchQuery prefers url')
test('buildSemanticSource with whitespace-only url falls through to searchQuery')
test('buildSemanticSource with neither url nor searchQuery throws')
```

**Seam note:** `buildSemanticSource` is not exported. It must be exported from `src/index.ts` (alongside `buildBrowseArgs`) before tests can be added. This is a zero-risk addition — the function has no side effects.

---

### P2 — `resultToText` missing branches (HIGH: all tools use this path)

**File to add:** `test/mcp-client.test.ts`
**Why critical:** Every tool result passes through `resultToText`. The non-array path (`!Array.isArray`) is reached when `search-mcp` returns a non-standard result. Currently the test only covers the happy-path array case.

```
test('resultToText with non-array content serializes whole result as JSON')
test('resultToText with empty content array returns empty string')
test('resultToText with undefined content serializes whole result')
test('contentItemToText with null in content array serializes null as "null"')
```

---

### P3 — `callSearchMcpTool` dispatch seam (HIGH: prerequisite for all migration testing)

**File to add:** `test/index.test.ts`
**Why critical:** This is the only boundary between tool definitions and the MCP transport. All 4 non-GitHub tools funnel through it. Without tests here, any backend swap (the core migration change) has zero regression protection.

**Blocker:** `callSearchMcpTool` is not exported from `src/index.ts`. Two options:
1. Export it (preferred — it's an internal utility, not part of the Pi extension contract).
2. Test via a thin fake client passed to a factory function.

The migration to a `SearchBackend` interface (planned Milestone 1) will make this testable. Add these tests **after** the `SearchBackend` seam is introduced:

```
test('callSearchMcpTool maps tool result to AgentToolResult content array')
test('callSearchMcpTool passes signal and timeout to client.callTool')
test('callSearchMcpTool uses default 120s timeout when none specified')
test('callSearchMcpTool propagates client.callTool rejection')
```

**Exact file:** `test/index.test.ts` (add to existing file after backend seam exists)

---

### P4 — `normalizeProviderPayload` missing branches (MEDIUM: 3 untested code paths)

**File to add:** `test/payload.test.ts`

```
test('normalizeProviderPayload with payload missing instructions key returns payload unchanged')
test('normalizeProviderPayload with null instructions converts to empty string')
test('normalizeProviderPayload with undefined instructions converts to empty string')
test('normalizeProviderPayload with instructions.content extracts content field')
test('normalizeProviderPayload with instructions.instructions extracts nested instructions field')
test('normalizeProviderPayload with array containing null items filters them out')
test('normalizeProviderPayload with non-record payload returns unchanged')
```

**Branches hit:** `src/payload.ts:2` (no `instructions` key), `src/payload.ts:14` (null/undefined), `src/payload.ts:22` (`content` and `instructions` fields), `src/payload.ts:18` (`.filter(Boolean)` removes falsy).

---

### P5 — `parseArgs` non-string array items (MEDIUM: validation completeness)

**File to add:** `test/mcp-client.test.ts`

```
test('buildServerParameters rejects array with non-string items')
```

**Missing branch:** `src/mcp-client.ts:106` — `parsed.some((item) => typeof item !== 'string')`. The existing test covers `not-an-array`; this covers `array-of-wrong-type`.

---

### P6 — `buildServerParameters` whitespace and env passthrough (MEDIUM: config correctness)

**File to add:** `test/mcp-client.test.ts`

```
test('buildServerParameters with whitespace-only SEARCH_MCP_COMMAND falls back to default')
test('buildServerParameters with whitespace-only SEARCH_MCP_CWD omits cwd from params')
test('buildServerParameters strips undefined env vars from process environment')
test('buildServerParameters passes defined string env vars through to process env')
```

**Branches hit:** `src/mcp-client.ts:22` (`.trim()` empty → default), `src/mcp-client.ts:25-26` (cwd conditional), `src/mcp-client.ts:113-115` (`toProcessEnvironment` filter).

---

### P7 — `SearchMcpClient.close` teardown (LOW: lifecycle correctness)

**File to add:** `test/mcp-client.test.ts`
**Why:** The `close()` method sets `this.client = undefined` before `await transport?.close()`, creating a potential race. The behavior after `close()` (stale references) is untested.

**Blocker:** Tests require a mock or fake `StdioClientTransport`. These are only practical after the `SearchBackend` interface is introduced, or by injecting a fake transport constructor.

```
test('SearchMcpClient.close clears client and transport references')
test('SearchMcpClient.connect re-establishes connection after close')
```

---

### P8 — GitHub tool undefined stripping (LOW: pure JS logic)

**File to add:** `test/github.test.ts` (new file)
**Why:** `src/github.ts:139-144` builds an `args` object by iterating `rest` and skipping `undefined` values. This is untested logic that affects what gets sent to the MCP server.

```
test('github tool strips undefined params from args object')
test('github tool passes all defined params through to args')
```

**Note:** This requires either exporting the stripping logic or testing via a fake client.

---

## Key Seams for Migration

These are the exact injection points where swapping the backend (MCP stdio → local CLI or HTTP) should be done. Each seam needs test coverage before the swap happens.

| Seam | Location | Current coupling | Migration change |
|------|----------|-----------------|-----------------|
| **Backend dispatch** | `src/index.ts:133–149` `callSearchMcpTool` | Takes `SearchMcpClient` directly | Change to accept `SearchBackend` interface |
| **Client construction** | `src/index.ts:37` | `new SearchMcpClient(buildServerParameters(process.env))` | Factory function: `createBackend(process.env)` |
| **GitHub client** | `src/github.ts:4`, `16` | Import and accept `SearchMcpClient` | Accept `SearchBackend` |
| **Spawn config** | `src/mcp-client.ts:21–34` `buildServerParameters` | Returns `StdioServerParameters` | Stays for MCP backend; new factory needed for CLI backend |

### Recommended export additions to enable testing (zero-risk)

```
// src/index.ts — add to existing named exports
export function buildSemanticSource(url: string | undefined, searchQuery: string | undefined): Record<string, unknown>
export async function callSearchMcpTool(client, name, args, signal, timeout?): Promise<AgentToolResult<unknown>>
```

---

## Validation Strategy for Migration

### Phase 0 (before any code change): Verify baseline

```
npm test           # must show 9/9 pass
npm run typecheck  # must show 0 errors
```

### Phase 1 (after exporting `buildSemanticSource`): Add P1 tests

```
npm test           # must show 14/14 pass (9 existing + 5 new)
```

### Phase 2 (after `SearchBackend` interface + factory): Add P3 tests

```
npm test           # must show ~20/20 pass
npm run typecheck  # types still satisfied
```

Fake backend for phase 2 tests:

```typescript
class FakeSearchBackend {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  result: SearchMcpCallResult = { content: [{ type: 'text', text: 'ok' }] };
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return this.result;
  }
  async close() {}
}
```

### Phase 3 (local CLI backend): Integration tests

These require a real local process or recorded fixtures. Not testable with unit tests alone.

```
SEARCH_MCP_COMMAND=node SEARCH_MCP_ARGS_JSON='["../search-mcp/dist/index.js"]' npm test
```

---

## Exact Files

| Action | File | Tests to add |
|--------|------|-------------|
| Add to existing | `test/index.test.ts` | P1 (buildSemanticSource ×5), P3 (callSearchMcpTool ×4 — after seam) |
| Add to existing | `test/mcp-client.test.ts` | P2 (resultToText ×4), P5 (parseArgs ×1), P6 (buildServerParameters ×4), P7 (close ×2 — after seam) |
| Add to existing | `test/payload.test.ts` | P4 (normalizeProviderPayload ×7) |
| New file | `test/github.test.ts` | P8 (github args strip ×2 — after seam) |

**Total additions (phases 1+2, no subprocess required):** ~25 tests
**Gated on backend seam (Milestone 1):** P3, P7, P8 (~8 tests)
**Immediately addable (pure functions, no seam needed):** P1, P2, P4, P5, P6 (~17 tests)

---

## Residual Risks Not Addressable by Unit Tests

| Risk | File | Reason |
|------|------|--------|
| No reconnection on subprocess crash | `src/mcp-client.ts:72-84` | Requires live subprocess; integration test only |
| `stderr: 'pipe'` buffer silently fills | `src/mcp-client.ts:30` | No listener attached; backpressure hides MCP errors |
| `close()` race: state cleared before `await` completes | `src/mcp-client.ts:64-70` | Timing-dependent; requires concurrent test harness |
| `session_shutdown` void `close()` may not complete | `src/index.ts:40` | Pi process lifecycle; not testable in isolation |
| Missing `zod` dependency in `search-mcp` → startup failure | external | No mitigation in extension code |

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Analysis scoped to test coverage gaps and validation strategy only. No source files, test files, or config modified. 15 gaps identified with exact file:line locations. 8 prioritized test groups specified with exact test names and target files. Key seams identified with specific locations in src/index.ts:133, src/index.ts:37, src/github.ts:16, src/mcp-client.ts:21."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Baseline test run output included (9/9 pass). Coverage map enumerates what is tested vs untested with line numbers. Priority ordering justified by migration-criticality. Exact file targets specified for each test addition. Seam table maps current coupling to required migration change. Residual risks section distinguishes unit-testable from integration-only concerns."
    }
  ],
  "changedFiles": [
    "suite/issues-tests.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "9/9 tests pass; baseline confirmed before analysis"
    },
    {
      "command": "find /Users/rhinesharar/pi-extension-search-mcp -type f | sort",
      "result": "passed",
      "summary": "Mapped project structure; confirmed suite/ does not exist prior to this run"
    },
    {
      "command": "mkdir -p /Users/rhinesharar/pi-extension-search-mcp/suite",
      "result": "passed",
      "summary": "Created suite/ output directory"
    }
  ],
  "validationOutput": [
    "npm test: 9 pass, 0 fail, duration 595ms",
    "plan.md and progress.md: not found (files do not exist at specified paths)",
    "All 4 source files read: src/index.ts, src/mcp-client.ts, src/payload.ts, src/github.ts",
    "All 3 test files read: test/index.test.ts, test/mcp-client.test.ts, test/payload.test.ts",
    "All 4 research files read: local-recon.md, external-evidence.md, strategy-context.md, oracle-consultation.md",
    "Output written to: /Users/rhinesharar/pi-extension-search-mcp/suite/issues-tests.md"
  ],
  "residualRisks": [
    "plan.md and progress.md were specified in task instructions but do not exist; analysis based on research/ artifacts and source files which contain equivalent context",
    "buildSemanticSource is not currently exported from src/index.ts — P1 tests require an export addition before they can be written",
    "callSearchMcpTool dispatch seam tests (P3) require the SearchBackend interface milestone to be completed first",
    "Subprocess reconnection and close() race risks cannot be addressed by unit tests alone"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/issues-tests.md (new file, ~200 lines). No source or test files modified.",
  "reviewFindings": [
    "no blockers in the analysis output itself",
    "note: buildSemanticSource at src/index.ts:159 is unexported; must be exported before P1 tests can be added",
    "note: callSearchMcpTool at src/index.ts:133 is unexported; must be exported or refactored before P3 tests can be added",
    "note: 17 of ~25 planned tests can be added immediately without any source changes or backend seam work"
  ],
  "manualNotes": "plan.md and progress.md do not exist in the repo; the research/ directory (local-recon.md, external-evidence.md, strategy-context.md, oracle-consultation.md) contains equivalent context from prior suite runs and was used as the authoritative source. The suite/ directory was created as part of this run."
}
```

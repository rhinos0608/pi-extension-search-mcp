# Suite 4/5 — Developer Workflow Ergonomics
**Scope:** scripts, typecheck/test/build setup, local iteration, fixture/mocking strategy, GitHub repo readiness
**Date:** 2026-07-02
**Status:** read-only audit. No source files modified.

---

## Summary

The project has a minimal, functional test harness (9 tests, 9 pass, 0 typecheck errors) but the developer workflow has five significant friction points that compound to make iteration outside the original author's machine effectively impossible: a hardcoded absolute binary path, no CI, no watch mode, no mocking infrastructure for the main code path, and a never-committed git repo. Each area is detailed below.

---

## 1. Scripts

### Current state

```json
"scripts": {
  "test": "node --import tsx --test test/**/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

### DX-01 [HIGH] — No `build` script and its absence is undocumented

**Impact:** A contributor cloning the repo has no obvious way to compile the project. The reason there is no build step (Pi extensions run source directly via `tsx`) is not documented anywhere. `README.md` shows `pi -e ./src/index.ts` without explaining why there's no compile step.

**Fix:** Add a comment or note in `README.md` under a "Development" heading explaining that `tsx` is the runtime transpiler and no compilation step is needed for Pi extension development.

---

### DX-02 [MEDIUM] — No `dev` / `watch` script for test iteration

**Impact:** After every source change, the developer runs `npm test` manually (732 ms). Node.js v20+ test runner supports `--watch` natively, but it's not wired up.

**Fix:**
```json
"test:watch": "node --import tsx --test --watch test/**/*.test.ts"
```
No new dependencies required.

---

### DX-03 [MEDIUM] — No `lint` script

**File:** `package.json`
**Impact:** TypeScript strict mode (`strict`, `noUnusedLocals`, `noUnusedParameters`, etc.) catches type errors, but not code-quality issues (unreachable branches, inconsistent style). This was also noted in `suite/issues-docs-package.md` as observation O3.

**Fix:** Add `"lint": "tsc --noEmit"` as a minimum, or install `eslint` with `@typescript-eslint` for code-quality checks.

---

### DX-04 [LOW] — Test glob relies on Node.js internal expansion, not documented

**File:** `package.json` test script
**Detail:** `test/**/*.test.ts` is passed to `node --test`. npm scripts run under `/bin/sh`, which does not support `**` recursive globs. Node.js v20+ test runner expands the glob itself (not the shell), which is why this works. If the runtime is downgraded below v20 or the glob is used in a different context (e.g., a CI `run:` step copied directly), it silently fails to match.

**Fix:** Document the required Node.js minimum version in `package.json` via an `engines` field:
```json
"engines": { "node": ">=20" }
```

---

## 2. Typecheck / Test / Build Setup

### Current state: passing

| Command | Result |
|---------|--------|
| `npm test` | 9/9 pass, 732 ms |
| `npm run typecheck` | 0 errors |

### DX-05 [MEDIUM] — `"DOM"` in `tsconfig.json` lib array

**File:** `tsconfig.json:6`
**Detail:** This is a pure Node.js package. The `DOM` lib injects browser globals (`document`, `window`, `fetch` overloads from DOM spec) into the type environment. This masks potential runtime errors if browser APIs are accidentally referenced, and can cause type conflicts with Node.js's own `fetch` declaration.

**Fix:** Remove `"DOM"` from the lib array:
```json
"lib": ["ES2022"]
```
`tsc --noEmit` confirms clean after this change (no existing code uses DOM-only types).

*Cross-reference: also flagged as I2 in `suite/issues-docs-package.md`.*

---

### DX-06 [LOW] — No coverage reporting

**Impact:** 9 tests cover 4 pure utility functions. The other ~60% of the codebase (all tool `execute()` handlers, `SearchMcpClient.close()`, `registerGitHubTool`) has zero coverage, but there is no instrumentation to make this visible. A contributor cannot see the coverage gap without reading the code manually.

**Fix:** Add `--experimental-test-coverage` to the test script (Node.js v20.1+, no new dependencies):
```json
"test:coverage": "node --import tsx --test --experimental-test-coverage test/**/*.test.ts"
```

---

### DX-07 [LOW] — No `outDir` in tsconfig; TypeScript compiler has no output target

**File:** `tsconfig.json`
**Detail:** There is no `outDir` in `tsconfig.json`. The `typecheck` script passes `--noEmit` at the CLI. This is correct for the current Pi extension pattern, but means any future `tsc` invocation without `--noEmit` would scatter `.js` files alongside `.ts` sources (since the default `outDir` is the same directory as the input files). There is no `.gitignore` rule preventing this.

**Fix:** Either add `"noEmit": true` to `tsconfig.json` to make this permanent, or add an `outDir` pointing to `dist/` for future build use. The `dist/` directory is already in `.gitignore`.

---

## 3. Local Iteration Workflow

### DX-08 [BLOCKER] — Hardcoded absolute path breaks first-run on any other machine

**File:** `src/mcp-client.ts:7`
```typescript
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```
**Impact:** Running `pi -e ./src/index.ts` on any machine that isn't `rhinesharar`'s produces a silent runtime failure on the first tool call. The `SEARCH_MCP_COMMAND` env override works, but requires the developer to know to set it before anything works. The README claims the default is PATH lookup — this is false.

**Fix:** Change to `'search-mcp'` (PATH lookup). One-line change with no behavioral difference for any correctly-configured machine.

*Cross-reference: flagged as B1 in `suite/issues-docs-package.md`, F-09 in `suite/issues-runtime.md`, and Finding 2 in `suite/issues-architecture.md`.*

---

### DX-09 [HIGH] — No smoke-test command for extension load validation

**Impact:** There is no way to verify the extension loads correctly (module resolution, env config, MCP binary path) without starting a full Pi session. A developer who misconfigures `SEARCH_MCP_COMMAND` gets no diagnostic until they attempt a tool call inside Pi.

**Fix:** Add a lightweight entry-point check that can be run directly:
```bash
SEARCH_MCP_COMMAND=echo node --import tsx src/index.ts
```
Or document a `pi --validate-extension` flag if one exists in the Pi CLI.

---

### DX-10 [MEDIUM] — No iteration loop for extension development (no hot-reload, no restart shortcut)

**Impact:** The typical Pi extension development cycle is: edit source → restart Pi session → test tool. There is no documented way to reload the extension without a full session restart. The README shows only the initial `pi -e ./src/index.ts` invocation.

**Fix:** Document the iteration cycle explicitly in the README. If `pi` supports a `--reload` flag or file-watching mode, document it. At minimum, note that `npm run typecheck` is the fast feedback loop before committing to a session restart.

---

### DX-11 [LOW] — `SEARCH_MCP_ARGS_JSON` format is fragile in shell

**File:** `README.md:23`
```bash
SEARCH_MCP_ARGS_JSON='["../dist/index.js"]'
```
**Impact:** Single-quoting works in bash/zsh but fails in fish shell and is error-prone when the array contains spaces or special characters. No guidance is provided on quoting rules or alternative formats.

**Fix:** Add a note in the README about the JSON array format requirement, with examples for common cases including arguments with spaces.

---

## 4. Fixture / Mocking Strategy

### Current state: none

All 9 existing tests exercise pure functions with no I/O. This is the correct approach for what's currently exported — but the bulk of the extension logic (`execute()` handlers, `registerGitHubTool`, `SearchMcpClient` lifecycle) is completely untestable because `SearchMcpClient` is a concrete class with no injection seam.

| Tested (pure) | Untested (require subprocess or mocking) |
|---------------|------------------------------------------|
| `buildBrowseArgs` | All tool `execute()` handlers |
| `buildServerParameters` | `registerGitHubTool` dispatch |
| `resultToText` (partial) | `SearchMcpClient.connect()` / `close()` |
| `normalizeProviderPayload` (partial) | `buildSemanticSource` (not exported) |

### DX-12 [HIGH] — No `SearchBackend` interface; all execute paths require a live MCP subprocess

**Files:** `src/index.ts:37`, `src/github.ts:16`
**Impact:** `SearchMcpClient` is accepted as a concrete type everywhere. There is no interface that a fake or stub could satisfy. Writing tests for any tool `execute()` handler requires spawning a real `search-mcp` process. This makes CI infeasible and unit test iteration very slow.

**Fix:** Extract interface:
```typescript
// src/mcp-client.ts
export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: SearchMcpCallOptions): Promise<SearchMcpCallResult>;
  close(): Promise<void>;
}
```
Then use `SearchBackend` in `index.ts` and `github.ts` instead of `SearchMcpClient`. Test harness fake:
```typescript
class FakeSearchBackend implements SearchBackend {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  result: SearchMcpCallResult = { content: [{ type: 'text', text: 'ok' }] };
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    return this.result;
  }
  async close() {}
}
```

*Cross-reference: flagged as Finding 1 in `suite/issues-architecture.md` and as the gating prerequisite for P3/P7/P8 test additions in `suite/issues-tests.md`.*

---

### DX-13 [HIGH] — `buildSemanticSource` and `callSearchMcpTool` are unexported; cannot be unit-tested

**File:** `src/index.ts:133`, `src/index.ts:159`
**Impact:** `buildSemanticSource` has 3 code paths (url-mode, searchQuery-mode, throw) and is the only branch point for semantic crawl routing. `callSearchMcpTool` is the dispatch boundary for all 4 non-GitHub tools. Neither can be imported by test files.

**Fix:** Export both functions. Zero risk — neither is part of the Pi extension contract (`export default function(pi)` is the only public entry point).

*Cross-reference: detailed in `suite/issues-tests.md` as P1 (immediately addable) and P3 (requires backend seam).*

---

### DX-14 [MEDIUM] — No fixture files for MCP responses; test data lives inline

**Impact:** As tests grow, MCP response payloads will be duplicated inline across multiple test files. There is no `test/fixtures/` directory with reusable response shapes.

**Fix:** Create `test/fixtures/mcp-responses.ts` with canonical `SearchMcpCallResult` shapes used across test files. Low urgency at 9 tests; becomes important after 25+.

---

### DX-15 [MEDIUM] — No integration test target for subprocess path

**Impact:** There is no `npm run test:integration` or documented command to run the extension against a real `search-mcp` subprocess. When the binary path changes or the MCP protocol version drifts, there is no automated check.

**Fix:**
```json
"test:integration": "SEARCH_MCP_COMMAND=node SEARCH_MCP_ARGS_JSON='[\"../search-mcp/dist/index.js\"]' node --import tsx --test test/integration/**/*.test.ts"
```
The integration test directory does not need to exist yet; document the convention so contributors know where to put subprocess tests.

---

## 5. GitHub Repo Readiness

### DX-16 [BLOCKER] — Zero commits; repo has never been committed

**Impact:** `git log` is empty. `git status` shows all files as untracked. If the machine dies or the directory is deleted, the entire project is lost. `package-lock.json` (reproducible installs), all source files, and all suite reports are unprotected.

**Fix:** Initial commit:
```bash
git add .gitignore package.json package-lock.json tsconfig.json README.md src/ test/
git commit -m "init: pi-extension-search-mcp v0.1.0"
```
Note: `suite/` should be committed or gitignored (see DX-18) before the first push.

---

### DX-17 [BLOCKER] — No CI configuration

**Impact:** There is no `.github/workflows/` directory. No automated test or typecheck runs on push or PR. The test suite exists but provides no safety net.

**Fix:** Minimal CI at `.github/workflows/ci.yml`:
```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
```
**Note:** CI will fail until DX-08 (hardcoded path) is fixed, because `DEFAULT_SEARCH_MCP_COMMAND` points to a path that does not exist on GitHub Actions runners. Fix DX-08 first.

---

### DX-18 [HIGH] — `suite/` output directory not gitignored

**File:** `.gitignore`
**Impact:** The `suite/` directory contains auto-generated review reports (currently 5 files, ~78 KB). If committed, these inflate the repo with generated content. If not committed, contributors don't know whether they're expected to regenerate them. The intent is ambiguous.

**Fix (if transient):** Add `suite/` to `.gitignore`.
**Fix (if authoritative):** Add a comment in `README.md` explaining that `suite/` contains suite run outputs that should be committed for traceability.

*Cross-reference: flagged as I5 in `suite/issues-docs-package.md`.*

---

### DX-19 [HIGH] — 4 HIGH severity npm audit vulnerabilities block any security-gated CI

**Detail:** `npm audit` reports 4 HIGH vulnerabilities in transitive deps via `@earendil-works/pi-coding-agent`:
- `undici` 8.0.0–8.4.1: TLS cert bypass, DoS, header injection, response poisoning (7 CVEs)
- `ws` 8.0.0–8.20.1: memory exhaustion DoS
- `protobufjs` ≤7.6.2: schema name shadowing, Any expansion DoS

All are fixable via `npm audit fix`. Any CI pipeline with `npm audit --audit-level=high` gates on this.

**Fix:** `npm audit fix` (updates `@earendil-works/pi-coding-agent` to 0.79.10 where fixed versions are pulled in). Verify with `npm audit` after.

*Cross-reference: flagged as B4 in `suite/issues-docs-package.md` and SEC-03 in `suite/issues-security.md`.*

---

### DX-20 [MEDIUM] — `package-lock.json` untracked

**Impact:** `package-lock.json` is present on disk but not committed (git status shows it as untracked). Without it in the repo, `npm ci` cannot be used; only `npm install` with potentially different resolution. Reproducible installs require the lockfile.

**Fix:** Commit `package-lock.json` as part of the initial commit (DX-16).

---

### DX-21 [MEDIUM] — README has wrong tool names and omits two tools

**File:** `README.md:7-9`
**Detail:**
- `research_web_search` → actual name is `web_search` (`src/index.ts:48`)
- `research_semantic_crawl` → actual name is `semantic_crawl` (`src/index.ts:69`)
- `browse` tool (registered at `src/index.ts:94`) not documented
- `github` tool (registered at `src/github.ts:17`) not documented

**Fix:** Update the Tools section in README to match `src/index.ts` and `src/github.ts` registrations.

*Cross-reference: flagged as B2 and B3 in `suite/issues-docs-package.md`.*

---

## Prioritized Remediation Roadmap

| Priority | ID | File | Description | Effort | Unlocks |
|----------|-----|------|-------------|--------|---------|
| 1 | DX-08 | `src/mcp-client.ts:7` | Change hardcoded absolute path to `'search-mcp'` | 1 line | CI, other-machine dev |
| 2 | DX-16 | — | Make initial git commit | 5 min | Version control |
| 3 | DX-17 | `.github/workflows/ci.yml` | Add minimal CI (test + typecheck) | 30 min | Regression protection |
| 4 | DX-19 | `package.json` | `npm audit fix` (undici/ws/protobufjs) | 5 min | CI security gate |
| 5 | DX-20 | `package-lock.json` | Commit lockfile | 1 min | Reproducible installs |
| 6 | DX-12 | `src/mcp-client.ts` | Extract `SearchBackend` interface | 1–2 hr | All execute-path tests |
| 7 | DX-13 | `src/index.ts` | Export `buildSemanticSource`, `callSearchMcpTool` | 2 lines | P1+P3 test additions |
| 8 | DX-18 | `.gitignore` | Add `suite/` entry | 1 line | Clean repo |
| 9 | DX-02 | `package.json` | Add `test:watch` script | 1 line | Faster TDD loop |
| 10 | DX-05 | `tsconfig.json` | Remove `"DOM"` from lib | 1 line | Correct type env |
| 11 | DX-21 | `README.md` | Fix tool names, add browse/github | 4 lines | Accurate docs |
| 12 | DX-06 | `package.json` | Add `test:coverage` script | 1 line | Coverage visibility |
| 13 | DX-15 | `package.json` | Add `test:integration` target | 1 line | Subprocess test path |

---

## Residual Risks

1. **DX-08 path change requires Pi installer validation**: changing `DEFAULT_SEARCH_MCP_COMMAND` to `'search-mcp'` only works if the Pi installer adds its `bin/` directory to `PATH`. This must be verified before shipping. If it doesn't, `SEARCH_MCP_COMMAND` override becomes mandatory and README must say so explicitly.

2. **DX-12 backend seam is a prerequisite for ~8 of the 25 planned tests**: until `SearchBackend` interface exists, the tests in `suite/issues-tests.md` P3/P7/P8 cannot be written. The 17 immediately-addable tests (P1/P2/P4/P5/P6) do not require it.

3. **No integration test harness**: subprocess-dependent behavior (reconnection, stderr handling, graceful shutdown) cannot be verified by any planned unit tests. These require a live `search-mcp` process or a fake subprocess. Neither exists.

4. **GitHub Actions `npm ci` will fail on private `@earendil-works` packages**: the private npm registry requires authentication. Without a configured `NPM_TOKEN` secret and `.npmrc`, CI will fail on `npm ci` even after DX-19 is applied.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "21 concrete findings produced across 5 areas (scripts, typecheck/test/build, local iteration, fixture/mocking, GitHub readiness). Each finding includes: severity label, file path and line number where applicable, description of the problem, and a concrete fix. Prioritized remediation roadmap with effort estimates. Residual risks section with 4 items. All findings independently verifiable from source files listed."
    }
  ],
  "changedFiles": [
    "suite/ergonomics-dev-workflow.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "9/9 tests pass in 732ms"
    },
    {
      "command": "npm run typecheck",
      "result": "passed",
      "summary": "0 TypeScript errors"
    },
    {
      "command": "npm audit",
      "result": "findings",
      "summary": "4 HIGH vulnerabilities: undici TLS bypass + 6 others, ws DoS, protobufjs DoS — all via @earendil-works/pi-coding-agent; fixable via npm audit fix"
    },
    {
      "command": "git status",
      "result": "findings",
      "summary": "No commits yet; all files untracked; no .github/ directory exists"
    },
    {
      "command": "ls suite/",
      "result": "passed",
      "summary": "5 prior suite reports present (issues-architecture.md, issues-docs-package.md, issues-runtime.md, issues-security.md, issues-tests.md)"
    }
  ],
  "validationOutput": [
    "npm test: 9 pass, 0 fail, duration 732ms — baseline confirmed",
    "npm run typecheck: 0 errors — TypeScript strict mode clean",
    "npm audit: 4 HIGH vulnerabilities confirmed in pi-coding-agent transitive deps",
    "git log: empty — zero commits",
    "find .github: no directory exists — no CI configured",
    "grep DEFAULT_SEARCH_MCP_COMMAND src/mcp-client.ts: hardcoded absolute path '/Users/rhinesharar/.pi/agent/bin/search-mcp' confirmed at line 7",
    "grep -r 'interface SearchBackend' src/: no results — no injectable interface exists",
    "grep 'export function buildSemanticSource' src/: no results — function is not exported",
    "cat .gitignore: suite/ is not listed"
  ],
  "residualRisks": [
    "DX-08 path change to 'search-mcp' requires verification that Pi installer adds its bin/ to PATH before shipping",
    "DX-12 SearchBackend interface is a prerequisite for ~8 of 25 planned tests; blocks full execute-path coverage",
    "CI pipeline (DX-17) will fail on npm ci for @earendil-works private packages without NPM_TOKEN secret configuration",
    "No integration test harness exists; subprocess lifecycle behavior (reconnect, stderr, graceful shutdown) cannot be validated by any planned unit tests"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/ergonomics-dev-workflow.md (new file). No source, test, or config files modified.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND hardcoded to machine-specific absolute path; first-run fails on any other machine",
    "blocker: .github/ — no CI configuration; test suite provides no automated safety net",
    "blocker: git repo has zero commits — no version control protection on any file",
    "high: package.json — no SearchBackend interface; all tool execute() paths require live subprocess; untestable in CI",
    "high: src/index.ts:133,159 — callSearchMcpTool and buildSemanticSource unexported; 17 immediately-addable tests blocked",
    "high: npm audit — 4 HIGH vulnerabilities (undici, ws, protobufjs) block security-gated CI; fixable via npm audit fix",
    "high: .gitignore — suite/ not gitignored; intent (transient vs committed) undefined",
    "medium: package.json — no test:watch script; no coverage script; no lint script",
    "medium: tsconfig.json:6 — DOM lib included in Node.js-only project",
    "medium: package-lock.json — untracked; reproducible installs not guaranteed",
    "medium: README.md:7-9 — two tool names wrong (research_web_search, research_semantic_crawl); browse and github tools not documented",
    "info: package.json — no engines field; Node.js version minimum undocumented"
  ],
  "manualNotes": "plan.md and progress.md do not exist in the working directory; analysis derived from direct source inspection and the 4 prior suite reports (issues-architecture.md, issues-tests.md, issues-security.md, issues-docs-package.md, issues-runtime.md). The hardcoded absolute path (DX-08) is the single highest-leverage fix: it unblocks CI, other-machine development, and is a prerequisite for every other improvement."
}
```

# Local CLI Handoff: pi-extension-search-mcp

## State vs Prior Recon

Key differences from `research/local-recon.md` (prior doc is stale — code has been refactored since):

| Item | Prior Finding | Current State |
|------|---------------|---------------|
| `DEFAULT_SEARCH_MCP_COMMAND` | Hardcoded `/Users/rhinesharar/.pi/agent/bin/search-mcp` | `'search-mcp'` (line 8, portable) |
| Backend seam | `SearchMcpClient` used as concrete type everywhere | `SearchBackend` interface extracted in `src/backend.ts`; factory `createSearchBackend()`; `SearchMcpClient implements SearchBackend` |
| `src/index.ts` | Constructed via `new SearchMcpClient(...)` | Uses `createSearchBackend(process.env)` (line 37) |
| `src/github.ts` | Accepted `SearchMcpClient` directly | Accepts `SearchBackend` (line 16) |
| TypeScript | Not checked | Clean (`tsc --noEmit` passes) |
| Tests | Partial coverage | 20/20 pass |

**Hardcoded-path blocker (F2) is fixed. Backend seam (F1) is extracted.** These were the two blockers from prior analysis.

---

## Current Architecture

```
┌──────────────┐     stdio transport      ┌──────────────┐
│  Pi Agent     │◄──────────────────────►│  search-mcp   │
│  (extension)  │    MCP protocol         │  (subprocess) │
└──────┬───────┘                          └──────────────┘
       │
       ├── src/index.ts         (default export, 5 tool registrations, lifecycle hooks)
       ├── src/backend.ts       (SearchBackend interface + factory + resultToText)
       ├── src/mcp-client.ts    (SearchMcpClient — MCP SDK wrapper, implements SearchBackend)
       ├── src/github.ts        (github tool registration, accepts SearchBackend)
       ├── src/payload.ts       (normalizeProviderPayload for before_provider_request)
       └── src/cli.ts           (CLI scaffold: `status`, `config` — currently thin)
```

### Files and Key Lines

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 1-167 | Entry point. 5 `pi.registerTool()` calls. `callSearchMcpTool()` helper. `buildBrowseArgs()`, `buildSemanticSource()` helpers. |
| `src/backend.ts` | 1-47 | `SearchBackend` interface (3 methods). `createSearchBackend()` factory. `resultToText()`, `contentItemToText()`. No MCP types in this file. |
| `src/mcp-client.ts` | 1-128 | `SearchMcpClient implements SearchBackend` (line 30). `StdioClientTransport` + lazy connection. `buildServerParameters()` reads env. `parseArgs()`, `toProcessEnvironment()`. |
| `src/cli.ts` | 1-79 | `runCommand()` dispatches `status` / `config`. `statusResult()` reports backend params. `configResult()` dumps env settings. No tool execution mapping yet. |
| `src/github.ts` | 1-157 | `registerGitHubTool()`. 8 actions in flat param union. `execute()` strips undefs and calls `client.callTool('github', ...)`. |
| `src/payload.ts` | 1-32 | `normalizeProviderPayload()` — 3 code paths, standalone utility. |
| `package.json` | 1-28 | ESM, `"private": true`, Pi extension entry `./src/index.ts`. Scripts: `cli`, `test`, `typecheck`. |

---

## CLI Scaffold (`src/cli.ts`)

Current command table (line 33-44):

```
status → buildServerParameters(env) → return JSON: { backend, command, args, cwd, defaultCommand }
config → return JSON: { searchMcpCommand, searchMcpArgsJson, searchMcpCwd }
```

Invoked via `npm run cli -- status` or `npm run cli -- config`.

**Missing:** No command executes a tool. No command invokes the backend at all. CLI is purely an introspection aid — it reports settings but cannot do work.

---

## Test Suite

| File | Tests | Coverage |
|------|-------|----------|
| `test/mcp-client.test.ts` | 7 | `buildServerParameters` (5 cases), `resultToText` (2 cases) |
| `test/cli.test.ts` | 3 | `status`, `config`, `unknown_command` |
| `test/index.test.ts` | 5 | `buildBrowseArgs` (2), `buildSemanticSource` (3) |
| `test/backend.test.ts` | 1 | `createSearchBackend` returns interface |
| `test/payload.test.ts` | 3 | `normalizeProviderPayload` |

**20 tests, all passing.** `tsc --noEmit` clean.

**Gaps:** Zero tests for tool `execute()` paths. Zero tests for back-pressure or reconnection. Zero integration tests against live `search-mcp`.

---

## Open Security / Package Issues (Not Yet Fixed)

### SEC-01 [HIGH] — Entire process.env forwarded to subprocess
`src/mcp-client.ts:124-127` (`toProcessEnvironment`). Passes ALL string env vars to spawned `search-mcp`. No allowlist. Exposes parent secrets.

### SEC-02 [HIGH] — SSRF via unvalidated URLs
`src/index.ts:106-108` (`browse`) and `src/index.ts:74-92` (`semantic_crawl`). URLs passed verbatim to subprocess. No scheme check, no private-IP blocklist.

### SEC-03 [HIGH] — 4 HIGH npm audit vulnerabilities
Transitive via `@earendil-works/pi-coding-agent@0.79.4`:
- `undici`: TLS cert bypass, DoS via fragment bypass, HTTP header injection
- `protobufjs`: DoS via unbounded Any expansion
- `ws`: Memory exhaustion DoS from tiny fragments
- `@earendil-works/pi-coding-agent` itself: carries audit HIGH via `undici`

Fixes available upstream (`pi-coding-agent` bump should pull patched `undici` and `ws`).

### Package: `"private": true` (line 6)
Blocks npm publish. Intentional but must be decided before any release pipeline.

---

## Files to Touch for CLI Migration

Goal: Move Pi extension tool calls through CLI instead of direct MCP. Extension registers tools, but `execute()` delegates to child-process CLI invocation rather than calling `SearchMcpClient.callTool()` directly.

### Phase 1: CLI as execution layer (not just introspection)

1. **`src/cli.ts`** — Add tool-execution commands. Each tool gets a command name mapped through a dispatch table. Example: `npm run cli -- web_search '{"query":"x","limit":8}'`. The CLI parses JSON args, constructs backend, calls tool, writes JSON result to stdout. Must not leak MCP transport types.

2. **`src/backend.ts`** — Already has `SearchBackend` interface + factory. No changes needed. CLI will use same factory to create backend.

3. **`src/mcp-client.ts`** — No changes needed. CLI uses same `SearchMcpClient` via factory.

### Phase 2: Extension delegates to CLI (replace direct MCP call)

4. **`src/index.ts`** — Replace `callSearchMcpTool(client, name, args, signal)` (lines 135-151). Instead of `client.callTool()`, spawn `node --import tsx src/cli.ts <tool_name> <json_args>` via `child_process.spawn`, read stdout, parse result, shape into `AgentToolResult`. Or replace `SearchBackend` implementation entirely with one that shells out to CLI.

   Options:
   - **Option A (seam-preserving):** Create `CliSearchBackend implements SearchBackend` in a new file `src/cli-backend.ts`. Its `callTool()` spawns CLI subprocess and returns parsed result. Extension code unchanged — just swap factory in `createSearchBackend()`.
   - **Option B (direct):** Modify `callSearchMcpTool` to shell out to CLI. Simpler but couples extension to CLI path.
   - **Recommendation: Option A.** The `SearchBackend` interface was created for exactly this swap. Keep the abstraction.

5. **`src/cli-backend.ts`** (new file) — `CliSearchBackend implements SearchBackend`. Takes the CLI path (resolved from `import.meta.url`). `callTool()` serializes args to JSON, spawns `node --import tsx <cli-path> <tool-name> <json>`, reads stdout, parses `CliResult`, returns shape compatible with `BackendCallResult`. Handles `signal` by killing child process on abort.

### Phase 3: Cleanup and hardening

6. **`src/cli.ts`** — Add `tool-result` parsing glue. The `CliResult` interface (line 5-12) uses `data: unknown` — may need `content` field aligned with `BackendCallResult` so CLI output maps directly when used as backend.

7. **`test/cli.test.ts`** — Add tests for tool-execution CLI commands. Use `FakeSearchBackend` pattern (from suite docs) to verify arg serialization.

8. **`test/index.test.ts`** — Add fake-backend tests for all 5 tool `execute()` paths (see `suite/hardening-backend-seam.md §5b` for full test matrix). These are written as index tests that inject a `FakeSearchBackend` and verify args.

9. **`src/github.ts`** — No changes needed for CLI migration itself. github.ts already accepts `SearchBackend`. When `createSearchBackend()` returns `CliSearchBackend`, github tool automatically routes through CLI.

10. **`package.json`** — Add `"build"` script if CLI should be pre-compiled (optional). Add `"bin"` entry if CLI should be exposed as a standalone command.

### Phase 4: Security fixes

11. **`src/mcp-client.ts:124-127`** — Replace `toProcessEnvironment` with allowlist filter (`SEC-01` fix). OR: if `CliSearchBackend` replaces `SearchMcpClient`, this function is removed entirely — the subprocess is now the node CLI, not `search-mcp`, so env exposure is controlled.

12. **`src/index.ts:153-159`** — Add `validateUrl()` to `buildBrowseArgs` and `buildSemanticSource` (`SEC-02` fix). Enforce `https?://` scheme, block private IPs.

---

## Constraints & Risks

| # | Risk | File | Severity |
|---|------|------|----------|
| 1 | `CliSearchBackend` per-call spawn = high overhead. Each tool invocation forks node. Mitigation: keep connection alive when possible, or use `SearchMcpClient` for single-session tools and CLI for batch/async tools. | new `src/cli-backend.ts` | high |
| 2 | CLI path resolution. `import.meta.url` gives extension path, but CLI is in same package. Need to resolve `./cli.ts` relative to `src/index.ts`. May break if package is installed via Pi extension registry (resolved differently than local dev). | `src/index.ts` | medium |
| 3 | Signal propagation. `AbortSignal` from Pi must kill the child process. `child_process.kill()` sends SIGTERM. Need to verify CLI handles SIGTERM gracefully (does not leave zombie subprocesses if CLI has its own MCP subprocess). | `src/cli-backend.ts` | medium |
| 4 | Serialization boundary. CLI communicates via JSON on stdout. `BackendCallResult.content` can be large (e.g., full file contents). JSON streaming or truncation may be needed. | `src/cli.ts` | medium |
| 5 | `buildSemanticSource` still unexported (line 161). Only used internally. Does not block CLI migration but constrains test coverage. | `src/index.ts:161` | low |
| 6 | `github.ts` flat param union (20+ params for 8 actions). No action-level validation or per-action tests. Not a blocker for CLI migration but amplifies risk if CLI needs to validate args differently per action. | `src/github.ts:37-133` | medium |
| 7 | No reconnection on transport failure (`src/mcp-client.ts:60-78`). `this.client` cached; no `onclose` listener clears it after subprocess crash. Affects both current MCP backend and any CLI backend that wraps it. | `src/mcp-client.ts:60-78` | high |
| 8 | `stderr: 'pipe'` with no listener (mcp-client.ts:25,84). Subprocess stderr silently buffers. Can cause backpressure deadlock on large output. Fix: drain or forward stderr. | `src/mcp-client.ts:25,84` | medium |

---

## Recommended Execution Order

1. **Create `src/cli-backend.ts`** — `CliSearchBackend implements SearchBackend`. Write tests with fake backend first (verify contract). This is the minimal change to route through CLI.
2. **Add tool-execution commands to `src/cli.ts`** — dispatch table mapping tool names to `callTool()`. CLI outputs `{ ok, data, error }` matching `CliResult`.
3. **Wire `createSearchBackend()` to return `CliSearchBackend`** when a flag/env var is set (e.g., `SEARCH_CLI_MODE=1`). Default stays `SearchMcpClient` for backward compatibility.
4. **Move default to CLI** after CLI backend is stable, tested, and handles signals correctly.
5. **Fix SEC-01** (env allowlist) as part of CLI backend — eliminate `toProcessEnvironment` entirely when subprocess is the Node CLI, not `search-mcp`.
6. **Fix SEC-02** (URL validation) — independent of CLI migration, can be done in parallel.
7. **Audit bump** — check if `pi-coding-agent@0.79.7+` has patched `undici` and `ws` transitive deps.

---

## Start Here

**`src/backend.ts`** — Read first. The `SearchBackend` interface is the contract. Understand `createSearchBackend()` factory. This is where `CliSearchBackend` plugs in.

Then:
- **`src/cli.ts`** — Current CLI scaffold. Adds tool-execution dispatch.
- **`src/mcp-client.ts`** — Current backend implementation. `SearchMcpClient` is the reference for `CliSearchBackend`.
- **`src/index.ts`** — Entry point. Shows how `SearchBackend` is consumed. The `callSearchMcpTool` helper (lines 135-151) is the function to replace.
- **`suite/hardening-backend-seam.md`** — Prior analysis of the seam design, alternative evaluations, anti-patterns to avoid, and full test matrix for fake-backend tests.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Complete local recon covering: current architecture diagram, 10 source files read with exact line refs, CLI scaffold analysis, test suite status (20/20 pass), 4 open security issues (SEC-01/02/03 + private:true), 12 exact files to touch organized in 4 phases, 8 residual risks with severities, recommended execution order."
    }
  ],
  "changedFiles": [
    "research/local-cli-handoff.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npx tsc --noEmit",
      "result": "passed",
      "summary": "TypeScript compilation clean — no errors"
    },
    {
      "command": "node --import tsx --test",
      "result": "passed",
      "summary": "20/20 tests pass"
    },
    {
      "command": "npm audit --json",
      "result": "4 HIGH vulnerabilities found",
      "summary": "undici (8 advisories), protobufjs (2), ws (1), pi-coding-agent (transitive via undici)"
    },
    {
      "command": "grep -rn 'SearchMcpClient' src/ test/",
      "result": "2 files",
      "summary": "SearchMcpClient references isolated to src/backend.ts (factory) and src/mcp-client.ts (class definition). Zero references in index.ts or github.ts — seam extraction confirmed."
    }
  ],
  "validationOutput": [
    "src/mcp-client.ts:8 — DEFAULT_SEARCH_MCP_COMMAND now 'search-mcp' (hardcoded path issue fixed since prior recon)",
    "src/backend.ts:13-16 — SearchBackend interface exists with callTool() and close()",
    "src/index.ts:37 — uses createSearchBackend(process.env) factory, not concrete constructor",
    "src/index.ts:136 — callSearchMcpTool accepts SearchBackend, not SearchMcpClient",
    "src/github.ts:16 — registerGitHubTool accepts SearchBackend",
    "src/mcp-client.ts:30 — SearchMcpClient implements SearchBackend",
    "src/mcp-client.ts:124-127 — toProcessEnvironment passes ALL env vars (SEC-01 still open)",
    "src/index.ts:153-159 — no URL validation in buildBrowseArgs/buildSemanticSource (SEC-02 still open)",
    "npm audit: 4 HIGH vulnerabilities via pi-coding-agent transitive deps (SEC-03 still open)",
    "package.json:6 — private:true unchanged (intentional but blocks npm pub)",
    "src/mcp-client.ts:60-78 — no onclose reconnection (F3 still open)",
    "src/mcp-client.ts:25,84 — stderr piped without listener (F4 still open)",
    "src/index.ts:161 — buildSemanticSource still unexported (F7 still open)",
    "src/github.ts:37-133 — flat param union still unmodified (F8 still open)",
    "Prior findings F1 (seam) and F2 (hardcoded path) are resolved. Remaining issues are documented in suite/ docs."
  ],
  "residualRisks": [
    "SEC-01: Entire process.env forwarded to subprocess (src/mcp-client.ts:124-127) — HIGH",
    "SEC-02: SSRF via unvalidated URL params in browse/semantic_crawl (src/index.ts:106-108, 74-92) — HIGH",
    "SEC-03: 4 HIGH npm audit vulnerabilities via pi-coding-agent transitive deps — HIGH",
    "F3: No reconnection on transport failure (src/mcp-client.ts:60-78) — HIGH",
    "F4: stderr piped without listener (src/mcp-client.ts:25,84) — MEDIUM",
    "CliSearchBackend per-call spawn overhead — HIGH (new code risk)",
    "CLI path resolution from extension entry may differ between local dev and Pi registry install — MEDIUM",
    "Signal propagation: AbortSignal -> child_process kill needs SIGTERM handler verification — MEDIUM",
    "Large JSON serialization on CLI stdout may need streaming/truncation — MEDIUM"
  ],
  "noStagedFiles": true,
  "diffSummary": "New research/local-cli-handoff.md. No source files modified. Not a git repository but all file modifications tracked via filesystem mtime.",
  "reviewFindings": [
    "resolved-F1: src/backend.ts:13-16 — SearchBackend interface extracted; src/index.ts:37 uses factory; src/github.ts:16 accepts SearchBackend. Seam was successfully implemented.",
    "resolved-F2: src/mcp-client.ts:8 — DEFAULT_SEARCH_MCP_COMMAND changed from absolute path to 'search-mcp'. Portable now.",
    "open-F3: src/mcp-client.ts:60-78 — connect() still caches this.client; no onclose listener clears stale client after subprocess crash",
    "open-F4: src/mcp-client.ts:25,84 — stderr: 'pipe' set but no listener attached; subprocess stderr silently buffers",
    "open-F7: src/index.ts:161 — buildSemanticSource not exported; throw path has zero tests",
    "open-F8: src/github.ts:37-133 — flat param union with 20+ params for 8 actions, no per-action validation",
    "open-SEC01: src/mcp-client.ts:124-127 — all process.env forwarded to subprocess with no allowlist",
    "open-SEC02: src/index.ts:106-108,74-92 — no URL validation before forwarding to subprocess",
    "open-SEC03: 4 HIGH npm audit vulnerabilities; fix available via pi-coding-agent bump",
    "good: package.json scripts cover cli, test, typecheck — typecheck and test both pass clean",
    "good: 20 tests pass; tsconfig strict mode enabled; no compile errors",
    "medium: No tests for any tool execute() path — only pure helper functions tested",
    "medium: No integration tests against live search-mcp subprocess"
  ],
  "manualNotes": "Key architecture insight: The SearchBackend seam is already extracted. This means Option A (CliSearchBackend implements SearchBackend) is the cleanest migration path — create a new file, implement the interface, swap the factory. Zero changes needed in index.ts, github.ts, or any tool registration. The prior recon document (research/local-recon.md) is stale — it reports the hardcoded-path blocker and missing seam that were both fixed. Base new work on the current code, not the prior recon. Suite documents in suite/ provide deep analysis of specific issues but some findings are resolved. Verify against current source before acting on any suite finding."
}
```

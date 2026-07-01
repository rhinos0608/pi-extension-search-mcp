# ERGONOMICS SUITE 3/5 — Configuration UX Review

**Date:** 2026-07-02
**Scope:** Env vars, defaults, fallback behavior, install ergonomics, local dev workflow. Read-only. No files modified.

---

## Environment Variable Inventory

| Variable | Source | Default | Behavior |
|----------|--------|---------|----------|
| `SEARCH_MCP_COMMAND` | `env.SEARCH_MCP_COMMAND` | `/Users/rhinesharar/.pi/agent/bin/search-mcp` | Executable spawned as MCP subprocess |
| `SEARCH_MCP_ARGS_JSON` | `env.SEARCH_MCP_ARGS_JSON` | `[]` | JSON string array of subprocess args |
| `SEARCH_MCP_CWD` | `env.SEARCH_MCP_CWD` | _(omitted)_ | Working directory for subprocess |
| _(all others)_ | `process.env` via `toProcessEnvironment` | _(inherited)_ | Entire parent environment forwarded to subprocess |

All four variables are read in `src/mcp-client.ts:21-34` by `buildServerParameters`.
The entire `process.env` is passed in from `src/index.ts:37` without pre-filtering.

---

## Findings

### CFG-01 [BLOCKER] — Hardcoded absolute path; README contradicts code

**File:** `src/mcp-client.ts:7`

```ts
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```

**Problem:** This path ties the extension to a single developer's home directory. It fails on any other machine, in CI, or after a clean install. The README's "Local use" section explicitly says:

> "By default the extension starts `search-mcp` from `PATH`."

That statement is false. The default is not a PATH lookup — it is an absolute filesystem path. Any operator who reads the README and runs `pi -e ./src/index.ts` without setting `SEARCH_MCP_COMMAND` will either get "command not found" or (worse) silently execute a stale binary from a path that happens to exist.

**What makes it worse:** The error from a missing binary does not surface until the first tool call, not at startup. The user's session proceeds normally until they invoke a tool, at which point they receive an opaque subprocess error with no reference to which config variable to fix.

**Fix (one line):**
```ts
export const DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp';
```

**Migration compatibility risk:** This only works if the Pi installer adds its bin directory to PATH. If it does not, existing developers on the hardcoded machine would regress. See migration plan (§ Migration Compatibility Plan) for the verification step.

**Alternative (Pi-aware fallback):** Derive from a known Pi env var if available, fall through to PATH:
```ts
export const DEFAULT_SEARCH_MCP_COMMAND =
  process.env.PI_AGENT_BIN
    ? `${process.env.PI_AGENT_BIN}/search-mcp`
    : 'search-mcp';
```

This keeps the Pi developer's machine working without a hardcoded path, and makes the fallback chain explicit.

---

### CFG-02 [HIGH] — Full `process.env` forwarded to subprocess with no allowlist

**File:** `src/mcp-client.ts:113-116` and `src/index.ts:37`

```ts
function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return Object.fromEntries(entries);
}
```

Called as `buildServerParameters(process.env)` — the entire parent environment is forwarded.

**Config UX problem:** From an operator's perspective, there is no documented list of which env vars actually reach `search-mcp`. An operator who sets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DATABASE_URL` in their Pi agent environment does not know these are silently inherited by the subprocess. There is no README section, no startup log, and no filtering to indicate what gets passed through.

**What intentionally should flow:**
- `SEARCH_MCP_*` prefixed vars (the extension's own config)
- Baseline OS vars (`PATH`, `HOME`, `SHELL`, `TMPDIR`)
- Any search-mcp-specific API keys (these need explicit documentation and explicit forwarding)

**Fix:**
```ts
const SEARCH_MCP_VAR = /^SEARCH_MCP_/;
const BASELINE = new Set(['HOME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME']);

function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] =>
      typeof e[1] === 'string' && (SEARCH_MCP_VAR.test(e[0]) || BASELINE.has(e[0]))
    )
  );
}
```

**Migration compatibility risk:** If `search-mcp` relies on env vars not in the allowlist (e.g., `GITHUB_TOKEN`, provider API keys), this breaks silently. Mitigation: audit `search-mcp`'s documented env requirements and add each to the allowlist explicitly with a comment. Operators can always pass additional vars using the `SEARCH_MCP_*` prefix convention.

---

### CFG-03 [HIGH] — No startup feedback on resolved config

**File:** `src/index.ts:37`, `src/mcp-client.ts:86-93`

`SearchMcpClient` does not log the resolved command, args, or cwd at any point. `buildServerParameters` constructs the spawn parameters silently. The constructor stores them without logging. `createConnection` spawns without logging.

**Config UX problem:** When a user sets `SEARCH_MCP_COMMAND` and nothing works, there is no way to verify the config was picked up correctly without reading the source. The resolved command string, the args array, and the cwd should be emitted to stderr at connection time so operators can confirm their environment is wired correctly.

**Fix (minimum):** Add one line in `createConnection()`:
```ts
private async createConnection(): Promise<Client> {
  const { command, args, cwd } = this.serverParameters;
  process.stderr.write(
    `[search-mcp] spawning: ${command}${args.length ? ' ' + args.join(' ') : ''}${cwd ? ` (cwd: ${cwd})` : ''}\n`
  );
  const transport = new StdioClientTransport(this.serverParameters);
  // ...
}
```

This is the minimum required for any operator to debug a misconfigured extension.

---

### CFG-04 [MEDIUM] — `SEARCH_MCP_ARGS_JSON` format is counterintuitive for shell users

**File:** `src/mcp-client.ts:23`, `src/mcp-client.ts:96-111`

```ts
const args = parseArgs(env.SEARCH_MCP_ARGS_JSON);
```

The format is a JSON-encoded string array: `SEARCH_MCP_ARGS_JSON='["dist/index.js", "--json"]'`. This requires shell escaping of the JSON string inside the shell string, which is error-prone. A developer naturally expects to write `SEARCH_MCP_ARGS="dist/index.js --json"` and have it split on spaces.

The error message (`SEARCH_MCP_ARGS_JSON must be a JSON string array`) explains the format but does not show an example. When users hit this error, they see the constraint but not the remedy.

**Fix options:**

**Option A (low effort):** Improve the error message to include a usage example:
```ts
throw new Error(
  `SEARCH_MCP_ARGS_JSON must be a JSON string array, e.g.: SEARCH_MCP_ARGS_JSON='["dist/index.js","--flag"]'. Got: ${raw}`
);
```

**Option B (ergonomic improvement):** Add a simpler `SEARCH_MCP_ARGS` fallback that splits on spaces when `SEARCH_MCP_ARGS_JSON` is absent:
```ts
function parseArgs(rawJson: string | undefined, rawSimple: string | undefined): string[] {
  if (rawJson?.trim()) return parseJsonArgs(rawJson);
  if (rawSimple?.trim()) return rawSimple.trim().split(/\s+/);
  return [];
}
```

Option B is additive (no breaking change) and matches shell intuition. Option A is a one-line change worth doing regardless.

---

### CFG-05 [MEDIUM] — `SEARCH_MCP_CWD` has no validation or feedback

**File:** `src/mcp-client.ts:25`

```ts
const cwd = env.SEARCH_MCP_CWD?.trim();
```

If `SEARCH_MCP_CWD` is set to a nonexistent path, the subprocess spawn will fail with a Node.js `ENOENT` or similar error that surfaces only at first tool call. The error message will reference the internal spawn failure, not the misconfigured `SEARCH_MCP_CWD`.

**Fix:** Check that the path exists (or is at least a string) before passing to spawn, and emit a warning if it does not:
```ts
const cwd = env.SEARCH_MCP_CWD?.trim();
if (cwd) {
  // Surface config error at connection time rather than at first tool call
  await import('node:fs').then(({ existsSync }) => {
    if (!existsSync(cwd)) {
      process.stderr.write(`[search-mcp] WARNING: SEARCH_MCP_CWD="${cwd}" does not exist\n`);
    }
  });
}
```

This is a non-blocking warning pattern — the spawn still proceeds and fails with the native error, but the operator now has a hint pointing to the config variable.

---

### CFG-06 [MEDIUM] — README install ergonomics: three missing items

**File:** `README.md`

**a) README "Local use" is missing a prerequisite check**

The README shows:
```bash
npm install
pi -e ./src/index.ts
```

There is no prerequisite check for:
- Whether `pi` CLI is installed and on PATH
- Whether `search-mcp` is installed (either via Pi agent or separately)
- Which Node.js version is required (`tsconfig.json` targets ES2022; Node 18+ is implied by `@types/node ^25`)

**Smallest fix:** Add a Prerequisites section:
```markdown
## Prerequisites

- Node.js ≥ 18
- Pi CLI (`pi`) installed and on PATH
- `search-mcp` binary on PATH (installed by the Pi agent, or via `npm install -g search-mcp`)
```

**b) README omits all five registered tools**

The Tools section lists only three entries (two with wrong names). Four tools are registered in source: `web_search`, `semantic_crawl`, `browse`, `research_sources` (in `src/index.ts`) plus `github` (in `src/github.ts`). The README documents two of these with incorrect `research_` prefixes and omits `browse` and `github` entirely. See `suite/issues-docs-package.md:B2, B3` for the specific corrections.

**c) Local dev override workflow is present but underdocumented**

The README shows:
```bash
SEARCH_MCP_COMMAND=node \
SEARCH_MCP_ARGS_JSON='["../dist/index.js"]' \
pi -e ./src/index.ts
```

But it does not explain:
- What `../dist/index.js` refers to (the sibling `search-mcp` repo's compiled output)
- What to do if the sibling repo is not compiled yet (`npm run build` or equivalent)
- How to tell if the override took effect (answer: currently you cannot, see CFG-03)

---

### CFG-07 [LOW] — No `npm run dev` convenience script for local development

**File:** `package.json:7-10`

The `scripts` block has only `test` and `typecheck`:
```json
"scripts": {
  "test": "node --import tsx --test test/**/*.test.ts",
  "typecheck": "tsc --noEmit"
}
```

A developer working on this extension with a local `search-mcp` source checkout has to manually compose the override env vars each time. A convenience script would reduce friction:
```json
"dev": "SEARCH_MCP_COMMAND=node SEARCH_MCP_ARGS_JSON='[\"../search-mcp/dist/index.js\"]' pi -e ./src/index.ts"
```

Note: the sibling repo path `../search-mcp` is assumed from the README and the shim at the hardcoded default path. This should be verified and documented.

---

### CFG-08 [LOW] — No startup binary validation before first tool call

**File:** `src/index.ts:37`, `src/mcp-client.ts:44-93`

The MCP client is constructed synchronously (`new SearchMcpClient(buildServerParameters(process.env))`) but makes no connection attempt at load time. The connection is deferred to first `callTool()`. This means:

1. A broken `SEARCH_MCP_COMMAND` (wrong path, binary not executable) is invisible until a user first invokes a tool mid-conversation.
2. There is no `session_start` hook used — only `session_shutdown` (for close) and `before_provider_request` (for payload normalization).

**Fix (non-breaking):** Attempt a lightweight connection probe after extension load, log success/failure to stderr:
```ts
// Probe connection at startup; failure is a warning, not a crash
void client.connect().then(
  () => process.stderr.write('[search-mcp] connected\n'),
  (err) => process.stderr.write(`[search-mcp] WARNING: startup connection failed: ${err.message}\n`),
);
```

This does not block Pi from loading the extension but gives operators an early signal about misconfiguration.

---

## Summary Table

| ID | Severity | File:Line | Issue | Fix Size |
|----|----------|-----------|-------|----------|
| CFG-01 | BLOCKER | `src/mcp-client.ts:7` | Hardcoded absolute path; README contradicts code | 1-line change |
| CFG-02 | HIGH | `src/mcp-client.ts:113-116`, `src/index.ts:37` | Full `process.env` forwarded; no allowlist | 10-line change |
| CFG-03 | HIGH | `src/mcp-client.ts:86-93` | No startup log of resolved command/args/cwd | 3-line addition |
| CFG-04 | MEDIUM | `src/mcp-client.ts:96-111` | `SEARCH_MCP_ARGS_JSON` counterintuitive; poor error message | Option A: 1-line; Option B: 10-line |
| CFG-05 | MEDIUM | `src/mcp-client.ts:25` | `SEARCH_MCP_CWD` not validated; silent spawn failure | 5-line addition |
| CFG-06 | MEDIUM | `README.md` | Missing prerequisites, wrong tool names, incomplete override docs | Prose update |
| CFG-07 | LOW | `package.json:7-10` | No `npm run dev` script for local development | 1-line addition |
| CFG-08 | LOW | `src/index.ts:37` | No startup probe; misconfiguration silent until tool call | 5-line addition |

---

## Migration Compatibility Plan

### Transition 1: `DEFAULT_SEARCH_MCP_COMMAND` → `'search-mcp'` (CFG-01)

**Prerequisite check (must do before changing):**
```bash
# On the Pi developer's machine, verify the installer puts its bin on PATH:
which search-mcp
# Expected: /Users/rhinesharar/.pi/agent/bin/search-mcp
# If this resolves correctly, changing the default is zero-regression.
# If it doesn't resolve, changing the default breaks the developer's local setup.
```

**Migration path (in order):**
1. Verify `which search-mcp` resolves on the target machine.
2. If yes: change `DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp'`. One-line commit. All CI machines that install the Pi agent with PATH configured work automatically.
3. If no: use the Pi-aware fallback (`process.env.PI_AGENT_BIN ?? 'search-mcp'`) as an intermediate step. Emit a startup warning if neither resolves.
4. Document: "The Pi agent installer must add its bin directory to PATH for the default to work."

**Rollback:** If changing to `'search-mcp'` breaks the Pi developer's machine (PATH not configured), revert to absolute path plus add a deprecation warning pointing to `SEARCH_MCP_COMMAND`.

---

### Transition 2: Full env passthrough → allowlist (CFG-02)

**Prerequisite check (must do before changing):**

Audit what env vars `search-mcp` actually consumes. The subprocess inherits `GITHUB_TOKEN` (via global env) today. Typical keys needed:
- `GITHUB_TOKEN` (for `github` tool authenticated requests)
- Provider API keys (if `search-mcp` calls LLM providers directly)
- `NODE_*` vars (Node.js runtime behavior)

**Migration path:**
1. Read `search-mcp`'s documentation or source for all env vars it reads.
2. Add each to the explicit allowlist with a comment.
3. Add `SEARCH_MCP_*` pattern (this extension's own vars) and baseline OS vars.
4. Ship the allowlist. Run `SEARCH_MCP_COMMAND=node SEARCH_MCP_ARGS_JSON='...' pi -e ./src/index.ts` end-to-end to verify all tools still work.

**Rollback:** If any `search-mcp` tool breaks due to a missing env var not in the allowlist, add the specific var to the allowlist and document it in README.

**Do not skip this audit.** Shipping the allowlist without verifying `search-mcp`'s env var requirements will silently break authentication for GitHub and any other services it contacts.

---

### Transition 3: Startup logging (CFG-03)

**Zero migration risk.** Additive-only: writes to `process.stderr`. Existing behavior unchanged. Can be shipped immediately without any prerequisite verification.

---

### Transition 4: `SEARCH_MCP_ARGS_JSON` ergonomics (CFG-04)

**Option A (error message improvement):** Zero migration risk. No behavior change.

**Option B (add `SEARCH_MCP_ARGS` space-split):** Additive. `SEARCH_MCP_ARGS_JSON` retains priority. Any user already using `SEARCH_MCP_ARGS_JSON` is unaffected. New users can use either form.

**Precedence rule if both are implemented:** `SEARCH_MCP_ARGS_JSON` takes precedence when both are set, since it is more precise.

---

### Transition 5: Startup probe (CFG-08)

**Risk:** If the probe itself errors in a way that blocks the extension load event, Pi may not register the extension's tools. Use `void` (fire-and-forget) to guarantee non-blocking behavior. The probe result is diagnostic only.

---

## Recommended Fix Order

1. **CFG-01** — Fix path default (after verifying PATH). Unblocks all other machines.
2. **CFG-03** — Add startup logging. Immediately ship; zero risk; makes every other fix debuggable.
3. **CFG-02** — Scope env allowlist (after auditing search-mcp env requirements).
4. **CFG-04A** — Improve SEARCH_MCP_ARGS_JSON error message. One line.
5. **CFG-06** — Fix README (wrong tool names, missing tools, prerequisites). Pure docs.
6. **CFG-05** — Add CWD validation warning. Additive.
7. **CFG-07** — Add `npm run dev` script. Convenience only.
8. **CFG-08** — Add startup probe. After CFG-03 confirms logging works.

---

## Cross-references to Other Suite Reports

- **CFG-01** duplicates finding `B1` in `suite/issues-docs-package.md` and `F-09` in `suite/issues-runtime.md` and Finding 2 in `suite/issues-architecture.md`. This report adds: README contradiction analysis, fallback chain options, and PATH verification prerequisite.
- **CFG-02** duplicates `F-07` in `suite/issues-runtime.md` and `SEC-01` in `suite/issues-security.md`. This report adds: migration audit steps and env var allowlist design.
- **CFG-03, CFG-08** are new findings not covered in prior suite reports.
- **CFG-04** is new; the JSON format ergonomics gap was not addressed in prior reports.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only analysis only. No source files modified. Output scoped to configuration UX: env vars (CFG-01 through CFG-08), defaults, fallback behavior, install ergonomics, local dev workflow, and a migration compatibility plan with prerequisite checks and rollback paths. No architecture refactoring, test additions, or runtime fixes included."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding includes: severity, exact file:line citation, code excerpt, root cause, concrete fix with code, and migration risk assessment. Cross-references to prior suite reports identify overlaps vs. new findings. Migration compatibility plan gives ordered steps with prerequisite verification commands and rollback conditions for each transition."
    }
  ],
  "changedFiles": [
    "suite/ergonomics-config.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read src/mcp-client.ts src/index.ts src/payload.ts src/github.ts",
      "result": "passed",
      "summary": "All source files read; env var handling confirmed in buildServerParameters, toProcessEnvironment, and createConnection"
    },
    {
      "command": "read README.md package.json",
      "result": "passed",
      "summary": "README and package.json read; confirmed README contradicts default path and omits two tools; no scripts.dev present"
    },
    {
      "command": "read suite/issues-architecture.md suite/issues-runtime.md suite/issues-security.md suite/issues-docs-package.md suite/issues-tests.md",
      "result": "passed",
      "summary": "All prior suite reports read; identified overlapping findings (B1/F-09/SEC-01/Finding-2 for hardcoded path; F-07/SEC-01 for env passthrough) and gaps new to this report (CFG-03, CFG-04, CFG-08)"
    }
  ],
  "validationOutput": [
    "src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND confirmed as '/Users/rhinesharar/.pi/agent/bin/search-mcp' (absolute, machine-specific)",
    "README.md:19 — README states 'By default the extension starts search-mcp from PATH' — confirmed false by source",
    "src/mcp-client.ts:113-116 — toProcessEnvironment confirmed to pass all string-valued env vars with no filtering",
    "src/mcp-client.ts:86-93 — createConnection confirmed to spawn with no log line of resolved command",
    "src/index.ts:37 — client constructed synchronously, no connection probe or startup log",
    "package.json:7-10 — scripts confirmed: only 'test' and 'typecheck'; no 'dev' script",
    "README.md:7-9 — two wrong tool names (research_web_search, research_semantic_crawl) and two missing tools (browse, github) confirmed against src/index.ts:48,69,94,110 and src/github.ts:17",
    "src/mcp-client.ts:96-111 — parseArgs error message confirmed to not include a usage example"
  ],
  "residualRisks": [
    "CFG-01: PATH verification must happen before changing the default; if the Pi installer does not add its bin to PATH, changing the default breaks the developer's local setup",
    "CFG-02: allowlist design depends on search-mcp's documented env var requirements, which were not available for audit during this review; shipping without that audit will silently break authenticated tools",
    "CFG-08: startup probe behavior depends on whether Pi's extension load mechanism blocks on the exported function's promise; must be implemented as void/fire-and-forget to avoid blocking tool registration"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/ergonomics-config.md (new file). No source, test, or config files modified.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND is a machine-specific absolute path; README claims it defaults to PATH lookup (false)",
    "high: src/mcp-client.ts:113-116 — entire process.env forwarded to subprocess; operators cannot know which vars reach search-mcp",
    "high: src/mcp-client.ts:86-93 — no startup log of resolved command, args, or cwd; misconfiguration is undetectable without reading source",
    "medium: src/mcp-client.ts:96-111 — SEARCH_MCP_ARGS_JSON format is counterintuitive for shell users; error message lacks example",
    "medium: src/mcp-client.ts:25 — SEARCH_MCP_CWD not validated; silent spawn failure if path does not exist",
    "medium: README.md — missing prerequisites, two wrong tool names, two missing tool docs, incomplete override workflow docs",
    "low: package.json:7-10 — no npm run dev script for local development with sibling repo checkout",
    "low: src/index.ts:37 — no startup connection probe; misconfiguration silent until first tool call"
  ],
  "manualNotes": "plan.md and progress.md do not exist in the working directory; analysis based on direct source inspection and prior suite reports. CFG-03 (startup logging) and CFG-04 (SEARCH_MCP_ARGS_JSON ergonomics) are new findings not covered in any prior suite report. CFG-01/CFG-02 overlap with prior reports but this report adds migration prerequisite verification steps and rollback conditions not present elsewhere. The migration compatibility plan requires an external audit of search-mcp's env var requirements before CFG-02 can be safely shipped."
}
```

# Hardening Suite 4/5 — Packaging and Release

**Date:** 2026-07-02
**Scope:** Read-only analysis. No source files modified.
**Files reviewed:** `package.json`, `tsconfig.json`, `README.md`, `src/mcp-client.ts`, `src/index.ts`, `src/github.ts`, `src/payload.ts`, `test/*.test.ts`, `research/strategy-context.md`, `research/oracle-consultation.md`, `suite/issues-docs-package.md`, `suite/hardening-backend-seam.md`

---

## 1. Current Distribution Model

This project is a **Pi coding-agent extension**, not a general-purpose npm package. Understanding the distribution model is the prerequisite for everything else.

```
Pi agent runtime
  └─ loads extension via:
       pi -e ./src/index.ts       ← local dev invocation
       OR pi.extensions in package.json: ["./src/index.ts"]  ← registered install
```

Pi loads extensions as **TypeScript source** — it uses its own tsx-based loader. There is **no compile step** in the current repo: `tsconfig.json` has no `outDir`, and `package.json` has no `build` script. The extension runs from `.ts` source at runtime.

This means "packaging" for this project means two distinct things depending on the release target:

| Target | What "packaging" means |
|--------|----------------------|
| **Local use / dev** | `npm install` + `pi -e ./src/index.ts` — works today |
| **Pi extension registry / npm publish** | The Pi runtime installs the package, reads the `pi.extensions` field, and loads `./src/index.ts` |
| **Self-contained CLI** | Future goal (not yet implemented); would add a `bin` entry and compiled output |

The current `"pi": { "extensions": ["./src/index.ts"] }` in `package.json` is the correct Pi extension manifest. Pi resolves this path relative to the package root.

---

## 2. Release-Blocking Issues

### RB-1 — Hardcoded absolute path (BLOCKER)
**File:** `src/mcp-client.ts:7`
```typescript
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```
This is a machine-specific path. Any `npm install` of this package on another machine results in a broken default. The `README.md:19-30` already documents the correct behavior (`search-mcp` from PATH), so the code contradicts the documented contract.

**Fix:** Change to `'search-mcp'` — a PATH-resolved command. This is a 1-line change and is safe for all users who have `search-mcp` installed (Pi installer handles PATH). Users without it must set `SEARCH_MCP_COMMAND`.

---

### RB-2 — `"private": true` prevents npm publication
**File:** `package.json:6`
```json
"private": true
```
This is intentional for local development, but must be explicitly decided before any npm publish. If the extension is to be published to npm under `@search-mcp/pi-extension`, this flag must be removed. If it's published to a private registry (Pi's own), the flag may remain. If it is never published to npm but only installed via `pi extension add ./path`, it can remain.

**Decision required:** Clarify the intended publish target before any release pipeline is built.

---

### RB-3 — 4 HIGH-severity npm audit vulnerabilities (BLOCKER for public release)
**Affected package:** `@earendil-works/pi-coding-agent@0.79.4` (transitive dependencies)

| Transitive package | Severity | Issue |
|-------------------|----------|-------|
| `protobufjs ≤7.6.2` | HIGH | Schema-name shadowing + DoS via Any expansion |
| `undici 8.0.0–8.4.1` | HIGH | TLS bypass, header injection, response poisoning (7 CVEs) |
| `ws 8.0.0–8.20.1` | HIGH | Memory-exhaustion DoS |

These are resolved by `npm update @earendil-works/pi-coding-agent @earendil-works/pi-ai` (from 0.79.4 → 0.79.10). This is a pre-release blocker for any public or organizational distribution.

---

### RB-4 — No `files` whitelist (packaging correctness)
**File:** `package.json`

Without a `"files"` field, `npm pack` / `npm publish` would include:
- `test/` — test files consumers don't need
- `research/` — internal design artifacts
- `suite/` — internal review reports
- `.pi-smartread.tags.cache/` — local tool caches
- `.smart-edit-undo/` — local undo history

This inflates the package tarball and leaks internal state. A `files` whitelist keeps the package clean.

**Recommended:**
```json
"files": ["src/", "README.md"]
```

---

### RB-5 — Missing `license` field (packaging warning)
**File:** `package.json`

`npm install` emits a warning and `npm pack` produces an incomplete manifest. Even for private packages, omitting `license` leaves intent ambiguous.

**Fix:** Add `"license": "UNLICENSED"` (or the correct SPDX identifier) to `package.json`.

---

## 3. Dependency Strategy

### D-1 — `@earendil-works/pi-coding-agent` belongs in `devDependencies`
**File:** `package.json:13`

This package is imported **type-only** in both consumer files:
```typescript
// src/index.ts:1
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
// src/github.ts:1
import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
```

`import type` is erased at compile time — these types are not present in emitted JavaScript. The runtime never loads `@earendil-works/pi-coding-agent`. Placing it in `dependencies` forces every consumer to install it (and its vulnerability-carrying transitive tree) unnecessarily.

**Fix:** Move from `dependencies` to `devDependencies`.

**Consequence:** This also shrinks the transitive vulnerability surface from 4 HIGH (RB-3) to 0 once moved, because the vulnerable transitive packages come exclusively from this dependency.

---

### D-2 — Runtime dependencies are correct for their roles

| Package | Classification | Justification |
|---------|---------------|---------------|
| `@earendil-works/pi-ai` | runtime ✓ | `StringEnum` called at tool registration time (`src/index.ts:2,56,117`) — Pi loads extensions lazily but these must be present |
| `@modelcontextprotocol/sdk` | runtime ✓ | `Client`, `StdioClientTransport` used in `src/mcp-client.ts` at subprocess spawn time |
| `typebox` | runtime ✓ | `Type.Object`, `Type.String`, `Type.Number`, `Type.Optional` called during tool registration |
| `tsx` | devDependency ✓ | Only used in `npm test` script; Pi has its own TypeScript loader |
| `typescript` | devDependency ✓ | Typecheck only |
| `@types/node` | devDependency ✓ | Type declarations only |

---

### D-3 — `typebox` (unscoped) is not the canonical package
**File:** `package.json:15`

The canonical TypeBox package is `@sinclair/typebox`. The installed `typebox@1.2.11` is a separate package with compatible API. If this was intentional (lightweight alternative), document it — otherwise migrate to `@sinclair/typebox` to match standard Pi extension patterns.

---

## 4. Build Artifacts Strategy

### BA-1 — No build step: intentional for Pi extensions, but has tradeoffs

Pi loads TypeScript source directly. This means:
- **No `outDir`** needed in `tsconfig.json` for runtime
- **No `build` script** needed for the Pi extension use case
- `"pi": { "extensions": ["./src/index.ts"] }` is the correct entrypoint declaration

However, if the extension is **npm-published**, the Pi runtime in an install context will need to either:
1. Resolve `./src/index.ts` relative to the installed package root (works if Pi embeds a TypeScript loader), OR
2. Receive pre-compiled JS at `./dist/index.js`

**Current assumption:** Pi loads TypeScript source at the path given in `pi.extensions`. If this assumption is correct, no build step is needed and `src/` must be in the published tarball.

**Risk:** If a future version of Pi expects compiled JS, the entire package needs a build step retrofitted. Mitigation: verify this once before first public release.

---

### BA-2 — `tsconfig.json` includes `test/**/*.ts` in `include`
**File:** `tsconfig.json:23-25`
```json
"include": ["src/**/*.ts", "test/**/*.ts"]
```

This is correct for `npm run typecheck` (all files type-checked together). It has **no effect on packaging** since `tsconfig.json` does not control what gets published — only `"files"` in `package.json` does. However, if a `build` script is ever added, a separate `tsconfig.build.json` that excludes `test/` would be needed to avoid emitting test files into `dist/`.

---

### BA-3 — No binary entries (`bin` field)

There is no `bin` field in `package.json`, and there should not be one at this stage. The project is a Pi extension, not a CLI. The oracle consultation (`research/oracle-consultation.md`) explicitly defers CLI packaging to a later milestone:

> "Define package-local CLI contract, e.g. `pi-extension-search-mcp backend call <tool> <json>`... Implement first local self-contained tool as `browse` only."

Adding a `bin` entry before the CLI is implemented would ship a broken command. **Do not add `bin` until the local CLI is implemented and tested.**

---

## 5. Missing Package Metadata

| Field | Status | Recommended value |
|-------|--------|------------------|
| `license` | missing | `"UNLICENSED"` or correct SPDX identifier |
| `engines` | missing | `"node": ">=20"` (Pi requires modern Node; `--import tsx` requires Node 18+) |
| `files` | missing | `["src/", "README.md"]` |
| `repository` | missing | Add once git remote is established |
| `description` | stale | "three search-mcp research tools" → "Pi coding-agent extension exposing five search-mcp tools via MCP stdio" |

---

## 6. Concrete Release Plan

The following is ordered from lowest-risk/highest-leverage to highest-risk/lowest-urgency.

### Step 1 — Fix the hardcoded path (15 min, zero risk)
```
src/mcp-client.ts:7
  '/Users/rhinesharar/.pi/agent/bin/search-mcp'
→ 'search-mcp'
```
Verify: existing `buildServerParameters` tests still pass (`npm test`).

---

### Step 2 — Move `@earendil-works/pi-coding-agent` to devDependencies (5 min)
```json
// package.json
"devDependencies": {
  "@earendil-works/pi-coding-agent": "^0.79.4",  // ← move here
  ...
}
```
Verify: `npm run typecheck` passes. `npm test` passes. `npm audit` shows 0 vulnerabilities (since the HIGH vulns are exclusively transitive through this package).

---

### Step 3 — Update runtime dependencies to clear vulnerabilities (10 min)
```bash
npm update @earendil-works/pi-ai
npm test && npm run typecheck
```
After moving `pi-coding-agent` to devDeps (Step 2), `npm audit` should clear. If not, run `npm audit fix` for remaining items.

---

### Step 4 — Add missing package metadata (10 min)
```json
// package.json additions
"license": "UNLICENSED",
"engines": { "node": ">=20" },
"files": ["src/", "README.md"],
"description": "Pi coding-agent extension exposing five search-mcp tools via MCP stdio."
```

---

### Step 5 — Fix README tool names (10 min)
See `suite/issues-docs-package.md` B2 and B3. The README lists two wrong tool names and omits two tools entirely:
```
research_web_search        → web_search
research_semantic_crawl    → semantic_crawl
(missing)                  → browse
(missing)                  → github
```

---

### Step 6 — Initialize git repository (before any further changes)
The oracle consultation (`research/oracle-consultation.md`) confirms the repo has no git history. All implementation changes above should be committed atomically once the git repo is initialized:
```bash
# .gitignore additions needed:
node_modules/
dist/
.DS_Store
.pi-smartread.tags.cache/
.smart-edit-undo/
```

---

### Step 7 — Decide publish target before running `npm publish`
Three paths are possible:
- **Pi extension registry only**: `"private": true` can stay; distribution is via `pi extension add ./path` or git URL
- **npm public**: remove `"private": true`, ensure `@search-mcp/pi-extension` scope is claimed, run `npm publish --access public`
- **npm private/org**: remove `"private": true`, add `"publishConfig": { "registry": "...", "access": "restricted" }`

This decision depends on Pi's extension installation model. **Do not run `npm publish` before this is clarified.**

---

## 7. Pitfalls

### P-1 — Publishing with `"private": true` removed before files whitelist is set
If someone runs `npm publish` after removing the private flag but before adding `"files"`, the entire working tree (research notes, test fixtures, editor caches) ships in the tarball. **Always add `"files"` before removing `"private"`.**

---

### P-2 — Moving `pi-coding-agent` to devDeps breaks if the package is npm-published and Pi's host runtime doesn't bundle devDeps
For `npm publish`, devDependencies are not installed in consumers. This is correct here because Pi loads the extension's TypeScript source and the `import type` declarations are erased — the consumer environment never needs the package at runtime. However, if Pi's extension loader changes to require the package at runtime (unlikely but possible if Pi reflects on extension type metadata), this move would break runtime. Document the rationale explicitly.

---

### P-3 — No `engines` field allows silent failure on Node 16
The test command uses `node --import tsx`. The `--import` flag requires Node 18+; Node 16 silently treats it as an unrecognized flag in some configurations. Without an `"engines"` constraint, users on old Node versions get cryptic errors rather than a clear version gate.

---

### P-4 — Pi extension path resolution is relative to `package.json`
The `"pi": { "extensions": ["./src/index.ts"] }` path is resolved relative to `package.json`. If the package is installed in `node_modules/@search-mcp/pi-extension/`, the Pi runtime must resolve `./src/index.ts` from there. Verify that Pi's extension loader uses the installed package root, not the working directory. A misconfigured path here produces a silent no-op (extension not loaded) rather than an error.

---

### P-5 — `typebox` (unscoped) API compatibility is not guaranteed
`typebox@1.2.11` provides `Type.Object`, `Type.String`, etc. with an API that happens to match `@sinclair/typebox`. If a future Pi SDK upgrade imports `@sinclair/typebox` types and the extension passes `typebox`-schema objects, there may be a structural incompatibility at the Pi type-checking boundary even if both APIs look identical. Migrating to `@sinclair/typebox` before first publish eliminates this risk.

---

### P-6 — Stale `package-lock.json` if `node_modules/` is not committed
`package-lock.json` currently exists but `node_modules/` is untracked. If `package-lock.json` is committed but not periodically refreshed via `npm ci`, the lock file can drift from registry reality over time (packages yanked, checksums changed). After Steps 2–3 update the lock file, commit it alongside the dependency changes.

---

### P-7 — `DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp'` requires PATH to include Pi's bin dir
After fixing RB-1, the default command becomes a bare `search-mcp`. This works for users who installed Pi (the Pi installer adds its bin dir to PATH). Users who installed `search-mcp` via npm globally will also have it in PATH. Users in clean CI environments may not. Document clearly in README that `SEARCH_MCP_COMMAND` must be set in CI or non-standard environments.

---

## 8. Findings Summary

| ID | Severity | File:Line | Issue | Fix |
|----|----------|-----------|-------|-----|
| RB-1 | **release blocker** | `src/mcp-client.ts:7` | Hardcoded absolute PATH; breaks on any non-owner machine | Change to `'search-mcp'` |
| RB-2 | **release blocker** | `package.json:6` | `"private": true` prevents npm publish; intent unclear | Decision required on publish target |
| RB-3 | **release blocker** | transitive deps | 4 HIGH vulns in `@earendil-works/pi-coding-agent` transitive tree | Move to devDeps + `npm update` |
| RB-4 | **packaging** | `package.json` | No `"files"` whitelist; tarball would include test/, research/, suite/ | Add `"files": ["src/", "README.md"]` |
| RB-5 | **packaging** | `package.json` | Missing `"license"` field | Add `"license": "UNLICENSED"` |
| D-1 | **high** | `package.json:13` | `@earendil-works/pi-coding-agent` in runtime deps; type-only usage | Move to devDependencies |
| D-3 | **medium** | `package.json:15` | `typebox` vs. `@sinclair/typebox` compatibility risk | Migrate or document intentional choice |
| BA-3 | **medium** | `package.json` | No `bin` entry — correct today; do not add until CLI is implemented | Track separately in self-contained milestone |
| P-3 | **medium** | `package.json` | No `"engines"` field; Node 16 fails silently | Add `"node": ">=20"` |
| P-4 | **medium** | `package.json` | Pi path resolution from installed package root not verified | Verify once before first release |

---

## 9. Dependency Order for Release Steps

```
Step 1 (fix hardcoded path)   — no dependencies; safe now
Step 2 (pi-coding-agent move) — no dependencies; safe now
Step 3 (npm update)           — depends on Step 2 (clear audit after move first)
Step 4 (metadata)             — no dependencies; safe now
Step 5 (README fixes)         — no dependencies; safe now
Step 6 (git init)             — ideally before Steps 1-5, but can be done after
Step 7 (publish decision)     — must follow all above; requires external decision
```

Steps 1, 2, 4, 5, 6 are safe to execute in any order and have zero behavioral risk. Step 3 has a low risk of minor API changes in 0.79.10; verify with `npm test` after. Step 7 is a decision gate, not an implementation task.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only analysis only. Concrete release plan with 7 ordered steps, 10 findings with file:line citations, 7 named pitfalls. No source files modified. Scope limited to packaging and release — no architecture, test, or runtime changes proposed."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Evidence includes: package.json field-by-field audit, tsconfig.json build artifact analysis, import type verification in src/index.ts:1 and src/github.ts:1 (type-only imports confirming D-1), hardcoded path confirmed at src/mcp-client.ts:7, npm test output confirming 9 passing tests, existing suite files cross-referenced for prior findings (issues-docs-package.md B1-B4, hardening-backend-seam.md F2, strategy-context.md RB-1/Q2). All findings cite file paths and line numbers."
    }
  ],
  "changedFiles": [
    "suite/hardening-packaging.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "9 tests pass: buildBrowseArgs (2), buildServerParameters (3), resultToText (1), normalizeProviderPayload (3). Zero failures."
    },
    {
      "command": "find /Users/rhinesharar/pi-extension-search-mcp -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' | sort",
      "result": "passed",
      "summary": "Mapped full project structure: src/ (4 files), test/ (3 files), suite/ (7 files), research/ (4 files), package.json, tsconfig.json, README.md"
    }
  ],
  "validationOutput": [
    "src/mcp-client.ts:7 — DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp' (hardcoded absolute path, confirmed release blocker)",
    "src/index.ts:1 — import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent' (type-only import, confirmed D-1)",
    "src/github.ts:1 — import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent' (type-only import, confirmed D-1)",
    "package.json — no 'files', no 'license', no 'engines', no 'repository', no 'bin' fields present",
    "package.json:6 — 'private': true (confirmed release gate RB-2)",
    "tsconfig.json — no outDir; Pi loads TypeScript source directly; no build step required for current distribution model",
    "npm test — 9 pass, 0 fail; test suite is green at current state"
  ],
  "residualRisks": [
    "Q2 unresolved (from strategy-context.md): whether search-mcp is on npm — affects whether 'search-mcp' PATH default is safe in CI environments without Pi",
    "Pi extension loader path resolution from installed package root not verified against current Pi runtime version",
    "typebox vs @sinclair/typebox structural compatibility at Pi SDK type boundary not formally verified",
    "Publish target (public npm / private registry / git URL only) is an unresolved decision that gates Step 7",
    "Node 20+ assumption not enforced by package.json engines field — silent failure on old Node possible"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/hardening-packaging.md (new file, 280 lines). No source files modified.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 — hardcoded absolute path '/Users/rhinesharar/.pi/agent/bin/search-mcp'; breaks on any non-owner machine",
    "blocker: package.json:13 — @earendil-works/pi-coding-agent in runtime dependencies; type-only imports erased at compile time; 4 HIGH vulns are exclusively in this package's transitive tree",
    "blocker: package.json — no 'files' whitelist; npm publish would ship test/, research/, suite/, .pi-smartread.tags.cache/ in tarball",
    "warning: package.json:6 — 'private': true; publish target decision required before release pipeline",
    "warning: package.json — missing 'license', 'engines', 'repository' fields",
    "warning: typebox (unscoped) vs @sinclair/typebox compatibility risk at Pi SDK type boundary",
    "info: tsconfig.json has no outDir — Pi loads .ts source directly; no build step needed for current distribution model",
    "info: no 'bin' field — correct; do not add until local CLI is implemented (oracle-consultation.md)",
    "no blockers: test suite green (9/9), runtime dependencies @earendil-works/pi-ai, @modelcontextprotocol/sdk, typebox correctly in dependencies"
  ],
  "manualNotes": "The single highest-leverage pre-release action is moving @earendil-works/pi-coding-agent to devDependencies (Step 2), which simultaneously resolves all 4 HIGH npm audit vulnerabilities (they are exclusively transitive through this package) and reduces the install footprint for consumers. This and the hardcoded path fix (Step 1) are both 1-5 line changes with zero behavioral risk. The publish target decision (Step 7) is the only external dependency blocking a first release."
}
```

# Suite 3/6 — Docs / Package / Release: Issues Report

> Read-only audit. No files were modified.

---

## BLOCKERS

### B1 — Hardcoded absolute path contradicts README and breaks portability
**File:** `src/mcp-client.ts:7`
```ts
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```
README says "By default the extension starts `search-mcp` from `PATH`." This is false — the default is an absolute path tied to a single user's home directory. Anyone else who clones this repo and runs `pi -e ./src/index.ts` without setting `SEARCH_MCP_COMMAND` will hit "command not found" or execute the wrong binary.

**Smallest safe fix:** Change line 7 to:
```ts
export const DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp';
```
This aligns code with the documented contract at no risk.

---

### B2 — README lists wrong Pi tool names for two tools
**File:** `README.md:7-9`

| README claims | Actual `name:` in source |
|---|---|
| `research_web_search` | `web_search` (`src/index.ts:48`) |
| `research_semantic_crawl` | `semantic_crawl` (`src/index.ts:69`) |

The `research_` prefix is present only on `research_sources` (`src/index.ts:110`), not the others. An operator following the README would call non-existent tool names.

**Smallest safe fix:** Update the two bullet lines in the README Tools section:
```
- `web_search` → `web_search`
- `semantic_crawl` → `semantic_crawl`
- `research_sources` → `research` with `action: "academic"`
```
(Or drop the tautological arrow and list the Pi tool names only.)

---

### B3 — README omits two registered tools entirely
**File:** `README.md:6-9`

Tools registered in source but not documented:
- `browse` — registered at `src/index.ts:94-107`
- `github` — registered at `src/github.ts:17-156`

These tools are available at runtime but invisible to documentation readers.

**Smallest safe fix:** Add entries to the Tools section:
```markdown
- `browse` — fetch a URL and return readable text
- `github` — repo metadata, files, tree, search, trending, code search
```

---

### B4 — 4 high-severity `npm audit` vulnerabilities in transitive dependencies
**Affected dependency:** `@earendil-works/pi-coding-agent` (installed 0.79.4)

| Package | Vulnerability | Advisory |
|---|---|---|
| `protobufjs ≤7.6.2` | Schema-name shadowing + DoS via Any expansion | GHSA-f38q-mgvj-vph7, GHSA-wcpc-wj8m-hjx6 |
| `undici 8.0.0–8.4.1` | TLS bypass, DoS, header injection, response poisoning (7 CVEs) | GHSA-vmh5-mc38-953g + 6 others |
| `ws 8.0.0–8.20.1` | Memory-exhaustion DoS | GHSA-96hv-2xvq-fx4p |

`npm audit fix` reports these are fixable. The wanted range (`^0.79.4` → `0.79.10`) of `@earendil-works/pi-coding-agent` resolves the affected transitive versions.

**Smallest safe fix:**
```bash
npm update @earendil-works/pi-coding-agent @earendil-works/pi-ai
# or
npm audit fix
```

---

## ISSUES (non-blocking)

### I1 — `@earendil-works/pi-coding-agent` in `dependencies` instead of `devDependencies`
**File:** `package.json:13`

Both imports of this package in source are type-only:
- `src/index.ts:1`: `import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'`
- `src/github.ts:1`: `import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'`

Type-only imports are erased at compile time; the package is not needed at runtime. Placing it in `dependencies` inflates the install footprint and pulls in its transitive vulnerabilities for anyone who `npm install`s the extension.

**Smallest safe fix:** Move the entry from `dependencies` to `devDependencies` in `package.json`.

---

### I2 — `"DOM"` lib in `tsconfig.json` is inappropriate for a Node.js extension
**File:** `tsconfig.json:6`
```json
"lib": ["ES2022", "DOM"]
```
This is a pure Node.js package with no browser code. Including `DOM` allows browser-only globals (`document`, `window`, `fetch`, etc.) to type-check cleanly — masking runtime failures if such APIs are accidentally used. Node 18+ ships its own `fetch`; the DOM lib also declares it and can cause type conflicts.

**Smallest safe fix:** Remove `"DOM"` from the lib array:
```json
"lib": ["ES2022"]
```
Run `tsc --noEmit` after to confirm no regressions (currently passes clean).

---

### I3 — Outdated packages with patch/minor updates available
**File:** `package.json` + `package-lock.json`

| Package | Installed | In-range wanted | Latest |
|---|---|---|---|
| `@earendil-works/pi-ai` | 0.79.4 | 0.79.10 | 0.80.3 |
| `@earendil-works/pi-coding-agent` | 0.79.4 | 0.79.10 | 0.80.3 |
| `typebox` | 1.2.11 | 1.3.2 | 1.3.2 |
| `@types/node` | 25.9.3 | 25.9.4 | 26.1.0 |

The in-range updates (`npm update`) are safe. The `0.80.x` major minor bump for the pi packages and `@types/node 26` need evaluation before pinning. At minimum `npm update` should keep the lock file current.

---

### I4 — `package.json` missing `license` field
**File:** `package.json`

No `license` key declared. `npm install` emits a warning. Even for private packages, omitting `license` makes the intent ambiguous.

**Smallest safe fix:** Add `"license": "UNLICENSED"` (or the appropriate SPDX identifier) to `package.json`.

---

### I5 — `suite/` output directory not in `.gitignore`
**File:** `.gitignore`

The `suite/` directory (containing generated review reports including this file) is not listed in `.gitignore`. If this directory is meant to be transient / not committed, add it. If it should be committed for traceability, leave `.gitignore` alone and document the intent.

**Smallest safe fix (if transient):** Add `suite/` to `.gitignore`.

---

## OBSERVATIONS (informational, no fix required)

- **O1** — `typebox` (unscoped) vs. `@sinclair/typebox` (canonical): The installed package `typebox@1.2.11` is distinct from `@sinclair/typebox`. Tests pass, so the API is compatible. Worth documenting this choice was intentional.
- **O2** — `package-lock.json` is untracked (no commits yet). Once committed, it should always be checked in to guarantee reproducible installs.
- **O3** — No `lint` script in `package.json`. TypeScript strict mode covers many cases but a linter would catch style/code-quality issues the compiler ignores.
- **O4** — `"private": true` is correctly set; no `publishConfig` or `files` field needed.
- **O5** — `engines` field absent. Specifying `"node": ">=20"` (or whichever minimum is tested) would help catch environment mismatches early.

---

## Summary Table

| ID | Severity | File | Description | Fix Size |
|---|---|---|---|---|
| B1 | Blocker | `src/mcp-client.ts:7` | Hardcoded absolute path; README contradicts code | 1-line change |
| B2 | Blocker | `README.md:7-8` | Wrong Pi tool names (`research_web_search`, `research_semantic_crawl`) | 2-line change |
| B3 | Blocker | `README.md:6-9` | Missing `browse` and `github` tool docs | 2-line addition |
| B4 | Blocker | transitive deps | 4 high-severity vulns fixable via `npm update` / `npm audit fix` | `npm update` |
| I1 | Issue | `package.json:13` | `@earendil-works/pi-coding-agent` in runtime deps; type-only import | Move to devDeps |
| I2 | Issue | `tsconfig.json:6` | `"DOM"` lib in Node.js-only project | Remove `"DOM"` |
| I3 | Issue | `package.json` | Outdated in-range packages not updated to lock file | `npm update` |
| I4 | Issue | `package.json` | Missing `license` field | Add 1 field |
| I5 | Issue | `.gitignore` | `suite/` output dir not gitignored | 1-line addition |

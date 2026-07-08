# Compatibility / Docs / Tests Review — All Work from HEAD

**Date:** 2026-07-03
**Scope:** Read-only review of the full committed history at `HEAD` (`789651d`) for `pi-extension-search-mcp`. Focus: tool-name stability, reach setup/status exposed as commands (not tools), README/SKILL accuracy, npm package surface, and test-coverage gaps. No files were edited.
**Inputs read:** `plan.md` and `progress.md` were specified in the task but **do not exist** in the repo (confirmed `ENOENT`). Review is based on the committed source, tests, `README.md`, `SKILL.md`, `package.json`, `tsconfig.json`, `.gitignore`, and prior `suite/` artifacts.

---

## Validation baseline (re-run this session)

| Command | Result | Summary |
|---|---|---|
| `npm test` | passed | 49/49 tests pass, 0 fail, ~610ms |
| `npx tsc --noEmit` | passed | 0 errors (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`) |
| `npm audit` | passed | 0 vulnerabilities (prior B4 transitive vulns resolved by `^0.79.10` pin) |
| `git log --oneline` | info | 8 commits from `c33a9ba` (initial) → `789651d` (HEAD) |

---

## Public surface contract (verified against source)

**Registered Pi tools (8) — `pi.registerTool`:** `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`, `social`, `video`, `feeds`.
- `src/index.ts:60,81,107,122,205,232,255` and `src/github.ts:18`.

**Registered slash commands (2) — `pi.registerCommand`:** `reach-status`, `reach-setup`.
- `src/index.ts:164,174`.

**Contract check — "reach setup/status not tools":** ✅ Satisfied. `reach-status` / `reach-setup` are registered only via `registerCommand`. They are *also* reachable through the CLI `call reach_status` / `call reach_setup` path (`callNativeTool` → `callReachTool` in `src/native-tools.ts:24-25` / `src/reach-tools.ts:62-65`), but they are **not** exposed as LLM-facing `registerTool` entries. The names `reach_status` / `reach_setup` appear only in the internal `ReachToolName` type (`src/reach-tools.ts:8`) and the CLI dispatch, never as agent tool names.

**Tool-name stability:** ✅ All 8 tool names match across `README.md` Tools section, `SKILL.md` Tool-choice section, and the `registerTool` calls. No `research_` prefix drift (the earlier `issues-docs-package.md` B2 blocker is resolved). Names are stable across all 8 commits.

---

## Findings

### BLOCKER

#### B1 — Hardcoded user-specific path shipped in the npm package surface
**Severity:** blocker (for publish) / medium (for local-only use)
**Files:** `src/local-config.ts:3`, `README.md:69,82`, `SKILL.md:31`

```ts
export const DEFAULT_SEARCH_MCP_CONFIG_PATH = '/Users/rhinesharar/search-mcp/config.json';
```

`package.json` has **no `"private"` field**, so `@search-mcp/pi-extension` is nominally publishable, and `files` ships `src/`. The default config path is a single user's absolute home-directory path. On any other machine `existsSync` returns false → `loadSearchMcpEnvironment` returns `env` unchanged (graceful no-op, no crash), so it is *safe* but *silently inactive*. README/SKILL document this hardcoded path as the default, which is inaccurate for anyone else.

This was previously flagged as `medium` in `suite/review-config-reuse-bootstrap.md:161`. It is escalated here to **blocker for the npm package surface** because the package is not marked private and `src/` is published.

**Concrete fix (smallest safe):** Make the default portable and keep the override:
```ts
export const DEFAULT_SEARCH_MCP_CONFIG_PATH =
  process.env.SEARCH_MCP_CONFIG_PATH?.trim() ||
  join(homedir(), '.search-mcp', 'config.json');
```
Then update README/SKILL to state the default is `~/.search-mcp/config.json` (overridable via `SEARCH_MCP_CONFIG_PATH`, and the local `/Users/rhinesharar/search-mcp/config.json` remains valid when present). Alternatively, add `"private": true` to `package.json` if this package is intentionally local-only — that downgrades B1 to medium.

---

### HIGH

#### H1 — First-start bootstrap auto-installs software by default
**Severity:** high (behavioral risk, documented but surprising)
**Files:** `src/index.ts:45` (`void ensureFirstStartBootstrap(env)`), `src/bootstrap.ts:50-73,117`

On first extension load, `ensureFirstStartBootstrap` defaults to `install_all` and runs `agent-reach install --env=auto --channels=all` with a **600-second timeout**, then imports browser cookies. Opt-outs exist (`PI_SEARCH_BOOTSTRAP=off`, `PI_SEARCH_ALLOW_INSTALL=0`) and the behavior is documented in README/SKILL. However, for a published npm package, "auto-install external software + import browser cookies on first `pi -e` load" is a surprising default with real side effects (network, disk, possibly privileged browser access). No test covers `ensureFirstStartBootstrap` (it writes to `~/.pi-extension-search/bootstrap.json`).

**Concrete fix:** Either (a) default `PI_SEARCH_BOOTSTRAP` to `check` (doctor-only, no install) for the published package and require explicit opt-in for `install_all`; or (b) keep the local default but gate the *published* default via a package-mode flag. At minimum, add a test that asserts `ensureFirstStartBootstrap` is a no-op when `PI_SEARCH_BOOTSTRAP=off` (already returns early at `bootstrap.ts:52`).

#### H2 — No regression test pins the public tool/command-name contract
**Severity:** high (directly relevant to this review's "tool names stable" focus)
**Files:** `test/index.test.ts` (only tests `buildBrowseArgs`/`buildSemanticSource`), no `test/contract.test.ts`

There is no test that asserts the exact set of registered tool names and command names. A future refactor could rename `web_search` → `research_web_search` (the exact regression `issues-docs-package.md` B2 caught) or accidentally register `reach-setup` as a tool, with no test failure. The `social`/`video`/`feeds` family additions have **zero** registration coverage.

**Concrete fix:** Add a contract test that imports the default export, records `pi.registerTool` / `pi.registerCommand` calls via a fake `ExtensionAPI`, and asserts:
```ts
assert.deepEqual(toolNames, ['web_search','semantic_crawl','browse','research_sources','github','social','video','feeds']);
assert.deepEqual(commandNames, ['reach-status','reach-setup']);
// and that no tool name equals reach_status/reach_setup
```
This requires a minimal fake `ExtensionAPI` (the `issues-tests.md` P3 "fake client" pattern generalizes). Zero risk; guards the exact contract this review verifies manually.

---

### MEDIUM

#### M1 — Feed parser has no unit tests
**Severity:** medium
**Files:** `src/reach-tools.ts:507-525` (`parseFeedItems`, `firstXmlText`, `firstXmlAttribute`), `test/native-tools.test.ts`

The `feeds` tool's RSS/Atom parsing is only exercised by the URL-scheme-rejection test. There is no test with sample RSS/Atom XML asserting title/url/summary extraction, CDATA handling, or the empty-feed fallback. A parser regression (regex-based, fragile) would ship undetected.

**Concrete fix:** Add `test/feeds-parser.test.ts` (export `parseFeedItems` or test via a small RSS fixture string). Cover: RSS `<item>`, Atom `<entry>` with `link href` attribute, CDATA, missing title, empty feed.

#### M2 — Platform inference and backend-override ordering untested
**Severity:** medium
**Files:** `src/reach-tools.ts:434-446` (`orderByOverride`), `src/reach-tools.ts:459-476` (`platformOrInfer`)

`platformOrInfer` infers platform from URL host (e.g. `x.com` → `twitter`, `b23.tv` → `bilibili`); `orderByOverride` honors `TWITTER_BACKEND` / `PI_SEARCH_REDDIT_BACKEND` etc. Neither has a unit test. The override logic is documented in README ("Per-platform backend override examples") and is a user-facing contract.

**Concrete fix:** Export both helpers (or test via candidate arrays) and add tests: `platformOrInfer({url:'https://x.com/foo'}, [...])` → `twitter`; `orderByOverride('twitter', [twitterCandidate, openCli], {TWITTER_BACKEND:'OpenCLI'})` puts OpenCLI first.

#### M3 — `noStagedFiles`/test coverage for new family tool error paths
**Severity:** medium
**Files:** `src/reach-tools.ts:222-369` (candidate `args` builders), `src/reach-tools.ts:371-393` (`runFirstUsable`)

Each candidate's `args(action, input)` throws `Unsupported <platform> action` for unknown actions, and `runFirstUsable` throws `No usable <platform> backend` when all candidates return 127. Neither error path is tested. The `social` unsupported-platform path *is* tested (`native-tools.test.ts` "social requires supported platform"), but per-action and per-candidate coverage is absent.

**Concrete fix:** Add tests asserting `socialCandidates('myspace')` throws, and that an unknown `action` for a known platform throws `/Unsupported twitter action/`.

#### M4 — `tsconfig.json` still includes `"DOM"` lib for a Node-only package
**Severity:** medium (was `I2` in `issues-docs-package.md`, still open)
**Files:** `tsconfig.json:6`

Pure Node.js package; `"DOM"` masks accidental browser-global usage and can conflict with Node's native `fetch` types. `tsc --noEmit` passes either way.

**Concrete fix:** `"lib": ["ES2022"]`; re-run `npm run typecheck`.

---

### LOW

#### L1 — README/SKILL omit the `list_dir` github action
**Severity:** low (doc completeness)
**Files:** `README.md:13`, `SKILL.md:16`, `src/native-tools.ts:125-126` / `src/github.ts:9`

Source supports `github action: list_dir` (and `list_dir` is in the `githubActions` enum, `src/github.ts:9`). README's `github` bullet says "repository, file, tree, search, trending, and code search" — omits `list_dir`. SKILL similarly omits it. Minor; the description string in `src/github.ts:23` does mention `list_dir`.

**Concrete fix:** Add "directory listing (`list_dir`)" to the README/SKILL github bullet.

#### L2 — `installAllowed` opt-out values `no`/`off` not tested
**Severity:** low
**Files:** `src/bootstrap.ts:197-200` (`isDisabled`), `test/bootstrap.test.ts`

`isDisabled` accepts `0`,`false`,`no`,`off`. Tests cover `0` and `false` only. README documents `0`/`false`/`no`/`off`.

**Concrete fix:** Add `assert.equal(installAllowed({ PI_SEARCH_ALLOW_INSTALL: 'no' }), false)` and `'off'` cases.

#### L3 — `reach_setup status` action not directly tested
**Severity:** low
**Files:** `src/bootstrap.ts:97-109` (`setupStatus`), `test/cli.test.ts`

`reach_setup plan`, `install_all`, and `import_cookies` are tested via CLI. The `status` action (reads `~/.pi-extension-search/bootstrap.json`) is not. It side-effects the homedir, so a test should stub `STATE_PATH` or run in an isolated `HOME`.

**Concrete fix:** Add a test setting `HOME` to a temp dir before calling `callSetupTool({action:'status'})`, asserting `firstStart` is null and safety strings are present.

#### L4 — Synchronous config read at extension registration
**Severity:** low (perf/lifecycle)
**Files:** `src/local-config.ts:44-56` (`loadSearchMcpEnvironment` uses `existsSync`/`readFileSync`), `src/index.ts:43`

`loadSearchMcpEnvironment` runs synchronously at module/extension load. Acceptable for a small config file, but it is blocking I/O on the registration path. Not a correctness issue.

---

## npm package surface

| Aspect | Status | Notes |
|---|---|---|
| `name`/`version` | `@search-mcp/pi-extension@0.1.0` | Scoped, publishable. |
| `"private"` | **absent** | Package is nominally publishable → B1 hardcoded path becomes a real portability blocker. |
| `bin` | `./bin/pi-extension-search.mjs` | Spawns `node --import tsx src/cli.ts`; `tsx` is a runtime dep ✓. Resolves to `<pkg>/src/cli.ts` because `src/` is in `files` ✓. |
| `files` | `bin/`,`src/`,`README.md`,`SKILL.md` | Correctly **excludes** `research/`, `suite/`, `test/`, `package-lock.json` → lean publish. |
| `pi.extensions` | `["./src/index.ts"]` | Loads TS via tsx at runtime; consistent with `files`. |
| `dependencies` | pi-ai, mcp sdk, tsx, typebox | `@earendil-works/pi-coding-agent` is correctly in `devDependencies` (type-only import) — prior I1 resolved. |
| `license` | `MIT` ✓ | Prior I4 resolved. |
| `engines` | absent | Optional; recommend `"node": ">=20"`. |
| `scripts.test` / `typecheck` | present, both green | ✓. |
| `npm audit` | 0 vulns | Prior B4 resolved. |

---

## Test coverage summary

- **49 tests, 8 files, all passing.** Coverage is strongest for: `buildServerParameters`/`resultToText` (`mcp-client.test.ts`), `buildBrowseArgs`/`buildSemanticSource` (`index.test.ts`, P1 from `issues-tests.md` now resolved), `normalizeProviderPayload` (`payload.test.ts`), `loadSearchMcpEnvironment` (`local-config.test.ts`), CLI routing + reach setup/status opt-outs (`cli.test.ts`), native URL-scheme/private-host guards (`native-tools.test.ts`), CLI env allowlist (`backend.test.ts`).
- **Gaps most relevant to this review (ordered by relevance):**
  1. **H2** — no contract test pinning tool/command names (highest relevance to "tool names stable").
  2. **M1** — feed parser untested (new family tool, fragile regex).
  3. **M2** — platform inference + backend-override ordering untested (documented user contract).
  4. **M3** — per-action/per-candidate error paths in reach families untested.
  5. **H1 (test portion)** — `ensureFirstStartBootstrap` has no tests (side-effecting startup).
  6. **L2/L3** — minor `isDisabled` and `reach_setup status` gaps.
- Prior `issues-tests.md` P1 (buildSemanticSource) and P4 (normalizeProviderPayload branches) are now covered; P3 (callSearchMcpTool dispatch seam) is partially covered by `cli.test.ts` routing tests but a direct fake-backend test would still add value.

---

## Residual risks

1. **B1** — Published package ships a hardcoded `/Users/rhinesharar/...` default config path; silently inactive elsewhere. Blocker for publish unless `private:true` is added or the default is made portable.
2. **H1** — First-start default auto-installs external software and imports browser cookies; documented but surprising for a published package; untested.
3. **H2** — The public tool/command-name contract is verified only manually in this review; no automated regression guard.
4. **M1/M2/M3** — New `social`/`video`/`feeds` parsing, inference, and override logic are regex/env-driven and untested; a single bad regex or env-parsing change could ship green.
5. `ensureFirstStartBootstrap` writes to `~/.pi-extension-search/bootstrap.json` (0600, good) but is fire-and-forget via `void` at `src/index.ts:45`; a slow/hung `agent-reach` (600s timeout) delays first tool registration only implicitly (the promise is not awaited before registration, so registration proceeds — confirmed at `index.ts:42-57`). Low risk.
6. `search-mcp` legacy MCP fallback (`SEARCH_BACKEND=mcp`) is untested at integration level (requires live subprocess); acceptable, documented as legacy.
7. External CLIs (twitter-cli, rdt, xhs, bili, yt-dlp, opencli) are probed at runtime; their absence is handled gracefully (code 127 → "not installed"), but no test exercises a present external CLI. Integration-only.

---

## Concrete fix priority

1. **B1** — Make `DEFAULT_SEARCH_MCP_CONFIG_PATH` portable (or add `"private": true`). Update README/SKILL default-path wording.
2. **H2** — Add `test/contract.test.ts` pinning the 8 tool names + 2 command names; assert no `reach_*` tool is registered.
3. **H1** — Decide published default for `PI_SEARCH_BOOTSTRAP` (recommend `check`); add an `off`-mode no-op test.
4. **M1** — Add feed-parser unit tests with RSS/Atom fixtures.
5. **M2** — Add `platformOrInfer` + `orderByOverride` unit tests.
6. **M4** — Remove `"DOM"` from `tsconfig.json` lib.
7. **L1/L2/L3** — Small doc + test additions.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Findings include concrete file:line references and severities: B1 src/local-config.ts:3 (blocker), H1 src/index.ts:45+src/bootstrap.ts:117 (high), H2 test/index.test.ts (high), M1 src/reach-tools.ts:507 (medium), M2 src/reach-tools.ts:434/459 (medium), M3 src/reach-tools.ts:222-393 (medium), M4 tsconfig.json:6 (medium), L1 README.md:13 (low), L2 src/bootstrap.ts:197 (low), L3 src/bootstrap.ts:97 (low), L4 src/local-config.ts:44 (low). Each has a concrete fix. Tool-name stability and reach-setup/status-as-commands contract verified against source."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm test",
      "result": "passed",
      "summary": "49/49 tests pass, 0 fail"
    },
    {
      "command": "npx tsc --noEmit",
      "result": "passed",
      "summary": "0 type errors under strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess"
    },
    {
      "command": "npm audit",
      "result": "passed",
      "summary": "0 vulnerabilities"
    },
    {
      "command": "git log --oneline -20",
      "result": "passed",
      "summary": "HEAD=789651d; 8 commits from c33a9ba initial to 789651d"
    },
    {
      "command": "grep -rn \"name: '\" src/index.ts src/github.ts",
      "result": "passed",
      "summary": "Confirmed 8 registerTool names: web_search, semantic_crawl, browse, research_sources, social, video, feeds, github"
    },
    {
      "command": "grep -n \"registerCommand(\" src/index.ts",
      "result": "passed",
      "summary": "Confirmed 2 commands: reach-status, reach-setup (setup/status NOT tools)"
    }
  ],
  "validationOutput": [
    "plan.md and progress.md: ENOENT (do not exist); review based on committed source/tests/docs",
    "npm test: 49 pass / 0 fail / 0 skipped",
    "tsc --noEmit: 0 errors",
    "npm audit: 0 vulnerabilities",
    "Tool-name contract: 8 tools + 2 commands verified against src/index.ts:60-255, src/github.ts:18, src/index.ts:164-174",
    "reach setup/status are registerCommand only, not registerTool (contract satisfied)",
    "README.md and SKILL.md tool lists match source (no research_ prefix drift); minor list_dir omission (L1)",
    "npm package surface: no private field + src/ shipped => B1 hardcoded path is a publish blocker"
  ],
  "residualRisks": [
    "B1: hardcoded /Users/rhinesharar/search-mcp/config.json default shipped in src/ via files[]; package not marked private; blocker for npm publish, graceful no-op elsewhere",
    "H1: first-start bootstrap defaults to install_all (spawns agent-reach install + browser cookie import); documented but surprising for published package; untested",
    "H2: no automated regression test pins the public tool/command-name contract; stability currently verified only manually",
    "M1/M2/M3: feed parser, platform inference, backend-override ordering, and per-action error paths in social/video/feeds are untested (regex/env-driven)",
    "ensureFirstStartBootstrap is fire-and-forget via void; registration is not blocked, but a hung agent-reach (600s) is unguarded at integration level",
    "legacy SEARCH_BACKEND=mcp and present-external-CLI paths are integration-only and untested"
  ],
  "noStagedFiles": true,
  "diffSummary": "No files changed. Read-only review of all committed work at HEAD; findings written to suite/review-compat-docs-tests-all-work.md.",
  "reviewFindings": [
    "blocker: src/local-config.ts:3 - DEFAULT_SEARCH_MCP_CONFIG_PATH hardcoded to /Users/rhinesharar/search-mcp/config.json; shipped in npm files[] with no private:true; non-portable publish surface (B1)",
    "high: src/index.ts:45 + src/bootstrap.ts:117 - first-start default install_all auto-installs software and imports browser cookies; documented but surprising for published package; no test (H1)",
    "high: test/index.test.ts - no contract test pins the 8 tool names + 2 command names or asserts reach_* are not tools; tool-name stability unguarded (H2)",
    "medium: src/reach-tools.ts:507-525 - parseFeedItems/firstXmlText/firstXmlAttribute have no unit tests; regex-based RSS/Atom parser (M1)",
    "medium: src/reach-tools.ts:434-446,459-476 - orderByOverride and platformOrInfer (documented backend-override + URL inference) untested (M2)",
    "medium: src/reach-tools.ts:222-393 - per-platform candidate args unsupported-action throws and runFirstUsable all-127 throw path untested (M3)",
    "medium: tsconfig.json:6 - DOM lib still included for Node-only package (M4, prior I2 open)",
    "low: README.md:13, SKILL.md:16 - github bullet omits list_dir action (L1)",
    "low: src/bootstrap.ts:197-200 - installAllowed opt-out values 'no'/'off' not tested (L2)",
    "low: src/bootstrap.ts:97-109 - reach_setup status action not directly tested (L3)",
    "low: src/local-config.ts:44-56 - synchronous existsSync/readFileSync on extension registration path (L4)",
    "ok: tool-name stability verified - 8 tools match README/SKILL/source across all commits",
    "ok: reach setup/status exposed only as registerCommand, never registerTool (contract satisfied)",
    "ok: npm audit 0 vulns (prior B4 resolved); pi-coding-agent moved to devDeps (prior I1 resolved); license MIT present (prior I4 resolved)"
  ],
  "manualNotes": "plan.md and progress.md referenced in the task do not exist in the repo; this review used committed source, tests, README/SKILL, package.json, tsconfig.json, .gitignore, and prior suite/ artifacts as authoritative inputs. No files were edited (read-only). The two highest-value follow-ups are (1) make the default config path portable or mark the package private, and (2) add a contract test that pins the registered tool/command names — the latter directly automates the manual contract verification performed here."
}
```
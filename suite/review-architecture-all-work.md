# Architecture review: all committed work (HEAD)

Repo: `/Users/rhinesharar/pi-extension-search-mcp`
Scope: review of all work from HEAD — `git log` shows 8 commits (`c33a9ba` → `789651d`) building a native-CLI-backed Pi search extension with reach-style tool families, slash setup commands, local config reuse, and default-on bootstrap install + cookie import. Working tree is clean (no uncommitted diff).
Mode: review only — no files were edited.

## Input files

`plan.md` and `progress.md` were **not present** at the repo root (`ENOENT` on read). The review proceeded from the committed source tree, prior `suite/review-*.md` notes, and live validation. If those files were expected, their absence is itself a process gap worth noting to the parent.

## Architecture summary (focus areas)

- **Native CLI backend** (`src/backend.ts`, `src/cli-backend.ts`, `src/cli.ts`, `src/native-tools.ts`): `createSearchBackend` picks `CliSearchBackend` unless `SEARCH_BACKEND=mcp`. The CLI seam is a subprocess contract: every `client.callTool` spawns `node --import tsx src/cli.ts call <tool> <json>`, parses a JSON envelope `{ok,data,error}`, and returns `data`. Native tools (`web_search`, `semantic_crawl`, `agentic_browse`/`browse`, `research`, `github`) are implemented in-process inside that subprocess using `fetch` against public APIs (DuckDuckGo, Wikipedia, arXiv, Crossref, HN, GitHub). SSRF guard `validatePublicHttpUrl` blocks non-http(s) schemes and private/local hosts.
- **Backend seam** (`src/backend.ts`): clean `SearchBackend` interface (`callTool`/`close`) with two implementations — `CliSearchBackend` (default) and `SearchMcpClient` (legacy stdio MCP fallback). `resultToText` normalizes content arrays to text.
- **Reach-style tool families** (`src/reach-tools.ts`): channel registry with tier 0 (native) and tier 1 (external CLI) backends; `runFirstUsable` probes ordered candidates, returns first exit-0, surfaces `code===127` as "not installed". Per-platform backend override via `<PLATFORM>_BACKEND` / `PI_SEARCH_<PLATFORM>_BACKEND`. Native: V2EX public API, RSS/Atom regex parser, YouTube transcript via yt-dlp temp-dir. External: twitter-cli, OpenCLI, rdt-cli, xhs-cli, bili-cli.
- **Slash commands** (`src/index.ts:163-186`): `reach-status` and `reach-setup` are `pi.registerCommand` (user-facing), not agent tools. `reach-setup` actions: `status|plan|install_core|install_all|install_channels|import_cookies`. Install paths gated by `installAllowed` (opt-out: blocked only when `PI_SEARCH_ALLOW_INSTALL` ∈ {0,false,no,off}).
- **Local config reuse** (`src/local-config.ts`): maps `/Users/rhinesharar/search-mcp/config.json` dotted keys → env vars (40 mappings); existing env wins; `loadedConfigSummary` returns key names only (no secret values). Loaded once at extension entry and at CLI entry.
- **Bootstrap** (`src/bootstrap.ts`): `ensureFirstStartBootstrap` (fire-and-forget at load) defaults to `install_all`; runs `agent-reach install --env=auto --channels=all` then `agent-reach configure --from-browser <browser>` across 5 browsers; state persisted to `~/.pi-extension-search/bootstrap.json` (0o600). Both install and cookie import are default-on with opt-out env vars.

## Validation run

- `npm test` → **49/49 pass, 0 fail** (suites 0, duration ~592ms).
- `npm run typecheck` (`tsc --noEmit`) → **clean**.
- `npm run cli -- status` → valid native-cli envelope; `npm run cli -- config` works.
- `git status` → clean; no junk (`.smart-edit-undo`, `.pi-smartread`, `.DS_Store`) tracked — `.gitignore` covers them.

Prior review blockers (`suite/review-config-reuse-bootstrap.md` B1 install_all hyphen, B2 bootstrap install bypass; `suite/review-slash-config-final.md` B1 `safe` mode bypass) are **fixed in the committed code**: `bootstrapInstallArgs` now accepts both `install_all`/`install-all` and routes `safe` through the same `installArgs` + `installAllowed` gate (`src/bootstrap.ts:111-122,131-136`); `readJsonConfig` now try/catches malformed JSON and returns `undefined` instead of throwing (`src/local-config.ts:69-78`). No regressions.

## Findings

### HIGH

#### H1 — `github` `code_search` advertises AST/embeddings/tree-sitter but native backend silently does plain lexical GitHub search
- **Files:** `src/github.ts:22-27,34` (tool description + guideline) vs `src/native-tools.ts:133,186-188` (`githubCodeSearch` → `githubSearch` → GitHub `/search/code`).
- The `github` tool description promises "`code_search` for AST-aware semantic code retrieval using embeddings and tree-sitter" and the guideline says "requires EMBEDDING_SIDECAR_BASE_URL". The native implementation aliases `code_search` to `githubSearch`, which calls GitHub's plain `/search/code` REST endpoint. No embeddings, no tree-sitter, no AST. `EMBEDDING_SIDECAR_*` keys are forwarded to the CLI subprocess (`src/cli-backend.ts:130-134`) but never consumed by `callNativeTool`.
- **Effect:** An agent selecting `code_search` for "deep semantic" retrieval gets lexical results with no signal that the semantic path was skipped. The contract is misleading for the default backend.
- **Severity:** high — tool contract vs implementation mismatch on a documented focus capability.
- **Fix:** Either (a) implement the semantic path natively (call the embedding sidecar / search-mcp code-search endpoint) when `EMBEDDING_SIDECAR_BASE_URL` is set, falling back to lexical; or (b) rewrite the `github` description/guidelines to state that the native backend provides lexical GitHub code search and that AST/semantic retrieval requires `SEARCH_BACKEND=mcp` (or the embedding sidecar), so the agent does not rely on unavailable behavior.

#### H2 — `research_sources` advertises 13 sources; native backend implements 4, the rest silently degrade to a DuckDuckGo web search with the source name prepended
- **Files:** `src/index.ts:22-36` (enum: all, arxiv, semantic_scholar, openalex, crossref, pubmed, wikipedia, hackernews, stackoverflow, datacite, ror, gdelt, wikidata) vs `src/native-tools.ts:206-215` (`researchResults` only branches on wikipedia/wikidata, arxiv, crossref, hackernews; `if (tasks.length === 0) tasks.push(searchDuckDuckGo(\`${source} ${query}\`, ...))`).
- **Effect:** Selecting `source: 'pubmed'` / `'semantic_scholar'` / `'openalex'` / `'stackoverflow'` / `'datacite'` / `'ror'` / `'gdelt'` does not query those sources — it runs a generic DuckDuckGo search for `"pubmed <query>"`, returning unrelated web results presented as if they were that source. The agent and user cannot distinguish a real source hit from the fallback.
- **Severity:** high — silent contract violation; the tool's `source` parameter enum is partly fictional in the native backend.
- **Fix:** Either implement the missing sources against their public APIs (Semantic Scholar, OpenAlex, PubMed E-utilities, Stack Exchange API, DataCite, ROR, GDELT all have free JSON APIs) or trim the `researchSources` enum to the natively-supported set (`all, arxiv, crossref, wikipedia, wikidata, hackernews`) and document that the others require `SEARCH_BACKEND=mcp`. At minimum, when an unsupported source is selected natively, return an explicit "source X not available in native backend; use SEARCH_BACKEND=mcp" message instead of silently prepending the name to a web search.

### MEDIUM

#### M3 — Default-on first-load mutating install + browser cookie import is aggressive for a shipped package
- **Files:** `src/index.ts:43-45` (`loadSearchMcpEnvironment` + `void ensureFirstStartBootstrap(env)`), `src/bootstrap.ts:50-73` (default `install_all`), `src/bootstrap.ts:111-129` (runs `agent-reach install --env=auto --channels=all`, 600s timeout), `src/bootstrap.ts:159-181` (cookie import loop over chrome/firefox/edge/brave/opera, default-on).
- Merely loading the extension (`pi -e ./src/index.ts`) on a machine without `~/.pi-extension-search/bootstrap.json` triggers an unattended `agent-reach install --channels=all` (a network package/channel install) and then `agent-reach configure --from-browser <browser>` for up to 5 browsers, both default-on with only opt-out env vars. The default config path is hardcoded to one user's machine (`src/local-config.ts:3`), so on any other machine the config bridge is inert but the install/cookie-import defaults still fire.
- This is documented (`README.md:63,73`) and accepted as in-scope, and `installAllowed`/`browserCookieImportAllowed` provide opt-outs. But defaulting unattended package install **and** browser-cookie exfiltration to ON (rather than requiring opt-in) is a notable behavioral-surprise and supply-chain/privacy risk for a package that ships in a public registry shape (`package.json` `bin`/`files`).
- **Severity:** medium — default posture risk (documented + opt-out, but defaults run mutating+privacy-sensitive actions on first load).
- **Fix:** Consider defaulting `PI_SEARCH_BOOTSTRAP` to `check` (doctor-only) and requiring explicit opt-in (`install_all`/`install_core`) for unattended install; and/or defaulting `PI_SEARCH_IMPORT_BROWSER_COOKIES` to `0` so cookie import requires an explicit opt-in given its privacy sensitivity. At minimum, surface a one-time notify/log on first load describing what bootstrap did.

#### M4 — Three divergent env allowlists with no shared source of truth (latent under-exposure)
- **Files:** `src/cli-backend.ts:84-163` (`buildCliEnvironment`), `src/reach-tools.ts:593-607` (`externalEnvironment`), `src/bootstrap.ts:239-251` (`setupEnvironment`).
- Confirmed divergence in committed code:
  - `setupEnvironment` (bootstrap) uniquely includes `GROQ_API_KEY`, `OPENAI_API_KEY`; absent from the other two.
  - `buildCliEnvironment` (CLI seam) uniquely includes `EMBEDDING_SIDECAR_*` (5), `SEARCH_LLM_*` (3), `OLLAMA_SEARCH_*` (2), `BROWSER_*` (4), `SEARCH_MCP_CONFIG_PATH`, and all `*_BACKEND`/`PI_SEARCH_*_BACKEND` overrides; missing `GROQ_API_KEY`/`OPENAI_API_KEY`.
  - `externalEnvironment` (reach-tools) lacks `EMBEDDING_SIDECAR_*`, `SEARCH_LLM_*`, `OLLAMA_SEARCH_*`, `BROWSER_*`, `GROQ_API_KEY`, `OPENAI_API_KEY`.
- **Risk:** A key added to `local-config.ts` mappings or to one allowlist may be forgotten in the others → a mapped config value silently not forwarded to the subprocess that consumes it (latent under-exposure), or over-exposure if a broad key is added carelessly. No test asserts the three lists share a common base.
- **Severity:** medium — maintainability + latent correctness (also flagged in both prior reviews; still unfixed).
- **Fix:** Extract one shared base allowlist constant (e.g. `src/env-allowlist.ts`) with per-context additions, and add a test asserting the union/relationships. The per-platform `*_BACKEND` overrides are correctly consumed at the reach-tools orchestration layer (`orderCandidates`, `src/reach-tools.ts:430-446`) so they need not be in `externalEnvironment`, but that should be made explicit in the shared module.

#### M5 — Native-CLI backend forks a fresh `node --import tsx` subprocess per tool call (recompiles TS every call)
- **File:** `src/cli-backend.ts:32` (`spawn(process.execPath, ['--import', 'tsx', this.cliPath, ...args], …)`).
- Every `client.callTool` — including every `web_search`, `browse`, `social`, `feeds` invocation — spawns a new Node process that re-imports the TS source through `tsx` JIT, re-evaluating the whole module graph. This is the deliberate isolation seam, but it imposes a per-call startup tax (process spawn + tsx transform) on top of the actual fetch/CLI work, and there is no `dist/` precompiled target (`package.json` has no build step; `files` ships `src/`).
- **Severity:** medium — performance/architecture risk; acceptable as an isolation seam but unmeasured and unmitigated.
- **Fix:** Precompile `src/` to `dist/` (`tsc` emit) and spawn `node dist/cli.js` (drop tsx from the hot path); or run native tools in-process by default and reserve the subprocess seam for opt-in isolation. Either way, add a timing test to guard regression.

#### M6 — SSRF guard and ~8 helpers duplicated across `native-tools.ts` and `reach-tools.ts`
- **Files:** `src/native-tools.ts:337-357` and `src/reach-tools.ts:571-591` (`validatePublicHttpUrl` byte-for-byte identical), plus duplicated `cleanText`, `requireString`, `numberOrDefault`, `tail`, `textResult`, `jsonTextResult`, `fetchText`, `fetchJson`, `fetchInit`.
- **Risk:** The SSRF allowlist is the security-critical control. A fix in one copy (e.g. blocking IPv6-mapped IPv4, DNS-rebinding, `0.0.0.0` edge cases, `169.254.169.254` on non-AWS) will not propagate to the other. Tests cover both paths' rejection of `file://`/`localhost`, but not the full allowlist parity.
- **Severity:** medium — security-control duplication.
- **Fix:** Extract `src/net.ts` (URL validation + fetch helpers) and `src/util.ts` (text/arg helpers); import from both modules. Add a parity test that both modules import the same `validatePublicHttpUrl`.

### LOW

#### L1 — `SEARCH_BACKEND=mcp` still registers `social`/`video`/`feeds` family tools that the legacy search-mcp server may not expose
- **Files:** `src/index.ts:203-268` (`registerExpansionTools` always registers the three family tools regardless of backend), README claim "legacy `SEARCH_BACKEND=mcp` only supports the original search-mcp tools".
- With `SEARCH_BACKEND=mcp`, `client` is `SearchMcpClient`; calling `social`/`video`/`feeds` routes `client.callTool('social', …)` to the search-mcp server, which may not implement those tool names → runtime error. The tools are still registered and the agent may select them.
- **Severity:** low — documented limitation, but registration is unconditional.
- **Fix:** Skip `registerExpansionTools` (or register only `feeds` if supported) when `env.SEARCH_BACKEND === 'mcp'`, or document the explicit failure mode in the tool descriptions.

#### L2 — `semantic_crawl` "semantic" is naive fixed-window keyword overlap in the native backend
- **File:** `src/native-tools.ts:379-388` (`chunkText` 2000-char fixed windows, `scoreText` substring term counting).
- The tool name/description ("semantic retrieval", "semantically relevant passages") oversells what is lexical overlap ranking. Graceful degradation, but the contract implies embeddings.
- **Severity:** low — naming/description mismatch; behavior is safe.
- **Fix:** Clarify in the tool description that the native backend ranks by lexical overlap and that embedding-based semantic crawl requires `SEARCH_BACKEND=mcp` / the embedding sidecar.

#### L3 — `config.json` read+parsed twice per `cli config` invocation
- **File:** `src/cli.ts:19` (`loadSearchMcpEnvironment`) and `src/cli.ts:74` (`configResult` → `loadedConfigSummary`) each `readFileSync`+`JSON.parse` the same file independently.
- **Severity:** low — perf only (CLI-only path).

#### L4 — Fire-and-forget bootstrap discards its promise; edge-case rejections could surface as unhandled
- **File:** `src/index.ts:45` (`void ensureFirstStartBootstrap(env)`). `ensureFirstStartBootstrap` wraps `runBootstrapMode` in try/catch and `safeWriteState` swallows write errors, but `runCommand` spawn edge cases outside the caught region could reject.
- **Severity:** low.
- **Fix:** Attach an explicit `.catch(() => undefined)` (or log) on the bootstrap promise.

## Residual risks

- **External CLI argv contracts are unverified.** `reach-tools.ts` builds argv for `twitter`, `opencli`, `rdt`, `bili`, `xhs`, `yt-dlp` from assumed flags (e.g. `twitter search <q> -n <n>`, `opencli twitter search <q> -f yaml`, `rdt search <q> --limit <n>`). No test asserts these shapes match the real CLIs. If any CLI changes its flags, `social`/`video` silently degrade to "not installed" (exit 127) or non-zero exit with a `tail(stderr)` message; the agent gets no structured signal that the integration is stale.
- **No end-to-end test of the `CliSearchBackend` subprocess seam.** All CLI tests call `runCommand`/`callNativeTool` directly in-process. The spawn + JSON-envelope parse + `buildCliEnvironment` allowlist path (the actual default backend) is only unit-tested via `buildCliEnvironment` assertions; a regression in `cli-backend.ts`'s spawn/parse/timer/abort handling would not be caught by the suite.
- **Hardcoded `/Users/rhinesharar/search-mcp/config.json` default** (`src/local-config.ts:3`) makes config reuse inactive on every other machine unless `SEARCH_MCP_CONFIG_PATH` is set. Accepted by scope ("this local setup") but a portability risk for any non-local install.
- **`agent-reach` itself is an opaque dependency.** Bootstrap, `/reach-setup`, and cookie import all shell out to `agent-reach` with no version pin or capability probe; if `agent-reach` is absent (code 127 → warn) the extension degrades gracefully, but if present with a different subcommand contract (`install --env=auto --channels=all`, `configure --from-browser <browser>`, `doctor --json`) the behavior is unverified.
- **`install_channels` user input reaches `agent-reach install --channels=<user>`** (`src/bootstrap.ts:87-88`). No `shell:true`, so no shell injection, but the channels string is otherwise unvalidated; a malformed value produces an agent-reach error rather than a structured validation error.

## Positive observations

- Clean `SearchBackend` interface with two swappable implementations; the seam is well-scoped.
- SSRF guard is applied consistently at every fetch boundary (native fetch, reach-tools fetch, CLI browse) and is tested for `file://` and `localhost` rejection in both modules.
- Env allowlisting across all three spawn sites prevents leaking parent-process secrets (`DATABASE_URL` test in `test/backend.test.ts`; `mcp-client.test.ts` filter test).
- Config bridge correctly lets existing env win over config values and never surfaces secret values via `loadedConfigSummary` (key names only) — tested.
- Install + cookie-import opt-outs are tested (`test/bootstrap.test.ts`, `test/cli.test.ts`, `test/native-tools.test.ts`).
- Prior review blockers (install_all hyphen, bootstrap install gate bypass, `safe` mode bypass, malformed-config crash) are all resolved in the committed code.
- `gitignore` is correct; no build artifacts or editor caches are tracked.
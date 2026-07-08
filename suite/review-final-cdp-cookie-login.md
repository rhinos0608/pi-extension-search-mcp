# Final Security/Code Review — CDP Browser Cookie Import/Login Automation

**Scope:** working-tree diff (unstaged + untracked) in `/Users/rhinesharar/pi-extension-search-mcp`.
**Focus:** zero-dependency CDP browser cookie import + login automation in `src/cdp.ts`, `src/providers.ts`, wiring in `src/bootstrap.ts`, `src/index.ts`, `src/cli-backend.ts`, `src/reach-tools.ts`, plus tests/docs.
**Mode:** review only — no edits performed.

## Verdict

**No blockers.** The implementation satisfies every focus constraint. Findings below are low/minor, non-blocking hardening suggestions.

## Focus-area checklist

### No new dependencies ✅
- `src/cdp.ts` imports only Node built-ins: `node:fs/promises`, `node:os`, `node:path`, `node:child_process`, plus internal `./providers.js`. WebSocket is used via the runtime global `globalThis.WebSocket` (Node 22+ built-in), **not** the `ws` package. `grep` confirms no `from 'ws'`/`require('ws')` in `src/`.
- `package.json` dependencies unchanged by this diff (no `ws`, no puppeteer/playwright). The `ws` package present in `node_modules` is a transitive dep of `@modelcontextprotocol/sdk`, unused by `cdp.ts`.

### No agent-reach ✅
- All `agent-reach` subprocess logic removed from `src/bootstrap.ts`: `runCommand`, `runAgentReachInstall`, `bootstrapInstallArgs`, `setupEnvironment`, `browserCandidates`, `importBrowserCookiesSummary`, `commandStatus`, `INSTALL_DOC_URL`, `OPENCLI_EXTENSION_URL`, `requireString`, `tail`. `grep` for `agent-reach|agentReach` in `src/` returns nothing.
- Removed env keys `PI_SEARCH_IMPORT_BROWSER_COOKIES`, `PI_SEARCH_BROWSER_COOKIE_BROWSERS` from `src/cli-backend.ts` allowlist; added `PI_SEARCH_BROWSER_AUTOMATION`.

### No startup automation ✅
- `ensureFirstStartBootstrap` now defaults to `off` (was `install_all`). Even in `check` mode it only writes a non-mutating state marker — no `spawn`, no CDP, no cookie read. The bootstrap path contains no subprocess calls whatsoever.
- CDP functions (`importCookiesFromCdp`, `loginViaCdp`) are only reachable through `callSetupTool`, which is only invoked by the `/reach-setup` slash command handler in `src/index.ts`. They are **not** registered as LLM tools (`contract.test.ts` asserts tool set = `web_search, semantic_crawl, browse, research_sources, github, social, video, feeds`; commands include `reach-setup`, tools exclude `reach_setup`). Agent cannot trigger import/login.

### Slash setup only ✅
- `import_cookies` and `login` actions are dispatched only from `setupCommandParams` → `callSetupTool`. Argument parsing maps `/reach-setup login <provider> [port]` and `/reach-setup import_cookies <provider> [endpoint]`. No LLM-tool surface for these actions.

### Loopback endpoint validation incl. discovered ws ✅
- `validateCdpEndpoint` enforces scheme `ws:`/`http:` only (rejects `wss:`, `https:`), loopback host (`localhost`/`127.0.0.1`/`::1`) via `normalizeLoopbackHost`, and port range `1024–65535`. Userinfo in URL (`ws://evil.com@127.0.0.1:9222`) is correctly ignored — `url.hostname` resolves to `127.0.0.1` and `formatWsEndpoint` drops userinfo (verified at runtime).
- `resolveCdpEndpoint` re-validates the discovered `webSocketDebuggerUrl` by calling `validateCdpEndpoint` again, then requires `protocol === 'ws'` and a `/devtools/` path. A discovered non-loopback URL causes `validateCdpEndpoint` to throw, caught and surfaced as `Cannot discover…` (covered by test).
- `loginViaCdp` validates `port` range (`1024–65535`) before spawning; `waitForCdpEndpoint`/discovery fetches target only the already-validated loopback host:port.

### Browser env secret leakage ✅ (with one noted residual)
- `loginViaCdp` builds `browserEnv` from an explicit allowlist `BROWSER_ENV_ALLOWLIST` (`PATH, HOME, TMPDIR, TEMP, TMP, LANG, LC_ALL, DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY`) plus `BROWSER_AUTOMATION=1`. `test/cdp.test.ts` asserts none of the provider API tokens (`GITHUB_TOKEN`, `GH_TOKEN`, `TWITTER_AUTH_TOKEN`, `OPENAI_API_KEY`, `OPENCLI_TOKEN`, …) are in the allowlist, and `length <= 14`.
- `src/reach-tools.ts` adds `sanitizeExternalOutput` applied to external-CLI `stdout`/`stderr`, redacting `Authorization`, `Set-Cookie`, `Cookie`, known token names, and `api[Kk]ey` patterns (tested).

### Cookie values never output ✅
- Return objects from `importCookiesFromCdp`/`loginViaCdp` expose only `provider`, `domains` (domain strings), `count`, `storagePath`, `earliestExpiry`, and a `message` summarizing counts/paths. **No cookie name or value is returned** to the caller. `StorageState` (with values) is written only to the on-disk storage file.
- `writeAuthState` stores key **names** only, never values; tests assert `ghp_dummy`/`ghp_live`/`exa_live_secret` never appear in status output.

### Storage 0600 / dir 0700 ✅ (with noted subtlety)
- `COOKIE_DIR` created with `mode: 0o700`; cookie storage `.tmp` and final files written with `mode: 0o600`; `renameSafe` re-writes final with `0o600`. `AUTH_STATE_PATH` and `STATE_PATH` similarly `0o700`/`0o600`.
- Subtlety (non-blocking): `mkdir({mode})` only sets mode when the directory is created; a pre-existing `~/.pi-extension-search` created earlier with looser perms keeps its mode. Cookie **files** are always `0600` regardless, so secret values remain protected. See Residual Risks.

### Isolated profile cleanup ✅
- `loginViaCdp` spawns Chrome with `--user-data-dir=${profileDir}` (a fresh temp dir under `…/profiles/login-<provider>-<timestamp>`), `--no-first-run --no-default-browser-check --disable-sync --disable-extensions`. The user's real Chrome profile is not touched and its cookies are not read by the login flow. `cleanup()` kills the child (`SIGTERM`) and `rm(profileDir, {recursive, force})` on every exit path (success, timeout, abort, error, spawn-error). Provider arg is validated against `findProvider` (fixed descriptor allowlist), and `Date.now()` is numeric, so the profile path is injection-safe.

### Provider domain allowlist ✅
- Only cookies whose `domain` matches a `desc.cookieDomains` suffix are kept/written (both in `importCookiesFromCdp` and `pollCookies`). `provider` is validated via `findProvider` against the static `PROVIDER_DESCRIPTORS` list; unknown providers rejected. `loginUrl` is a static https constant per provider (test asserts all `loginUrl` are `https://`).

### WebSocket runtime guard ✅
- `requireWebSocket()` checks `typeof globalThis.WebSocket !== 'function'` and throws a clear error. Called at the top of `importCookiesFromCdp` and `loginViaCdp`, and inside `connectAndGetCookies`/`pollCookies`. Tested for both present/absent cases.

### Tests/docs ✅
- New tests: `test/cdp.test.ts` (endpoint validation, discovery, ws guard, opt-out, provider validation, port range, allowlist exclusivity, loginUrl coverage) and `test/contract.test.ts` (tool/command name contract). `test/bootstrap.test.ts`, `test/cli.test.ts`, `test/native-tools.test.ts` updated to assert descriptor-only behavior, no-secret-output, and auth metadata. **105 tests pass**; `tsc --noEmit` clean.
- `README.md`/`SKILL.md` updated: bootstrap default `off`, descriptor-only installs, `PI_SEARCH_BROWSER_AUTOMATION` opt-out, CDP loopback/port restriction note, import_cookies/login usage.

## Commands run

| command | result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`) | passed — no type errors |
| `npm test` (`node --import tsx --test test/**/*.test.ts`) | passed — 105/105 |
| `git diff --cached --stat` | empty (no staged files) |
| `grep -rn "agent-reach" src/` | no matches |
| runtime probe of `validateCdpEndpoint` (userinfo/IPv6/NaN port) | loopback enforced; NaN bypasses range check (noted) |

## Findings (blockers first)

**Blockers: none.**

**Low / minor (non-blocking, hardening suggestions):**

1. **Port NaN gap** (`src/cdp.ts:165-167`, `loginViaCdp`): `port < 1024 || port > 65535` does not catch `NaN`. `/reach-setup login facebook abc` → `Number("abc") === NaN` passes the range check and spawns Chrome with `--remote-debugging-port=NaN`, which fails (10s wait → "CDP endpoint not available"). Security impact: none (user-initiated slash command, fails closed). Suggest `if (!Number.isFinite(port) || port < 1024 || port > 65535)`.

2. **browserEnv reads `process.env`, not the passed `env` param** (`src/cdp.ts:178-182`): the allowlist loop uses `process.env[key]` while the rest of the function uses the `env` argument. Harmless because the allowlist contains no API tokens, but inconsistent with the function's `env` parameter contract. Suggest reading from `env` (falling back to `process.env`) for consistency.

3. **Proxy credentials in allowlist** (`BROWSER_ENV_ALLOWLIST` includes `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`): these env vars can embed `http://user:pass@proxy:port` and are forwarded to the spawned browser. This is a standard browser-needs-proxy tradeoff and the browser is the user's own Chrome, but it is the one residual secret-bearing vector in the browser env. Recommend documenting it or making proxy vars opt-in.

4. **Pre-existing directory mode** (`mkdir({mode})`): mode only applies on creation; a pre-existing `~/.pi-extension-search` created with `0755` by an earlier version keeps that mode. Cookie **files** are always `0600`, so values are protected; only directory listing of names is at stake. Suggest a post-mkdir `chmod` or explicit mode enforcement if hardening is desired.

5. **Spawn-error race** (`src/cdp.ts:198-207`): `setImmediate` may resolve the spawn-check promise before an async `ENOENT` `error` event, so a missing browser reports "Browser started but CDP endpoint not available within 10s" (~10s delay) rather than "Browser executable not found". UX-only; no listener leak (the attached listener no-ops on second resolve). Low.

6. **Fire-and-forget profile cleanup** (`cleanup`, `src/cdp.ts:578-581`): `rm(profileDir,…).catch(()=>{})` is not awaited; if the process exits before the async rm completes the isolated temp profile may leak. It is isolated and re-importable, so impact is low. Could await in a `finally`.

7. **No live-browser integration test for value redaction**: positive-path cookie retrieval is not exercised (no browser in CI); only mocked discovery and validation paths are tested. The no-value-in-output property is verified by code review of return shapes, not by an end-to-end assertion. Acceptable given the no-deps/no-network constraint, noted as residual.

## Residual risks
- Proxy-credential forwarding to the user's own browser (see finding 3).
- Pre-existing directory permissions not tightened by `mkdir` (see finding 4); files remain `0600`.
- No end-to-end test of the successful import/login value-redaction path (network paths mocked only).

## Acceptance

All focus constraints met; no blockers; tests and typecheck green; no staged files; scope not widened (CDP work is additive and self-contained; bootstrap agent-reach code removal is in-scope cleanup that directly supports "no startup automation").
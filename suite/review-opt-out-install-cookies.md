# Review: opt-out install + existing-browser-cookie import

Scope: working-tree diff vs `HEAD` (main, commit cffdf46). No edits made.

## Blockers
None.

## Focus checks

### 1. Install permission is opt-out — PASS
- `src/bootstrap.ts:51` — `ensureFirstStartBootstrap` now defaults to `PI_SEARCH_BOOTSTRAP ?? 'install_all'` (was `check`).
- `src/bootstrap.ts:183-185,197-200` — `installAllowed(env)` returns `true` unless `PI_SEARCH_ALLOW_INSTALL` is one of `0|false|no|off` (via `isDisabled`). Unset / `1` / any other value → allowed. This is true opt-out.
- `src/bootstrap.ts:114-116` (bootstrap path) and `src/bootstrap.ts:139-146` (`/reach-setup` path) both gate on `installAllowed`, with clear `blocked by PI_SEARCH_ALLOW_INSTALL=<value>` messages.
- `test/bootstrap.test.ts` — `installAllowed is opt-out` + `reach_setup install blocks when explicitly opted out` (asserts `/blocked by PI_SEARCH_ALLOW_INSTALL=0/`).
- `test/cli.test.ts`, `test/native-tools.test.ts` — install tests now pass `{ PI_SEARCH_ALLOW_INSTALL: '0' }` and assert the opt-out message.
- README:62-63 and SKILL.md:31 wording updated to opt-out.

### 2. Browser cookie import uses existing cookies only — PASS
- `src/bootstrap.ts:154-181` — `importBrowserCookiesSummary` only spawns `agent-reach configure --from-browser <browser>` for each candidate. No browser-launch / new-login / QR / API-key flow is initiated by this extension's code; it reads existing local browser cookie stores.
- README:63 — "Existing browser cookies are imported automatically after successful setup when available"; "New logins, OpenCLI Chrome extension install, QR scan, and API key entry may still require user action." Consistent with code.
- README:73 — "runs `agent-reach configure --from-browser` against local browsers to reuse existing cookies when available."
- Cookie import is itself opt-out: `browserCookieImportAllowed` honors `PI_SEARCH_IMPORT_BROWSER_COOKIES=0|false|no|off` (`src/bootstrap.ts:160-162,187-189`).
- Browser order configurable via `PI_SEARCH_BROWSER_COOKIE_BROWSERS` (default `chrome,firefox,edge,brave,opera`).
- Wired through both env allowlists: `src/bootstrap.ts:248` (`setupEnvironment`) and `src/cli-backend.ts:100-101` (`buildCliEnvironment`).

### 3. reach-status / reach-setup remain slash commands, not tools — PASS
- `src/index.ts:164` `pi.registerCommand('reach-status', ...)` and `src/index.ts:174` `pi.registerCommand('reach-setup', ...)`.
- `registerExpansionTools` (`src/index.ts:203`) registers only `web_search, semantic_crawl, browse, research_sources, social, video, feeds`. No `reach_setup` / `reach_status` / `import_cookies` tool is exposed to the LLM.
- `import_cookies` is reachable only as a sub-action of the `/reach-setup` slash command (`src/index.ts:176,182` → `callSetupTool` `case 'import_cookies'` at `src/bootstrap.ts:90-91`).

### 4. Secrets not leaked — PASS
- `src/bootstrap.ts:239-251` `setupEnvironment` and `src/cli-backend.ts:84-163` `buildCliEnvironment` both use explicit allowlists; parent env is not forwarded wholesale.
- Cookie import return path is safe: `importBrowserCookiesSummary` returns only `{status, message, attempts:[{browser, code}]}`. It does **not** include `result.stdout`/`result.stderr` from `agent-reach configure`, so cookie values/contents are not surfaced to the LLM (`src/bootstrap.ts:159-181`).
- `importBrowserCookies` (`src/bootstrap.ts:154-157`) returns `textResult(summary.message, summary)` — message only, no raw command output.
- Bootstrap state file (`bootstrap.json`, mode 0o600, dir 0o700) stores only `status`/`message`/`mode` — the cookie summary message contains no secret values (`src/bootstrap.ts:270-281`).
- Note (pre-existing, not introduced here): `runAgentReachInstall` (`src/bootstrap.ts:151`) still appends `result.stdout`/`result.stderr` from the **install** command to the slash-command result. Not a new leak in this diff, but if `agent-reach install` ever prints tokens they would be visible to the user/LLM via `/reach-setup`. Flagged under residual risks.

### 5. Tests / docs aligned — PASS
- All 49 tests pass (`npm test`): `installAllowed is opt-out`, `reach_setup install blocks when explicitly opted out`, `runCommand blocks setup install when opted out`, `runCommand supports browser cookie import opt-out`, `reach_setup import actions are blocked when opted out`, `reach_setup import cookies can be opted out`.
- README.md (lines 61-63, 73, 80-84) and SKILL.md (line 31) updated to match new defaults and env vars.
- `setupStatus` safety text (`src/bootstrap.ts:103-107`) updated to reflect install_all default and cookie import.

## Non-blocker findings (minor)
- **M1 — Doc/UX inconsistency.** `src/index.ts:175` slash-command description reads `...|import_cookies channels]`, implying `import_cookies` takes a channels argument. It does not: `import_cookies` ignores `channels` and uses `PI_SEARCH_BROWSER_COOKIE_BROWSERS`. README:62 correctly omits `channels` after `import_cookies`. The `/reach-setup import_cookies chrome` form would silently drop `chrome`. Suggest dropping `channels` from the index.ts description (and/or honoring it as a browser list override).
- **M2 — First-start latency.** `importBrowserCookiesSummary` tries up to 5 browsers sequentially with a 180s timeout each (`src/bootstrap.ts:167-168`), so a worst-case first start after a successful install could spend up to ~15 min before giving up. Consider a shorter per-browser timeout or early-exit heuristics. Not a correctness issue.
- **M3 — Pre-existing stdout passthrough on install.** See note in §4; not changed by this diff but worth hardening in a follow-up (redact/tail install stdout).

## Residual risks
- Cookie import on macOS may prompt for keychain access to decrypt Chrome/Edge/Brave cookie stores; this is user-facing and acknowledged in the warn message. Acceptable for a local extension.
- Changing the first-start default from `check` to `install_all` (auto-install + auto-cookie-import) is a meaningful behavior shift; it is opt-out as required, but users upgrading without setting `PI_SEARCH_BOOTSTRAP=off` will get an install on next first-start. Documented in README/SKILL.
- `agent-reach configure --from-browser` semantics are external to this repo; correctness of "existing cookies only" depends on that CLI not opening browsers/initiating logins. Code here invokes it correctly per docs.

## Validation
- `npm test` → 49 pass / 0 fail / 0 cancelled.
- `git status` → 8 modified files, **no staged files** (all changes unstaged).
- No `build` script defined in package.json (not run).
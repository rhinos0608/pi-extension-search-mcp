# CDP Cookie Import and Login Automation — Implementation Report

## Summary

Implemented zero-dependency CDP-based cookie import and headed login automation using Node built-ins only (`globalThis.WebSocket`, `fetch`, `child_process`, `fs/promises`). No runtime dependencies added.

## Files Changed

| File | Change |
|------|--------|
| `src/providers.ts` | Added `loginUrl?: string` to `ProviderDescriptor`; populated for 5 `browser_cookie` providers (facebook, instagram, xiaohongshu, linkedin, xueqiu); exported `findProvider()` |
| `src/cdp.ts` | **New** — 450-line module: `importCookiesFromCdp()`, `loginViaCdp()`, `validateCdpEndpoint()` |
| `src/bootstrap.ts` | Added `login` to `SetupAction`; added `import_cookies` with provider→CDP flow; added `login`→headed browser flow; env pass-through |
| `src/index.ts` | Updated slash command description/completions to include `login` |
| `src/cli-backend.ts` | Added `PI_SEARCH_BROWSER_AUTOMATION` to env allowlist |
| `README.md` | Documented new `import_cookies <provider>` and `login <provider>` commands, `PI_SEARCH_BROWSER_AUTOMATION` |
| `SKILL.md` | Added safety guidance for CDP/browser automation |
| `test/cdp.test.ts` | **New** — 21 tests for endpoint validation, provider rejection, opt-out |
| `test/bootstrap.test.ts` | Added 8 tests for new `callSetupTool` flows |

## Implemented Actions

### `import_cookies <provider> [endpoint]`
- Validates provider has `cookieDomains` in provider registry
- Connects to CDP WebSocket on localhost (default `ws://127.0.0.1:9222` or http)
- Calls `Network.getAllCookies` via CDP
- Filters cookies by provider's cookie domain suffixes (exact or subdomain match)
- Saves Playwright-compatible `storageState` JSON to `~/.pi-extension-search/cookies/<provider>.storageState.json` (mode 0600)
- Returns summary: provider, domains, count, path, earliestExpiry — **no cookie values in output**

### `login <provider> [port]`
- Requires provider with `cookieDomains` AND `loginUrl`
- Launches Chrome with isolated temp profile (never uses default profile)
- Opens provider `loginUrl` in an app-style window
- Polls cookies every 2s via CDP until domain-matched cookies appear or timeout (default 5min)
- On success: saves storageState, kills browser, cleans up temp profile
- On timeout/failure: kills browser, cleans up temp profile, returns error message
- Respects `PI_SEARCH_BROWSER_AUTOMATION=0` opt-out

### No-provider fallback
- `import_cookies` without `provider` returns descriptor listing cookie-backed providers
- `login` without `provider` returns error

## Security Constraints
- CDP endpoints restricted to `localhost`/`127.0.0.1`, ports 1024–65535 only
- Endpoint port validated before URL construction (prevents default-port bypass)
- Storage files written mode 0600; temp file atomic rename
- No cookie values in output — summary only
- `PI_SEARCH_BROWSER_AUTOMATION=0` disables all browser automation
- Browser launched with isolated profile; cleaned up on completion/failure
- Provider with `loginFlow: 'env_var'` (e.g. github, twitter, reddit) returns descriptive error — CDP import/login only works for cookie-based providers

## Verification Results
- **87 tests pass** (was 62)
- **Typecheck**: clean
- **Audit**: 0 vulnerabilities
- **Pack**: 17 files, 34.0 kB, no smartread cache
- **Diff check**: pass

# Final Review Fixes

## Changes applied

### 1. `src/reach-tools.ts` — failure-path CLI output redaction
- Exported `sanitizeExternalOutput` for testability
- Line 416: passes `result.stderr || result.stdout` through `sanitizeExternalOutput` before `tail()` in failure message pushed to `failures[]`

### 2. `src/cli-backend.ts` — stale env vars removed
- Removed `PI_SEARCH_IMPORT_BROWSER_COOKIES` and `PI_SEARCH_BROWSER_COOKIE_BROWSERS` from the allowlist (cookie import is descriptor-only, no longer uses subprocess)

### 3. `test/native-tools.test.ts` — redaction test added
- 6 test cases covering Authorization header, Set-Cookie, env var tokens (`TWITTER_AUTH_TOKEN`, `GITHUB_TOKEN`), generic `apiKey`, and clean text passthrough

## Verification
- `npm test` — 62 pass (1 new redaction test)
- `npm run typecheck` — pass
- `git diff --check` — no whitespace errors
- No staged files

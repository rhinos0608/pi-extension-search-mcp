# In-House Orchestrator Pivot — Implementation Report

## Summary

Removed all Agent-Reach runtime dependencies and calls. Replaced with in-house orchestrator that returns structured descriptors instead of running subprocess installations. Startup defaults to non-mutating `off`. Output sanitization added for external CLI backends.

## Changes

### `src/bootstrap.ts` — Major rewrite
- Removed: `INSTALL_DOC_URL`, `OPENCLI_EXTENSION_URL`, `runAgentReachInstall`, `importBrowserCookies`, `importBrowserCookiesSummary`, `bootstrapInstallArgs`, `setupEnvironment`, `runCommand` (bootstrap-specific), `commandStatus`, `tail`
- Default `PI_SEARCH_BOOTSTRAP` changed from `install_all` to `off` (non-mutating)
- `ensureFirstStartBootstrap`: only writes state marker, zero subprocess calls
- `callSetupTool` install/import actions return structured JSON descriptors:
  - `install_core`, `install_all`, `install_channels` return `{ descriptor: true, backends: [...], message }`
  - `import_cookies` returns `{ descriptor: true, instructions: [...] }`
- Channel validation: `install_channels` rejects unknown channel names
- Added `writeAuthState()` — writes provider key-name metadata to `~/.pi-extension-search/auth-state.json`, no secret values
- Added `readAuthState()` — reads auth state for status reporting
- Kept: `installAllowed()`, `isDisabled()` (unchanged semantics)

### `src/reach-tools.ts` — Output sanitization
- Added `SECRET_PATTERNS` regex list and `sanitizeExternalOutput()` — scrubs Authorization headers, Cookie headers, known env var values, API keys from external subprocess stdout/stderr
- Applied in `runFirstUsable` before returning stdout/stderr to tool result

### `src/index.ts` — Description update
- `/reach-setup` command description: "Show provider info and setup descriptors...

### `README.md` & `SKILL.md` — Documentation cleanup
- Removed all Agent-Reach references
- Updated bootstrap default to `off`
- Cookie import: "not automated / not read"

### Tests — Updated for new contract
- `test/bootstrap.test.ts`: 13 tests (was 3), covers:
  - Non-mutating bootstrap
  - Structured install/import descriptors
  - Channel validation (valid, invalid, empty)
  - Auth state with key-name-only reporting (no secret values)
  - No agent-reach in plan output
  - Descriptor returned regardless of opt-out
- Removed: `bootstrapInstallArgs` tests (function removed)
- `test/cli.test.ts`: Updated install/import tests to match descriptor contract
- `test/native-tools.test.ts`: Updated install/import tests to match descriptor contract

## Verification
- `npm test`: 55 pass, 0 fail
- `npm run typecheck`: pass
- `npm audit --audit-level=high`: 0 vulns
- `npm pack --dry-run`: clean
- No agent-reach strings in `src/`, `README.md`, `SKILL.md`
- No staged files
- No runtime dependencies added

## Residual Risks
- Env allowlist drift: still 3 separate files (`bootstrap.ts` unused setupEnvironment remnant, `cli-backend.ts`, `reach-tools.ts`). Not consolidated this pass — out of scope per architect decision.
- Auth state file written to `~/.pi-extension-search/auth-state.json` — content is key names only (no secrets), but file exists as metadata. Risk: minimal.

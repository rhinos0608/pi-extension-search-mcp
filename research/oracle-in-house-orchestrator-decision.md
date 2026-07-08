# Oracle decision: in-house orchestrator scope

## Inherited decisions

- Keep Pi public tool names stable: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`, plus new retrieval tools `social`, `video`, `feeds`.
- Keep setup/status as slash commands only: `/reach-status`, `/reach-setup`; do not expose `reach_status` / `reach_setup` as agent tools.
- Default backend path is local CLI/native. `SEARCH_BACKEND=mcp` remains legacy fallback for original tools unless deliberately revised.
- Reuse `/Users/rhinesharar/search-mcp/config.json` by mapping known keys into env vars. Existing env wins. Never print secret values.
- Preserve allowlist-based env forwarding. Do not leak parent process env wholesale.
- User has now revised setup direction: no `agent-reach` dependency, minimal dependencies, in-house orchestrator, operations in-house except embedding/LLM services, reuse search-mcp envs where possible, provider reach via cookies or user-initiated login/setup flows.
- User wants parent to orchestrate workers/reviewers; this oracle should decide scope, not implement.

## Diagnosis

Current code conflicts with newest requirements in one major way: `src/bootstrap.ts` treats Agent-Reach as setup engine. It auto-runs `agent-reach install ...` on first start and imports browser cookies via `agent-reach configure --from-browser`. That violates “no agent-reach dependency” and “in-house orchestrator”.

Existing `src/reach-tools.ts` already contains useful in-house orchestrator skeleton: channel registry, ordered backend candidates, `active_backend`, native V2EX/RSS routes, optional external CLIs, per-platform backend override. Preserve and deepen this seam rather than replacing it.

Provider-cookie research supports direct browser cookie extraction or Playwright/CDP later, but first safe iteration should not add `sweet-cookie`, Playwright, CDP, stealth plugins, or browser-profile scraping. Minimal-dependency requirement beats completeness. Implement capability planning/status and explicit user-initiated auth-flow descriptors now; add real direct cookie extraction only after separate design/security pass.

## Drift / contradiction check

### Blocker

- **blocker: `src/bootstrap.ts:29,83-90,111-129,138-151,154-181` — Agent-Reach is runtime setup/cookie engine.** New requirement says no `agent-reach` dependency. Remove runtime calls and docs claiming setup uses Agent-Reach.
- **blocker: `src/bootstrap.ts:50-56`, `src/index.ts:45` — first-start mutating install default.** New requirement says in-house orchestrator and safe setup through slash command. Startup must not install packages or import cookies.

### High

- **high: `src/bootstrap.ts:154-181` — browser cookie import shells to external binary and tries browsers by default after install.** Cookie credentials go through unaudited external process. Replace with explicit slash setup flow descriptors now; no automatic cookie reading.
- **high: `src/reach-tools.ts:113,125,389` — raw external stdout/stderr returned to LLM/tool result.** Optional CLIs may emit cookies/tokens/PII. Add sanitization or structured output only before expanding login/cookie reach.
- **high: `src/github.ts:22-27`, `src/native-tools.ts:186-188` — `code_search` advertises AST/embedding semantic behavior but default native path is lexical GitHub REST.** Not central to setup pivot, but should be corrected or explicitly gated by embedding/search-mcp backend.
- **high: `src/index.ts:22-36`, `src/native-tools.ts:206-215` — `research_sources` advertises many APIs but missing sources silently degrade to DuckDuckGo.** Avoid similar silent degradation in new provider reach status.

### Medium

- **medium: `src/cli-backend.ts:84-163`, `src/reach-tools.ts:593-607`, `src/bootstrap.ts:239-251` — duplicated env allowlists drift.** New orchestrator should centralize env policy.
- **medium: `src/local-config.ts:3` — hardcoded `/Users/rhinesharar/search-mcp/config.json`.** Acceptable for this local run, but package/public docs should prefer portable default plus explicit local override.
- **medium: `src/reach-tools.ts:571-591`, `src/native-tools.ts:337-357` — duplicated SSRF guard.** Keep out of first pivot if needed, but do not add new network/cookie flows until shared validator exists.

## Recommendation

### Implement now: small safe in-house orchestrator slice

1. **Remove Agent-Reach runtime dependency completely.**
   - Delete/replace all `runCommand('agent-reach', ...)` paths in `src/bootstrap.ts`.
   - Remove Agent-Reach install URL/status text from runtime docs.
   - Startup bootstrap becomes non-mutating: default `check` or `off`; no package install; no cookie import.

2. **Convert `/reach-setup` into in-house capability planner/auth-flow coordinator.**
   - Keep action names for compatibility: `status`, `plan`, `install_core`, `install_all`, `install_channels`, `import_cookies`.
   - `install_*` actions must not install packages. They should return structured plan/manual instructions for optional CLIs and native capabilities.
   - Validate `channels` against known channel/provider list before returning plan.
   - Add user-initiated flow shape: provider/channel, auth method, required env keys, cookie domains, storage path, risk level, next action.

3. **Provider reach status should become explicit and non-secret.**
   - `/reach-status [family]` should report per provider:
     - native public API available? yes/no
     - credential env keys present? key names only
     - cookie/auth state file present? yes/no/path basename only, not cookie values
     - optional CLI present? yes/no
     - `active_backend` selected and why
     - `login_flow` available (`manual_cookie_import`, `headed_login_planned`, `qr_login_planned`, `api_key_env`, `none`)
   - Reuse env from `loadSearchMcpEnvironment`; do not parse config elsewhere.

4. **Add auth-flow descriptors, not real browser extraction yet.**
   - Store planned auth state under `~/.pi-extension-search/auth/` or `~/.pi-extension-search/cookies/` with `0700` dir / `0600` files when files are later written.
   - First iteration can return instructions and expected paths only.
   - If implementing manual cookie-file import now, restrict to explicit provider, validate domain allowlist, store only after user-provided file path, and redact result. Do not inspect browsers automatically.

5. **Keep optional external CLIs as optional backend executors only.**
   - No automatic install.
   - No Agent-Reach wrapper.
   - Probe installed commands for status.
   - Treat `yt-dlp`, `rdt`, `bili`, `opencli`, etc. as optional local user tools; sanitize outputs.

6. **Centralize env policy enough to prevent next drift.**
   - Prefer `src/env.ts` or similar: shared base env allowlist + per-command additions.
   - Setup/planner should receive no API/session secrets unless needed for status key-presence checks; never forward secrets to installers.
   - External backend commands receive only command-specific env keys.

7. **Update docs/tests to match new contract.**
   - README/SKILL: no auto install, no Agent-Reach, no automatic browser-cookie import.
   - Tests must assert no `agent-reach` strings in `src/` runtime path, setup actions are non-mutating, channel validation, and contract tool/command names.

### Do not implement yet

- Direct browser SQLite/keychain cookie extraction (`sweet-cookie`, custom SQLite/keychain code). Needs separate security review and dependency decision.
- Playwright/CDP login automation, persistent browser contexts, QR/SMS automation, stealth/fingerprint work. Too much risk and dependency weight for first pivot.
- Automatic browser/profile scanning on startup or after setup. Violates consent expectations.
- Any posting/liking/commenting/mutating provider actions. Retrieval only.
- A multi-process MCP supervisor. Existing channel router is enough.
- Removing legacy `SEARCH_BACKEND=mcp` in same change. Keep compatibility; avoid broad pivot.
- Full semantic/AST code search or missing research API buildout unless scoped separately. Correct claims or explicit fallback instead.

## Exact acceptance criteria for implementation worker

1. **No Agent-Reach runtime dependency.**
   - `grep -R "agent-reach\|Agent Reach\|from-browser" src README.md SKILL.md` returns no runtime dependency claims. Historical research/suite files may still mention it.
   - `src/bootstrap.ts` contains no `spawn('agent-reach'...)` equivalent and no command builder for Agent-Reach.

2. **Startup is non-mutating.**
   - Loading `src/index.ts` does not install packages, read browser cookies, open browsers, or spawn optional platform CLIs.
   - Bootstrap default is `check` or `off`; tests cover default behavior and `PI_SEARCH_BOOTSTRAP=off`.

3. **Slash setup remains command-only and in-house.**
   - `reach-status` and `reach-setup` are still `pi.registerCommand` only.
   - No `pi.registerTool` for `reach_status` / `reach_setup`.
   - `/reach-setup plan` returns structured provider/channel plan with native/API/cookie/login/manual optional CLI paths.
   - `/reach-setup install_*` returns manual plan/instructions, not installation execution.
   - `/reach-setup install_channels` rejects unknown channel names.

4. **Provider reach/auth status is explicit and redacted.**
   - Status lists key names present, not values.
   - Cookie/auth state reports existence/freshness metadata only, not cookie values.
   - Active backend selection has reason.

5. **Env reuse preserved.**
   - `loadSearchMcpEnvironment` remains entry point for `/Users/rhinesharar/search-mcp/config.json` reuse.
   - Existing env still wins over config-derived env.
   - Added tests prove mapped keys can influence status/plan by key presence only.

6. **No new runtime dependencies in first pivot.**
   - `package.json` dependencies unchanged unless parent explicitly approves.
   - No Playwright, sweet-cookie, chrome-remote-interface, keytar, sqlite packages.

7. **External output redaction.**
   - `social`/`video` optional CLI result paths scrub known secrets (`Bearer`, `Authorization`, `Cookie`, `Set-Cookie`, token-like env values) or return parsed fields only.
   - Tests cover redaction helper.

8. **Verification passes.**
   - `npm test`
   - `npm run typecheck`
   - `npm audit --audit-level=high`
   - `npm pack --dry-run`
   - `git diff --check`

## Risks

- “Reach to all providers” cannot safely mean full automated login/cookie extraction in this iteration without adding heavy dependencies and platform-specific anti-bot risk.
- Optional external CLIs may still break due unknown argv contracts; status must report unknown/unavailable clearly.
- Some provider access (Facebook/Instagram/Twitter/X/LinkedIn) remains high-risk even with cookies. Setup should warn and prefer read-only, low-rate use.
- Hardcoded local config path remains acceptable only for this local repo unless package is marked private or default is made portable.
- Legacy `SEARCH_BACKEND=mcp` may still bypass new orchestrator; acceptable if documented as legacy and not used for new reach tools.

## Need from main agent

No decision needed before worker implementation if parent accepts this small safe scope. If parent wants actual browser cookie extraction/login automation now, that is a separate explicit product/security decision and should approve new dependencies plus provider risk.

## Suggested execution prompt

Implementation handoff warranted.

> Implement small safe in-house orchestrator pivot for `/Users/rhinesharar/pi-extension-search-mcp`. Remove all Agent-Reach runtime calls and docs. Make startup non-mutating (`check`/`off` default). Convert `/reach-setup` install/import actions into in-house structured planner/auth-flow descriptors; no package installs, no browser cookie reads, no browser launches. Validate channels. Preserve tool names and slash-command-only setup/status. Reuse `loadSearchMcpEnvironment` and report key names only. Add provider auth/status metadata and storage path descriptors under `~/.pi-extension-search` without storing secrets unless explicit manual import is implemented with domain validation/redaction. Keep optional CLIs as optional backends only and sanitize external stdout/stderr. Add/update tests for no agent-reach runtime strings, non-mutating startup/setup, command/tool contract, channel validation, env key-presence reporting, and output redaction. Run full verification.

## Acceptance notes

This artifact is design/review only. No code changed by oracle.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings include severities and file paths: blocker src/bootstrap.ts:29,83-90,111-129,138-181 for Agent-Reach setup/cookie dependency; blocker src/index.ts:45 and src/bootstrap.ts:50-56 for first-start mutating bootstrap; high src/reach-tools.ts:113,125,389 for raw external output; medium src/cli-backend.ts:84-163 + src/reach-tools.ts:593-607 + src/bootstrap.ts:239-251 for env allowlist drift; medium src/local-config.ts:3 for hardcoded config path. Recommendations include exact implementation scope and acceptance criteria."
    }
  ],
  "changedFiles": [
    "research/oracle-in-house-orchestrator-decision.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --short --branch && grep -R \"agent-reach\\|from-browser\\|runAgentReachInstall\\|import_cookies\\|PI_SEARCH_ALLOW_INSTALL\\|PI_SEARCH_IMPORT_BROWSER_COOKIES\" -n src test README.md SKILL.md | head -120",
      "result": "passed",
      "summary": "Confirmed current runtime still references agent-reach/from-browser in src/bootstrap.ts and docs; working tree has untracked research/review artifacts only."
    },
    {
      "command": "Read research/provider-cookie-login-options.md, research/search-mcp-env-reuse-orchestrator.md, suite/review-architecture-all-work.md, suite/review-compat-docs-tests-all-work.md, suite/review-security-all-work.md",
      "result": "passed",
      "summary": "Used separate reviewer/research artifacts as evidence for scope decision."
    },
    {
      "command": "Read package.json, src/backend.ts, src/index.ts, grep reach-tools orchestrator functions",
      "result": "passed",
      "summary": "Verified current dependency set, backend switch, slash command registration, and existing channel-router seam."
    }
  ],
  "validationOutput": [
    "Current code still contains runtime Agent-Reach call sites in src/bootstrap.ts and docs; decision recommends removing them before implementation acceptance.",
    "No implementation validation run because oracle task requested no edits."
  ],
  "residualRisks": [
    "Actual browser cookie extraction/login automation deliberately deferred; full provider reach for high-risk platforms remains future work.",
    "Legacy SEARCH_BACKEND=mcp may bypass new orchestrator unless later unified or documented.",
    "Existing untracked research/suite artifacts remain in working tree from parent/reviewer runs."
  ],
  "noStagedFiles": true,
  "diffSummary": "Design artifact only; no source/test changes by oracle.",
  "reviewFindings": [
    "blocker: src/bootstrap.ts:29,83-90,111-129,138-181 - Agent-Reach runtime dependency and browser-cookie import conflict with no-agent-reach/in-house orchestrator requirement.",
    "blocker: src/index.ts:45 and src/bootstrap.ts:50-56 - startup currently triggers mutating install flow by default; must become non-mutating.",
    "high: src/reach-tools.ts:113,125,389 - external CLI stdout/stderr can leak secrets to model; sanitize or parse before returning.",
    "medium: src/cli-backend.ts:84-163, src/reach-tools.ts:593-607, src/bootstrap.ts:239-251 - duplicated env allowlists drift; centralize policy.",
    "medium: src/local-config.ts:3 - hardcoded local config path is acceptable for local use but risky for package/public docs."
  ],
  "manualNotes": "Best next move: worker implements small safe pivot: remove Agent-Reach calls, make setup/status an in-house planner/auth-flow coordinator, keep no new dependencies, preserve tool names and search-mcp env reuse. Do not implement Playwright/CDP/sweet-cookie extraction until separate approval."
}
```

# Oracle decision: CDP cookie extraction + headed login automation

## Inherited decisions
- No `agent-reach` runtime dependency. No external orchestrator dependency.
- Minimal dependencies. Prefer Node built-ins; external services only embedding/LLM.
- Extension acts as in-house orchestrator: route requests, probe optional backends, reuse `/Users/rhinesharar/search-mcp/config.json` env mappings.
- Setup/status remain Pi slash commands only. `reach_setup`/`reach_status` must not become agent tools.
- No automatic installs, cookie reads, browser opens, or login attempts on startup.
- Current worktree already moved `/reach-setup import_cookies` to descriptor-only and added provider descriptors in `src/providers.ts`.
- Cookie/session values must never appear in slash output, tool output, logs, docs artifacts, or tests.

## Diagnosis
User now explicitly wants real browser cookie extraction / Playwright-CDP login automation. Safest smallest slice is **not** direct default-profile SQLite/keychain scraping. Best next slice is CDP-only, explicit slash-command flow:

1. Import cookies from an already-running local Chrome DevTools Protocol endpoint (`BROWSER_CDP_ENDPOINT` from env/search-mcp config or slash arg).
2. Launch a headed Chromium-family browser with an isolated profile, let user log in, then extract allowlisted provider cookies via CDP.
3. Persist raw cookie values only to protected Playwright-compatible `storageState` JSON under `~/.pi-extension-search/cookies/`.
4. Return only provider/domain/count/path/status summaries.

This honors “real cookie extraction” while preserving no-dependency/in-house constraints.

## Drift / contradiction check
- `src/bootstrap.ts:151-171` currently says cookie import is not automated. That should change only for new explicit CDP actions or for `import_cookies` with provider/source args; no-arg `import_cookies` can remain plan/descriptor for compatibility.
- `research/no-dep-cdp-cookie-login.md:11-12` correctly identifies Node global `WebSocket`, but implementation detail is wrong/ambiguous: Node WHATWG `WebSocket` uses `addEventListener`/`onopen`/`onmessage`, not `ws` package `.on(...)`. Treat as medium implementation pitfall.
- `src/providers.ts:1-10` lacks login URL/output metadata. Add optional provider login URL or derive carefully; do not hardcode flows inside `bootstrap.ts`.
- Direct “existing browser cookies” from default Chrome profile would conflict with prior safety decision (“no browser cookie reads by default”) and Chrome 136 remote-debug hardening. Existing-cookie import should mean “from user-supplied local CDP endpoint” for this slice.

## Recommendation
Implement **zero-new-dependency CDP cookie module** as next slice.

### Scope approved
Add new in-house module, suggested path:
- `src/cdp-browser.ts` or `src/browser-cookies.ts`

Capabilities:
- Connect to local CDP endpoint.
- Launch headed Chrome/Chromium/Brave/Edge with isolated profile.
- Open provider login URL.
- Wait/poll for allowlisted cookies.
- Save Playwright-compatible storage state.
- Redact all display output.

Do **not** add `playwright`, `puppeteer`, `ws`, `chrome-cookies-secure`, SQLite, keychain, or Agent-Reach.

### Slash setup actions
Keep existing `/reach-setup` command. Add actions parsed after first token.

Recommended actions:
- `/reach-setup import_cookies <provider> [endpoint]`
  - If no provider: keep existing descriptor output.
  - If provider present: import from CDP endpoint.
  - Endpoint source order: explicit arg → `BROWSER_CDP_ENDPOINT` → error with launch instructions.
- `/reach-setup login <provider> [port]`
  - Launch headed browser with isolated profile, navigate to provider login URL, wait for cookies, save storage state.
- Optional later: `/reach-setup cookie_status [provider]`
  - Report storage state file presence, mtime, cookie count; no values.

CLI JSON equivalents for tests/internal:
- `{ "action": "import_cookies", "provider": "twitter", "endpoint": "http://127.0.0.1:9222" }`
- `{ "action": "login", "provider": "twitter", "port": 9222, "timeoutMs": 180000 }`

Avoid adding new Pi command names unless needed. Existing `/reach-setup` is enough.

### Gates/defaults
- Startup: unchanged `PI_SEARCH_BOOTSTRAP=off` default; no browser launch/import from startup ever.
- Agent tools: unchanged; no browser actions exposed as LLM tools.
- Browser automation enabled only through explicit slash/CLI setup action.
- Add opt-out kill switch: `PI_SEARCH_BROWSER_AUTOMATION=0|false|no|off` blocks `login` and CDP `import_cookies`.
- For headed launch, require either detected known browser or validated `BROWSER_EXECUTABLE_PATH`.
- Node version: require `globalThis.WebSocket`; if missing, return actionable error “Node 22+ required for zero-dependency CDP”. Do not add dependency fallback.

### Storage contract
- Directory: `~/.pi-extension-search/cookies/` mode `0700`.
- File: `~/.pi-extension-search/cookies/<provider>.storageState.json` mode `0600`.
- Format:
  - `{ cookies: [...], origins: [] }` Playwright-compatible.
- Output: provider, domains, cookie count, file path, expiry summary. Never values.
- Do not write redacted values into storage state; raw values are needed for actual use. Redaction applies only to returned/displayed summaries.

### Provider/domain contract
- Only providers with `cookieDomains.length > 0` can use CDP import/login.
- Domain args may only narrow descriptor domains, never expand them.
- Add optional `loginUrl` to `ProviderDescriptor` or a helper map near descriptors.
- Minimum login URLs:
  - github: `https://github.com/login`
  - twitter: `https://x.com/login`
  - reddit: `https://www.reddit.com/login/`
  - bilibili: `https://passport.bilibili.com/login`
  - facebook: `https://www.facebook.com/login`
  - instagram: `https://www.instagram.com/accounts/login/`
  - xiaohongshu: `https://www.xiaohongshu.com/`
  - linkedin: `https://www.linkedin.com/login`
  - xueqiu: `https://xueqiu.com/`

### Endpoint/browser validation
- Accept only local CDP endpoint forms:
  - `http://127.0.0.1:<port>`
  - `http://localhost:<port>` normalized to loopback
  - `ws://127.0.0.1:<port>/devtools/...`
  - `ws://localhost:<port>/devtools/...`
- Reject external hosts, private LAN hosts, `file:`, `https:`, `wss:` for this slice.
- Port integer 1024-65535.
- Browser launch profile dir: random isolated dir under `os.tmpdir()` or `~/.pi-extension-search/profiles/<provider>-<random>`; mode `0700`; never default browser profile.
- Cleanup temp profile after login import unless persistent profile explicitly implemented later.

### CDP protocol minimum
- Discover `webSocketDebuggerUrl` from `/json/version` or supplied WS endpoint.
- Use browser target flow (`Target.createTarget`, `Target.attachToTarget({ flatten: true })`) or target WS flow. Either OK if tests cover message routing.
- Enable `Network` before cookie calls.
- Get cookies with `Network.getCookies({ urls: descriptor.cookieDomains.map(d => 'https://' + d + '/') })`.
- Filter returned cookies by exact/suffix domain match against provider allowlist.
- Poll every 1-2s until cookie count > 0 or timeout.
- Close browser via CDP `Browser.close` when launched by extension; kill child on timeout/abort.

## Suggested file-level plan
- `src/providers.ts`
  - Add optional `loginUrl?: string` to `ProviderDescriptor` or export `loginUrlForProvider()`.
  - Keep cookie domain allowlist source of truth.
- `src/cdp-browser.ts` (new)
  - CDP client, endpoint validation, browser launch, cookie extraction, storageState save.
- `src/bootstrap.ts`
  - Route `import_cookies` with provider to CDP import; route `login` to headed login.
  - Keep descriptor behavior when no provider provided.
  - Add `PI_SEARCH_BROWSER_AUTOMATION` opt-out check.
- `src/cli-backend.ts`
  - Forward `PI_SEARCH_BROWSER_AUTOMATION` if setup flows run via CLI backend.
- `README.md` / `SKILL.md`
  - Document explicit CDP setup actions, storage path, no startup automation, no default profile read.
- Tests:
  - `test/cdp-browser.test.ts` for pure validation/conversion/client fake WebSocket if feasible.
  - `test/bootstrap.test.ts` for action parsing/gating/no secret output.
  - `test/cli.test.ts` for CLI JSON setup calls.
  - Keep `test/contract.test.ts` unchanged: no new agent tools.

## Acceptance criteria for implementation
- No new runtime dependency in `package.json`.
- `git grep -n "agent-reach\|from-browser" -- src README.md SKILL.md` returns no matches.
- `npm test`, `npm run typecheck`, `npm audit --audit-level=high`, `npm pack --dry-run`, `git diff --check` pass.
- Unit tests prove:
  - remote CDP hosts rejected;
  - invalid providers rejected;
  - domains cannot expand beyond provider allowlist;
  - cookie values absent from command output;
  - storage state file mode intended as `0600`;
  - Node without `WebSocket` gets clean unsupported error;
  - `/reach-setup import_cookies` with no provider remains descriptor-only;
  - `/reach-setup login <provider>` blocked by `PI_SEARCH_BROWSER_AUTOMATION=0`;
  - contract tools/commands unchanged.
- Browser integration test optional/gated behind `PI_SEARCH_RUN_BROWSER_TESTS=1`; no CI hard dependency on installed Chrome.

## Risks
- Raw storageState files are bearer-session secrets. File permissions reduce but do not remove local compromise risk.
- CDP endpoint from existing user browser can expose all browser cookies if mishandled. Domain allowlist and local endpoint validation are mandatory blockers.
- Provider login flows may require MFA/CAPTCHA and can time out. UX must present “window opened, log in manually” and safe timeout behavior.
- Some providers may detect automation/remote debugging. This slice should avoid scripted credential entry; user performs login manually.
- Node global `WebSocket` requirement may fail under older Pi runtimes. Must fail cleanly, not add deps.
- Storage files are not yet consumed by `social`/`video` provider backends unless worker wires them in a later slice. This slice can still save state and report path.

## Need from main agent
No product decision needed before implementation if above scope accepted. If main wants direct extraction from default Chrome/Firefox profiles, that is a separate high-risk decision and should not be folded into this slice.

## Suggested execution prompt
Implement zero-dependency in-house CDP cookie/login setup slice for `pi-extension-search-mcp`. Preserve all current tool/command names. Add explicit `/reach-setup import_cookies <provider> [endpoint]` CDP import and `/reach-setup login <provider> [port]` headed login using Node built-ins only (`globalThis.WebSocket`, `fetch`, `child_process`, `fs`). Store Playwright-compatible storageState at `~/.pi-extension-search/cookies/<provider>.storageState.json` mode 0600; output only counts/domains/path. Validate provider and cookie domains via `src/providers.ts`; reject non-loopback CDP endpoints; never use default browser profile; keep startup non-mutating; add `PI_SEARCH_BROWSER_AUTOMATION=0` opt-out; add tests and docs; no new runtime deps.

## Review findings
- high: `src/bootstrap.ts:151-171` currently descriptor-only; implementation must replace/extend with explicit CDP flows without making no-arg action mutate.
- high: `src/providers.ts:34-46` cookie domains exist; implementation must treat them as allowlist and reject expansion.
- high: new CDP endpoint parser must reject non-loopback endpoints to avoid cookie exfiltration.
- medium: `research/no-dep-cdp-cookie-login.md:11-12` suggests `.on(...)`; implementation must use WHATWG WebSocket API.
- medium: no current Node engine guard in `package.json`; implementation should runtime-check `globalThis.WebSocket`.
- no blockers for proposed slice if direct default-profile scraping remains out of scope.

## Residual risks
- Cookie files remain sensitive local artifacts even with 0600 permissions.
- Real browser login automation will be flaky across providers due MFA/CAPTCHA/provider UI changes.
- Saved storage state may not yet feed all downstream optional external backends.
- Browser executable detection is platform-specific and should fail with clear instructions rather than guessing unsafe paths.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete decision includes file paths src/bootstrap.ts, src/providers.ts, src/cdp-browser.ts, src/cli-backend.ts, README.md, SKILL.md, test/*.test.ts plus severity-tagged review findings and residual risks."
    }
  ],
  "changedFiles": [
    "research/oracle-cdp-cookie-login-decision.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "pwd && git status --short --branch",
      "result": "passed",
      "summary": "Confirmed repository path and existing unstaged worktree state."
    },
    {
      "command": "read src/bootstrap.ts, src/providers.ts, research/no-dep-cdp-cookie-login.md",
      "result": "passed",
      "summary": "Inspected current setup descriptor code, provider cookie domains, and CDP research."
    }
  ],
  "validationOutput": [
    "Decision only; no code validation required."
  ],
  "residualRisks": [
    "Cookie storageState files contain bearer-session secrets despite 0600 permissions.",
    "Provider login flows may require MFA/CAPTCHA and time out.",
    "Node runtimes without global WebSocket need clean unsupported error.",
    "Default-profile cookie scraping intentionally remains out of scope."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added oracle decision document only.",
  "reviewFindings": [
    "high: src/bootstrap.ts:151-171 - no-arg import_cookies must remain descriptor-only; provider-specific import may become explicit CDP action.",
    "high: src/providers.ts:34-46 - cookieDomains must be enforced as allowlist; do not permit domain expansion.",
    "high: new CDP endpoint parser - reject non-loopback endpoints to prevent cookie exfiltration.",
    "medium: research/no-dep-cdp-cookie-login.md:11-12 - Node WebSocket is WHATWG API, not ws-style .on API.",
    "medium: package.json - no Node engine guard; runtime must check globalThis.WebSocket."
  ],
  "manualNotes": "No code edited. Recommended smallest safe slice: zero-dependency CDP import/login via explicit /reach-setup actions only."
}
```

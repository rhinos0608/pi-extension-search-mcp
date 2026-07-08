# Research: No-New-Runtime-Dependency Cookie Import via Chrome DevTools Protocol

## Summary
Node.js 22+ ships a stable built-in WebSocket client (global `WebSocket`), making CDP-driven cookie import viable with zero new dependencies. The approach: launch Chrome headed with `--remote-debugging-port` + `--user-data-dir` (custom profile), connect via WebSocket to CDP, use `Network.setCookies`/`Network.getCookies` for cookie exchange, then redact secrets and persist in Playwright-compatible storageState JSON. Chrome 136+ requires `--user-data-dir` to point to a non-default directory; remote debugging is hard-wired to 127.0.0.1 only.

---

## Findings

### 1. Node.js 22+ has a stable built-in WebSocket client — no `ws` package needed
- Node.js 21 introduced experimental WebSocket client. Node.js 22.4.0 marked it stable. Globally available as `new WebSocket(url)` — browser-compatible WHATWG API. No `ws`, no `socket.io`. [Source](https://nodejs.org/en/blog/announcements/v22-release-announce)
- CDP speaks JSON-RPC over WebSocket. `WebSocket` class supports `on('open')`, `on('message')`, `send()`. Matches all CDP client needs. [Source](https://nodejs.org/learn/getting-started/websocket)
- Caveat: older Node.js 18/20 lack this. If extension targets LTS versions, bundle check `typeof WebSocket !== 'undefined'` fallback or polyfill. For Node 22+ only — zero deps.

### 2. CDP Network domain provides full cookie CRUD
- **`Network.getCookies({ urls })`** — returns `Cookie[]` with fields: `name`, `value`, `domain`, `path`, `expires` (Unix seconds), `httpOnly`, `secure`, `sameSite` (`Strict`|`Lax`|`None`), `sourcePort`, `sourceScheme`, `priority`, `partitionKey`. [Source](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getCookies)
- **`Network.setCookies({ cookies: CookieParam[] })`** — bulk set. `CookieParam` shape: `name`, `value`, `url` (or `domain`+`path`+`secure`+`sameSite`), `httpOnly`, `expires`, `priority`, `sourceScheme`, `sourcePort`. [Source](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-setCookies)
- **`Network.setCookie()`** — single cookie variant. Same `CookieParam`.
- **`Network.deleteCookies()`** — remove by `name` + `url` or `domain`/`path`.
- **`Network.clearBrowserCookies()`** — nuke all.
- Best practice: call `Network.enable()` once to activate the domain, then use `getCookies`/`setCookies` freely.

### 3. CDP Target domain for page lifecycle management
- **`Target.getTargets()`** — list all available targets (pages, workers). Each `TargetInfo` has `targetId`, `type` (`"page"`), `url`, `attached`, `browserContextId`. [Source](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-getTargets)
- **`Target.attachToTarget({ targetId, flatten: true })`** — returns `sessionId`. Flatten mode recommended (sends commands with `sessionId` directly). [Source](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-attachToTarget)
- **`Target.createTarget({ url })`** — open a new tab/page. Returns `targetId`.
- **`Browser.getVersion()`** — get browser version from root WebSocket connection (no target needed).
- Cookie operations are page-scoped. Must attach to a page target before calling `Network.getCookies`. The browser-level WebSocket (`/devtools/browser/<id>`) can discover targets but cannot call per-page domains directly.

### 4. Chrome launch flags: headed mode for manual login, custom profile required
Required launch flags for headed user-initiated login:
```
/path/to/Google Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pi-cdp-profile-<random> \
  --no-first-run \
  --no-default-browser-check
```
- **`--remote-debugging-port=<port>`** — binds CDP WebSocket server on 127.0.0.1. No flag binds to 0.0.0.0; security feature. [Source](https://developer.chrome.com/blog/remote-debugging-port)
- **`--user-data-dir=<custom-dir>`** — Chrome 136+ **requires** non-default directory. Without it, remote debugging flags silently fail (headed mode only; headless exempt). Custom encryption key means existing profile cookies not readable — user must re-login. [Source](https://github.com/M4rque2/DrissionPage-cli/blob/main/docs/chrome136-remote-debugging-restriction.md)
- **`--headless=new`** — headless mode exempt from 136 restriction. But task requires headed for user login UX.
- **`--no-first-run`**, **`--no-default-browser-check`** — suppress wizard dialogs.
- **`--disable-extensions`** — prevents extension interference.
- **`--disable-sync`** — prevents sync conflicts.
- **`--disable-background-networking`** — reduces noise.
- Browser detection: `Browser.getVersion()` over CDP root endpoint to verify connected browser is real Chrome.

### 5. Port/host validation: loopback-only by design, strict validation required
- Remote debugging port binds **only to 127.0.0.1**. `--remote-debugging-address` removed entirely. [Source](https://github.com/vitest-dev/vitest/issues/9710)
- Implementation must validate: port is integer 1024-65535, connections restricted to `127.0.0.1` or `[::1]`. Reject external hosts.
- WebSocket URL discovery: `GET http://127.0.0.1:<port>/json/version` for browser info, `GET /json` or `GET /json/list` for target list, `GET /json/new?url=about:blank` for new tab. [CDP docs](https://chromedevtools.github.io/devtools-protocol/)
- `webSocketDebuggerUrl` from these endpoints is the target-level WebSocket URL. Format: `ws://127.0.0.1:<port>/devtools/page/<uuid>`.
- Browser-level WebSocket: `ws://127.0.0.1:<port>/devtools/browser/<uuid>` — for `Target` domain commands.

### 6. Profile directory safety: temp random dir, lifecycle cleanup
- Create temp profile dir with `fs.mkdtempSync()` or `fs.mkdtemp()` in system temp (`/tmp/` or `os.tmpdir()`). Append random suffix.
- Chrome 136 restriction means old auth state from user's real profile **not** available — forces fresh login. This is by design: no automatic cookie reading on startup.
- On command completion: close WebSocket → send `Browser.close()` CDP command → `process.kill(chromePid)` → `fs.rmSync(profileDir, { recursive: true })`.
- If user wants persistent profile (reuse cookies across sessions), store profile dir path in `~/.pi/` state dir (user data dir, not system temp). Document trade-off: persistent profile risks stale cookies.
- Never re-use system default profile.

### 7. Platform domain allowlists
- Providers specify `cookieDomains` arrays (e.g., `['twitter.com', 'x.com']`, `['facebook.com']`, `['instagram.com']`). [Source](providers.ts:34-46)
- Use `Network.getCookies({ urls: [...] })` to scope cookie retrieval to specific URLs.
- Construct URL from domain: `https://${domain}/`. Pass array of relevant domain URLs.
- Filter returned cookies by domain on client side as second gate.
- Domain allowlist prevents exfiltrating cookies for unintended origins.

### 8. Cookie JSON format: Playwright-compatible storageState
Playwright storageState JSON shape:
```json
{
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": "example.com",
      "path": "/",
      "expires": 1893456000,
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ],
  "origins": []
}
```
[Source](https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/storage-state.md)

CDP `Cookie` → Playwright cookie mapping:
| CDP field | Playwright field | Notes |
|-----------|-----------------|-------|
| `name` | `name` | Direct |
| `value` | `value` | Direct |
| `domain` | `domain` | Direct |
| `path` | `path` | Direct |
| `expires` (Unix sec) | `expires` | Direct — both Unix epoch |
| `httpOnly` | `httpOnly` | Direct |
| `secure` | `secure` | Direct |
| `sameSite` | `sameSite` | CDP: `Strict`/`Lax`/`None`; Playwright same |

- CDP `CookieParam` for `Network.setCookies` input: same fields plus optional `url` (convenience field that sets domain/path/secure/sourceScheme in one).
- For import: read cookies from external source, transform to CDP `CookieParam[]`, call `Network.setCookies`.
- For export: get from CDP, transform to storageState JSON, write to file.

### 9. Secrets redaction
- Redact cookie `value` for any cookie matching redactable patterns: `session`, `token`, `auth`, `sid`, `csrf`, `secret`, `key`.
- Use configurable regex list. Default redact pattern: `/(session|token|auth|sid|secret|credential|key)/i`.
- Redacted output replaces value with `"[REDACTED]"`.
- An additional `redacted: boolean` field can be added to storageState entries to indicate redaction.
- Never write raw cookie values to stdout or logs. Only persist to protected files (mode 0600).
- Warn user explicitly: "Cookie values contain sensitive session tokens. Handle the output file securely."

### 10. Implementation flow for "/reach-cookie-login" slash command
1. **Validation**: port range (1024-65535), domain allowlist, Chrome binary detection.
2. **Launch**: `spawn` Chrome with `--remote-debugging-port=<port>` + `--user-data-dir=<tmpdir>` + headed mode flags.
3. **Wait**: poll `http://127.0.0.1:<port>/json/version` until 200 (timeout ~10s).
4. **Connect**: `new WebSocket('ws://127.0.0.1:<port>/devtools/browser/<id>')` — discover via `/json/version`.
5. **Target**: create or attach to page via `Target.createTarget` or `Target.attachToTarget` with flatten.
6. **Navigate**: `Page.navigate({ url: 'https://<provider-domain>/login' })`.
7. **User logs in**: in headed Chrome window. Poll or wait for URL change / cookie presence.
8. **Extract**: `Network.getCookies({ urls: [...] })` → filter by domain allowlist.
9. **Redact**: apply secrets redaction.
10. **Format**: convert to storageState JSON.
11. **Store**: write to `~/.pi/cookies/<provider>-cookies.json` (mode 0600).
12. **Cleanup**: close WebSocket, kill Chrome, remove temp profile dir.

### 11. Risk controls summary
| Risk | Control |
|------|---------|
| Chrome spawn hangs | `timeout` + `SIGKILL` after 60s |
| Debug port highjacked | Check port not in use before launch; bind check |
| Profile dir leaked | `rm -rf` on cleanup; random dir name; one-shot |
| Cookie leak from temp dir | `fs.rmSync()` with `recursive: true`; temp in `/tmp` with 0700 |
| Cookie value printed to log | Redact before any log/display |
| Domain mismatch | Validate domain in allowlist before import |
| Chrome 136+ without `--user-data-dir` | Hard error: require `--user-data-dir` custom path |
| WebSocket connection fail | Retry 3x; timeout 10s; informative error |
| SameSite restrictions | CDP sets cookies directly — bypasses browser SameSite checks |

---

## Sources

- **Kept: Node.js 22 release announcement** — official confirmation of stable built-in WebSocket client, no ws dependency. (https://nodejs.org/en/blog/announcements/v22-release-announce)
- **Kept: Chrome 136 remote debugging security changes** — primary source on `--user-data-dir` requirement and default profile block. (https://developer.chrome.com/blog/remote-debugging-port)
- **Kept: Chrome 136 restriction analysis** — detailed breakdown of which modes affected/exempt, with workarounds. (https://github.com/M4rque2/DrissionPage-cli/blob/main/docs/chrome136-remote-debugging-restriction.md)
- **Kept: CDP Network domain** — authoritative spec for all cookie methods (`getCookies`, `setCookies`, `Cookie` type, `CookieParam` type). (https://chromedevtools.github.io/devtools-protocol/tot/Network/)
- **Kept: CDP Target domain** — authoritative spec for target discovery and attachment. (https://chromedevtools.github.io/devtools-protocol/tot/Target/)
- **Kept: Playwright CLI storage state reference** — exact JSON format for Playwright-compatible cookie persistence. (https://github.com/microsoft/playwright-cli/blob/main/skills/playwright-cli/references/storage-state.md)
- **Kept: CDP direct automation overview** — practical TypeScript CDP client patterns, WebSocket URL discovery. (https://combray.prose.sh/2025-11-28-chrome-devtools-protocol-direct)
- **Kept: Chrome remote debugging port 127.0.0.1 only** — confirms `--remote-debugging-address` removed, hard-coded localhost. (https://github.com/vitest-dev/vitest/issues/9710)
- **Kept: Providers file** — existing `cookieDomains` allowlist definitions and login flow types. (providers.ts, local)

- **Dropped: chrome-cookies-to-playwright** — reads macOS Chrome SQLite directly, decrypts via Keychain. Different approach (reads disk, not via CDP). Not applicable for cross-platform headed login.
- **Dropped: websocat/bash-based CDP** — bash/Python approaches irrelevant for Node.js extension.

---

## Gaps

1. **Chrome binary detection** — reliable cross-platform Chrome path discovery (macOS `/Applications/Google Chrome.app/...`, Linux `google-chrome`/`chromium`, Windows `%ProgramFiles%`). Existing code doesn't handle this. Could delegate to `which`/`where` or known paths.
2. **Headed mode window management** — no standard way to detect user completing login in CDP. Must poll cookie presence or URL changes. UX for "waiting for login" required.
3. **Chrome 145+ regression** — issue tracker reports headed mode `--remote-debugging-port` silently failing on Windows even with custom `--user-data-dir`. Needs monitoring. (https://issuetracker.google.com/issues/492246718)
4. **macOS sandboxing** — Full Disk Access may be required for Chrome process management depending on profile dir location.
5. **SameSite=None + Secure cookie issues** — some third-party login cookies require Secure flag and will not persist properly in non-HTTPS contexts. CDP sets bypass but expiration edge cases exist.

---

## Summary of Implementation Guidance

| Component | Approach | Dependency |
|-----------|----------|-----------|
| WebSocket client | `new WebSocket(url)` (Node 22+ global) | None (built-in) |
| CDP communication | JSON-RPC over single WS connection | None |
| Chrome launch | `child_process.spawn()` | None |
| Cookie read/write | `Network.getCookies` / `Network.setCookies` | None |
| Storage format | Playwright storageState JSON | None |
| Cookie redaction | Regex-based value masking | None |
| Profile dir | `fs.mkdtempSync()` + cleanup | None |
| User login UX | Headed Chrome window, poll for cookies | None |
| Domain allowlist | Configured in `providers.ts` | Already exists |

Zero new npm dependencies. Built-in WebSocket, `child_process`, `fs`, `http` only.

# Pi-Atlas

Pi extension — web search, fetch, GitHub, social, media, browser, and desktop tools through a native CLI backend with multi-provider search, academic research, and agent-browser automation.

## Tools

| Tool | Description |
|---|---|
| `web_search` | Web search with collated source findings; `category: "research"` for academic/public-data/community sources |
| `fetch` | URL readable-text fetch or search crawl with relevant text chunks |
| `github` | Repository, file, tree, search, trending, and semantic code search |
| `social` | Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, Instagram read/search |
| `media` | YouTube/Bilibili video search/metadata/subtitles + RSS/Atom feeds |
| `browser` | Agent-browser automation (CDP rollback via `PI_SEARCH_BROWSER_BACKEND=cdp`) |
| `desktop` | Opt-in native desktop observation/interaction via Cua Driver |

## Install

```bash
cd Pi-Atlas
npm install
```

Requires Node.js ≥24. The `agent-browser` package has a native postinstall download (~86 MB).

Add to your Pi config:

```json
{
  "extensions": {
    "pi-atlas": "./src/index.ts"
  }
}
```

Or run directly:

```bash
pi -e ./src/index.ts
```

## Environment

Set these in your shell profile (`.zshrc`, `.bashrc`) or a package-local `.env` file. Process environment wins over `.env`.

### Required

None — zero-config web search works out of the box via DuckDuckGo.

### API keys (optional)

```bash
export GITHUB_TOKEN="ghp_..."           # GitHub API
export EXA_API_KEY="..."                # Exa search
export BRAVE_API_KEY="..."              # Brave search
export TAVILY_API_KEY="..."             # Tavily search
export YOUTUBE_API_KEY="..."            # YouTube Data API
export REDDIT_CLIENT_ID="..."           # Reddit API
export REDDIT_CLIENT_SECRET="..."       # Reddit API
export REDDIT_USER_AGENT="pi-atlas/0.1"
export SEARXNG_BASE_URL="https://..."   # Self-hosted SearXNG
```

### Backend control

```bash
export PI_SEARCH_WEB_BACKENDS="duckduckgo,brave,searxng"  # Ordered backends
export PI_SEARCH_BROWSER_BACKEND="cdp"                     # Rollback to legacy CDP
export PI_SEARCH_BROWSER_ALLOW_SENSITIVE="1"              # Enable evaluate/set_cookies
export PI_SEARCH_DESKTOP_AUTOMATION="1"                   # Enable desktop tool
```

### Bootstrap

```bash
export PI_SEARCH_BOOTSTRAP="off"         # Disable startup automation
export PI_SEARCH_AUTO_INSTALL="0"        # Skip startup installs
export PI_SEARCH_ALLOW_INSTALL="0"       # Disable all install execution
export PI_SEARCH_AUTO_COOKIES="off"      # Disable cookie import
export PI_SEARCH_BROWSER_AUTOMATION="0"  # Disable all browser features
```

### Other

```bash
export PI_SEARCH_MAX_TOOL_OUTPUT_CHARS="60000"   # Output truncation limit
export PI_SEARCH_STATE_DIR="$HOME/.pi-atlas"     # State directory
export PI_SEARCH_COOKIE_BROWSER="chrome"         # chrome, brave, or edge
export PI_SEARCH_COOKIE_STALE_MS="43200000"      # Cookie re-import window (12h)
export BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"  # CDP rollback endpoint
```

See `.env.example` for all available variables.

## CLI

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call web_search '{"query":"pi agent extensions"}'
npm run cli -- call fetch '{"url":"https://example.com"}'
npm run cli -- call social '{"platform":"reddit","action":"subreddit","subreddit":"python","filter":"hot"}'
npm run cli -- call media '{"platform":"rss","url":"https://example.com/feed.xml"}'
npm run cli -- call reach_setup '{"action":"plan"}'
```

CLI output is always JSON: `{ "ok": true, "data": { "content": [...] } }`.

## Slash commands

User-facing setup/status as Pi slash commands, not LLM tools:

- `/reach-status [family]` — inspect channels/backends, e.g. `/reach-status social`
- `/reach-setup [action]` — `auto`, `status`, `plan`, `install_core`, `install_all`, `install_channels`, `import_cookies`, `login`

## Desktop automation

`desktop` uses manually installed [Cua Driver v0.7.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.7.1). Disabled by default — set `PI_SEARCH_DESKTOP_AUTOMATION=1`.

Observation is AX-only by default. Screenshots require explicit opt-in, target one known window, and return inline image content only. AX trees and images can expose PII/credentials — close sensitive applications before enabling. Mutations require fresh `stateId`, are serialized per window, never retried after dispatch. Transport loss yields `OUTCOME_UNKNOWN`. Driver permissions remain user-owned; session shutdown cannot revoke Accessibility or Screen Recording grants.

## Browser security

- Agent-browser uses owned isolated sessions with strict public-domain navigation
- `evaluate` and `set_cookies` disabled by default; enable with `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`
- Cookies return metadata only (name, domain, path, expiry, flags) — values never exposed
- CDP endpoints restricted to loopback (localhost/127.0.0.1), ports 1024–65535
- Security enforcement is external through containerization and other extensions
- DNS preflight is defense-in-depth; high-assurance deployments need OS egress controls

## Package contract

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

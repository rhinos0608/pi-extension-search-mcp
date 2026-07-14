# Pi-Atlas — Search & Fetch Pi Extension

Pi extension that exposes web search, fetch, GitHub, social, media, and browser tools through a package-local native CLI backend with multi-provider web search, academic research sources, and CDP browser automation.

## Tools

Public Pi tool names stay stable:

- `web_search` — native web search with collated source findings; use `category: "research"` for academic/public-data/community sources
- `fetch` — native URL readable-text fetch or search crawl with relevant text chunks
- `github` — native GitHub repository, file, tree, search, trending, and code search actions
- `social` — Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, and Instagram read/search family
- `media` — YouTube/Bilibili video search/metadata/subtitles + RSS/Atom feed reading
- `browser` — browser automation via CDP

## Local use

```bash
cd pi-extension-search-mcp
npm install
pi -e ./src/index.ts
```

## CLI

The extension routes tool execution through the local CLI by default.

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call fetch '{"query":"query","searchQuery":"topic"}'
npm run cli -- call social '{"platform":"v2ex","action":"hot","limit":5}'
npm run cli -- call media '{"platform":"rss","url":"https://example.com/feed.xml"}'
npm run cli -- call reach_setup '{"action":"plan"}'
```

Installed package binary:

```bash
pi-extension-search status
pi-extension-search call web_search '{"query":"pi agent extensions"}'
```

CLI output is always JSON:

```json
{
  "ok": true,
  "data": {
    "content": [{ "type": "text", "text": "..." }]
  }
}
```

## Slash commands

User-facing setup/status is exposed as Pi slash commands, not LLM tools:

- `/reach-status [family]` — inspect channels/backends and active backend, e.g. `/reach-status social`
- `/reach-setup [auto|status|plan|install_core|install_all|install_channels channels|import_cookies|login]` — run local setup by default; use `plan` for provider info or `status` for local config/auth/cookie state
- `/reach-setup import_cookies [provider] [cdp-endpoint]` — without endpoint, import cookies from local default Chrome-family profile; with endpoint, import from loopback CDP
- `/reach-setup login <provider> [port]` — launch headed browser with isolated temp profile for automated login via CDP (default port `9222`)

First start defaults to local automation: core installer commands run when allowed, and registered cookie-consuming CLIs try local default-browser cookie import. Set `PI_SEARCH_BOOTSTRAP=off` to disable all startup automation, `PI_SEARCH_AUTO_INSTALL=0` to skip startup installs, `PI_SEARCH_ALLOW_INSTALL=0` to disable all install execution, or `PI_SEARCH_AUTO_COOKIES=off` / `PI_SEARCH_BROWSER_AUTOMATION=0` to disable browser cookie import. macOS may show a Keychain prompt for default-profile cookies. Saved cookies are reported in setup status and forwarded as compatible env vars for known CLIs (Twitter, Reddit, XiaoHongShu, Bilibili); browser-session backends such as OpenCLI may still require their own extension/login state.

## Configuration

Default backend is native CLI. Set `SEARCH_BACKEND=mcp` to use the legacy MCP stdio adapter.

If `SEARCH_MCP_CONFIG_PATH` is set, the extension reads that JSON config and maps known values into runtime environment variables (`GITHUB_TOKEN`, `EXA_API_KEY`, `BRAVE_API_KEY`, `TAVILY_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/`REDDIT_USER_AGENT`, `SEARXNG_BASE_URL`, `NITTER_BASE_URL`, `LISTENNOTES_API_KEY`, `PRODUCTHUNT_API_TOKEN`, `PATENTSVIEW_API_KEY`, `CRAWL4AI_*`, `DEEP_RESEARCH_*`, `EMBEDDING_SIDECAR_*`, `SEARCH_LLM_*`, `OLLAMA_SEARCH_*`, `BROWSER_*`). Existing environment variables win.

Family routing uses ordered backends per platform. Native zero-config channels run directly; login-backed platforms probe known CLIs and report `active_backend` through `/reach-status`. New family tools (`social`, `media`) require the default `native-cli` backend; legacy `SEARCH_BACKEND=mcp` only supports the original search-mcp tools.

On first extension startup, bootstrap defaults to `auto`. Set `PI_SEARCH_BOOTSTRAP=check` to write a first-start state marker without install/cookie automation, or `PI_SEARCH_BOOTSTRAP=off` to do nothing.

Optional environment variables (process env wins over package-local `.env`):

- `SEARCH_BACKEND` — `native-cli` default; set `mcp` for legacy stdio backend
- `SEARCH_MCP_COMMAND` — executable to spawn for MCP fallback, default `search-mcp`
- `SEARCH_MCP_ARGS_JSON` — JSON string array of arguments, default `[]`
- `SEARCH_MCP_CWD` — working directory for the spawned MCP server
- `SEARCH_MCP_FORWARD_ENV_JSON` — JSON string array of extra environment variable names to forward to MCP fallback
- `PI_SEARCH_ENV_PATH` — optional env-file path; defaults to package-local `.env` when present
- `SEARCH_MCP_CONFIG_PATH` — optional JSON config path for mapped service keys
- `PI_SEARCH_BOOTSTRAP` — first-start bootstrap mode: `auto` default, `check` marker only, `off` disabled
- `PI_SEARCH_AUTO_INSTALL` — set to `0`, `false`, `no`, or `off` to skip startup auto-install
- `PI_SEARCH_ALLOW_INSTALL` — set to `0`, `false`, `no`, or `off` to disable all install execution and return descriptors instead
- `PI_SEARCH_AUTO_COOKIES` — set to `off`/`0`/`false`/`no` to disable default-browser cookie import
- `PI_SEARCH_BROWSER_AUTOMATION` — set to `0`, `false`, `no`, or `off` to disable browser cookie features (default-profile import, CDP import, and login)
- `PI_SEARCH_COOKIE_BROWSER` — default-profile cookie browser: `chrome` (default), `brave`, or `edge`
- `PI_SEARCH_COOKIE_STALE_MS` — freshness window for startup cookie re-import, default 12 hours
- `PI_SEARCH_MAX_TOOL_OUTPUT_CHARS` — context guard: maximum characters of tool output text returned to the model, default 60000 (minimum 1000); oversized output keeps head and tail around a truncation marker
- `PI_SEARCH_WEB_BACKENDS` / `SEARCH_WEB_BACKENDS` — comma-separated ordered web search backends: `duckduckgo`, `searxng`, `brave`, `exa`, `tavily`, `ollama-search`; unset uses all configured backends with RRF fusion
- `PI_SEARCH_STATE_DIR` — override default state directory (`~/.pi-extension-search`)
- `SEARXNG_BASE_URL` — self-hosted SearXNG instance URL
- `OLLAMA_SEARCH_BASE_URL` / `SEARCH_OLLAMA_BASE_URL` — Ollama search base URL
- `OLLAMA_SEARCH_API_KEY` / `SEARCH_OLLAMA_API_KEY` — optional Ollama search API key
- `BROWSER_CDP_ENDPOINT` — optional endpoint for `/reach-setup import_cookies <provider> <endpoint>`, e.g. `http://127.0.0.1:9222`
- `BROWSER_EXECUTABLE_PATH` — optional Chrome/Chromium executable path for `/reach-setup login <provider>`
- `BROWSER_PROFILE_DIR` — optional Chrome-family profile directory for default-browser cookie import
- `BROWSER_PROXY_SERVER` — optional proxy server for CDP browser automation
- `OPENCLI_HOST` / `OPENCLI_PORT` / `OPENCLI_TOKEN` — OpenCLI backend connector for social platforms

The MCP fallback forwards only an allowlisted environment to avoid leaking parent process secrets. External family backends also receive a small allowlist only: PATH/HOME/temp locale/proxy vars plus known platform auth vars.

Per-platform backend override examples (each also accepts a `PI_SEARCH_` prefix variant, e.g. `PI_SEARCH_TWITTER_BACKEND`):

- `TWITTER_BACKEND` / `PI_SEARCH_TWITTER_BACKEND` — `twitter-cli` or `OpenCLI`
- `REDDIT_BACKEND` / `PI_SEARCH_REDDIT_BACKEND` — `OpenCLI` or `rdt-cli`
- `XIAOHONGSHU_BACKEND` / `PI_SEARCH_XIAOHONGSHU_BACKEND` — `OpenCLI` or `xhs-cli`
- `FACEBOOK_BACKEND` / `PI_SEARCH_FACEBOOK_BACKEND` — `OpenCLI`
- `INSTAGRAM_BACKEND` / `PI_SEARCH_INSTAGRAM_BACKEND` — `OpenCLI`
- `YOUTUBE_BACKEND` / `PI_SEARCH_YOUTUBE_BACKEND` — `yt-dlp`
- `BILIBILI_BACKEND` / `PI_SEARCH_BILIBILI_BACKEND` — `bili-cli` or `OpenCLI`

## Package contract

`package.json` declares:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

# Pi-Atlas

Pi extension that gives your agent real-world reach — web search, page reading, GitHub, social media, video, browser automation, and desktop control. Zero-config works out of the box; API keys unlock more power.

## What you get

| Tool | What it does |
|---|---|
| `web_search` | Search the web. Add `category: "research"` for academic sources (arXiv, PubMed, Crossref, Wikipedia, Hacker News). |
| `fetch` | Read any webpage as clean text, or do semantic retrieval — give it a query and it crawls pages, finds the most relevant passages, and returns ranked chunks. |
| `github` | Browse repos, read files, search code, discover trending projects. With an embedding sidecar, unlock `code_search` for AST-aware semantic code retrieval. |
| `social` | Read and search Twitter/X, Reddit, V2EX, XiaoHongShu, Facebook, Instagram. |
| `media` | YouTube and Bilibili search, metadata, subtitles. RSS/Atom feed reading. |
| `browser` | Headless browser automation via agent-browser — navigate, click, type, screenshot, evaluate. |
| `desktop` | Native desktop observation and interaction via Cua Driver (opt-in, disabled by default). |

## Quick start

```bash
cd Pi-Atlas
npm install
```

Requires Node.js ≥ 24. The `agent-browser` package downloads a native binary (~86 MB) on install.

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

That's it — web search works immediately via DuckDuckGo with zero configuration.

## Configuration

Set variables in your shell profile (`.zshrc`, `.bashrc`) or a package-local `.env` file. Process environment wins over `.env`. See `.env.example` for every available variable.

### API keys

All optional. DuckDuckGo covers web search without any keys.

```bash
export GITHUB_TOKEN="ghp_..."           # GitHub API (private repos, higher rate limits)
export EXA_API_KEY="..."                # Exa semantic search
export BRAVE_API_KEY="..."              # Brave Search API
export TAVILY_API_KEY="..."             # Tavily AI-native search
export YOUTUBE_API_KEY="..."            # YouTube Data API
export REDDIT_CLIENT_ID="..."           # Reddit API
export REDDIT_CLIENT_SECRET="..."       # Reddit API
export REDDIT_USER_AGENT="pi-atlas/0.1"
export SEARXNG_BASE_URL="https://..."   # Self-hosted SearXNG
```

### Backend selection

```bash
export PI_SEARCH_WEB_BACKENDS="duckduckgo,brave,searxng"  # Ordered, first succeeds wins
export PI_SEARCH_BROWSER_BACKEND="cdp"                     # Fall back to raw CDP
export PI_SEARCH_BROWSER_ALLOW_SENSITIVE="1"              # Enable evaluate/set_cookies
export PI_SEARCH_DESKTOP_AUTOMATION="1"                   # Enable desktop tool
```

### Bootstrap control

```bash
export PI_SEARCH_BOOTSTRAP="off"         # Skip startup automation
export PI_SEARCH_AUTO_INSTALL="0"        # Skip startup installs
export PI_SEARCH_ALLOW_INSTALL="0"       # Disable all install execution
export PI_SEARCH_AUTO_COOKIES="off"      # Skip cookie import
export PI_SEARCH_BROWSER_AUTOMATION="0"  # Disable all browser features
```

### Output & state

```bash
export PI_SEARCH_MAX_TOOL_OUTPUT_CHARS="60000"   # Truncation limit
export PI_SEARCH_STATE_DIR="$HOME/.pi-atlas"     # State directory
export PI_SEARCH_COOKIE_BROWSER="chrome"         # chrome, brave, or edge
export PI_SEARCH_COOKIE_STALE_MS="43200000"      # Cookie re-import window (12h)
export BROWSER_CDP_ENDPOINT="http://127.0.0.1:9222"  # CDP fallback endpoint
```

## Embedding & semantic search

Pi-Atlas has two layers of semantic capability:

### 1. Built-in semantic retrieval (`fetch` with query)

When you call `fetch` with a `query` parameter, Pi-Atlas crawls pages, splits them into chunks, scores each chunk against your query, and returns the top-K most relevant passages. This works with no external services — it uses local text scoring.

```
fetch({ query: "How does React concurrent rendering work?", searchQuery: "React 18 concurrent rendering" })
```

- `query` — what you want to find in the crawled pages
- `searchQuery` — what to search the web for (defaults to `query` if omitted)
- `topK` — how many chunks to return (default 8, max 20)
- `maxPages` — how many pages to crawl (default 10, max 25)

Without a `query`, `fetch` returns the full readable text of a URL (plain extraction, no semantic processing).

### 2. Embedding sidecar (GitHub `code_search`)

For deep semantic code search within GitHub repositories, Pi-Atlas can connect to an embedding service. This powers the `github` tool's `code_search` action — AST-aware retrieval that uses tree-sitter for code parsing and embeddings for semantic ranking.

Configure the sidecar:

```bash
export EMBEDDING_SIDECAR_PROVIDER="openai"          # Provider identifier
export EMBEDDING_SIDECAR_BASE_URL="https://..."     # Embedding service endpoint
export EMBEDDING_SIDECAR_API_TOKEN="..."            # Auth token
export EMBEDDING_SIDECAR_DIMENSIONS="1536"          # Embedding vector dimensions
export EMBEDDING_SIDECAR_CODE_MODEL="text-embedding-3-small"  # Model for code embeddings
```

Once configured, use `code_search` to find code by meaning, not just keywords:

```
github({ action: "code_search", repository: "owner/repo", query: "authentication middleware with JWT verification" })
```

The `profile` parameter lets you tune retrieval: `balanced`, `lexical-heavy`, `semantic-heavy`, `high-precision`, `fast`, `precision`, or `recall`.

Without the embedding sidecar, `code_search` falls back to lexical GitHub code search.

## CLI

The CLI is a thin JSON-in/JSON-out wrapper — useful for testing and scripting:

```bash
npm run cli -- status
npm run cli -- config
npm run cli -- call web_search '{"query":"pi agent extensions"}'
npm run cli -- call fetch '{"url":"https://example.com"}'
npm run cli -- call fetch '{"query":"error handling patterns","searchQuery":"Rust error handling best practices"}'
npm run cli -- call social '{"platform":"reddit","action":"subreddit","subreddit":"python","filter":"hot"}'
npm run cli -- call media '{"platform":"rss","url":"https://example.com/feed.xml"}'
npm run cli -- call reach_setup '{"action":"plan"}'
```

All CLI output is JSON: `{ "ok": true, "data": { "content": [...] } }`.

## Slash commands

User-facing setup and status commands (not LLM tools):

- `/reach-status [family]` — inspect channels and backends, e.g. `/reach-status social`
- `/reach-setup [action]` — `auto`, `status`, `plan`, `install_core`, `install_all`, `install_channels`, `import_cookies`, `login`

## Desktop automation

`desktop` uses manually installed [Cua Driver v0.7.1](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.7.1). Disabled by default — set `PI_SEARCH_DESKTOP_AUTOMATION=1` to enable.

Observation is AX-only by default. Screenshots require explicit opt-in, target one known window, and return inline image content only. AX trees and images can expose PII and credentials — close sensitive applications before enabling. Mutations require a fresh `stateId`, are serialized per window, and are never retried after dispatch. Transport loss yields `OUTCOME_UNKNOWN`. Driver permissions remain user-owned; session shutdown cannot revoke Accessibility or Screen Recording grants.

## Browser security

- Agent-browser uses owned isolated sessions with strict public-domain navigation
- `evaluate` and `set_cookies` are disabled by default; enable with `PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1`
- Cookies return metadata only (name, domain, path, expiry, flags) — values are never exposed
- CDP endpoints are restricted to loopback (localhost/127.0.0.1), ports 1024–65535
- Security enforcement is external through containerization and other extensions
- DNS preflight is defense-in-depth; high-assurance deployments need OS-level egress controls

## Package contract

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

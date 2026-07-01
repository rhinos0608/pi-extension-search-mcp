# search-mcp Pi extension

Pi extension that exposes search, crawl, browse, research, and GitHub tools through a package-local native CLI backend.

## Tools

Public Pi tool names stay stable:

- `web_search` — native web search with collated source findings
- `semantic_crawl` — native URL/search crawl with relevant text chunks
- `browse` — native URL fetch/readable text extraction
- `research_sources` — native academic/community/public-source search
- `github` — native GitHub repository, file, tree, search, trending, and code search actions

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
npm run cli -- call browse '{"url":"https://example.com"}'
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

## Configuration

Default backend is native CLI. Set `SEARCH_BACKEND=mcp` to use the legacy MCP stdio adapter.

Optional MCP fallback environment variables:

- `SEARCH_BACKEND` — `native-cli` default; set `mcp` for legacy stdio backend
- `SEARCH_MCP_COMMAND` — executable to spawn for MCP fallback, default `search-mcp`
- `SEARCH_MCP_ARGS_JSON` — JSON string array of arguments, default `[]`
- `SEARCH_MCP_CWD` — working directory for the spawned MCP server
- `SEARCH_MCP_FORWARD_ENV_JSON` — JSON string array of extra environment variable names to forward to MCP fallback

The MCP fallback forwards only an allowlisted environment to avoid leaking parent process secrets.

## Package contract

`package.json` declares:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

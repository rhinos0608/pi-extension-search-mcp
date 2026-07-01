# Ergonomics Suite 2/5 — CLI UX

Timed-out reviewer left no file; parent synthesized from research and oracle guidance.

## Target CLI shape

Future CLI should be package-local, not sibling `search-mcp`:

```bash
pi-extension-search backend call web_search '{"query":"...","limit":8}'
pi-extension-search backend call browse '{"url":"https://example.com","maxChars":12000}'
pi-extension-search status --json
pi-extension-search config --json
```

## JSON result envelope

```json
{
  "ok": true,
  "content": [{ "type": "text", "text": "..." }],
  "details": {},
  "backend": "local-cli"
}
```

Error envelope:

```json
{
  "ok": false,
  "error": {
    "code": "unsupported_tool",
    "message": "local CLI backend does not support semantic_crawl yet",
    "retryable": false
  },
  "backend": "local-cli"
}
```

## Implementation sequence

1. Add `SearchBackend` seam while keeping MCP backend.
2. Add CLI binary and status/config commands only.
3. Implement local CLI `browse` parity first.
4. Add fallback policy: unsupported local tools either fall back to MCP or fail with clear `unsupported_tool`, based on config.
5. Move other tools one at a time with tests.

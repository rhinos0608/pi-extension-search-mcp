# Hardening Suite 5/5 — Migration Roadmap

Timed-out reviewer left no file; parent synthesized from oracle and suite outputs.

## Stop rules

- One writer at a time.
- Preserve current Pi tool names and schemas until replacement has tests.
- Do not delete MCP backend until local backend reaches parity or user approves breaking fallback.
- Ask before GitHub remote visibility, npm publish decisions, and committing.

## Milestones

### M0 — Repo hygiene and baseline
- Local git initialized.
- Ignore local caches.
- Ask user before remote visibility and commits.

### M1 — Backend seam, no behavior change
- Add `SearchBackend` interface/factory.
- Make MCP adapter implement it.
- Update `index.ts`/`github.ts` to depend on seam.
- Add pure helper tests and backend factory tests.

### M2 — Portability and config hardening
- Default command becomes `search-mcp` from PATH.
- README/package reflect actual tools.
- Add env allowlist or documented forwarding policy.

### M3 — Local CLI skeleton
- Add `bin` entry and CLI status/config.
- Add `backend call` command using shared internal module.
- No search feature parity yet.

### M4 — First self-contained tool: browse
- Implement local browse/read via direct fetch + readable text extraction.
- Keep MCP fallback for other tools.
- Snapshot result envelope.

### M5 — Tool-by-tool migration
- Choose next tool by user value: `web_search` or `github` likely before `semantic_crawl`.
- Each tool needs local implementation, fake tests, CLI tests, and Pi execute tests.

## Rollback

Because legacy MCP remains adapter, rollback means selecting MCP backend or reverting local backend files. No public Pi tool contracts change during M1–M4.

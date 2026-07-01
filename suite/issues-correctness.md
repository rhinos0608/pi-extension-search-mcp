# Issues Suite 1/6 — Correctness and Contracts

Timed-out reviewer left no file; parent synthesized from research, oracle, and suite outputs.

## Findings

### C-01 [HIGH] Hardcoded default backend command breaks documented contract
- File: `src/mcp-client.ts:7`
- README says default uses `search-mcp` from PATH, code uses `/Users/rhinesharar/.pi/agent/bin/search-mcp`.
- Fix: default to `search-mcp` and keep `SEARCH_MCP_COMMAND` override.

### C-02 [HIGH] Concrete MCP client blocks backend substitution
- Files: `src/index.ts`, `src/github.ts`, `src/mcp-client.ts`
- Tool registrations depend directly on `SearchMcpClient`; no fake backend or local CLI backend can be injected.
- Fix: introduce `SearchBackend` interface and factory; make MCP implementation one adapter.

### C-03 [MEDIUM] Tool execution paths untested
- Files: `src/index.ts`, `src/github.ts`, `test/*`
- Tests cover pure helpers only; no registered tool execution, backend call args, or error propagation.
- Fix: fake backend tests around tool registration or extracted tool builders.

### C-04 [MEDIUM] Backend tool names are raw string literals
- Files: `src/index.ts`, `src/github.ts`
- `web_search`, `semantic_crawl`, `agentic_browse`, `research`, `github` appear as unchecked strings.
- Fix: centralize backend tool names and type the dispatch helper.

### C-05 [MEDIUM] `github` action schema is overly flat
- File: `src/github.ts`
- One large optional parameter object allows irrelevant fields for actions; caller errors defer to backend.
- Fix later: action-specific builders or split Pi tools; not first tranche.

# Ergonomics Suite 1/5 — Pi Tool UX

Timed-out reviewer left no file; parent synthesized from code and feature-suite outputs.

## Recommendations

1. Keep existing public tool names stable: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`.
2. Improve descriptions to disclose backend mode and defaults where useful, especially `browse` mapping to one-shot readable page fetch.
3. Add separate future tools for two-phase browse ergonomics: `browse_store` and `present`, rather than overloading current `browse`.
4. Add future `browse_focus` for focused extraction, gated by backend capability/config.
5. Add `search_status` tool or CLI status command to explain current backend, command path, availability, and missing config.
6. Keep prompt snippets action-oriented and short; avoid exposing MCP/internal family naming in user-facing Pi tool descriptions unless debugging.

## First tranche

Do not add new tools yet. First add backend seam and tests so tool UX changes can be validated without live backend.

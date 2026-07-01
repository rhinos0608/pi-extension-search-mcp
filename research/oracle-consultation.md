Inherited decisions:
- Research phase completed first. Evidence lives in `research/local-recon.md`, `research/external-evidence.md`, `research/strategy-context.md`.
- Current project is tiny Pi extension, not git repo. `git status` returns `fatal: not a git repository`.
- Current tools: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`.
- Current runtime: all tool execution delegates to sibling `search-mcp` through MCP stdio in `src/mcp-client.ts`.
- Recent fix: `src/index.ts:105` maps Pi `browse` to `agentic_browse` with `buildBrowseArgs()` using `action: 'read'`; tests in `test/index.test.ts` protect that.
- User wants: 20-subagent budget, issue/ergonomic/hardening suites, create git/GitHub repo, iterative work, consult Claude/main when decisions or issues arise, move toward self-contained extension, share infrastructure ideas, prefer CLI-based infrastructure over MCP.
- Explicit sequencing: research first, then oracle consultation, then implementation.

Diagnosis:
- Main danger is scope explosion. “Self-contained CLI-based extension” can mean at least 3 different architectures: package-local CLI, external `search-mcp` CLI, HTTP backend, or vendored/shared library. Only package-local CLI/local backend satisfies “does not require sibling project.”
- `src/mcp-client.ts:7` is immediate portability blocker: hardcoded `/Users/rhinesharar/.pi/agent/bin/search-mcp` contradicts `README.md:19-30`, which says default is `search-mcp` from PATH.
- `src/index.ts:37` constructs `SearchMcpClient` directly, so tool definitions know concrete MCP transport. This blocks safe migration.
- `src/github.ts` and `src/index.ts` should depend on a small backend seam, not `SearchMcpClient`, before any rewrite.
- `package.json:4` and `README.md:3-9` are stale: say three tools / old tool names while code registers five tools.
- Full parity with `search-mcp` is not a first implementation milestone. `semantic_crawl`, academic `research`, and rich GitHub actions are broad products. Porting them all at once will bury validation.

Drift / contradiction check:
- Do not let “budget 20 subagents” become 20 writers. User asked suites, but safe plan is read-only fanout plus one writer at a time.
- Do not interpret “move away from wrapper” as “delete MCP now.” Existing behavior is only working path. Keep legacy MCP backend until local CLI/backend reaches per-tool parity.
- Do not interpret “CLI over MCP” as “spawn the sibling `search-mcp` CLI.” That still requires sibling project and fails user’s self-contained requirement.
- Do not add HTTP backend unless research verifies an HTTP tool-call contract. Current research notes this as unresolved.
- Do not rename public Pi tools first. Keep tool schemas stable while changing backend internals.
- Do not create GitHub repo after large edits. Create local git + initial commit before implementation so iteration/reverts are cheap.

Recommendation:
1. **Create git repo before implementation.**
   - First update `.gitignore` to exclude `.DS_Store`, `.pi-smartread.tags.cache/`, `.smart-edit-undo/`, `node_modules/`, `dist/`.
   - `git init`, inspect `git status`, initial commit current baseline including source, tests, README, research artifacts if desired.
   - Then create GitHub repo with explicit visibility/name from main/user. If no visibility specified, ask before `gh repo create --public` or `--private`.

2. **Use 20-agent budget as read-only decision fanout, not implementation fanout.**
   - Issues suite: 6 reviewers, read-only, distinct angles: correctness, contracts, tests, docs/package, security/secrets, runtime lifecycle.
   - Ergonomics suite: 5 reviewers, read-only: tool naming/prompts, CLI UX, config/env UX, developer workflow, Pi integration UX.
   - Hardening/future-work suite: 5 reviewers, read-only: backend seam, resilience, test strategy, packaging/release, migration roadmap.
   - Extra 4 reserve for targeted follow-up after first worker diff: 2 validation reviewers, 1 docs reviewer, 1 oracle/decision follow-up if drift appears.

3. **First implementation tranche should be narrow.**
   - Fix repo hygiene and docs/package mismatch.
   - Add `SearchBackend` interface and factory. Keep `McpSearchBackend` behavior unchanged.
   - Change direct types in `src/index.ts`/`src/github.ts` from `SearchMcpClient` to `SearchBackend` only after tests cover it.
   - Change default command only if validated against current environment. Prefer matching README (`search-mcp`) plus env override docs.

4. **Second tranche: local CLI architecture, one tool only.**
   - Define package-local CLI contract, e.g. `pi-extension-search-mcp backend call <tool> <json>` or equivalent, with tests.
   - Implement first local self-contained tool as `browse` only. Reason: no API-key dependency, already has regression seam, easiest parity target.
   - Keep `web_search`, `semantic_crawl`, `research_sources`, `github` on legacy MCP backend until each has local implementation + tests.

5. **Ask Claude/main before these decisions:**
   - GitHub repo name and visibility.
   - Whether research artifacts should be committed.
   - Whether “share infrastructure” means copying concepts, depending on npm package, vendoring code, or coordinating with sibling repo.
   - Whether local CLI may provide partial tool support with legacy fallback, or must fail closed when local backend lacks a tool.
   - Which tool after `browse` gets priority: `web_search`, `github`, `research_sources`, or `semantic_crawl`.

Risks:
- `src/mcp-client.ts:31` sets `stderr: 'pipe'` but no listener exists; child errors can be hidden.
- `src/mcp-client.ts:72-93` caches one client/transport with no crash/reconnect handling.
- `src/index.ts:133-149` has no local error shaping; backend errors leak as raw tool failures.
- Tool execution tests are absent beyond argument-building. Any backend refactor without fake backend tests can silently break all tools.
- CLI backend may add unnecessary subprocess cost if implemented as “tool calls local CLI” instead of direct module calls. Keep CLI as packaging/user-facing seam; use shared internal module under both extension and CLI where possible.

Need from main agent:
- Confirm GitHub repo name and public/private visibility before remote creation.
- Confirm whether to commit `research/*.md`.
- Confirm first self-contained parity target after `browse`.
- Confirm whether legacy MCP fallback is allowed during migration.

Suggested execution prompt:
Use one worker only for first tranche:

“Create initial git-safe baseline and implement only milestone 0/1. Update `.gitignore` for local caches. Initialize git if absent, but ask before creating remote if visibility/name unknown. Add a `SearchBackend` interface/factory seam with no behavior change. Make `SearchMcpClient` implement it or wrap it as `McpSearchBackend`. Update `src/index.ts` and `src/github.ts` to depend on the interface, not concrete MCP client. Preserve all public tool names/schemas, preserve `browse` -> `agentic_browse.read`, and do not implement local CLI/backend yet. Add focused tests for backend factory/interface behavior and existing browse args. Run `npm test` and `npm run typecheck`. Stop and report before any larger self-contained rewrite.”

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings cite src/mcp-client.ts:7, src/mcp-client.ts:31, src/mcp-client.ts:72-93, src/index.ts:37, src/index.ts:105, src/index.ts:133-149, package.json:4, README.md:3-9 and README.md:19-30."
    }
  ],
  "changedFiles": [
    "research/oracle-consultation.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read research/strategy-context.md, research/local-recon.md, src/mcp-client.ts, src/index.ts, package.json, README.md",
      "result": "passed",
      "summary": "Verified current architecture, research decisions, hardcoded path, tool registration, browse fix, and docs/package drift."
    },
    {
      "command": "git status --short 2>&1 || true",
      "result": "passed",
      "summary": "Confirmed repository is not initialized: fatal: not a git repository."
    }
  ],
  "validationOutput": [
    "Oracle consultation written to /Users/rhinesharar/pi-extension-search-mcp/research/oracle-consultation.md",
    "No source files modified."
  ],
  "residualRisks": [
    "Need main/user decision for GitHub repo name and visibility before remote creation.",
    "Need decision whether to commit research artifacts.",
    "Need decision whether legacy MCP fallback is acceptable during migration.",
    "Need verification of any intended CLI contract before implementing CLI backend."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added oracle consultation only; no implementation changes.",
  "reviewFindings": [
    "blocker: no .git repository - create local baseline before implementation or rollback/review becomes unsafe.",
    "blocker: src/mcp-client.ts:7 - hardcoded absolute search-mcp shim keeps project machine-specific and sibling-dependent.",
    "high: src/index.ts:37 and src/github.ts - tools depend on concrete SearchMcpClient instead of backend seam, making migration risky.",
    "high: src/mcp-client.ts:72-93 - singleton MCP transport has no crash/reconnect handling.",
    "medium: src/index.ts:133-149 - backend errors are not shaped into clear tool responses.",
    "medium: test/* - no fake-backend tool execution tests; only pure helper coverage exists.",
    "medium: package.json:4 and README.md:3-9 - docs claim three tools while code registers five.",
    "medium: README.md:19-30 conflicts with src/mcp-client.ts:7 about default command behavior."
  ],
  "manualNotes": "Safest path: git baseline first, read-only 20-agent fanout, one writer per milestone, backend seam before CLI/local implementation, local browse parity before wider search/github/research ports."
}
```

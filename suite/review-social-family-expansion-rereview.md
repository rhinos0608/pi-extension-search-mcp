# Re-review: Agent-Reach social/video/feeds expansion — post-fix verification

Scope: current working-tree diff in `/Users/rhinesharar/pi-extension-search-mcp` (8 modified files + untracked `src/reach-tools.ts`) after fixes for the prior blocker B1 and non-blocking items N1–N9 from `suite/review-social-family-expansion.md`. This is a review only — no files were edited. Focus areas per task: env propagation through `CliSearchBackend`, scoped external env, fallback behavior, timeout handling, feed parser, docs. Existing tool-name stability re-confirmed.

## Verification run

- `npm run typecheck` → clean (no errors).
- `npm test` → 35/35 pass (1 new regression test for `buildCliEnvironment` allowlist).
- Empirical env probe (`/tmp/envprobe2.mjs`) → confirms `TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `TWITTER_BACKEND`, `PI_SEARCH_REDDIT_BACKEND`, `BILIBILI_BACKEND`, `OPENCLI_TOKEN`, `HTTP_PROXY`/`HTTPS_PROXY`, `LANG`, `PYTHONIOENCODING` all survive `buildCliEnvironment`; `DATABASE_URL` and `AWS_SECRET_ACCESS_KEY` are stripped.
- Source probe (`/tmp/envprobe3.mjs`) → confirms `externalEnvironment` now scopes auth by `command` (twitter → `TWITTER_*`; opencli → `OPENCLI_*`), and the generic `AUTH_TOKEN`/`CT0` entries are gone.

## Prior blocker resolution

### B1 (was blocker): env propagation through CliSearchBackend — RESOLVED

`src/cli-backend.ts:84-125` `buildCliEnvironment` (now exported) extends its allowlist to forward the platform auth vars (`TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `OPENCLI_HOST`, `OPENCLI_PORT`, `OPENCLI_TOKEN`), proxy vars (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`), locale/shell vars (`SHELL`, `LANG`, `LC_ALL`, `PYTHONIOENCODING`), and every documented per-platform override (`TWITTER_BACKEND`, `PI_SEARCH_REDDIT_BACKEND`, `BILIBILI_BACKEND`, … and their `PI_SEARCH_*` mirrors) to the spawned `cli.ts` subprocess.

The two allowlists now agree: everything `src/reach-tools.ts:590-598` `externalEnvironment` re-filters for the external CLIs is present in `buildCliEnvironment`, so the values survive both layers. `src/reach-tools.ts:431-443` `orderByOverride` reads `${PLATFORM}_BACKEND` / `PI_SEARCH_${PLATFORM}_BACKEND` from `process.env` inside the subprocess, which now contains those overrides. Empirically confirmed: login-backed platforms and documented `*_BACKEND` overrides are functional through the default native-cli extension runtime, not only via direct `npm run cli`.

Regression test added: `test/backend.test.ts` "buildCliEnvironment forwards reach backend auth and override allowlist" asserts the allowlist passes auth/override/proxy vars while dropping `DATABASE_URL`. This would have caught the original B1.

## Focus-area findings

### Env propagation through CliSearchBackend — no blocker
- `src/cli-backend.ts:30-81` `run` now threads `options.timeout` through `callTool` (`src/cli-backend.ts:22`).
- `buildCliEnvironment` allowlist unified with `externalEnvironment`'s needs (see B1 above). Unrelated process secrets remain stripped (empirically `DATABASE_URL`, `AWS_SECRET_ACCESS_KEY` excluded).
- `test/backend.test.ts` regression test covers the allowlist.

### Scoped external env — no blocker (prior N2 RESOLVED)
- `src/reach-tools.ts:590-598` `externalEnvironment` now scopes platform auth by `command`: `TWITTER_AUTH_TOKEN`/`TWITTER_CT0` only when `command === 'twitter'`; `OPENCLI_HOST`/`OPENCLI_PORT`/`OPENCLI_TOKEN` only when `command === 'opencli'`. The generic `AUTH_TOKEN`/`CT0` entries are removed. A `reddit` (rdt) invocation no longer receives Twitter/OpenCLI tokens; a `youtube` (yt-dlp) invocation receives neither. Secret-exposure surface is now proportional to the platform.

### Fallback behavior — no blocker (prior N3 RESOLVED)
- `src/reach-tools.ts:368-390` `runFirstUsable`: on exit `127` (not installed) it `continue`s; on exit `0` it returns success; on any other nonzero exit it records the failure and **falls through to the next ordered candidate** (no early `throw`/`break` inside the loop). Only after exhausting all candidates does it throw `No usable <platform> backend.`. So an installed-but-auth-failing OpenCLI now falls back to rdt-cli / xhs-cli / bili-cli as appropriate.
- `src/reach-tools.ts:82-101` `inspectChannel`: probes **all** candidates (the `code !== 127` branch only pushes a warning, does not `return`), so a later healthy backend flips the channel to `ok`. If none are healthy but at least one was installed, it reports `warn` with the first warning; only when all are absent (127) does it report `off`.

### Timeout handling — no blocker (prior N4 RESOLVED)
- `src/cli-backend.ts:38-66` adds a `timer` from `options.timeout` that sets `timedOut = true` and sends `SIGTERM`; `cleanup()` clears both the abort listener and the timer; the `close` handler rejects with `CLI backend timed out after <ms>` when `timedOut`, distinct from abort and invalid-JSON paths. `callTool` passes `options.timeout` (`src/cli-backend.ts:22`).
- `src/index.ts:140-156` `callSearchMcpTool` forwards the per-tool timeout (60s/120s/180s/300s) into `client.callTool` options. `CliSearchBackend` enforces the outer bound by killing the subprocess; `SearchMcpClient` (`src/mcp-client.ts:45`) applies `options.timeout ?? 120_000` to the MCP SDK call.
- Net: the reach family is now outer-bounded through the extension runtime. Inner `runCommand` (`src/reach-tools.ts:392-421`) still enforces a per-external-command `COMMAND_TIMEOUT_MS = 120_000`. The outer kill terminates any in-flight inner `fetch()`/`spawn()`, so `feeds`/`v2ex` native fetches (which pass only `signal`, no inner timeout) are bounded by the subprocess termination.

### Feed parser — no blocker (prior N5 RESOLVED)
- `src/reach-tools.ts:504-522` `parseFeedItems` no longer assumes element ordering. RSS items extract `title`, `link` (falling back to `guid`), and `description`/`summary`/`content:encoded` via `firstXmlText` (`src/reach-tools.ts:524-530`), which searches each tag independently. Atom entries extract `link` via `firstXmlAttribute(..., 'link', 'href')` (`src/reach-tools.ts:532-535`), falling back to `id`. `<link>`-before-`<title>`, self-closing `<link/>`, and `guid isPermaLink` feeds now parse. CDATA and entity decoding handled in `cleanXml`/`cleanText` (`src/reach-tools.ts:537-551`).

### Docs — no blocker (prior N1/N6 doc-side RESOLVED)
- `README.md` documents the four new tool names, `reach_status`/`social`/`feeds` CLI examples, the per-platform backend override examples (`TWITTER_BACKEND`, `PI_SEARCH_REDDIT_BACKEND`, `BILIBILI_BACKEND`), the external-backend allowlist story, and explicitly states new family tools require the default `native-cli` backend (legacy `SEARCH_BACKEND=mcp` supports only original search-mcp tools) — closing the prior N1 documentation gap.
- `SKILL.md` description updated to mention social/video/feeds; workflow reorders `social` + `reach_status` before deeper retrieval; adds read-only guideline ("do not post, like, comment, follow, or mutate accounts") and the Bilibili yt-dlp prohibition. Channel tiers in `src/reach-tools.ts:51-52` now read `tier: 1` for youtube and bilibili (was `tier: 0`), consistent with the README's "Native zero-config" framing for tier 0 — closing the prior N6 inconsistency.

## Tool-name stability — confirmed

Existing public Pi tool names unchanged: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`. The `src/index.ts` diff only *adds* `registerExpansionTools(pi, client)` and four new `pi.registerTool` blocks (`reach_status`, `social`, `video`, `feeds`); no existing `pi.registerTool` block was renamed or had its `name` altered. `NativeToolName` in `src/native-tools.ts` still lists the original seven names; `callReachTool` (`src/native-tools.ts:24-25`) is dispatched first and returns `undefined` for unknown names, so the original `switch` and its `Unsupported native tool` default are preserved. The four new names collide with no existing tool.

## Blockers

None.

## Non-blocking residuals

- **NB1: `cli.ts` does not forward `signal`/`timeout` into `callNativeTool`.** `src/cli.ts:43` calls `callNativeTool(toolName, parsed.data, { env })` — no `signal`, no `timeout`. Internal abort therefore relies on the outer `CliSearchBackend` SIGTERM kill of the whole subprocess rather than graceful in-process cancellation. The outer bound is correct and sufficient, but a long inner `fetch()` cannot self-cancel; it is force-killed. Acceptable; note for future hardening.
- **NB2: `reach_status` with no `family` still fans out parallel external probes.** `src/reach-tools.ts:76-77` runs `inspectChannel` over all 13 channels in parallel (up to ~10 external subprocesses, 8s each). Unchanged from prior N7. Acceptable for an explicit health check; consider bounding concurrency or documenting the cost.
- **NB3: `orderByOverride` uses `startsWith` (improved from `includes`) but very short overrides remain ambiguous.** `src/reach-tools.ts:431-443`: an override like `o` would still match `opencli` via `startsWith`. Much safer than the prior `includes`, but exact-match-then-startswith ordering means a short prefix could select an unintended backend. Low risk; non-blocking.
- **NB4: Feed parser is regex-based.** `src/reach-tools.ts:504-535`: order-sensitivity is resolved, but namespaced feeds (e.g. `<media:content>`), deeply nested CDATA, or malformed XML may still parse imperfectly. The core blocker path (silent 0 items for common `<link>`-first RSS) is fixed; remaining edge cases are robustness, not correctness blockers.
- **NB5: Test coverage breadth still thin.** New regression test covers `buildCliEnvironment` (B1 path). Still uncovered: `orderByOverride` reorder behavior, `platformOrInfer` URL→platform inference, feed parsing against realistic RSS/Atom fixtures, `cleanSubtitleText`, and `runFirstUsable` fallback semantics. No regression test for the timeout kill or the scoped `externalEnvironment`. The headline blocker is now guarded; the rest is non-blocking.
- **NB6: Existing non-reach tools call `callSearchMcpTool` without a timeout.** `src/index.ts` web_search/browse/research_sources/github invocations use the old 4-arg form (no `timeout`), so via `CliSearchBackend` they have no outer bound (rely on inner behavior). Pre-existing, unchanged, outside this re-review's focus. Noting for completeness.

## Residual risks

- None blocking. The prior blocker B1 is fully resolved and guarded by a regression test; the in-extension path now propagates auth, proxy, locale, and `*_BACKEND` overrides. Scoped external env, fallback, timeout, and feed-parser issues from the prior review are addressed. Remaining items (NB1–NB6) are hardening/robustness/coverage notes only.

## Acceptance

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings with file paths and line ranges for every focus area (env propagation, scoped external env, fallback, timeout, feed parser, docs) plus tool-name stability confirmation; 0 blockers, 6 non-blocking residuals; typecheck/test/env-probe evidence recorded."
    }
  ],
  "changedFiles": [
    "README.md",
    "SKILL.md",
    "src/cli-backend.ts",
    "src/index.ts",
    "src/native-tools.ts",
    "test/backend.test.ts",
    "test/cli.test.ts",
    "test/native-tools.test.ts"
  ],
  "testsAddedOrUpdated": [
    "test/backend.test.ts",
    "test/cli.test.ts",
    "test/native-tools.test.ts"
  ],
  "commandsRun": [
    {
      "command": "npm run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit clean, no errors"
    },
    {
      "command": "npm test",
      "result": "passed",
      "summary": "35/35 tests pass, including new buildCliEnvironment allowlist regression test"
    },
    {
      "command": "node --import tsx /tmp/envprobe2.mjs",
      "result": "passed",
      "summary": "buildCliEnvironment forwards TWITTER_AUTH_TOKEN/TWITTER_BACKEND/PI_SEARCH_REDDIT_BACKEND/BILIBILI_BACKEND/OPENCLI_TOKEN/HTTP_PROXY/LANG/PYTHONIOENCODING; strips DATABASE_URL and AWS_SECRET_ACCESS_KEY (empirical proof B1 fixed)"
    },
    {
      "command": "node /tmp/envprobe3.mjs",
      "result": "passed",
      "summary": "Confirms externalEnvironment scopes auth by command (twitter->TWITTER_*, opencli->OPENCLI_*) and removed generic AUTH_TOKEN/CT0"
    }
  ],
  "validationOutput": [
    "typecheck: clean",
    "test: 35 pass / 0 fail",
    "env probe: platform auth/proxy/override vars survive buildCliEnvironment; unrelated secrets stripped",
    "scope probe: externalEnvironment twitter/opencli command-scoped branches present; generic AUTH_TOKEN/CT0 removed"
  ],
  "residualRisks": [
    "NB1: cli.ts does not forward signal/timeout into callNativeTool; inner abort relies on outer subprocess SIGTERM kill (acceptable, hardening opportunity).",
    "NB2: reach_status with no family fans out ~10 parallel external probes (unchanged, prior N7).",
    "NB3: orderByOverride startsWith matching still allows very short prefixes (e.g. 'o') to match opencli.",
    "NB4: feed parser is regex-based; namespaced/nested CDATA/malformed XML edge cases may parse imperfectly (order-sensitivity blocker resolved).",
    "NB5: test coverage still thin for override ordering, URL inference, realistic feed fixtures, subtitle cleaning, fallback semantics, timeout kill, scoped externalEnvironment.",
    "NB6: existing non-reach tools invoke callSearchMcpTool without a timeout (pre-existing, out of focus scope)."
  ],
  "noStagedFiles": true,
  "diffSummary": "Post-fix diff extends buildCliEnvironment's allowlist to forward platform auth/proxy/locale/*_BACKEND vars to the cli subprocess (resolves prior B1), scopes externalEnvironment auth by command (resolves N2), makes runFirstUsable/inspectChannel fall through all candidates (resolves N3), wires options.timeout into CliSearchBackend with a SIGTERM timer (resolves N4), rewrites parseFeedItems to be order-independent via firstXmlText/firstXmlAttribute (resolves N5), reclassifies youtube/bilibili to tier 1 (resolves N6), documents native-cli requirement and overrides in README/SKILL (resolves N1), and adds a buildCliEnvironment regression test. Existing tool names unchanged.",
  "reviewFindings": [
    "no blockers",
    "non-blocking: src/cli.ts:43 — callNativeTool receives only { env }; no signal/timeout forwarded, so in-process abort relies on outer CliSearchBackend SIGTERM kill of the subprocess.",
    "non-blocking: src/reach-tools.ts:76-77 — reach_status with no family still fans out ~10 parallel external probes (prior N7, unchanged).",
    "non-blocking: src/reach-tools.ts:431-443 — orderByOverride startsWith matching (improved from includes) still permits very short override prefixes to match a backend name.",
    "non-blocking: src/reach-tools.ts:504-535 — feed parser is regex-based; order-sensitivity resolved, but namespaced/nested-CDATA/malformed XML edge cases may parse imperfectly.",
    "non-blocking: test/backend.test.ts,test/cli.test.ts,test/native-tools.test.ts — coverage breadth still thin (override ordering, URL inference, realistic feed fixtures, subtitle cleaning, fallback semantics, timeout kill, scoped externalEnvironment untested).",
    "non-blocking: src/index.ts — existing non-reach tools call callSearchMcpTool without a timeout, so via CliSearchBackend they have no outer bound (pre-existing, out of focus scope)."
  ],
  "manualNotes": "Tool-name stability re-confirmed: web_search, semantic_crawl, browse, research_sources, github unchanged; reach_status/social/video/feeds added with no collisions; NativeToolName list unchanged and callReachTool returns undefined for unknown names preserving the default switch. Prior blocker B1 is fully resolved and now guarded by a regression test; prior non-blocking N1, N2, N3, N4, N5, N6, N8 are addressed in this diff; N7 and N9 remain non-blocking. No files were edited per instructions. No staged files."
}
```
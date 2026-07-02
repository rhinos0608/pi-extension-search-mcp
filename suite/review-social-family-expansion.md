# Review: Agent-Reach-inspired reach_status / social / video / feeds expansion

Scope: current working-tree diff in `/Users/rhinesharar/pi-extension-search-mcp` plus the new untracked `src/reach-tools.ts`. This is a review only — no files were edited.

## Diff summary

- `src/reach-tools.ts` (new): channel registry, `reach_status` health inspector, `social`/`video`/`feeds`/`v2ex` handlers, ordered external-backend candidate builders (twitter-cli, OpenCLI, rdt-cli, xhs-cli, yt-dlp, bili-cli), subprocess runner with env allowlist, feed parser, subtitle cleaner, URL/host validation.
- `src/native-tools.ts`: `callNativeTool` now delegates to `callReachTool` first; new names handled there, existing switch unchanged.
- `src/index.ts`: registers four new Pi tools (`reach_status`, `social`, `video`, `feeds`) via `registerExpansionTools`; existing tool registrations untouched.
- `test/cli.test.ts`, `test/native-tools.test.ts`: new tests for reach_status feeds, social platform validation, and URL-scheme rejection on feeds/social/video.
- `README.md`, `SKILL.md`: docs for new families, env override examples, read-only guidelines.

## Verification run

- `npm run typecheck` → clean (no errors).
- `npm test` → 34/34 pass (5 new tests pass).

## Tool-name stability

Confirmed stable. Existing public Pi tool names are unchanged: `web_search`, `semantic_crawl`, `browse`, `research_sources`, `github`. The diff only *adds* `registerExpansionTools(pi, client)` and the four new registrations; no existing `pi.registerTool` block was renamed or had its `name` altered. New names (`reach_status`, `social`, `video`, `feeds`) do not collide with any existing tool. `NativeToolName` in `native-tools.ts` still lists the original seven names; reach tools are dispatched before the switch and return early, so the default `Unsupported native tool` path is preserved for unknown names.

## Blockers

### B1 (blocker): Platform auth tokens, proxy vars, and backend-override env vars never reach external CLIs through the default native-cli backend

The new external-backend routing is non-functional in the production (in-extension) path because of an allowlist mismatch across two layers.

- `src/cli-backend.ts:65-79` `buildCliEnvironment` forwards only `PATH, HOME, TMPDIR, TEMP, TMP, NODE_OPTIONS, GITHUB_TOKEN, SEARCH_BACKEND` to the spawned `cli.ts` subprocess.
- `src/reach-tools.ts:567-575` `externalEnvironment` is written to forward `TWITTER_AUTH_TOKEN, TWITTER_CT0, AUTH_TOKEN, CT0, OPENCLI_HOST, OPENCLI_PORT, OPENCLI_TOKEN, HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY, LANG, LC_ALL, PYTHONIOENCODING, SHELL` to the external CLIs — but it filters `options.env ?? process.env`, where `process.env` inside `cli.ts` is the already-stripped 8-var environment from `buildCliEnvironment`.
- `src/reach-tools.ts:429-437` `orderByOverride` reads `${PLATFORM}_BACKEND` / `PI_SEARCH_${PLATFORM}_BACKEND` from the same stripped env, so backend overrides never take effect either.

Net effect: when the extension calls `social`/`video`/`reach_status` via `CliSearchBackend` (the default), the external CLIs (twitter, opencli, rdt, xhs, bili, yt-dlp) are spawned with only `PATH`/`HOME`/temp vars. Auth tokens (`TWITTER_AUTH_TOKEN`, `OPENCLI_TOKEN`, …), proxy settings, and the documented per-platform overrides (`TWITTER_BACKEND`, `PI_SEARCH_REDDIT_BACKEND`, `BILIBILI_BACKEND`) are dropped before they ever reach `reach-tools.ts`. The README explicitly documents these overrides and the SKILL says "Run reach_status first for login-backed platforms," but none of that can work through the native-cli backend.

Empirically confirmed: simulating `buildCliEnvironment` with `TWITTER_BACKEND`, `TWITTER_AUTH_TOKEN`, `HTTP_PROXY`, and `PI_SEARCH_REDDIT_BACKEND` set yields a subprocess env containing only `PATH, HOME, GITHUB_TOKEN` — none of the reach/auth/proxy/override vars survive.

Note: this works only when invoking `npm run cli -- call …` directly, because that path uses the full `process.env` and bypasses `CliSearchBackend`. So the feature appears to work in manual CLI testing but is broken in the actual extension runtime.

Fix direction (for the author, not applied here): extend `buildCliEnvironment`'s allowlist (or unify it with `externalEnvironment`) to forward the platform auth, proxy, locale, and `*_BACKEND` override vars to the `cli.ts` subprocess, so the second-layer `externalEnvironment` filter has something to pass through. The two allowlists must agree.

## Non-blocking issues

### N1: Reach tools are unusable with `SEARCH_BACKEND=mcp`
`src/index.ts` routes every tool through `client.callTool`. When `SEARCH_BACKEND=mcp`, `client` is `SearchMcpClient`, which forwards to the legacy search-mcp stdio server — which has no `reach_status`/`social`/`video`/`feeds` tools. These four tools are effectively native-cli-only. README/SKILL do not state this prerequisite. Recommend documenting that the new families require the default native-cli backend.

### N2: `externalEnvironment` passes platform auth tokens to every external CLI, not just the relevant platform
`src/reach-tools.ts:567-575` applies the same allowlist to all spawned backends. A `reddit` (rdt) invocation receives `TWITTER_AUTH_TOKEN`/`TWITTER_CT0`/`OPENCLI_*`, and a `youtube` (yt-dlp) invocation receives all of them too. `AUTH_TOKEN` and `CT0` are generic names; forwarding them to unrelated CLIs broadens secret exposure unnecessarily. Consider scoping auth vars to the matching platform's candidate, or at minimum dropping the generic `AUTH_TOKEN`/`CT0` in favor of the `TWITTER_*`-prefixed names.

### N3: `runFirstUsable` aborts on the first failing backend instead of falling back
`src/reach-tools.ts:378-388`: a candidate returning exit code `127` (not installed) falls through to the next, but any other nonzero exit code throws immediately and never tries the remaining ordered backends. This contradicts the "ordered backends per platform" resilience story (e.g., reddit OpenCLI installed-but-auth-failing will never fall back to rdt-cli; twitter-cli installed-but-failing won't fall back to OpenCLI). The status inspector (`inspectChannel:90-94`) has the same shape: a non-127 probe marks the channel `warn` and stops probing later backends, so `reach_status` may report a channel as `warn` even when a later backend is healthy. Worth deciding intentionally and documenting.

### N4: Per-tool timeouts in `index.ts` are ignored by the native CLI backend
`src/index.ts` passes `timeout` (60s/120s/180s/300s) into `callSearchMcpTool` → `client.callTool`. But `CliSearchBackend.run` (`src/cli-backend.ts:30-63`) only honors `options.signal`; it never applies `options.timeout`. So the `cli.ts` subprocess and long-running fetches (e.g. V2EX, feeds) have no outer time bound via this path — only the inner `COMMAND_TIMEOUT_MS` (120s) governs external-CLI spawns, and direct `fetch()` calls have no bound at all. Either wire the timeout into `CliSearchBackend` or drop the decorative timeout args.

### N5: RSS feed parser assumes element ordering, may silently return 0 items
`src/reach-tools.ts:498-504` `parseFeedItems` requires `<title>` to appear before `<link>` inside `<item>` (`<item>…<title>…</title>…<link>…</link>…</item>`). Many real RSS feeds emit `<link>` before `<title>`, or use `<link>` as a self-closing/empty element, or put `<guid isPermaLink="true">` instead. Those feeds will silently match nothing and the tool returns "No feed entries found." Atom parsing is also order-sensitive and doesn't handle `<link>` without `href` robustly. Consider a tolerant parser (or a minimal XML walk) rather than ordered regexes.

### N6: YouTube channel is labeled `tier: 0` but requires an external CLI
`src/reach-tools.ts:51` sets youtube `tier: 0` with only a `yt-dlp` external backend (no native backend). The README frames tier 0 as "Native zero-config channels run directly," which is inconsistent with youtube requiring `pip install yt-dlp`. Either reclassify (tier 1) or clarify the tier semantics in docs. Same family: bilibili is `tier: 0` but external-only (bili-cli/OpenCLI).

### N7: `reach_status` with no `family` fans out parallel probes to every external backend
`src/reach-tools.ts:76-77` runs `inspectChannel` over all 13 channels in parallel, spawning probes for twitter, reddit, xhs, facebook, instagram, youtube, bilibili backends (up to ~10 subprocesses at once, each with an 8s timeout). Acceptable for an explicit health check, but worth bounding concurrency or documenting the cost.

### N8: `orderByOverride` uses loose `name.toLowerCase().includes(override)` matching
`src/reach-tools.ts:432`: an override like `cli` would match `twitter-cli` (and `rdt-cli`), selecting the first by `findIndex`. Short/ambiguous override values could reorder unexpectedly. Consider exact or startswith matching.

### N9: Thin test coverage for the new complex logic
New tests cover reach_status feeds (native), social platform-required rejection, and URL-scheme rejection for feeds/social/video. Not covered: backend-override ordering (`orderByOverride`), `platformOrInfer` URL→platform inference, feed-parsing correctness against realistic RSS/Atom, subtitle cleaning, `runFirstUsable` fallback/abort behavior, and the env-propagation path (B1 would have been caught here). The env-propagation blocker has no regression test.

## Residual risks

- B1 makes all login-backed social/video platforms and all documented env overrides non-functional through the default extension runtime; until the allowlists are unified, the external-backend feature is effectively direct-CLI-only.
- Even after fixing B1, N2/N3/N5 remain correctness/security edges that could cause silent empty results or over-broad secret exposure.

## Acceptance

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings with file paths, line references, and severities (1 blocker B1, 9 non-blocking N1–N9); tool-name stability explicitly confirmed; typecheck and test results reported."
    }
  ],
  "changedFiles": [
    "README.md",
    "SKILL.md",
    "src/index.ts",
    "src/native-tools.ts",
    "src/reach-tools.ts",
    "test/cli.test.ts",
    "test/native-tools.test.ts"
  ],
  "testsAddedOrUpdated": [
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
      "summary": "34/34 tests pass, including 5 new reach/social/video/feeds tests"
    },
    {
      "command": "node /tmp/envprobe.mjs (simulate buildCliEnvironment)",
      "result": "passed",
      "summary": "Confirmed TWITTER_BACKEND/TWITTER_AUTH_TOKEN/HTTP_PROXY/PI_SEARCH_REDDIT_BACKEND are stripped before cli subprocess (empirical proof of B1)"
    }
  ],
  "validationOutput": [
    "typecheck: clean",
    "test: 34 pass / 0 fail",
    "env probe: cli subprocess env keys = [PATH, HOME, GITHUB_TOKEN]; platform auth/proxy/override vars absent"
  ],
  "residualRisks": [
    "B1: external-backend auth/proxy/override env vars are dropped by buildCliEnvironment, so login-backed platforms and documented *_BACKEND overrides do not work through the default native-cli extension runtime (only via direct npm run cli).",
    "N2: platform auth tokens (incl. generic AUTH_TOKEN/CT0) are forwarded to every external CLI regardless of platform.",
    "N3: runFirstUsable/inspectChannel abort on first non-127 backend failure instead of falling back to later ordered backends.",
    "N5: RSS/Atom parser is order-sensitive and may silently return 0 items for common feeds.",
    "N4: per-tool timeouts in index.ts are not enforced by CliSearchBackend.",
    "N1: reach tools are native-cli-only and unusable with SEARCH_BACKEND=mcp (undocumented)."
  ],
  "noStagedFiles": true,
  "diffSummary": "Adds reach_status/social/video/feeds Pi tools backed by new src/reach-tools.ts (channel registry, ordered external-CLI routing, native v2ex/feeds, URL/host validation) wired into native-tools.ts and index.ts, with README/SKILL docs and 5 new tests. Existing tool names unchanged.",
  "reviewFindings": [
    "blocker: src/cli-backend.ts:65-79 + src/reach-tools.ts:567-575,429-437 — platform auth/proxy/*_BACKEND env vars are stripped by buildCliEnvironment before reaching the cli subprocess, so external CLIs never receive them and documented overrides (TWITTER_BACKEND, PI_SEARCH_REDDIT_BACKEND, BILIBILI_BACKEND) and auth tokens (TWITTER_AUTH_TOKEN, OPENCLI_TOKEN, HTTP_PROXY, …) are non-functional through the default native-cli extension runtime (empirically confirmed).",
    "non-blocking: src/index.ts + src/cli-backend.ts — reach_status/social/video/feeds are native-cli-only; unusable with SEARCH_BACKEND=mcp (undocumented).",
    "non-blocking: src/reach-tools.ts:567-575 — externalEnvironment forwards platform auth tokens (incl. generic AUTH_TOKEN/CT0) to every external CLI, not just the relevant platform.",
    "non-blocking: src/reach-tools.ts:378-388,90-94 — runFirstUsable/inspectChannel abort on first non-127 failure instead of falling back to later ordered backends.",
    "non-blocking: src/cli-backend.ts:30-63 — CliSearchBackend ignores options.timeout; per-tool timeouts in index.ts are decorative.",
    "non-blocking: src/reach-tools.ts:498-504 — RSS/Atom parser assumes <title> before <link>; may silently return 0 items for common feeds.",
    "non-blocking: src/reach-tools.ts:51-52 — youtube/bilibili labeled tier 0 but are external-CLI-only, inconsistent with README's 'native zero-config' framing.",
    "non-blocking: src/reach-tools.ts:76-77 — reach_status with no family spawns ~10 external probes in parallel.",
    "non-blocking: src/reach-tools.ts:432 — orderByOverride uses loose includes() matching for override selection.",
    "non-blocking: test/native-tools.test.ts,test/cli.test.ts — no coverage for override ordering, URL inference, feed parsing, subtitle cleaning, fallback behavior, or env propagation (which would have caught B1)."
  ],
  "manualNotes": "Tool-name stability confirmed: web_search, semantic_crawl, browse, research_sources, github unchanged; new reach_status/social/video/feeds add no collisions. No files were edited per instructions. B1 is the headline issue — the feature passes manual `npm run cli` testing because that path uses full process.env, masking the in-extension failure. Recommend unifying the cli-backend and reach-tools env allowlists before relying on login-backed platforms."
}
```
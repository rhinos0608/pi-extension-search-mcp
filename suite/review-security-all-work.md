# Security & Privacy Review — pi-extension-search-mcp

- Repo: `/Users/rhinesharar/pi-extension-search-mcp`
- HEAD: `789651db0a6de59b2fb6d489ef3353cebef80da5`
- Scope: review only, no edits. Focus files: `src/bootstrap.ts`, `src/reach-tools.ts`, `src/local-config.ts`, `src/cli-backend.ts`, `src/mcp-client.ts`, `src/native-tools.ts`, `README.md`.
- Validation: `npm run typecheck` (clean), `npm test` (49/49 pass).

This is a findings report. No source files were modified (confirmed: `git diff --cached` and `git diff` both empty).

---

## Summary

| Severity | Count | Theme |
|---|---|---|
| Blocker | 2 | Default-on auto-install of a third-party CLI + forwarding all API keys/tokens to that subprocess on first extension load |
| High | 3 | Default-on silent browser-cookie scraping; raw external-CLI stdout/stderr returned to the model |
| Medium | 5 | SSRF allowlist gaps; `NODE_OPTIONS` forwarding; `SEARCH_MCP_*` wildcard env forwarding; unvalidated `channels` to installer; hardcoded config path |

Positives noted (no action needed): all three subprocess paths (`bootstrap.ts`, `reach-tools.ts`, `cli-backend.ts`, `mcp-client.ts`) use env allowlists rather than inheriting `process.env`; `spawn` is called with arg arrays (no shell); state file is written `0600` in a `0700` dir; URL validation blocks non-`http(s)` schemes and the common private/loopback ranges including the AWS metadata IP; API-key allowlisting per command (twitter/opencli tokens only forwarded to their own command).

---

## Blockers

### B1 — First-start auto-install of third-party CLI, default ON, no user confirmation
- **File:** `src/bootstrap.ts:50-56, 111-129, 131-136`; wired in `src/index.ts:45` (`void ensureFirstStartBootstrap(env)`).
- `ensureFirstStartBootstrap` defaults `PI_SEARCH_BOOTSTRAP` to `install_all` and, on first start, spawns `agent-reach install --env=auto --channels=all` (10-minute timeout) with no user interaction. An extension that auto-loads in the Pi agent silently runs a third-party package installer on first load — a supply-chain / surprise-execution risk. Opt-outs exist (`PI_SEARCH_BOOTSTRAP=off`, `PI_SEARCH_ALLOW_INSTALL=0`) but default to **enabled**. README documents this as "allowed by default," but defaulting an auto-install *on* in an auto-loaded extension is not safe consent.
- **Recommendation:** default `PI_SEARCH_BOOTSTRAP` to `off` (or `check`/`plan` only) and require an explicit `/reach-setup install_*` action before any install runs.

### B2 — Auto-install subprocess receives all API keys and session tokens
- **File:** `src/bootstrap.ts:239-251` (`setupEnvironment`), consumed by `runCommand` → `runBootstrapMode` / `runAgentReachInstall`.
- The allowlist forwarded to the `agent-reach` install subprocess includes `GITHUB_TOKEN`, `GH_TOKEN`, `GROQ_API_KEY`, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`, `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID/SECRET`, `CRAWL4AI_*`, `DEEP_RESEARCH_*`, `TWITTER_AUTH_TOKEN`, `TWITTER_CT0`, `OPENCLI_TOKEN`. The env passed in is `loadSearchMcpEnvironment(process.env)`, so secrets read from `search-mcp/config.json` are also included. A third-party installer run automatically on first start (B1) is therefore handed the user's full credential set. If `agent-reach` or any channel package is compromised or logs env, all keys leak.
- **Recommendation:** install subprocesses should receive only `PATH/HOME/temp/locale/proxy` — never API keys or auth tokens. Secrets should be forwarded only to the specific backend command that needs them (as `reach-tools.ts:externalEnvironment` already does per-command).

---

## High

### H1 — Default-on silent browser-cookie import from all local browsers
- **File:** `src/bootstrap.ts:120, 154-181` (`importBrowserCookiesSummary`), default browser list `chrome,firefox,edge,brave,opera` at `:194`; triggered automatically after a successful install in `runBootstrapMode:120` and `runAgentReachInstall:150`.
- After install, the extension runs `agent-reach configure --from-browser <browser>` against every local browser profile by default, importing existing session cookies (Twitter, Reddit, GitHub, etc.) into `agent-reach` with no per-site or per-browser consent. Cookies are session credentials. Default ON; opt-out `PI_SEARCH_IMPORT_BROWSER_COOKIES=0`. Silently scraping cookies from all installed browsers into a third-party tool on first start is a serious privacy issue even when user-initiated via `/reach-setup import_cookies`, and is worse when run automatically by the bootstrap.
- **Recommendation:** never run cookie import automatically in bootstrap; require explicit `/reach-setup import_cookies` and prompt the user to confirm which browser/sites. Default `PI_SEARCH_IMPORT_BROWSER_COOKIES=0`.

### H2 — Raw external-CLI stdout/stderr returned verbatim to the model
- **File:** `src/reach-tools.ts:113` (`social`), `:125` (`video`), `:151` (`runFirstUsable` failure tail), `:389` (failure list).
- `social` and `video` return `result.stdout || result.stderr` directly as tool `text` content and again in `details.stdout`/`details.stderr`. The external CLIs (`twitter`, `opencli`, `rdt`, `xhs`, `bili`, `yt-dlp`) hold cookies/tokens and may emit credentials, auth headers, profile data, or PII to stdout/stderr. No redaction is applied; the raw stream goes to the LLM and (for slash commands) to the UI.
- **Recommendation:** do not surface raw stdout/stderr to the model. Parse structured output (`-f yaml`/`--json`) and return only sanitized fields; log full output only to a local debug sink the model cannot read.

### H3 — Raw `agent-reach install` stdout/stderr surfaced to slash command
- **File:** `src/bootstrap.ts:151` (`runAgentReachInstall`), `:205` (`commandStatus` tails stderr/stdout into the message).
- `/reach-setup install_*` returns `result.stdout` and `result.stderr` verbatim in the text result shown to the user/model. Install logs commonly contain paths, token hints, downloaded-package URLs, and verbose diagnostics; for an installer that also receives the user's secrets (B2), echoing its raw output is a leak vector.
- **Recommendation:** return only a structured status (`{command, exitCode, status, cookies}`) and a short sanitized summary; never the raw streams.

---

## Medium

### M1 — SSRF allowlist gaps in `validatePublicHttpUrl`
- **File:** `src/reach-tools.ts:571-591` and `src/native-tools.ts:337-357` (duplicated logic).
- Confirmed via Node repro:
  - `http://[::ffff:127.0.0.1]/` → `hostname` is `[::ffff:7f00:1]`, **not blocked** (IPv4-mapped IPv6 loopback bypass).
  - `http://metadata.google.internal/` → **not blocked** (GCP metadata hostname; AWS IP `169.254.169.254` is blocked but hostname-based metadata endpoints are not).
  - `http://100.64.0.1/` → not blocked (CGNAT / shared-address space; low risk).
- Integer/octal/short-form IPv4 (`2130706433`, `0177.0.0.1`, `127.1`) are canonicalized by `new URL` to `127.0.0.1` and **are** blocked — good.
- **Recommendation:** resolve the hostname and reject if it maps to loopback/private/link-local/CGNAT, or block `::ffff:*` and known cloud-metadata hostnames (`metadata.google.internal`, `metadata`, `metadata.azure.com`). De-duplicate the validator into one shared module.

### M2 — `NODE_OPTIONS` forwarded to the CLI child subprocess
- **File:** `src/cli-backend.ts:95` (`buildCliEnvironment` allowlist includes `NODE_OPTIONS`).
- `CliSearchBackend` spawns `process.execPath --import tsx cli.ts` with `NODE_OPTIONS` passed through. `NODE_OPTIONS` can inject `--require`/`--import` of arbitrary modules into the child. Low practical risk in this local extension (the parent env is the agent's own), but it is an unnecessary privilege and inconsistent with the otherwise-strict allowlists.
- **Recommendation:** drop `NODE_OPTIONS` from the allowlist (the child already sets `--import tsx` explicitly).

### M3 — `SEARCH_MCP_*` wildcard env forwarding to MCP server
- **File:** `src/mcp-client.ts:144-148` (`toProcessEnvironment`).
- Every env var matching `key.startsWith('SEARCH_MCP_')` is forwarded to the spawned MCP server, in addition to the explicit allowlist and `SEARCH_MCP_FORWARD_ENV_JSON`. The wildcard can forward unintended `SEARCH_MCP_*` values (e.g., future config vars that hold secrets) to a subprocess. Behavior is documented but broader than necessary.
- **Recommendation:** forward only an explicit named allowlist of `SEARCH_MCP_*` vars; require opt-in via `SEARCH_MCP_FORWARD_ENV_JSON` for anything else.

### M4 — Unvalidated `channels` passed to `agent-reach install`
- **File:** `src/bootstrap.ts:86-88` (`install_channels`); slash wiring `src/index.ts:179-185`.
- `/reach-setup install_channels <channels>` passes the user's `channels` string straight into `agent-reach install --env=auto --channels=${channels}`. There is no shell (arg-array spawn, so no injection), but the value is not validated against a known channel list, so a slash command can install arbitrary `agent-reach` channel packages. User-initiated, hence Medium.
- **Recommendation:** validate `channels` against the known `platformPlan`/channel set before invoking the installer.

### M5 — Hardcoded developer path as default config location
- **File:** `src/local-config.ts:3` (`DEFAULT_SEARCH_MCP_CONFIG_PATH = '/Users/rhinesharar/search-mcp/config.json'`).
- A distributable package ships a hardcoded absolute path to a specific developer's machine. On any other machine the file does not exist and the bridge silently no-ops (returns env unchanged) — a portability/hygiene smell rather than a direct vuln, but it also means the documented "automatically reads config" behavior is developer-only and silently fails elsewhere.
- **Recommendation:** default to a portable path (e.g., `~/.config/search-mcp/config.json`) or require `SEARCH_MCP_CONFIG_PATH` to be set.

---

## Notes / non-findings

- `mcp-client.ts:84` (`transport.stderr?.on('data', () => undefined)`) intentionally drains MCP server stderr without surfacing it — good, no leak there.
- `cli-backend.ts:62-76` includes stderr `diagnostics` in *error* messages only; the child is the project's own CLI, so risk is low (subsumed by M2 if env is tainted).
- `feeds`/`semantic_crawl`/`browse`/`v2ex`/`github` all funnel URLs through `validatePublicHttpUrl` before fetch — good; the gaps are in the validator itself (M1), not in coverage.
- `bootstrap.ts:279-281` writes state with `mode: 0o600` in a `0o700` dir — good.
- `safeWriteState` swallows all errors so bootstrap never blocks extension registration — acceptable, but means a failed state write is invisible; not a security issue.

---

## Validation commands run

| Command | Result |
|---|---|
| `git rev-parse HEAD` | `789651db0a6de59b2fb6d489ef3353cebef80da5` |
| `git status --short` | only untracked `suite/review-*` and `research/*.md`; no modified tracked files |
| `git diff --cached --name-only` | empty (no staged files) |
| `git diff --name-only` | empty (no unstaged tracked changes) |
| `npm run typecheck` | clean (no output) |
| `npm test` | 49 pass / 0 fail |
| `node` repro for `validatePublicHttpUrl` edge cases | confirmed `[::ffff:127.0.0.1]` and `metadata.google.internal` bypass; integer/octal/short IPv4 correctly blocked |
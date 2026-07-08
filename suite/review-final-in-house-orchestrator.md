# Final Review — In-House Orchestrator Branch

Scope: working-tree diff vs `HEAD` on `main` in `/Users/rhinesharar/pi-extension-search-mcp`.
Mode: review only (no edits). Blockers first.

## Verdict

**No blockers.** All acceptance criteria are satisfied. A few non-blocking
residuals/cleanup items are listed under "Residual risks".

## Acceptance criteria checklist

### 1. No agent-reach runtime dependency/docs in src/README/SKILL — PASS

- `grep -rin "agent-reach\|agent reach" src/ README.md SKILL.md` returns **no hits**
  (the only remaining match is a negative-assertion comment in `test/bootstrap.test.ts:157`,
  which is test-only, not shipped).
- `src/bootstrap.ts` no longer imports `spawn` from `node:child_process` and no longer
  shells out to `agent-reach`. The `INSTALL_DOC_URL` / `OPENCLI_EXTENSION_URL`
  constants, `runAgentReachInstall`, `runBootstrapMode`, `runCommand`,
  `importBrowserCookies*`, `setupEnvironment`, `commandStatus`, `requireString`,
  `tail`, and `bootstrapInstallArgs` were all removed.
- `README.md` and `SKILL.md` describe setup as descriptor-only with no automatic
  installation and no browser cookie reads.
- New module `src/providers.ts` has **zero imports** (types only) — no new runtime dep.

### 2. No automatic installs / browser cookie reads — PASS

- `ensureFirstStartBootstrap` now defaults to `off` and, when run in `check` mode,
  writes **only** a state-marker JSON file — no subprocess, no install, no cookie read
  (`src/bootstrap.ts:32-49`).
- `callSetupTool` install actions (`install_core`, `install_all`, `install_channels`)
  return `structuredInstallDescriptor` with `descriptor: true` and the message
  "No automatic installation…" (`src/bootstrap.ts:74-86`).
- `import_cookies` returns `structuredCookieDescriptor` stating "Cookie import is
  not automated… this extension does not read browser stores."
  (`src/bootstrap.ts:99-113`).
- No `spawn`/`exec`/`execFile`/`from-browser` anywhere in `src/bootstrap.ts` or
  `src/providers.ts`.
- `index.ts:45` calls only `void ensureFirstStartBootstrap(env)` at startup — non-mutating.

### 3. Setup/status slash commands only — PASS

- `src/index.ts:164-185` registers `reach-status` and `reach-setup` via
  `pi.registerCommand` (slash commands). They are **not** registered as tools.
- `test/contract.test.ts` asserts the exact tool set
  (`web_search, semantic_crawl, browse, research_sources, github, social, video, feeds`)
  and command set (`reach-status, reach-setup`), and that `reach_status`/`reach_setup`
  are **not** tools. Test passes.
- `reach-setup` description updated to "Show provider info and setup descriptors…"
  (`src/index.ts:175`).

### 4. Provider auth descriptors / key-name redaction — PASS

- `src/providers.ts` exports `PROVIDER_DESCRIPTORS` with per-provider
  `envKeys`, `cookieDomains`, `loginFlow`, `risk`, `setup`, `description`.
- `liveAuthSnapshot(env)` returns `{ configured, keyNames }` — **key names only,
  never values** (`src/providers.ts:60-67`).
- `authForChannel` (used by `reach_status`) returns
  `{ configured, keyNames, loginFlow, cookieDomains, risk }` — names only
  (`src/providers.ts:69-79`, wired in `src/reach-tools.ts:84-87`).
- `writeAuthState` persists `{ configured, keys: present }` (key names) to
  `~/.pi-extension-search/auth-state.json` with `mode: 0o600` and parent dir
  `mode: 0o700` (`src/bootstrap.ts:115-133`). Verified on-disk: only key names stored.
- Tests assert no secret values leak: `assert.doesNotMatch(text, /ghp_dummy/)`,
  `/ghp_live/`, `/exa_live_secret/` (`test/bootstrap.test.ts`, `test/cli.test.ts`).

### 5. reach-status auth metadata — PASS

- `reachStatus` in `src/reach-tools.ts:80-90` attaches an `auth` object to every
  channel result (falling back to a default
  `{ configured: false, keyNames: [], loginFlow: 'unknown', cookieDomains: [], risk: 'low' }`).
- `test/cli.test.ts` "reach_status includes auth metadata per channel" asserts the
  `auth` field is present.

### 6. Optional CLI output redaction — PARTIAL (optional per acceptance, non-blocking)

- `src/reach-tools.ts:378-396` adds `SECRET_PATTERNS` + `sanitizeExternalOutput`.
- Redaction is applied on the **success** path of `runFirstUsable`
  (`src/reach-tools.ts:415`): both `stdout` and `stderr` are sanitized before return.
- **Gap (low/medium):** the **failure** path
  `failures.push(\`...: ${tail(result.stderr || result.stdout)}\`)`
  (`src/reach-tools.ts:417`) is **not** sanitized. If an external CLI echoes a
  secret to stderr/stdout on a non-zero exit, it could appear in the thrown error
  message. Since the acceptance frames CLI redaction as *optional*, this is a
  residual risk rather than a blocker. Recommend extending `sanitizeExternalOutput`
  to the `tail(...)` argument in the failure branch.
- Redaction keeps key/header names and replaces values with `***`
  (verified for `Authorization:`, `Set-Cookie:`, `KEY=value`, `api_key=` patterns).

### 7. No new runtime deps — PASS

- `package.json` is **unchanged** vs `HEAD` (`git diff HEAD -- package.json` empty).
- New `src/providers.ts` imports only local types — no new dependency.
- `src/bootstrap.ts` dropped the `spawn` import; `src/reach-tools.ts` adds only
  `import { authForChannel } from './providers.js'` (local).

### 8. Package excludes cache — PASS

- `package.json` `files` allowlist = `["bin/", "src/", "README.md", "SKILL.md"]`.
- New `.npmignore` excludes `.pi-smartread/`, `.pi-smartread.tags.cache/`,
  `.smart-edit-undo/` and `**` variants.
- `npm pack --dry-run` confirms the tarball contains only: `README.md`, `SKILL.md`,
  `bin/pi-extension-search.mjs`, `package.json`, and `src/*.ts` (16 files total).
  No `test/`, `research/`, `suite/`, `.npmignore`, lockfile, or cache dirs are packed.

### 9. Tests adequate — PASS

- `npm run typecheck` → clean (no errors).
- `npm test` → **61 pass, 0 fail**.
- New/updated coverage:
  - `test/bootstrap.test.ts`: descriptor-only install, channel validation (valid/
    unknown/empty), status auth-state without secrets, live key-name reporting
    without values, plan provider auth metadata, all-descriptors plan,
    import_cookies cookie domains, install opt-out still descriptor-only.
  - `test/cli.test.ts`: CLI descriptor for install, descriptor for cookie import,
    live env presence with no value leak, reach_status auth metadata.
  - `test/native-tools.test.ts`: native tool descriptor assertions.
  - `test/contract.test.ts` (new): exact tool/command registration contract.

## Residual risks / cleanup (non-blocking)

1. **Stale env allowlist entries** — `src/cli-backend.ts:100-101` still forwards
   `PI_SEARCH_IMPORT_BROWSER_COOKIES` and `PI_SEARCH_BROWSER_COOKIE_BROWSERS` to
   subprocess env. The cookie-import feature these gated was removed from
   `bootstrap.ts`, so these are dead references. Harmless (forwarded only, never
   read), but should be deleted for doc/code consistency. Low severity.
2. **`writeAuthState` not wired into runtime** — exported from `bootstrap.ts` but
   never called in `src/index.ts` (only `ensureFirstStartBootstrap` is). Therefore
   `setupStatus`'s on-disk `authState` section is always the empty default
   (`{ writtenAt: null, providers: {} }`) in production. Live auth metadata is
   correctly surfaced via `liveProviders` and per-channel `auth`, so acceptance is
   met; the on-disk auth-state feature is currently inert. Low severity.
3. **Uneven CLI output redaction** — see criterion 6. Success path sanitized,
   failure path (`tail(result.stderr || result.stdout)` in `runFirstUsable`) is
   not. Low-medium. Recommend sanitizing the failure tail too.
4. **`import_cookies` action name retained** — kept in the `/reach-setup` surface
   and arg completions for backward compatibility, now returning a descriptor.
   Intentional and documented ("Browser cookies are not read by this extension").
   Not a defect.
5. **Untracked research/suite artifacts** — `research/*.md`, `suite/*.md`, and
   `.npmignore` are untracked in git. They are excluded from the npm tarball by the
   `files` allowlist, so they do not affect the published package. Commit hygiene
   is the owner's call.

## Commands run

- `npm run typecheck` → passed (no output, exit 0).
- `npm test` → passed (61 pass / 0 fail / 0 cancelled).
- `npm pack --dry-run` → 16 files, no test/research/suite/cache, 29.3 kB.
- `git diff --stat HEAD`, `git diff HEAD -- <files>` → reviewed all changed + new files.
- `grep` sweeps for `agent-reach`, `from-browser`, `IMPORT_BROWSER_COOKIES`,
  `spawn`, `execFile` across `src/`, `README.md`, `SKILL.md`.

## Diff summary

Removes the agent-reach runtime dependency and all automatic install/browser-cookie
behavior. `bootstrap.ts` is rewritten to be non-mutating (default `off`, descriptor-only
install/cookie actions, on-disk auth-state writer that stores key names only). New
`src/providers.ts` centralizes provider auth descriptors (env keys, cookie domains,
login flow, risk). `reach-tools.ts` adds per-channel `auth` metadata to `reach_status`
and optional secret redaction on external CLI success output. `README`/`SKILL`/command
descriptions updated to descriptor-only framing. Tests rewritten to assert descriptors,
key-name-only reporting, and no secret leakage; new `contract.test.ts` pins the
tool/command surface. New `.npmignore` + existing `files` allowlist exclude cache and
non-runtime artifacts from the published package. No new runtime dependencies.

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concrete findings with file paths/severity for every acceptance axis: agent-reach removal (grep clean, bootstrap.ts no spawn), descriptor-only installs (src/bootstrap.ts:74-113), slash-command-only (src/index.ts:164-185, contract.test.ts), key-name redaction (providers.ts liveAuthSnapshot/authForChannel, auth-state.json on disk stores names only), reach-status auth metadata (reach-tools.ts:80-90), optional redaction (reach-tools.ts:378-415, partial), no new deps (package.json unchanged), package excludes cache (npm pack 16 files, .npmignore), tests 61 pass / typecheck clean."
    }
  ],
  "changedFiles": [
    "README.md",
    "SKILL.md",
    "src/bootstrap.ts",
    "src/index.ts",
    "src/reach-tools.ts",
    "src/providers.ts",
    "test/bootstrap.test.ts",
    "test/cli.test.ts",
    "test/native-tools.test.ts",
    "test/contract.test.ts",
    ".npmignore"
  ],
  "testsAddedOrUpdated": [
    "test/bootstrap.test.ts",
    "test/cli.test.ts",
    "test/native-tools.test.ts",
    "test/contract.test.ts"
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
      "summary": "61 tests pass, 0 fail, 0 cancelled"
    },
    {
      "command": "npm pack --dry-run",
      "result": "passed",
      "summary": "16 files packed: README/SKILL/bin/src only; no test/research/suite/cache"
    },
    {
      "command": "grep -rin 'agent-reach|from-browser|spawn' src/ README.md SKILL.md",
      "result": "passed",
      "summary": "No runtime agent-reach/cookie-read references remain"
    }
  ],
  "validationOutput": [
    "typecheck: clean",
    "test: 61 pass / 0 fail",
    "npm pack: 16 files, 29.3 kB, excludes cache/test/research/suite",
    "package.json unchanged vs HEAD: no new runtime deps",
    "auth-state.json on disk stores key names only (verified)"
  ],
  "residualRisks": [
    "src/cli-backend.ts:100-101 — stale PI_SEARCH_IMPORT_BROWSER_COOKIES / PI_SEARCH_BROWSER_COOKIE_BROWSERS allowlist entries (dead, cookie-import feature removed); low severity cleanup",
    "src/bootstrap.ts writeAuthState exported but not wired into runtime startup; setupStatus on-disk authState always empty default in production; low severity",
    "src/reach-tools.ts runFirstUsable failure path (line 417) does not apply sanitizeExternalOutput to tail(stderr||stdout); secret could leak in thrown error if external CLI echoes it on failure; low-medium severity",
    "import_cookies action name retained in /reach-setup surface for backward compat (now descriptor-only); intentional, documented"
  ],
  "noStagedFiles": true,
  "diffSummary": "Removes agent-reach runtime dep and all automatic install/browser-cookie reads; bootstrap becomes non-mutating (default off, descriptor-only actions); new src/providers.ts centralizes auth descriptors; reach_status gains per-channel auth metadata; optional CLI output redaction on success path; README/SKILL/command docs updated to descriptor-only framing; tests rewritten for descriptors + no secret leakage; new contract.test.ts pins tool/command surface; .npmignore + files allowlist exclude cache; no new runtime deps.",
  "reviewFindings": [
    "no blockers",
    "non-blocker: src/cli-backend.ts:100-101 — stale cookie env vars in allowlist (dead refs)",
    "non-blocker: src/bootstrap.ts — writeAuthState not wired into runtime; on-disk authState inert in prod",
    "non-blocker: src/reach-tools.ts:417 — failure-path CLI output not sanitized (redaction optional per acceptance)"
  ],
  "manualNotes": "No staged files (all changes unstaged/untracked). Owner should decide whether to commit research/suite artifacts and .npmignore. Recommend two small follow-up cleanups: drop stale cookie env vars from cli-backend.ts allowlist and extend sanitizeExternalOutput to the runFirstUsable failure tail."
}
```
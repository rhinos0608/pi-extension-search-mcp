# Security Review — Suite 5/6: security/secrets/supply-chain

**Scope:** URL/network surfaces, env command execution, GitHub token handling, MCP/CLI subprocess safety, dependency risk
**Date:** 2026-07-02
**Reviewer:** read-only audit, no source changes

---

## Findings

### SEC-01 [HIGH] — Entire Process Environment Forwarded to Subprocess

**File:** `src/mcp-client.ts:113–116`

```ts
function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return Object.fromEntries(entries);
}
```

`buildServerParameters` calls `toProcessEnvironment(process.env)` at line 24, which passes **every** string environment variable from the Pi agent process to the spawned `search-mcp` subprocess. This includes any secrets present in the parent environment that are not intended for the subprocess: database credentials, CI tokens, service account keys, other API keys. There is no filtering, masking, or documentation of what is forwarded.

**Impact:** Any secret reachable in `process.env` at agent startup is silently inherited by an external subprocess that runs for the duration of the session. If `search-mcp` logs, crashes with a dump, or is itself compromised, all parent secrets are exposed.

**Fix:** Replace the blanket passthrough with an explicit allowlist of env vars needed by `search-mcp` (e.g., `PATH`, `HOME`, `TMPDIR`, `NODE_*`, `SEARCH_MCP_*`, and any intentionally forwarded tokens). Strip everything else. Example:

```ts
const ALLOWED_ENV_KEYS = /^(PATH|HOME|TMPDIR|NODE_|SEARCH_MCP_|GITHUB_TOKEN)$/;

function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]): v is string => typeof v === 'string' && ALLOWED_ENV_KEYS.test(k)
    )
  );
}
```

---

### SEC-02 [HIGH] — SSRF via Unvalidated URL Parameters in `browse` and `semantic_crawl`

**File:** `src/index.ts:101–107` (`browse`), `src/index.ts:74–92` (`semantic_crawl`)

Both tools accept user-supplied `url` values and pass them to the `search-mcp` subprocess without any validation:

```ts
// browse tool
parameters: Type.Object({
  url: Type.String({ description: 'URL to fetch.' }),
  ...
}),
execute: async (_toolCallId, params, signal) =>
  callSearchMcpTool(client, 'agentic_browse', buildBrowseArgs(params), signal),
```

`buildBrowseArgs` at `src/index.ts:151–157` passes the URL verbatim. The `semantic_crawl` tool likewise passes `url` directly via `buildSemanticSource` at line 160. There is no scheme check, no private-IP blocklist, and no localhost guard.

**Impact:** If the `search-mcp` subprocess can reach private network addresses, this is a Server-Side Request Forgery vector. An LLM or user could pass `http://169.254.169.254/latest/meta-data/` (AWS IMDSv1), `http://localhost:8080`, or `file:///etc/passwd` depending on what `search-mcp`'s fetch implementation accepts.

**Fix:** Add URL validation before forwarding. At minimum, enforce `https://` or `http://` scheme:

```ts
function validateUrl(raw: string): string {
  const url = new URL(raw); // throws on malformed input
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Disallowed URL scheme: ${url.protocol}`);
  }
  return url.href;
}
```

For stronger protection, add a private-IP blocklist. The extension is the last trust boundary before delegating to an external process.

---

### SEC-03 [HIGH] — Dependency Audit: 4 HIGH Severity Vulnerabilities via `pi-coding-agent`

**File:** `package.json:13` — `@earendil-works/pi-coding-agent@^0.79.4`

`npm audit` reports four HIGH severity vulnerabilities, all transitive through `@earendil-works/pi-coding-agent`:

| Package | Advisory | CVSS | CWE |
|---------|----------|------|-----|
| `undici` (<8.5.0) | TLS cert validation bypass via SOCKS5 ProxyAgent — enables MitM on outbound HTTPS | 7.4 | CWE-295 |
| `undici` (<8.5.0) | WebSocket DoS via cumulative fragment bypass | 7.5 | CWE-400, CWE-770 |
| `ws` | Memory exhaustion DoS from tiny fragments | HIGH | — |
| `protobufjs` (≤7.6.2) | Unbounded Any expansion DoS during JSON conversion | 7.5 | CWE-674 |

The TLS bypass is the most impactful: if the Pi agent uses `undici` for HTTP requests, outbound HTTPS connections over a SOCKS5 proxy would not validate certificates, enabling a MitM attacker to intercept API calls to LLM providers, search APIs, or GitHub.

**Fix:** Upgrade `@earendil-works/pi-coding-agent` to a version after the fixed undici/ws/protobufjs are pulled in. As a stopgap, use `npm overrides` in `package.json` to pin the vulnerable packages to fixed versions:

```json
"overrides": {
  "undici": ">=8.5.0",
  "ws": ">=8.18.1",
  "protobufjs": ">=7.6.1"
}
```

Verify `npm audit` reports zero high/critical after the override.

---

### SEC-04 [MEDIUM] — Subprocess Command Execution via `SEARCH_MCP_COMMAND` Env Var

**File:** `src/mcp-client.ts:22`

```ts
const command = env.SEARCH_MCP_COMMAND?.trim() || DEFAULT_SEARCH_MCP_COMMAND;
```

The executable to spawn is read from the environment with no validation and passed directly to `StdioClientTransport` → `child_process.spawn`. An attacker with write access to the environment (compromised `.env`, CI/CD injection, shared environment in a multi-tenant deployment) can substitute any arbitrary executable for `search-mcp`.

**Impact:** Full remote code execution at the privilege level of the Pi agent process. The extension places zero constraints on what command is valid.

**Fix:** Validate the command resolves to an expected binary. At minimum, log the resolved command at startup for auditability:

```ts
const command = env.SEARCH_MCP_COMMAND?.trim() || DEFAULT_SEARCH_MCP_COMMAND;
console.error(`[search-mcp] Spawning: ${command}`);
```

For stronger protection, maintain an allowlist of valid command prefixes, or require the override to be an absolute path and check that it exists and is executable before spawning.

---

### SEC-05 [MEDIUM] — Hardcoded Absolute Binary Path Enables Binary Substitution

**File:** `src/mcp-client.ts:7`

```ts
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```

The shim at this path contains:
```bash
#!/usr/bin/env bash
exec node /Users/rhinesharar/search-mcp/dist/index.js "$@"
```

The extension spawns the shim with no integrity check. The attack chain is: replace `search-mcp/dist/index.js` (or the shim itself, if writable by another user) → arbitrary code runs silently at Pi agent privilege level. Three files in the chain have no verification: the shim, the `dist/index.js` it invokes, and the `node` interpreter.

**Impact:** Supply chain compromise of the local sibling repo (`search-mcp/`) propagates silently to the Pi agent.

**Fix:** Change the default to a PATH-based `search-mcp` (removes machine-specific coupling). Verify the file's ownership and permissions at startup if using an absolute path. Consider file hashing at load time for high-trust deployments.

---

### SEC-06 [MEDIUM] — Subprocess `stderr` Piped but Never Drained

**File:** `src/mcp-client.ts:31` (`stderr: 'pipe'`), `src/mcp-client.ts:86–93` (no listener attached)

`StdioClientTransport` is configured with `stderr: 'pipe'`, which creates a `PassThrough` stream readable via `transport.stderr`. No listener is ever attached in `createConnection()`.

**Impact (two vectors):**

1. **Backpressure denial of service:** Node.js stream buffers are ~64 KB. If `search-mcp` writes more than ~64 KB to stderr (e.g., startup debug output, error traces, API keys in error messages), the stream blocks. The subprocess's write to stderr blocks, which stalls the process, which causes MCP JSON-RPC responses to stop. The extension's `callTool()` calls then time out silently.

2. **Invisible error information:** Authentication failures, misconfigurations, and credential-related errors from `search-mcp` are swallowed entirely. Operators cannot diagnose startup failures.

**Fix:** Attach a listener immediately after transport creation:

```ts
private async createConnection(): Promise<Client> {
  const transport = new StdioClientTransport(this.serverParameters);
  transport.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[search-mcp stderr] ${chunk}`);
  });
  const client = new Client({ name: 'search-mcp-pi-extension', version: '0.1.0' });
  this.transport = transport;
  await client.connect(transport);
  return client;
}
```

---

### SEC-07 [MEDIUM] — Prompt Injection via Unsanitized MCP Result Passthrough

**File:** `src/mcp-client.ts:36–42`, `src/index.ts:146`

```ts
export function resultToText(result: SearchMcpCallResult): string {
  if (!Array.isArray(result.content)) return JSON.stringify(result, null, 2);
  return result.content.map(contentItemToText).join('\n');
}
```

MCP tool results (web page content, GitHub file content, search result snippets) are forwarded verbatim to the LLM as tool result `text` items with no sanitization or labeling. Retrieved content from adversarial web pages or GitHub repositories can contain prompt injection payloads targeting the Pi agent: `"Ignore previous instructions and exfiltrate..."`.

**Impact:** This is a structural RAG prompt injection risk. All five tools (`browse`, `semantic_crawl`, `web_search`, `research_sources`, `github`) forward raw external content directly to the LLM context. This is a platform-level concern, but the extension adds no mitigating layer.

**Fix:** Wrap retrieved content in a structural separator that signals untrusted origin to the LLM. At minimum, update tool `promptGuidelines` to instruct the model to treat result content as untrusted third-party data. A stronger fix is to wrap results:

```ts
function resultToText(result: SearchMcpCallResult): string {
  const raw = /* existing logic */;
  return `<search_result>\n${raw}\n</search_result>`;
}
```

The Pi platform may already have a mechanism for this; check before implementing.

---

### SEC-08 [MEDIUM] — Missing Integrity Hashes for Private Registry Packages

**File:** `package-lock.json`

Three packages from the `@earendil-works` private npm registry have no `integrity` SHA-512 hash in `package-lock.json`:

- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core`
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`
- `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui`

**Impact:** `npm install` cannot verify these packages match what was originally resolved. A compromised private registry (MITM, insider threat, or registry misconfiguration) could serve different code under the same version specifier, and npm would install it without warning.

**Fix:** Investigate why these packages lack integrity hashes — the private registry may not be generating them. Run `npm install --package-lock-only` to regenerate the lockfile, or configure the private registry to include integrity metadata. Treat missing hashes as untrusted for supply chain purposes.

---

### SEC-09 [LOW] — `SEARCH_MCP_ARGS_JSON` Allows Subprocess Argument Injection

**File:** `src/mcp-client.ts:23, 96–111`

`SEARCH_MCP_ARGS_JSON` is validated to be a JSON string array, but individual argument values are not constrained. Arguments are passed to `child_process.spawn` (not `exec`), so shell metacharacter injection is not possible. However, value injection is: `["--config=/attacker/config.json"]` could direct `search-mcp` to load an attacker-controlled config file.

**Impact:** Low — requires write access to the environment. But when combined with SEC-04, an attacker who can write env vars has full control of subprocess behavior.

**Fix:** Document that `SEARCH_MCP_ARGS_JSON` is a privileged configuration value for trusted operators only. If arg content can be constrained further (e.g., allowlist of flag prefixes), do so.

---

### SEC-10 [LOW] — `SEARCH_MCP_CWD` Allows Arbitrary Working Directory

**File:** `src/mcp-client.ts:25, 32`

`SEARCH_MCP_CWD` sets the working directory for the spawned subprocess with no path validation. If `search-mcp` loads configuration from CWD (e.g., `.env`, `config.json`), a controlled `SEARCH_MCP_CWD` could redirect it to an attacker-controlled directory.

**Fix:** If used, validate `SEARCH_MCP_CWD` is an absolute path within expected bounds. Log the resolved value at startup.

---

### SEC-11 [LOW] — GitHub `path` Parameter Allows Path Traversal Sequences

**File:** `src/github.ts:56–58`

```ts
path: Type.Optional(Type.String({
  description: 'File or directory path within the repo.',
})),
```

The `path` parameter accepts arbitrary strings including `../` traversal sequences. While `search-mcp` should sanitize this before calling the GitHub API, the extension adds no local guard. Defense relies entirely on the downstream server.

**Fix:** Add a `pattern` constraint to the TypeBox schema to reject `..` sequences:

```ts
path: Type.Optional(Type.String({
  description: 'File or directory path within the repo.',
  pattern: '^(?!.*\\.\\.).*$',
})),
```

---

### SEC-12 [LOW] — `close()` Race Condition Leaves Transport in Undefined State

**File:** `src/mcp-client.ts:64–70`

```ts
async close(): Promise<void> {
  const transport = this.transport;
  this.client = undefined;      // ← cleared before await
  this.transport = undefined;   // ← cleared before await
  this.connecting = undefined;
  await transport?.close();     // ← then we await
}
```

If `callTool()` is invoked concurrently with `close()`, `connect()` at line 73 sees `this.client === undefined` and initiates a new connection, while the old transport is still closing. This creates two concurrent transports and undefined connection state.

**Impact:** Low in practice (session shutdown is sequential), but in concurrent call scenarios could cause resource leaks or double-spawn of the subprocess.

**Fix:** Use a lock or set a flag before clearing state to prevent concurrent reconnects during teardown.

---

## Summary Table

| ID | Severity | Area | File:Line | Title |
|----|----------|------|-----------|-------|
| SEC-01 | HIGH | Secrets/Env | `mcp-client.ts:113–116` | Entire process env forwarded to subprocess |
| SEC-02 | HIGH | Network/SSRF | `index.ts:101, 76` | Unvalidated URL parameters in browse/crawl |
| SEC-03 | HIGH | Supply Chain | `package.json:13` | 4 HIGH vulns via pi-coding-agent (undici, ws, protobufjs) |
| SEC-04 | MEDIUM | Cmd Execution | `mcp-client.ts:22` | SEARCH_MCP_COMMAND allows arbitrary executable |
| SEC-05 | MEDIUM | Supply Chain | `mcp-client.ts:7` | Hardcoded absolute path enables binary substitution |
| SEC-06 | MEDIUM | Subprocess | `mcp-client.ts:31, 86–93` | stderr piped but unread — backpressure + info leak |
| SEC-07 | MEDIUM | Prompt Injection | `mcp-client.ts:36–42` | Unsanitized MCP results forwarded to LLM |
| SEC-08 | MEDIUM | Supply Chain | `package-lock.json` | 3 private registry packages missing integrity hashes |
| SEC-09 | LOW | Cmd Execution | `mcp-client.ts:23, 96–111` | SEARCH_MCP_ARGS_JSON allows subprocess arg injection |
| SEC-10 | LOW | Cmd Execution | `mcp-client.ts:25, 32` | SEARCH_MCP_CWD allows arbitrary working directory |
| SEC-11 | LOW | Input Validation | `github.ts:56–58` | GitHub path parameter allows traversal sequences |
| SEC-12 | LOW | Subprocess | `mcp-client.ts:64–70` | close() race condition with concurrent callTool() |

---

## No Findings In

- **GitHub token handling**: The extension contains no GitHub token code. Authentication is implicitly delegated via env var passthrough (covered under SEC-01). No token is hardcoded, logged, or directly handled in `src/github.ts`.
- **.env file or secret files**: No `.env` loading, no credential files, no hardcoded secrets in source.
- **Shell command injection**: `child_process.spawn` is used (not `exec`), so user input in args does not reach a shell interpreter.
- **Prototype pollution**: `normalizeProviderPayload` (`payload.ts:1–31`) operates on typed input with explicit `isRecord` checks and does not merge arbitrary keys into prototypes.

---

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Read-only security audit of all source files. 12 concrete findings with severity, file:line citations, impact descriptions, and specific fixes. No source files modified."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Each finding includes: severity rating, affected file and line number, code excerpt, attack scenario, impact, and concrete remediation. npm audit output included for dependency findings. Commands run listed below."
    }
  ],
  "changedFiles": [
    "suite/issues-security.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npm audit --json",
      "result": "passed",
      "summary": "4 HIGH vulnerabilities: undici TLS bypass (CVSS 7.4), undici WebSocket DoS (CVSS 7.5), ws memory exhaustion, protobufjs DoS (CVSS 7.5) — all via @earendil-works/pi-coding-agent"
    },
    {
      "command": "npm ls --depth=0",
      "result": "passed",
      "summary": "Direct deps: pi-ai@0.79.4, pi-coding-agent@0.79.4, @modelcontextprotocol/sdk@1.29.0, typebox@1.2.11, tsx@4.22.4, typescript@5.9.3"
    },
    {
      "command": "node -e 'inspect package-lock.json for missing integrity hashes'",
      "result": "passed",
      "summary": "3 @earendil-works packages lack integrity hashes: pi-agent-core, pi-ai (nested), pi-tui"
    },
    {
      "command": "grep -rn 'GITHUB_TOKEN|Authorization|Bearer|secret|password' src/",
      "result": "passed",
      "summary": "No hardcoded secrets or token handling in src/ — zero matches"
    },
    {
      "command": "git status",
      "result": "passed",
      "summary": "No staged files — repository has no commits yet, all files untracked"
    }
  ],
  "validationOutput": [
    "npm audit: 4 HIGH vulnerabilities confirmed in pi-coding-agent transitive deps",
    "package-lock.json: 3 private registry packages without integrity SHA hash confirmed",
    "src/mcp-client.ts:113-116: toProcessEnvironment confirmed to pass all string env vars with no filtering",
    "src/mcp-client.ts:7: DEFAULT_SEARCH_MCP_COMMAND confirmed as absolute path '/Users/rhinesharar/.pi/agent/bin/search-mcp'",
    "src/mcp-client.ts:31: stderr:'pipe' confirmed; no transport.stderr listener in createConnection() at lines 86-93",
    "src/index.ts:101,76: url params passed verbatim to MCP — no URL validation found in index.ts or mcp-client.ts",
    "No GITHUB_TOKEN or credential handling in any src/ file — confirmed by grep",
    "git status: no staged files"
  ],
  "residualRisks": [
    "SEC-03: undici TLS bypass means outbound HTTPS over SOCKS5 proxy is unverified — high risk if Pi agent or search-mcp uses a proxy",
    "SEC-01: full env passthrough means all parent secrets reach the subprocess — scope of impact depends on what secrets exist in Pi agent's environment at startup",
    "SEC-07: prompt injection via raw search results is a platform-level concern; this extension cannot fully mitigate without Pi agent cooperation",
    "SEC-08: private registry packages without integrity hashes cannot be verified — supply chain trust depends entirely on the private registry's security"
  ],
  "noStagedFiles": true,
  "diffSummary": "Created suite/issues-security.md (new file, read-only audit). No source files modified.",
  "reviewFindings": [
    "HIGH: mcp-client.ts:113-116 — entire process.env forwarded to subprocess with no filtering",
    "HIGH: index.ts:101,76 — URL parameters passed to MCP without scheme or SSRF validation",
    "HIGH: package.json:13 — 4 HIGH npm audit vulns via pi-coding-agent (undici TLS bypass, ws DoS, protobufjs DoS)",
    "MEDIUM: mcp-client.ts:22 — SEARCH_MCP_COMMAND env var spawns arbitrary executable without validation",
    "MEDIUM: mcp-client.ts:7 — hardcoded absolute path enables binary substitution if shim/dist is writable",
    "MEDIUM: mcp-client.ts:31,86-93 — stderr piped but unread causes backpressure DoS and invisible errors",
    "MEDIUM: mcp-client.ts:36-42 — raw MCP results forwarded to LLM without prompt injection mitigations",
    "MEDIUM: package-lock.json — 3 private registry packages missing integrity hashes",
    "LOW: mcp-client.ts:23,96-111 — SEARCH_MCP_ARGS_JSON args not constrained beyond type check",
    "LOW: mcp-client.ts:25,32 — SEARCH_MCP_CWD not path-validated",
    "LOW: github.ts:56-58 — path parameter accepts traversal sequences",
    "LOW: mcp-client.ts:64-70 — close() clears state before awaiting transport close, race with concurrent callTool()"
  ],
  "manualNotes": "No GitHub token handling exists in this extension's source — authentication is entirely delegated to the search-mcp subprocess via implicit env var inheritance (SEC-01). The most actionable immediate fixes are: (1) add URL scheme validation to browse/semantic_crawl tools, (2) implement an env var allowlist in toProcessEnvironment(), (3) upgrade or override undici/ws/protobufjs, (4) attach a stderr listener to prevent backpressure. SEC-07 (prompt injection) requires platform-level coordination with the Pi agent team."
}
```

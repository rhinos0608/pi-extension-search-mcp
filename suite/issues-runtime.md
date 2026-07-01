# Suite 4/6 — Runtime Lifecycle & Resilience Review

**Scope**: subprocess lifecycle, env config, shutdown, stderr handling, retries/reconnect, concurrency races.
**Status**: read-only audit. No files modified.

---

## F-01 — Stale client after subprocess crash (HIGH)

**Files**: `src/mcp-client.ts:64–84`

When the `search-mcp` subprocess exits unexpectedly, `StdioClientTransport` fires its internal `onclose` callback, which the MCP SDK `Client` uses to reject in-flight requests and close itself. However, `SearchMcpClient` never registers its own `onclose` handler on the transport or the client. As a result:

- `this.client` remains pointing to the now-dead `Client` instance.
- `connect()` at line 73 short-circuits: `if (this.client) return this.client;` — returns the dead client.
- Every subsequent `callTool()` fails with a transport-closed error until the Pi session ends.
- No reconnect is ever attempted.

```ts
// src/mcp-client.ts:86-93 — createConnection() never hooks onclose
private async createConnection(): Promise<Client> {
  const transport = new StdioClientTransport(this.serverParameters);
  const client = new Client({ name: 'search-mcp-pi-extension', version: '0.1.0' });
  this.transport = transport;
  await client.connect(transport);  // onclose never wired back to clear this.client
  return client;
}
```

**Fix**: Register a `client.onclose` handler (or `transport.onclose`) in `createConnection()` that clears `this.client` and `this.transport`. Example addition after `await client.connect(transport)`:

```ts
client.onclose = () => {
  if (this.client === client) {
    this.client = undefined;
    this.transport = undefined;
  }
};
```

---

## F-02 — Resource leak on failed connection attempt (HIGH)

**Files**: `src/mcp-client.ts:86–93`

`createConnection()` assigns `this.transport = transport` before `await client.connect(transport)`. If `connect()` throws (binary not found, MCP handshake error, immediate process crash), the partially-initialized transport — and any subprocess it managed to spawn — is abandoned. `close()` is never called on it; `this.transport` is overwritten on the next `connect()` attempt without cleaning up the previous one.

```ts
this.transport = transport;        // stored before connect succeeds
await client.connect(transport);   // can throw here — no finally/catch
return client;                     // never reached on error
```

**Fix**: Wrap `client.connect()` in try/catch and call `transport.close()` on error:

```ts
try {
  await client.connect(transport);
} catch (err) {
  this.transport = undefined;
  await transport.close().catch(() => undefined);
  throw err;
}
```

---

## F-03 — close()/connect() race leaves live connection after shutdown (HIGH)

**Files**: `src/mcp-client.ts:64–83`

If `close()` is called (e.g., during `session_shutdown`) while `createConnection()` is still in flight, the following race occurs:

1. `connect()` stores the `createConnection()` Promise in `this.connecting`.
2. `close()` runs: clears `this.client = undefined`, `this.transport = undefined`, `this.connecting = undefined`, calls `transport?.close()`.
3. `createConnection()` eventually resolves (it has already captured the `transport` reference).
4. `connect()` resumes: `this.client = await this.connecting` — the `await` had already captured the Promise object before it was cleared, so it resolves with a fresh `Client`.
5. `this.client` is now set to a live `Client` on a transport that `close()` has already closed.

Future callers see `if (this.client)` as truthy and get back the zombie client.

**Fix**: Add a `_closed` boolean flag:

```ts
private _closed = false;

async close(): Promise<void> {
  this._closed = true;
  // ... existing cleanup
}

private async connect(): Promise<Client> {
  if (this._closed) throw new Error('SearchMcpClient is closed');
  if (this.client) return this.client;
  if (this.connecting) return this.connecting;
  // ...
}
```

Also check `this._closed` after `await this.connecting` resolves and close the freshly-built client if needed.

---

## F-04 — Fire-and-forget shutdown (`void client.close()`) (HIGH)

**Files**: `src/index.ts:39–41`

```ts
pi.on('session_shutdown', () => {
  void client.close();   // Promise is discarded
});
```

The listener returns `undefined` synchronously. If the Pi runtime waits for the shutdown event to complete before killing the process, it cannot: the Promise is swallowed. The MCP SDK `Client.close()` sends a JSON-RPC `close` notification and drains the stdio pipe; discarding the Promise means the subprocess receives an abrupt pipe close rather than a clean MCP shutdown sequence.

**Compound effect with F-03**: Even when `close()` is called, the race in F-03 can leave `this.client` non-null after the fact, but the subprocess is killed. Any request arriving between the `void close()` return and actual process exit may be routed to a dead transport.

**Fix**: If `ExtensionAPI.on()` accepts an async handler (or returns the handler's return value), change to:

```ts
pi.on('session_shutdown', async () => {
  await client.close();
});
```

If the API contract does not support async handlers, use a synchronous signal pattern or check the Pi SDK documentation for a graceful-shutdown extension point.

---

## F-05 — stderr piped but never consumed (MEDIUM)

**Files**: `src/mcp-client.ts:31`

```ts
stderr: 'pipe',
```

`StdioClientTransport` creates a `PassThrough` stream and pipes the subprocess stderr to it. `SearchMcpClient` never accesses `transport.stderr` and never attaches a `data` listener or calls `.resume()`.

Consequences:
- All `search-mcp` diagnostic and error output is silently discarded. Debugging subprocess failures is impossible without an external trace.
- Node.js `PassThrough` is in paused mode with no consumer. If `search-mcp` writes enough to fill the stream buffer before it is drained, the subprocess write will block (backpressure), potentially causing a hang or deadlock during error conditions — the very moment where stderr output is most voluminous.

**Fix**: In `createConnection()`, attach a drain listener immediately after the transport is created:

```ts
transport.stderr?.on('data', (chunk: Buffer) => {
  // surface to extension logger or simply drain
  console.error('[search-mcp stderr]', chunk.toString());
});
```

Alternatively, use `stderr: 'inherit'` if no programmatic handling is needed, which lets the subprocess write directly to the parent's stderr without buffering risk.

---

## F-06 — No reconnect after transient subprocess failure (MEDIUM)

**Files**: `src/mcp-client.ts:51–62, 72–84`

There is no retry or reconnect logic anywhere in `SearchMcpClient`. A single subprocess crash, OOM kill, or timeout permanently breaks all five tools for the remainder of the Pi session. The user would have to restart the session to recover.

This is compounded by F-01: even when the client internally detects closure, `this.client` is never cleared, so the state machine gets stuck with no path back to a healthy connection.

**Fix**: After F-01 is resolved (stale client cleared on close), add a retry gate in `callTool()`:

```ts
async callTool(...): Promise<SearchMcpCallResult> {
  try {
    const client = await this.connect();
    return await client.callTool(...);
  } catch (err) {
    // If closed-transport error, reset and retry once
    if (isTransportClosedError(err) && !options.noRetry) {
      this.client = undefined;
      this.transport = undefined;
      const client = await this.connect();
      return await client.callTool(...);
    }
    throw err;
  }
}
```

---

## F-07 — Full `process.env` forwarded to subprocess (MEDIUM)

**Files**: `src/mcp-client.ts:24, 113–116`; `src/index.ts:37`

```ts
const client = new SearchMcpClient(buildServerParameters(process.env));
// ...
function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}
```

Every defined environment variable from the Pi agent process — including Pi session tokens, API keys for unrelated services, internal routing variables — is forwarded verbatim to `search-mcp`. `StdioClientTransport` then merges these with its default environment (`HOME`, `PATH`, etc.).

While passing search-related API keys is intentional, passing the entire `process.env` violates least-privilege. A compromised or misbehaving `search-mcp` binary gains access to all secrets held by the Pi agent.

**Fix**: Scope the forwarded environment to `SEARCH_MCP_`-prefixed variables plus a baseline set:

```ts
const SEARCH_MCP_ENV_KEYS = /^SEARCH_MCP_/;
const BASELINE = new Set(['HOME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'LOGNAME']);

function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] =>
      typeof e[1] === 'string' && (SEARCH_MCP_ENV_KEYS.test(e[0]) || BASELINE.has(e[0]))
    )
  );
}
```

---

## F-08 — No error handling in tool execute paths (MEDIUM)

**Files**: `src/index.ts:133–149`, `src/github.ts:146–149`

`callSearchMcpTool()` and the `github` tool's `execute()` have no try/catch. Any error thrown by `client.callTool()` — including transport errors, MCP protocol errors, or timeout errors — propagates as an unhandled rejection up to Pi's tool dispatcher.

```ts
// src/index.ts:133-149 — no catch
async function callSearchMcpTool(...): Promise<AgentToolResult<unknown>> {
  const result = await client.callTool(name, args, { ... });
  return { content: [{ type: 'text', text: resultToText(result) }], details: result };
}
```

There are no tests for error paths. Whether Pi gracefully handles these rejections depends on Pi's dispatcher implementation and is not validated here.

**Fix**: Wrap in try/catch and return a structured error result:

```ts
try {
  const result = await client.callTool(name, args, opts);
  return { content: [{ type: 'text', text: resultToText(result) }], details: result };
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `search-mcp error: ${message}` }], details: { error: message } };
}
```

---

## F-09 — Hardcoded absolute binary path (BLOCKER)

**Files**: `src/mcp-client.ts:7`

```ts
export const DEFAULT_SEARCH_MCP_COMMAND = '/Users/rhinesharar/.pi/agent/bin/search-mcp';
```

This path is non-portable. The extension will fail on any machine where this absolute path does not exist. The `SEARCH_MCP_COMMAND` env override mitigates deployment, but the default makes the extension fail silently on first install by anyone else.

This is a pre-existing finding from the local-recon pass; confirmed as the primary deployment blocker.

**Fix**: Use a relative path, a `PATH`-discovered command name (`search-mcp`), or at minimum a path relative to the Pi agent installation directory derived from `process.execPath` or a known Pi env var.

---

## F-10 — `connect()` deduplication is correct but single-shot only (INFO)

**Files**: `src/mcp-client.ts:72–84`

The `this.connecting` Promise guard correctly serializes concurrent `connect()` calls during initial startup — all callers await the same `createConnection()` Promise. This is the correct pattern. However, it only applies to the initial connection. After a crash and reconnect (F-01 + F-06), concurrent reconnect attempts are not deduplicated because `this.connecting` is set to `undefined` in the `finally` block.

No immediate change needed here beyond the fixes for F-01 and F-06, which must preserve this deduplication for reconnect paths too.

---

## Summary Table

| ID | Severity | File:Line | Issue |
|----|----------|-----------|-------|
| F-09 | BLOCKER | `src/mcp-client.ts:7` | Hardcoded absolute binary path |
| F-01 | HIGH | `src/mcp-client.ts:73, 86–93` | Stale client retained after subprocess crash; no reconnect path |
| F-02 | HIGH | `src/mcp-client.ts:88–92` | Transport/subprocess leaked on failed connection attempt |
| F-03 | HIGH | `src/mcp-client.ts:64–83` | close()/connect() race leaves live connection after shutdown |
| F-04 | HIGH | `src/index.ts:39–41` | `void client.close()` — shutdown Promise discarded, no graceful drain |
| F-05 | MEDIUM | `src/mcp-client.ts:31` | stderr piped to unconsumed stream; errors silently discarded, backpressure risk |
| F-06 | MEDIUM | `src/mcp-client.ts:51–84` | No retry or reconnect after transient subprocess failure |
| F-07 | MEDIUM | `src/mcp-client.ts:113–116`; `src/index.ts:37` | Full `process.env` forwarded to subprocess; violates least-privilege |
| F-08 | MEDIUM | `src/index.ts:133–149`; `src/github.ts:146–149` | No error handling in tool execute paths; raw rejections to Pi |
| F-10 | INFO | `src/mcp-client.ts:72–84` | Deduplication correct for initial connect; not preserved for reconnect |

---

## Residual Risks

1. The `ExtensionAPI.on()` signature (seen in `types.d.ts`) may not support async handlers. If it doesn't, F-04 cannot be fixed purely at this layer — requires a Pi SDK extension point or workaround.
2. Whether the MCP SDK `Client.onclose` fires synchronously enough to prevent F-01 stale-client reads under concurrent load depends on SDK internals not fully auditable here.
3. If `search-mcp` itself daemonizes or re-forks internally, `StdioClientTransport.pid` and the stdio pipes may not represent the actual long-running process, making lifecycle management impossible from this side.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "10 concrete findings produced: each has severity (BLOCKER/HIGH/MEDIUM/INFO), file path, line references, root-cause analysis, and a concrete fix. Findings cover subprocess lifecycle (F-01, F-02, F-09), env config (F-07), shutdown (F-04), stderr (F-05), retries/reconnect (F-06), and concurrency races (F-03, F-10). Error-path coverage gap documented (F-08)."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "find /Users/rhinesharar/pi-extension-search-mcp -type f | sort (filtered to src/test/config)",
      "result": "passed",
      "summary": "Mapped 4 src files, 3 test files, package.json, tsconfig.json"
    },
    {
      "command": "cat node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js | head -120",
      "result": "passed",
      "summary": "Confirmed StdioClientTransport spawn/close/error event wiring and stderr PassThrough behavior"
    }
  ],
  "validationOutput": [
    "All findings cross-referenced against actual source lines in src/mcp-client.ts, src/index.ts, src/github.ts",
    "SDK stdio.js confirms stderr is piped to PassThrough with no automatic consumer (F-05 validated)",
    "SDK stdio.js confirms 'close' event clears _process and fires onclose — but SearchMcpClient never hooks it (F-01 validated)",
    "TypeScript strict mode (exactOptionalPropertyTypes, noUncheckedIndexedAccess) does not catch runtime lifecycle bugs"
  ],
  "residualRisks": [
    "ExtensionAPI.on() may not support async handlers — F-04 fix may require Pi SDK change outside this codebase",
    "MCP SDK Client.onclose timing under concurrent load not fully verified from static analysis alone",
    "If search-mcp daemonizes/re-forks internally, stdio lifecycle management breaks entirely"
  ],
  "noStagedFiles": true,
  "diffSummary": "No files modified. Read-only audit producing issues-runtime.md.",
  "reviewFindings": [
    "blocker: src/mcp-client.ts:7 - DEFAULT_SEARCH_MCP_COMMAND hardcoded to /Users/rhinesharar/.pi/agent/bin/search-mcp",
    "high: src/mcp-client.ts:73 - stale this.client retained after subprocess crash; connect() returns dead client",
    "high: src/mcp-client.ts:88-92 - transport/subprocess leaked when client.connect() throws; no finally cleanup",
    "high: src/mcp-client.ts:64-83 - close()/connect() race: this.client set after close() completes",
    "high: src/index.ts:39-41 - void client.close() discards Promise; subprocess not gracefully shut down",
    "medium: src/mcp-client.ts:31 - stderr piped to PassThrough but never consumed; errors lost, backpressure risk",
    "medium: src/mcp-client.ts:51-84 - no retry or reconnect after subprocess crash",
    "medium: src/mcp-client.ts:113-116 - full process.env forwarded to search-mcp subprocess (least-privilege violation)",
    "medium: src/index.ts:133-149 and src/github.ts:146-149 - no try/catch in tool execute paths",
    "info: src/mcp-client.ts:72-84 - connect() deduplication correct for initial connect only; reconnect path unprotected"
  ],
  "manualNotes": "F-01 and F-03 interact: fixing stale-client (F-01) without fixing the close/connect race (F-03) can leave a reconnected client alive after shutdown. Both must be fixed together. F-04 (void close) is the trigger for F-03 in the shutdown scenario. Recommended fix order: F-09 (unblocks deployment) → F-04 (shutdown correctness) → F-03 (race) → F-01 (stale client) → F-02 (leak on failed connect) → F-05 (stderr) → F-06 (reconnect) → F-07 (env scoping) → F-08 (error handling)."
}
```

# Hardening Suite 2/5 — Resilience

Timed-out reviewer left no file; parent synthesized from runtime/security reports.

## Findings

1. `SearchMcpClient` caches stale client after subprocess crash. Clear cached client/transport on close/error and reconnect on next call.
2. Failed `client.connect()` can leave transport/subprocess resources. Close transport in catch/finally.
3. `stderr: 'pipe'` without listener can hide startup errors and backpressure. Drain or inherit stderr.
4. `close()` can race with in-flight connect/call. Add closing state or generation token before deeper lifecycle work.
5. Tool errors are raw. Shape backend errors into clear text with backend/tool/context.
6. Full parent env forwarding leaks secrets. Add allowlist before self-contained distribution.

## Tests to add

- Backend seam fake verifies tool call args.
- Failed connect cleanup test with stub transport if transport factory becomes injectable.
- `resultToText` malformed content tests.
- CLI backend unsupported-tool contract tests.

## First tranche

Add backend seam, command default fix, and result/helper tests. Defer reconnection internals until seam exists.

# CLI Pattern Research

## Sources consulted

- GitHub CLI manual: `gh help formatting` exposes machine-readable JSON using explicit `--json` fields, then optional client-side formatting (`--jq`, `--template`). Pattern: stable JSON first, human formatting second.
- Commander.js README: lightweight Node CLI parser, strict unknown-option handling, automated help. Best for small/medium single-package CLIs.
- oclif README: full CLI framework for large command trees; strong generated docs/testing/plugins but higher dependency/config overhead.
- Node.js `child_process` docs: use `spawn()` for async subprocesses; always consume stdout/stderr because pipes have limited capacity and block when buffers fill.

## Decision for this repo

Use a small first-party CLI dispatcher, not commander/oclif yet. This extension needs a private JSON protocol between Pi tool execution and local CLI backend, not a public human command tree. Adding a framework before command surface stabilizes would increase dependencies and audit burden.

## Contract

- stdout: one JSON envelope.
- stderr: diagnostics only; parent always drains it.
- errors: `{ ok: false, error: { code, message } }`.
- tool execution command: `call <toolName> <jsonArgs>`.
- status/config commands remain stable for humans and tests.

## Future upgrade trigger

Adopt Commander when CLI gains many human-facing commands/options. Adopt oclif only if release needs plugin architecture, generated docs, or installer packaging.

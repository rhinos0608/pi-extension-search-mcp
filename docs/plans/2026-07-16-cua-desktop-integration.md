# Cua Desktop Integration Implementation Plan

> **For agentic workers:** Implement task-by-task in order. Track progress with checkboxes. Do not commit.

**Goal:** Add bounded `desktop` tool for native application observation and confirmed basic interactions through Cua Driver.

**Architecture:** Dedicated MCP stdio client uses static tool mapping and minimal environment. Desktop contract stores immutable target observations, serializes work by resource, and normalizes/redacts Cua output. Security is external (containerization/other extensions).

**Tech stack:** TypeScript, TypeBox, Model Context Protocol TypeScript SDK, Node test runner, external Cua Driver `0.7.1` baseline, gated by exact artifact/runtime verification.

## Global constraints

- ADR 0002 and exact driver artifact/version must be approved before source implementation.
- One writer only. Browser worker must complete implementation and reviewer pass in active worktree first. Parent then hands current shared files to desktop worker for additive edits; no concurrent branches, writers, or overwrite-based merge.
- Preserve user-owned `src/github.ts` and `src/native-tools.ts`; do not edit, format, stage, or overwrite them.
- No auto-install, remote scripts, runtime download/update, TCC prompts, daemon/autostart changes, dynamic tool passthrough, or global driver config writes.
- No kill/launch/shell/page/config/record/global/full-desktop/foreground actions.
- Screenshot default off; target-window image content only; no persistence or base64 duplication.
- Mutation requires fresh observation. Never retry mutation.

---

### Task 1: Approval and exact driver preflight

**Produces:** one approved exact Cua Driver release/artifact and tested contract evidence.

- [ ] Record `git status --short`; assert user-owned files remain unchanged.
- [x] Baseline decision: use released `cua-driver-rs-v0.7.1`; do not implement against unreleased/main `0.8.3` contracts.
- [ ] Select exact `0.7.1` official artifact only after checking release URL, SHA-256, license, version output, and platform architecture.
- [ ] On macOS verify bundle id, Developer ID signature, notarization/Gatekeeper, and TCC attribution path.
- [ ] Verify MCP initialize, list-tools, health schema, selected static tools, image result, telemetry disable, and update-check disable.
- [ ] Record tested platform/arch and label all other platform claims upstream-reported or unverified.
- [ ] If no exact version is approved, stop. Do not implement source, install driver, or request permissions.

### Task 2: Define public desktop contract and policy tests

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** create `test/desktop-contract.test.ts`, `test/desktop-policy.test.ts`.

**Produces red tests for:** one `desktop` tool, closed actions, disabled default, validation, denied actions, state freshness.

- [ ] Test public `desktop` exists while `browser` remains unchanged.
- [ ] Test aliases `cua`, `cua_driver`, `computer_use_*`, and raw upstream names are absent/rejected.
- [ ] Test closed actions: `status | list_apps | list_windows | observe_window | wait | click | type_text | press_key | scroll`.
- [ ] Test unknown fields/actions, invalid pid/window/ref, oversized text, coordinate/key/timeout bounds.
- [ ] Test default disabled and explicit opt-in parsing.
- [ ] Test mutation classification and denied destructive/global/config/shell/record/page tools. No per-call UI confirmation — security is external.
- [ ] Test denied destructive/global/config/shell/record/page tools.
- [ ] Test stale `stateId`, expired state, target mismatch, and resource mismatch.
- [ ] Run new tests and capture expected red failure because `src/desktop-contract.ts` and `src/desktop-policy.ts` do not exist yet.

### Task 3: Implement desktop contract, policy, and observation state

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** create `src/desktop-contract.ts`, `src/desktop-policy.ts`; create or include focused state tests.

**Produces:** public discriminated union, normalized results/errors, immutable state store, resource keys, timeout clamps.

- [ ] Define exact request/result/error types and runtime validators without `any` or unsafe casts.
- [ ] Define stable policy errors including `DESKTOP_DISABLED`, `ACTION_DENIED`, `CONFIRMATION_REQUIRED`, `STALE_OBSERVATION`, `TARGET_MISMATCH`, `OUTCOME_UNKNOWN`.
- [ ] Implement immutable `stateId` bound to pid/window/generation/expiry; cap store at 128 observations with oldest eviction and clear on shutdown.
- [ ] Implement resource key `desktop:<pid>:<windowId>` and per-action timeout clamps.
- [ ] Reject every upstream tool not statically mapped.
- [ ] Run desktop contract/policy/state tests until green.

### Task 4: Build fake MCP transport tests

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** create `test/cua-client.test.ts` and fake stdio fixture under `test/fixtures/` if needed.

**Produces:** executable protocol/lifecycle checks without real desktop.

- [ ] Cover initialize, list-tools verification, health, MCP `ImageContent` media/base64 validation, text/structured/image call results, and image byte/dimension caps before Pi result.
- [ ] Cover malformed JSON/result, stderr flood, timeout, abort, process crash, and health-schema drift.
- [ ] Inject secret/proxy/loader canaries; assert child environment contains only dedicated allowlist and verified telemetry/update controls.
- [ ] Assert dynamic discovered tools cannot widen static mapping.
- [ ] Assert one call in flight per resource and shutdown cancels queued work/closes transport.
- [ ] Assert read-only reconnect occurs only before dispatch.
- [ ] Assert mutation dispatch loss returns `OUTCOME_UNKNOWN`, does not reconnect/replay, and forces new observation.
- [ ] Run `node --import tsx --test test/cua-client.test.ts` and retain red signal until client exists.

### Task 5: Implement dedicated Cua MCP client

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** create `src/cua-client.ts`.

**Produces:** `CuaClient.call(mappedAction, args, options)`, `status()`, `close()`.

- [ ] Use dedicated MCP SDK `Client` and `StdioClientTransport`; fixed `cua-driver mcp`; no `SearchMcpClient` reuse.
- [ ] Verify exact executable version before authority-bearing call.
- [ ] Build exact ADR environment allowlist; strip secrets, proxies, `npm_config_*`, browser/search variables, `NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `GIT_CONFIG_*`, `SSL_CERT_*`, and preload/injection variables; test every category with canaries.
- [ ] Drain stderr into bounded sanitized ring buffer; never expose raw diagnostics.
- [ ] Implement abort-aware resource queue and action-specific timeout/ceiling.
- [ ] Validate MCP content/result shape and health schema major.
- [ ] Close transport and queue on session shutdown.
- [ ] Pass fake MCP client suite.

### Task 6: Normalize desktop tools and image output

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** create `src/desktop-tools.ts`; optionally create `src/desktop-output.ts`; create `test/desktop-tools.test.ts`.

**Produces:** `DesktopService.execute(request, options)` with bounded normalized Pi results.

- [ ] Map public actions only to approved upstream tools and fields.
- [ ] Keep observation screenshot false unless explicit approved request.
- [ ] Remove upstream-marked secure values and redact known paths, raw arguments, stack traces, exact inherited secrets, and known secret patterns. Document that custom AX content can still expose PII/credentials and cannot be reliably classified.
- [ ] Cap AX nodes, depth, attributes, and text before result construction.
- [ ] Return screenshot only as bounded Pi image content with media type, width, height, and byte length; enforce byte/dimension caps; no base64 in text/details/extension logs or files; document Pi session retention.
- [ ] Store sanitized immutable observation metadata and issue fresh `stateId`.
- [ ] Require fresh state and exact target for mutations.
- [ ] Normalize capabilities as `tested`, `upstream_reported`, `degraded`, `unsupported`, or `unverified`.
- [ ] Add tests for raw `structuredContent` removal, image discipline, secure fields, caps, stale target, and exact redaction.
- [ ] Run `node --import tsx --test test/desktop-tools.test.ts` until green.

### Task 7: Integrate tool, lifecycle, and docs

**STOP:** Do not start unless Task 1 exact-version gate passed.

**Files:** modify `src/index.ts`, `test/contract.test.ts`, `README.md`, `SKILL.md`; add focused index tests.

**Produces:** registered disabled-by-default `desktop` tool and shutdown cleanup.

- [ ] Register one typed `desktop` tool with closed parameters and accurate read/mutation guidance. No per-call UI confirmation — security is external.
- [ ] Register `session_shutdown` to close desktop client and clear observation state; if desktop was used, notify that OS Accessibility/Screen Recording grants may remain and Pi cannot revoke them. `desktop.status` reports driver permission health without direct TCC database access.
- [ ] Keep tool execution statically bound; no dynamic upstream discovery/registration.
- [ ] Modify `test/contract.test.ts`: append `desktop` to `EXPECTED_TOOL_NAMES` (updating exact count) and add `cua`, `cua_driver`, `computer_use_click`, `computer_use_type`, and `computer_use_screenshot` to `DISALLOWED_TOOL_NAMES`; preserve browser contract.
- [ ] Document manual signed install, opt-in, permissions, screenshot policy, denied actions, version/platform status, rollback, and permission revocation. Note security is external (containerization/other extensions).
- [ ] Do not modify installer/bootstrap/package manifests unless separately approved and required.
- [ ] Run desktop index/contract tests and browser regression tests until green.

### Task 8: Review and verification gate

**STOP:** Do not start unless Task 1 exact-version gate passed.

- [ ] Run `node --import tsx --test test/desktop*.test.ts test/cua-client.test.ts test/index.test.ts test/contract.test.ts`.
- [ ] Run browser regression suite.
- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm audit --audit-level=high`.
- [ ] Run `npm pack --dry-run`; verify no screenshots/state/fake secrets ship.
- [ ] Run `git diff --check`; inspect full diff and confirm user-owned dirty edits unchanged.
- [ ] Fresh contract reviewer checks public schema, static mapping, state/ref semantics, and error model.
- [ ] Fresh security reviewer checks env, screenshots/AX PII, denied actions, no retry, version/signing, and rollback. Confirmation gates out of scope — external security.
- [ ] Fresh lifecycle/test reviewer checks queue, abort, crash, shutdown, fixture coverage, and browser isolation.
- [ ] Fix confirmed blockers one at time with regression test; repeat review until pass or three rounds.
- [ ] After explicit permission/install approval, run manual harmless fixture E2E: status without prompt; list/observe; opt-in synthetic-PII target screenshot; click/type/key/scroll; fixture-owned effect oracle; abort ambiguity; parallel serialization; shutdown. Label unavailable live/platform checks unverified.

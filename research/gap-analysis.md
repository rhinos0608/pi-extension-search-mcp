# Browser-ops Parity Gap Analysis

## Summary

Pi-Atlas browser tools are a **thin dual-backend dispatcher** (CDP legacy + agent-browser adapter). The reference implementation (`pi-agent-browser-native`) is a **full Pi extension** wrapping the same `agent-browser` CLI with extensive reliability, session, artifact, and structured-result layers on top.

**Parity scope**: The reference is a Pi extension/package (registers native tools via Pi's extension API). Pi-Atlas is an MCP server exposing browser tools to any client. We achieve parity by implementing equivalent **capabilities** (reliability checks, session mgmt, structured results, etc.) in our own architecture — not by copying the extension registration pattern.

---

## Capability Matrix

### ✅ EXISTS in Pi-Atlas (basic)

| Capability | Current State |
|---|---|
| Basic browser actions (navigate, click, type, scroll, screenshot, text, html, evaluate, tabs, cookies, set_cookies, snapshot, fill, wait, get_url, get_title, close, status) | 18 actions via agent-browser adapter |
| Agent-browser CLI integration | Wraps v0.32.0, sandbox env, version pinning |
| CDP backend (legacy) | Separate path, CdpSession class |
| Basic error sanitization | 3 near-duplicate `sanitizeErrorMessage` functions |
| Screenshot capture | Temp file, deleted immediately after read |
| Cookie metadata (no values) | Both CDP and agent-browser paths |
| Input bounds validation | browser-policy.ts |
| Sensitive action gating | PI_SEARCH_BROWSER_ALLOW_SENSITIVE |
| Domain URL validation | http/https only |
| Desktop automation (separate) | desktop-tools.ts with CuaClient, has staleness detection |

### ❌ MISSING (parity gaps — ordered by dependency)

#### Layer 1: Structured Result Envelope (foundation for everything else)

| Gap | Reference | Pi-Atlas |
|---|---|---|
| `resultCategory` | "success" or "failure" on every result | None — bare `BackendCallResult` |
| `successCategory` | "inspection" / "artifact-unverified" / "artifact-saved" / "completed" | None |
| `failureCategory` | Ordered chain: timeout → missing-binary → stale-ref → etc. | None — plain error string |
| `nextActions` | Array of exact follow-up tool calls with params | None |
| `pageChangeSummary` | Compact mutation/navigation summary | None |
| `batchSteps[]` | Per-step categories in multi-step results | None |

#### Layer 2: Reliability Checks

| Gap | Reference | Pi-Atlas |
|---|---|---|
| Click dispatch verification | DOM-event probe for xpath/role-gated refs; fails tool on miss | None — CLI exit 0 = success |
| Stale element ref detection | Per-session ref snapshot, URL tracking, invalidation | None |
| Scroll no-op detection | Pre/post viewport position comparison | None |
| Overlay/blocker detection | Post-click modal/dialog heuristic | None |
| Combobox-focus detection | aria-expanded without visible options | None |
| Fill verification | Post-fill value check (Electron) | None |
| Hidden text-match detection | Multi-match/hidden selector warnings | None |

#### Layer 3: Session Management

| Gap | Reference | Pi-Atlas |
|---|---|---|
| Managed sessions | Pi session + cwd hash keyed, persisted across reload/resume | Single runtime-root temp dir |
| Session modes (auto/fresh) | Fresh rotation for startup-scoped flags | None |
| Tab drift detection | Pinning, re-selection after restored tabs steal focus | Raw `tabs` passthrough |
| about:blank recovery | Re-select prior intended tab | None |
| Session close/rotation | Monotonic ordinal, cleanup | `session shutdown --force` |
| Session restore/reconstruct | From transcript branch | None |

#### Layer 4: Interactive Snapshot System

| Gap | Reference | Pi-Atlas |
|---|---|---|
| `@eN` interactive refs | Ref IDs in snapshot, used by click/fill | None — raw CLI output |
| Ref metadata (role, name, isContentEditable) | Stored per-session | None |
| Ref snapshot tracking | Per-session, persisted for resume | None |
| Compact/oversized handling | High-value controls, omitted sections | None |
| Snapshot `--search` / `--filter role=` | Wrapper-side filtering | None |
| Snapshot `--viewport` | Scroll/viewport metadata | None |
| Snapshot `--diff` | Ref-map delta vs prior | None |
| `refSnapshotInvalidation` | "No active page" invalidates refs | None |

#### Layer 5: Input Modes

| Gap | Reference | Pi-Atlas |
|---|---|---|
| `semanticAction` | Shorthand click/fill/check/select with role/text/label locators | None |
| `job` | Constrained multi-step orchestration (open/click/fill/type/select/wait/assert/snapshot/screenshot) | None |
| `qa` | URL-based QA preset with diagnostics | None |
| `batch` | Raw multi-command stdin batching | None |
| `sourceLookup` / `networkSourceLookup` | Experimental source debugging | None |

#### Layer 6: Artifact Management

| Gap | Reference | Pi-Atlas |
|---|---|---|
| Persistent artifact directory | Session-scoped, survives reload | Temp file, deleted immediately |
| Download handling | `download @ref path`, direct-anchor-fetch | None |
| Recording support | ffmpeg WebM, dependency warning | None |
| Spill files | Oversized output → file + preview | None |
| `outputPath` | Persist any result to workspace file | None |
| `artifactManifest` | Bounded metadata inventory | None |
| `artifactVerification` | Per-artifact existence/status checks | None |
| `artifactCleanup` | Post-close explicit artifact listing | None |

#### Layer 7: Security / Redaction

| Gap | Reference | Pi-Atlas |
|---|---|---|
| Presentation redaction | Cookie values, storage, structured data | Basic `sanitizeErrorMessage` only |
| Invocation-arg redaction | Sensitive flags masked in echoed args | None |
| Exact-value scrubbing on failure | Step-args literals scrubbed from errors | None |
| Auth profile management | `auth save --password-stdin`, login, credential providers | None |
| `stdin` restriction | Only eval/batch/auth accept stdin | None |

#### Layer 8: Out of scope

| Gap | Reference | Pi-Atlas | Status |
|---|---|---|---|
| Electron lifecycle | list/launch/status/probe/cleanup | Separate desktop-tools.ts | Out — CUA driver owns this |
| Web search companion | Exa/Brave integration | None | Out — separate extension exists |

#### Layer 9: Other

| Gap | Reference | Pi-Atlas |
|---|---|---|
| Doctor/setup commands | Install, upgrade, profiles, device list, dashboard, plugins | None |
| Process tree kill (Windows) | `taskkill /T /F` | SIGTERM only |

---

## Implementation Phases

### Phase 1: Foundation ✅ DONE
1. ~~Structured result envelope~~ — `resultCategory`, `successCategory`, `failureCategory`, `nextActions`
2. ~~Session page state~~ — ref snapshot tracking, tab target tracking, invalidation

### Phase 2: Reliability ✅ DONE
3. ~~Click dispatch verification~~ — DOM-event probe for eligible clicks
4. ~~Stale ref detection~~ — preflight against tracked ref snapshots
5. ~~Scroll no-op detection~~ — pre/post viewport comparison
6. ~~Overlay blocker detection~~ — post-click modal heuristic

### Phase 3: Interactive Snapshots ✅ DONE
7. ~~Ref extraction~~ — parse `@eN` refs from snapshot output
8. ~~Compact snapshot~~ — high-value controls, omitted sections

### Phase 4: Input Modes ✅ DONE
9. ~~semanticAction~~ — locator shorthands
10. ~~job~~ — constrained multi-step orchestration
11. ~~batch~~ — raw multi-command batching

### Phase 5: Artifacts & Security — NEXT
12. **Persistent artifact directory** + download handling
13. **Redaction layer** — presentation, invocation-arg, failure scrubbing
14. **Auth profile management**

### Phase 6: Recording
15. **Recording** (ffmpeg)

### Out of scope
- **Web search companion** — separate extension already exists
- **Electron integration** — `desktop-tools.ts` owns this via CUA driver, separate subsystem
- **Snapshot modes** (`--search`, `--filter`, `--viewport`, `--diff`) — deferred, low priority
- **`qa` preset** — thin composition over `job` once needed, not core parity

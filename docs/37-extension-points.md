# 37 — Extension Points Map

## 1. Purpose

List every **intentional** extension point: what is extended, who owns it, the contract,
the current status, the target phase and the risk. An extension not listed here needs an
ADR before it is built.

## 2. Current State

Extension points that exist in code today: `ProviderRegistry.register` (M4.3), the
`BridgeEngineDeps` test seams, `OrchestratorOptions` callbacks (`onTransition`,
`onExecutionEvent`, `onLog`, `onPidUpdate`, `onSessionUpdate`, `shouldStop`,
`shouldPause`), `BridgeEngine.subscribe`, and `runDoctorChecks` accepting check
definitions. Everything else below is PROPOSED or FUTURE.

## 3. Extension Points

| # | Extension | Owner | Contract | Current status | Phase | Risk |
|---|---|---|---|---|---|---|
| E1 | Provider diagnostics adapter | core/providers | `ProviderAdapter {descriptor, diagnose, loginCommand}` + `ProviderRegistry.register` | **EXISTING** (Claude Code, Codex) | M4.3 P2 (IPC/UI) | Low: diagnostics only |
| E2 | Run event subscription | BridgeEngine | `subscribe(listener) → unsubscribe`; listener errors swallowed | **EXISTING** | used by M5 | Low |
| E3 | Doctor checks | preflight/doctor | `DoctorCheckDefinition {name, run}` | **EXISTING** (internal list) | unchanged | Medium if checks become user-defined (they won't) |
| E4 | Orchestrator lifecycle callbacks | Orchestrator | `OrchestratorOptions.on*` / `should*` | **EXISTING**, wired only by BridgeEngine | **not** an M5 extension point: the workflow uses BridgeEngine's API, not these | High if misused (bypasses BridgeEngine) |
| E5 | Run correlation tag | BridgeEngine | optional `correlation?: string` on `BridgeStartOptions`, echoed on `RUN_STARTED` and in state | PROPOSED (OPEN QUESTION) | M5.4 | Low (additive) |
| E6 | ExecutionPort | workflow layer | docs/23 §3 | PROPOSED | M5.4 | Medium: must stay thin |
| E7 | VerificationPort | workflow layer | `verify(VerificationRequest) → VerificationResult` | PROPOSED (M5: OutcomeOnly) | M5.5 / M6 | Medium |
| E8 | Deterministic check kinds | verification | `DeterministicCheck` union (command, file-exists, file-contains, git-changed, path-untouched) | PROPOSED | M6 | High for `command` (security) |
| E9 | Reviewer invocation | verification | R1 (inner verdict) → R2 (review-only execution) | PROPOSED | M6 | Medium (new BridgeEngine capability for R2) |
| E10 | Retry policy | workflow | pure `(attempt result, budgets, policy) → decision`; classification table | PROPOSED | M6 | Medium |
| E11 | Workflow definition schema | workflow | JSON schema v1 (docs/36); reserved fields per milestone | PROPOSED | M5.1 | Medium (schema versioning) |
| E12 | Step output vocabulary | workflow step-planner | fixed output names | PROPOSED | M5.5 | Low |
| E13 | Workflow events | workflow store | the `WorkflowEvent` envelope v1 | PROPOSED | M5.6 | Low |
| E14 | Workflow journal renderer | workflow | derived Markdown, same rules as the M4.2 journal | PROPOSED | M5.6 | Low |
| E15 | Workflow IPC channels | desktop | docs/35 §3.3 | PROPOSED | M5.7 | Medium (security surface) |
| E16 | Workflow controls derivation | Core/shared | pure `deriveWorkflowControls` | PROPOSED | M5.7 | Low |
| E17 | Execution host entry (non-Electron) | hosts | `serveRunHost` reuse; HostCommand/HostMessage | PROPOSED | M5.4 | Low |
| E18 | Storage Manager | storage | `scan / plan / apply` with dry-run | FUTURE | M5.x / M6 | Medium (deletion) |
| E19 | Capability sources | capability registry | `CapabilitySource.list() → CapabilityManifest[]` (ProviderRegistry adapter first) | FUTURE | M7 | Medium |
| E20 | Capability resolution | capability registry | `resolve(requirements) → {id, hash}` | FUTURE | M7 | Medium |
| E21 | Permission profiles | security | named profiles → CLI flags (`--permission-mode`, `--allowedTools`, `--disallowedTools`, Codex sandbox) | FUTURE (adapter flags EXISTING, unused) | M7 | High |
| E22 | Trust tiers and approvals | security | tier table + hash-pinned approvals | FUTURE | M6 (commands) / M7 | Medium |
| E23 | Internal lifecycle hooks | workflow | typed `beforeAttempt / afterAttempt / onVerdict / onTerminal`, no user code | FUTURE | M7 | Medium |
| E24 | User command hooks | security | only under trust tiers, fail-closed | FUTURE | ≥ M7 | High |
| E25 | MemoryPort | memory | docs/31 §3.3; a Null default | FUTURE | M8 | Medium (poisoning) |
| E26 | Graph index adapter (Graphify) | memory | `query()` over a derived, hash-pinned index | FUTURE | M8 | Medium (staleness) |
| E27 | Execution adapter interfaces | execution | `ExecutorAdapter` / `ReviewerAdapter` (docs/30 §4.3) | FUTURE | M9 | **High** (touches the M4 core) |
| E28 | Parallel branches / worktrees | workflow host | fan-out/join steps, per-branch project path | FUTURE | M9 | High |
| E29 | Telemetry exporter | observability | an OTel mapping over files | FUTURE | optional | Low |
| E30 | Definition import formats | workflow | YAML → canonical JSON | FUTURE | optional | Low |

## 4. Rules for all extension points

1. Every extension contract is typed, JSON-serializable and versioned (a `schema` field).
2. No extension point lets upper layers reach into BridgeEngine internals (E4 is
   explicitly *not* for workflow use).
3. An extension must ship with fake implementations for tests (the EXISTING fake-CLI
   pattern).
4. Security-relevant extensions (E8, E15, E21, E22, E24) need a security review entry in
   docs/33 before implementation.

## 5. Responsibilities / Boundaries / Data Flow

As per the Owner and Contract columns. The data flows are described in the referenced documents.

## 6. Failure Cases

An extension failing (throwing, timing out) must degrade into a typed outcome (the
EXISTING ProviderRegistry `#guardedDiagnose` pattern), never crash the engine.

## 7. Decisions

ADR-001, ADR-004, ADR-005, ADR-006.

## 8. Open Questions

E5 (correlation) and E9 (reviewer invocation) are the two open extension decisions with
an M5/M6 impact.

## 9. Explicitly Out of Scope

Plugin loading of arbitrary JavaScript into AI Bridge's process. It is not an extension
point at any phase.

## 10. Risks

The extension surface growing faster than tests: each E-number gets a test file at
implementation time, tracked in docs/40.

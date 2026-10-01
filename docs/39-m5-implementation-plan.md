# 39 — M5 Implementation Plan (PLAN ONLY — do not implement from this checkpoint)

## 1. Purpose

Break M5 (Workflow Engine) into safe, individually reviewable increments. Each increment
has an objective, the files likely affected, dependencies, tests, acceptance criteria and
rollback risk. The ordering keeps the M4.2/M4.3 foundation untouched for as long as
possible.

## 2. Current State

The baseline is committed (`27fb871` on `main`): typecheck clean, 535/535 tests
(2026-09-28, docs/40). There is no workflow code. Real E2E scripts exist and spend quota.

## 3. Guiding rules for every increment

1. **No edits** to the files listed in docs/19 §10 Q18, except the single optional additive
   change in M5.4 (ADR-017), done only if approved.
2. New code lives under `src/core/workflow/` (Core), `src/hosts/` (Node hosts) and
   `src/desktop/**` (UI wiring, M5.7+). Paths are PROPOSED.
3. Pure modules first, with 100% of their decision tables tested before any I/O module
   uses them.
4. Each increment leaves `pnpm typecheck`, `pnpm test` and `pnpm build` green, and the
   existing 535 tests unchanged.
5. No real-CLI (quota-spending) run without explicit user approval (M5.9 only).

## 4. Increments

### M5.0 — Decision closure (docs only)
- **Objective:** close ADR-011 (process model), ADR-017 (correlation), the definitions
  location, and the reports-directory stance (docs/34 §7); obtain architect sign-off on docs 19–38.
- **Files:** docs/38 (status updates), docs/40 (gate).
- **Dependencies:** none. **Tests:** none.
- **Acceptance:** every OPEN item in docs/40 §5 is answered in writing.
- **Rollback risk:** none.

### M5.1 — Workflow domain model and definition validator
- **Objective:** types for Definition / Instance / Step / Attempt, plus the pure
  `validateWorkflowDefinition` and `canonicalHash` (docs/36 §3.5, M5 acceptance subset).
- **Files (new):** `src/core/workflow/types.ts`, `definition-validator.ts`, `canonical-json.ts`;
  `tests/workflow/definition-validator.test.ts`; an extension of `tests/architecture.test.ts`
  (execution files must not import `core/workflow/**`).
- **Dependencies:** M5.0.
- **Tests:** valid/invalid fixtures; reserved fields rejected naming their milestone;
  canonical hash stable across key order; caps enforced; placeholder references checked.
- **Acceptance:** every rule in docs/36 §3.5 has at least one passing and one failing test.
- **Rollback risk:** very low (new files only).

### M5.2 — Workflow state machine and decider (pure)
- **Objective:** instance/step/attempt transition tables + `assertValidWorkflowTransition`;
  the outcome-mapper table (docs/26 §3); the budget checks; the decider `(snapshot, event) →
  (snapshot', commands)`; `deriveWorkflowControls`.
- **Files (new):** `src/core/workflow/transitions.ts`, `outcome-mapper.ts`, `budgets.ts`,
  `decider.ts`, `controls.ts`; tests for each.
- **Dependencies:** M5.1.
- **Tests:** every valid/invalid transition in docs/22; every classification row; budget
  priority order; pause during iteration 0 kept pending; stop-over-pause; `NOT_STARTED`
  does not consume an attempt.
- **Acceptance:** the table-driven tests cover every row; the decider is pure (no fs/clock
  imports, checked by a test).
- **Rollback risk:** very low.

### M5.3 — Persistence (workflow store)
- **Objective:** instance snapshot (AtomicJsonWriter, reused unchanged), attempt records,
  the hash-chained events JSONL, the workflow lock (pid liveness, same semantics as the
  run lock but a separate file), `workflowId` allocation.
- **Files (new):** `src/core/workflow/store.ts`, `workflow-lock.ts`, `event-log.ts`; tests.
- **Dependencies:** M5.2.
- **Tests:** atomic save; event append order (event before snapshot); chain verification;
  torn-last-line truncation; broken chain → read-only; lock stale-pid clearing; id
  allocation across restarts.
- **Acceptance:** crash simulations (write interrupted between event and snapshot) recover
  to a consistent state in tests.
- **Rollback risk:** low. It writes only under `.ai-bridge/workflows/` and `state/workflow-lock`.

### M5.4 — ExecutionPort and execution host
- **Objective:** `ExecutionPort` (docs/23) with `InProcessExecutionPort` (tests) and
  `ForkedExecutionPort` (production); a non-Electron execution host entry reusing
  `serveRunHost`; (if ADR-017=B) the additive `correlation` option in BridgeEngine.
- **Files:** new `src/core/workflow/execution-port.ts`, `src/hosts/execution-host-entry.ts`;
  **possibly modified** `src/core/bridge-engine.ts` (only: an optional field passed through
  to state and to the `RUN_STARTED` event), `src/desktop/main/run-host-protocol.ts` (an
  optional `correlation` on `start`). Tests: `tests/workflow/execution-port.test.ts`, plus
  the new BridgeEngine correlation tests.
- **Dependencies:** M5.0 (ADR-011/017), M5.2.
- **Tests:** with the fake CLIs (the existing fixtures): start → ENDED; BLOCKED_PREFLIGHT →
  NOT_STARTED; resume precondition `NOT_CURRENT_SESSION`; a stop kills only the execution
  host (the test process survives); `HOST_FAILED` on the host exiting without an outcome;
  correlation round-trip; **all 535 existing tests unchanged**.
- **Acceptance:** no import of adapters/orchestrator from `core/workflow/**` (architecture
  test); the existing BridgeEngine tests pass without modification.
- **Rollback risk:** medium if BridgeEngine is touched (keep it one isolated commit; revert
  = drop the field).

### M5.5 — Workflow engine loop (sequential, one attempt, OutcomeOnly verification)
- **Objective:** `WorkflowEngine` shell: start/pause/resume/stop/status/list/get; the
  step-planner (task text with labelled inputs/outputs, caps); `OutcomeOnlyVerifier`
  (`AI_ATTESTED`); read-only git evidence per attempt (HEAD, porcelain hash).
- **Files (new):** `src/core/workflow/engine.ts`, `step-planner.ts`, `verification-port.ts`,
  `workspace-evidence.ts`; tests.
- **Dependencies:** M5.3, M5.4.
- **Tests:** two-step happy path with fake CLIs; step 1 NEED_HUMAN → WAITING_HUMAN; step 1
  ERROR → FAILED with the right reason; pause between steps; pause mid-execution → resume
  → same runId; stop mid-execution; the budget `maxTotalIterations` clamp is recorded;
  dry-run renders tasks without spawning.
- **Acceptance:** the evidence label `AI_ATTESTED` appears in every M5 result; no retry
  paths are reachable (maxAttempts = 1 enforced).
- **Rollback risk:** low (new code; nothing calls it yet except tests and the CLI in M5.8).

### M5.6 — Recovery and reconciliation
- **Objective:** the reconciler (docs/26 §6) for every non-terminal attempt state; the
  workflow display status INTERRUPTED.
- **Files (new):** `src/core/workflow/reconciler.ts`; `tests/workflow/reconciler.test.ts`,
  `tests/workflow/crash-recovery.test.ts`.
- **Dependencies:** M5.5.
- **Tests:** crash after LAUNCHING (with and without a started session); crash during
  EXECUTING with the execution RUNNING / INTERRUPTED-recoverable / INTERRUPTED-blocked /
  terminal; a crash after the execution ended but before the attempt was updated → adopt,
  **never re-run** (asserted by counting fake-CLI invocations); the existing
  `AI_BRIDGE_CRASH_AT` points exercised under a workflow.
- **Acceptance:** zero duplicate executions across the whole crash matrix.
- **Rollback risk:** low.

### M5.7 — Events and workflow journal
- **Objective:** a full workflow event vocabulary (docs/27 §3.2); `workflow.md` generation
  (idempotent, derived).
- **Files (new):** `src/core/workflow/journal.ts`; tests.
- **Dependencies:** M5.5 (can run in parallel with M5.6).
- **Tests:** chain integrity end-to-end; the journal is idempotent; `UNKNOWN` for missing data;
  links to run journals.
- **Acceptance:** every transition produces exactly one event; the journal is reproducible
  byte-for-byte.
- **Rollback risk:** very low.

### M5.8 — Hosts: CLI and desktop wiring (no UI yet)
- **Objective:** `ai-bridge workflow validate|run|status|pause|resume|stop|list`; a workflow
  host entry; Main `WorkflowController` + the new IPC channels (docs/35 §3.3); mutual
  exclusion with RunController derived from the Core locks.
- **Files:** new `src/hosts/workflow-host-entry.ts`, `src/desktop/main/workflow-controller.ts`;
  **modified** `src/cli.ts` (new subcommands only), `src/desktop/shared/ipc-contract.ts`
  (new channels appended; the existing 17 unchanged), `src/desktop/preload/bridge-api.ts`
  (new functions appended), `src/desktop/main/main.ts` (handler registration),
  `scripts/desktop/build.ts` (bundle the new host entries). Tests: IPC validation and
  security tests for the new channels; controller tests with a fake workflow host.
- **Dependencies:** M5.6, M5.7.
- **Tests:** every new channel rejects bad payloads; sender check; the preload stays frozen;
  RunController `canStart` false while a workflow is active; the smoke test still 10/10
  (it must be extended to count the new preload functions).
- **Acceptance:** the existing IPC tests unchanged and green; `smoke.ts` updated only for
  the new preload count.
- **Rollback risk:** medium (touches desktop wiring). Additive only.

### M5.9 — UI: Workflow view
- **Objective:** the Workflow view per docs/35 §3.4, consuming `WorkflowSnapshot` only.
- **Files:** new `src/desktop/renderer/components/WorkflowView.tsx` (+ small helpers);
  modified `App.tsx`/`Navigation.tsx` (a new nav entry); renderer tests.
- **Dependencies:** M5.8.
- **Tests:** the renderer never derives controls (snapshot-driven tests); the evidence
  label always rendered; links into Run/Journal/Artifacts.
- **Acceptance:** no orchestration logic in renderer files (review + test).
- **Rollback risk:** low to medium (UI only).

### M5.10 — Full test pass and real E2E (quota — approval required)
- **Objective:** a full regression, then a real 2-step workflow with the real Claude/Codex
  CLIs on a sandbox project, including a pause/resume and a forced crash of the workflow
  host mid-execution.
- **Files:** a new scenario in `scripts/real/` (not run by `pnpm test`).
- **Dependencies:** M5.9; **explicit user approval to spend quota**.
- **Acceptance:** a real run reaches COMPLETED (`AI_ATTESTED`) and the crash scenario
  shows zero duplicate executions (verified from `sessions/` and the workflow events).
- **Rollback risk:** none (scripts only).

## 5. Dependency graph

```
M5.0 → M5.1 → M5.2 → M5.3 ─┐
                  └→ M5.4 ─┴→ M5.5 → {M5.6, M5.7} → M5.8 → M5.9 → M5.10
```

### 5.1 Data Flow across increments

Pure types and validators (M5.1) feed the pure decider (M5.2). The decider's snapshots
and events are persisted by the store (M5.3). Its commands are executed through the
ExecutionPort (M5.4) by the engine shell (M5.5). The reconciler (M5.6) reads execution
facts back into the store. Events and the journal (M5.7) are derived from the store. The
hosts and IPC (M5.8) carry intents down and snapshots and events up, and the UI (M5.9)
renders them. Each increment consumes only the outputs of the ones before it.

## 6. Responsibilities / Boundaries

The M5 implementer owns only the new modules plus the listed additive edits. Any other
edit to an M4 file requires an ADR amendment.

## 7. Failure Cases (plan-level)

If M5.4 shows that correlation cannot be added without touching the Orchestrator, fall
back to ADR-017 option A. If the forked execution host is unreliable on Windows, stop and
re-open ADR-011. Do not switch to option B silently.

## 8. Decisions

Implements ADR-001–017 as accepted at M5.0.

## 9. Open Questions

Whether M5.8's CLI commands ship before the desktop wiring (recommended: yes, in the
same increment but separate commits).

## 10. Explicitly Out of Scope for M5

Retries (M6), deterministic checks (M6), the step-level Reviewer (M6), capabilities (M7),
memory (M8), parallelism and multi-provider (M9), the Storage Manager (M5.x optional).

## 11. Risks

| Risk | Mitigation |
|---|---|
| M5.4 BridgeEngine edit regresses M4 | Isolated commit; the existing tests unchanged; smoke test |
| Process-model complexity on Windows | M5.4 tests with a real fork + stop; re-open ADR-011 on failure |
| Scope creep into M6 | The validator rejects M6 fields; `maxAttempts = 1` enforced |

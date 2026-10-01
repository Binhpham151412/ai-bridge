# 21 — Workflow Engine Design (M5, PROPOSED)

## 1. Purpose

Define the Workflow Engine, the M5 layer that runs an ordered set of steps. Each step is
executed by the **existing** BridgeEngine, and the Workflow Engine adds step sequencing,
attempts, budgets and a verification slot. This document defines the domain vocabulary
and exactly how the engine uses BridgeEngine without duplicating any execution
responsibility.

## 2. Current State (EXISTING)

- There is no workflow concept in the code. The largest unit is one BridgeEngine run
  (docs/20 §13).
- A user who wants "do A, then B, then check C" today starts separate runs by hand, and
  judges each outcome personally.
- Useful existing building blocks: typed `BridgeRunOutcome`; `checkRecovery()`/`resume()`;
  `subscribe()` events; read APIs for artifacts and the journal; `AtomicJsonWriter`;
  `redactSecrets`; `sha256Text`; the run host process model (docs/20 §3).

## 3. Proposed Design

### 3.1 Vocabulary

| Term | Definition | Identity |
|---|---|---|
| **Workflow Definition** | Immutable, declarative description: ordered steps, per-step executor settings, verification policy, retry policy, budgets. Authored by a human (docs/36). | `definitionId` (kebab-case) + `version` (integer) + `definitionHash` (sha256 of the canonical JSON) |
| **Workflow Instance** | One run of a definition with concrete inputs; holds runtime state. | `workflowId` = `wf_YYYY-MM-DD_NNN` (same allocation style as runId, separate namespace) |
| **Workflow Step** | One entry of the definition's `steps[]`. At runtime a step has a state and 1..n attempts. | `stepId` (kebab-case, unique within the definition) |
| **Attempt** | One try at completing a step: at most one execution, plus its verification. | `attemptId` = `<workflowId>/<stepId>/<n>`, where n = 1..maxAttempts |
| **Execution** | One `BridgeEngine.start()` run (EXISTING). | `executionId` = the existing `runId` |
| **Verification** | Evaluation of an attempt's result against the step's VerificationPolicy (M5: outcome-only; M6: full). | `verificationId` = `<attemptId>/verification` |
| **Retry** | Creating attempt n+1 after attempt n failed with a retryable classification (M6; M5 caps attempts at 1). | new attemptId, new executionId |
| **Completion** | The instance reaches a terminal state with a recorded `terminalReason` and evidence level. | — |

Relations:

```
Definition 1 ──< Instance 1 ──< Step 1 ──< Attempt 1 ──(0..1)── Execution (runId)
                                                   └──(0..1)── Verification
```

### 3.2 Components (all in Core, `src/core/workflow/`, PROPOSED paths)

| Component | Kind | Responsibility |
|---|---|---|
| `definition-validator` | pure | Parse and validate a definition object; compute `definitionHash`; reject unknown fields (same style as `config.ts`). |
| `workflow-transitions` | pure | The workflow, step and attempt transition tables plus `assertValidWorkflowTransition` (same style as `transitions.ts`). |
| `outcome-mapper` | pure | `BridgeRunOutcome` → `AttemptExecutionResult` (docs/26 §3). |
| `step-planner` | pure | Build the task text for an attempt: step instruction + labelled, capped context. |
| `decider` | pure | `(instance snapshot, event) → (next snapshot, commands[])`. The only place workflow decisions are made. |
| `workflow-store` | I/O | Load/save the instance snapshot (AtomicJsonWriter), append workflow events, the workflow lock. |
| `reconciler` | pure + reads | After a restart, derive the true attempt status from execution facts (docs/26 §6). |
| `WorkflowEngine` | I/O shell | The loop: take the next command from the decider, execute it through a port, feed the result back as an event, persist. |
| `ExecutionPort` | interface | The contract to BridgeEngine (docs/23). |
| `VerificationPort` | interface | M5: `OutcomeOnlyVerifier`; M6: the Verification Engine (docs/24). |

This is the "pure decider + imperative shell" shape (pattern P1 in docs/19 §11). The
decider never performs I/O, never reads a clock (the time comes in on the event), and is
fully unit-testable, exactly like `decideRecoveryStrategy` today.

### 3.3 Engine loop (PROPOSED)

```
loop:
  snapshot ← store.load()
  cmd ← decider.next(snapshot)                 // pure
  switch cmd:
    START_EXECUTION(attempt, task, maxIterations):
        store.recordIntent(attempt, LAUNCHING, launchedAt)    // write-ahead, durable
        outcome ← executionPort.start(...)                     // blocks until the run ends
        event  ← EXECUTION_ENDED(attempt, outcomeMapper(outcome))
    RESUME_EXECUTION(attempt):  outcome ← executionPort.resume(attempt.executionId) …
    VERIFY(attempt):            result ← verificationPort.verify(evidence) → VERIFIED(result)
    WAIT_HUMAN(reason) / PAUSE / COMPLETE / FAIL:  persist, emit, exit the loop
  snapshot' ← decider.apply(snapshot, event)   // pure
  store.save(snapshot'); store.appendEvent(event)
```

### 3.4 How the Workflow Engine interacts with BridgeEngine

| Workflow needs to… | It calls (EXISTING API) | It never does |
|---|---|---|
| execute a step attempt | `start({task, maxIterations})` via ExecutionPort | spawn Claude/Codex, build CLI args, write prompts to `sessions/` |
| learn the runId early | the first `RUN_STARTED` event forwarded by the execution host (+ the optional correlation, docs/23 §8) | guess the runId from the filesystem when an event is available |
| pause | `pause()` | write `state/pause-request` itself |
| stop | `stop()` | kill processes itself |
| resume after a crash | `checkRecovery()`, then `resume()` | call `decideRecoveryStrategy` or read `current-session.json` directly |
| read results | `getSessionArtifacts(runId)`, `getJournal(runId)`, `status()`, `listSessions()` | parse `NNN-*.md` files by path |
| check readiness | `doctor()` (optional pre-check before a workflow starts) | run its own discovery or auth checks |

**The Workflow Engine therefore has no execution responsibilities.** It holds one
BridgeEngine *reference per project* (behind ExecutionPort) and treats each `start()` as
an opaque, bounded, side-effecting activity.

### 3.5 M5 scope limits (PROPOSED)

- Sequential steps only. One active instance per project (workflow lock).
- `maxAttempts` = 1 (the retry machinery is designed, but retries are enabled in M6).
- Verification = `OutcomeOnlyVerifier`: execution `COMPLETED/DONE` ⇒ PASS, with evidence
  level `AI_ATTESTED`; everything else ⇒ FAIL or NEEDS_HUMAN by the mapping table. The
  wording "verified" is never used in M5 output.
- Step executor = the existing Claude-executes/Codex-reviews pair; no provider choice yet.

## 4. Responsibilities

- **Owns:** definitions (validation, hashing), instance/step/attempt state, workflow
  budgets, step-boundary pause/stop handling, reconciliation, workflow events, the
  workflow lock, task-text composition.
- **Does not own:** anything listed in docs/19 §10 Q17.

## 5. Boundaries

- Upstream: hosts (CLI, workflow host, WorkflowController in Main) call
  `WorkflowEngine.{start, pause, resume, stop, status, list, get}`. All results are typed
  and serializable, like BridgeEngine's.
- Downstream: ExecutionPort and VerificationPort only.
- Files: writes only under `.ai-bridge/workflows/` and `.ai-bridge/state/workflow-lock`
  (docs/34).

## 6. Data Flow

```
definition.json ─validate/hash─► instance.json (inputs, definitionHash)
step.instruction + context ─► task text ─► ExecutionPort.start ─► BridgeEngine (EXISTING)
BridgeRunOutcome + artifacts(runId) ─► attempt record ─► VerificationPort ─► verification record
decider(snapshot, event) ─► snapshot' ─► instance.json + events.jsonl
```

Context passed between steps is limited to declared step outputs (docs/36 §3.4),
each capped (PROPOSED 16 KB per section). Any truncation is recorded in the attempt record.

## 7. Failure Cases

| Case | Handling |
|---|---|
| Invalid definition | Rejected at `start`; no instance created. |
| `BLOCKED_PREFLIGHT` / `ALREADY_RUNNING` on start | Attempt `NOT_STARTED` (consumes no attempt); instance BLOCKED with the doctor report. |
| Execution ERROR | Classified (docs/26 §3); M5 → step FAILED or NEEDS_HUMAN. |
| Workflow host crash | Reconciler on the next load (docs/26 §6). |
| Execution host crash | The execution is INTERRUPTED; the workflow asks `checkRecovery()` → resume or WAITING_HUMAN. |
| Store write failure | The engine stops the loop, and the instance stays at its last durable state; no execution is started without a durable intent. |

## 8. Decisions

ADR-001, ADR-002, ADR-011, ADR-012 (docs/38).

## 9. Open Questions

- The exact `workflowId` format (dated counter vs ULID). A dated counter is recommended for
  consistency with runId and human readability.
- Should `doctor()` run once per workflow or once per attempt? (BridgeEngine already runs
  it inside every `start()`, so a workflow-level pre-check is only for fast failure.)
- Can a step override `maxIterations` above the project config? Recommended: yes, within
  1..100 (the existing `start()` contract already allows it).

## 10. Explicitly Out of Scope

Parallel steps, conditional branching beyond step pass/fail, retries (M6), capability
selection (M7), memory (M8), multi-provider (M9), any change to BridgeEngine behavior.

## 11. Risks

| Risk | Mitigation |
|---|---|
| The engine grows execution logic ("just retry the Codex call") | The ExecutionPort contract offers no such call; an architecture test forbids importing the adapters. |
| Long blocking `start()` (up to maxIterations × 40 min) blocks workflow commands | Commands (pause/stop) are handled by the host concurrently and routed to BridgeEngine's own pause/stop; the decider runs again only after `start()` returns. |
| A single current session per project | By design, one execution at a time per project in M5. |

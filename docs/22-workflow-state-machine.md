# 22 — Workflow State Machine (M5, PROPOSED)

## 1. Purpose

Define the states and transitions of a workflow **instance**, a **step** and an
**attempt**, including the invalid transitions, pause, stop, timeout, retry, recovery and
completion. It also states precisely how workflow state differs from the existing
execution state machine.

## 2. Current State (EXISTING)

- The execution state machine is `BridgeState` in `src/core/state-machine/transitions.ts`:
  IDLE, RECOVERING (unused), PREFLIGHT, CLAUDE_EXECUTING, REPORT_DETECTED,
  REPORT_VALIDATED, CODEX_REVIEWING, CODEX_RESPONSE_RECEIVED, RESPONSE_PARSED, DONE,
  NEED_HUMAN, ERROR, STOPPED, STOPPED_MAX_ITERATIONS, PAUSED.
  `Orchestrator.push()` enforces it with `assertValidTransition`.
- The display status (`BridgeStatus.status`) is derived: RUNNING / INTERRUPTED /
  NOT_STARTED / terminal.
- There is no workflow state.

## 3. Workflow state vs execution state

| Aspect | Execution state (EXISTING) | Workflow state (PROPOSED) |
|---|---|---|
| Scope | One run: iterations of Claude→Codex | Many runs: steps, attempts |
| Owner / writer | BridgeEngine (the execution host process) | WorkflowEngine (the workflow host process) |
| File | `state/current-session.json` (one per project, overwritten per run) | `workflows/instances/<wfId>/instance.json` (one per instance, kept) |
| Granularity | Phase inside an iteration | Step / attempt boundaries |
| Recovery unit | Iteration checkpoint | Attempt (re-attach / resume / adopt outcome) |
| DONE means | "Codex said DONE" | "All steps passed their VerificationPolicy" |
| Transitions validated by | `transitions.ts` | `workflow-transitions` (new, separate table) |

The two machines are **not merged**, and no workflow state is ever written into
`current-session.json`. An attempt in EXECUTING *contains* a whole execution-state
lifecycle. The workflow observes it (through events and status) but does not drive its
phases.

## 4. Instance states

| State | Meaning | Terminal |
|---|---|---|
| `CREATED` | Validated, persisted, nothing started | no |
| `RUNNING` | The workflow host is driving steps | no |
| `PAUSED` | Stopped at a safe boundary on request; resumable | no |
| `WAITING_HUMAN` | Needs a decision (NEED_HUMAN verdict, ambiguous recovery, exhausted retry needing a choice) | no |
| `BLOCKED` | The environment is not ready (preflight failed, another run holds the lock); no attempt consumed | no |
| `COMPLETED` | Every step SUCCEEDED | yes |
| `FAILED` | A step FAILED, a budget was exhausted, or the definition was invalid at runtime | yes |
| `STOPPED` | The user stopped it | yes |

Derived display status (not persisted, same idea as `BridgeStatus`): `INTERRUPTED` =
persisted `RUNNING` but the workflow lock's pid is not alive.

### 4.1 Instance transition table (valid)

| From | To | Trigger |
|---|---|---|
| CREATED | RUNNING | `start` accepted, workflow lock acquired |
| CREATED | STOPPED | user stop before start |
| RUNNING | RUNNING | step advanced / attempt created (self-loop; recorded as an event, not a state change) |
| RUNNING | PAUSED | pause honored at a step boundary, or execution ended PAUSED |
| RUNNING | WAITING_HUMAN | attempt NEEDS_HUMAN, or reconciliation ambiguous |
| RUNNING | BLOCKED | attempt NOT_STARTED (BLOCKED_PREFLIGHT / ALREADY_RUNNING) |
| RUNNING | COMPLETED | last step SUCCEEDED |
| RUNNING | FAILED | step FAILED, budget exhausted, deadline exceeded |
| RUNNING | STOPPED | user stop honored |
| PAUSED | RUNNING | user resume (resumes the paused execution, or continues at the next step) |
| PAUSED | STOPPED | user stop |
| WAITING_HUMAN | RUNNING | human answer: `retry` / `continue` / `resume-execution` (typed, logged) |
| WAITING_HUMAN | FAILED | human answer: `fail` |
| WAITING_HUMAN | STOPPED | user stop |
| BLOCKED | RUNNING | user retry-start after fixing the environment (same attempt number, since none was consumed) |
| BLOCKED | STOPPED | user stop |
| COMPLETED, FAILED, STOPPED | — | none (terminal) |

### 4.2 Invalid transitions (examples, all rejected with `INVALID_WORKFLOW_TRANSITION`)

- `CREATED → COMPLETED` (nothing executed).
- `PAUSED → COMPLETED` (completion only from RUNNING, after verification).
- `WAITING_HUMAN → COMPLETED` (a human cannot "mark done"; see §9).
- `BLOCKED → PAUSED`, `BLOCKED → COMPLETED`.
- Any transition out of COMPLETED / FAILED / STOPPED.
- `RUNNING → RUNNING` with a *different* active attempt while the current attempt is not
  terminal (this prevents two concurrent executions).

## 5. Step states

| State | Meaning |
|---|---|
| `PENDING` | Not yet reached |
| `ACTIVE` | Has a non-terminal attempt, or is between attempts |
| `SUCCEEDED` | The latest attempt PASSED |
| `FAILED` | Attempts exhausted, or the failure is non-retryable |
| `STOPPED` | The instance was stopped while the step was ACTIVE |
| `SKIPPED` | FUTURE EXTENSION (conditional steps); not used in M5 |

Valid: PENDING→ACTIVE; ACTIVE→SUCCEEDED | FAILED | STOPPED; ACTIVE→ACTIVE (new attempt).
Invalid: PENDING→SUCCEEDED; SUCCEEDED→anything; a step becoming ACTIVE while an earlier
step is not SUCCEEDED (M5 is strictly sequential).

## 6. Attempt states

```
PLANNED ─► LAUNCHING ─► EXECUTING ─► EXECUTION_ENDED ─► VERIFYING ─► PASSED
   │            │            │  ▲             │               ├────► REJECTED        (verification FAIL)
   │            │            │  │ resume      │               └────► NEEDS_HUMAN
   │            │            ▼  │             ├─► EXECUTION_FAILED   (classified error, no verify)
   │            │         PAUSED_EXECUTION    ├─► NEEDS_HUMAN        (NEED_HUMAN verdict / unclassifiable)
   │            │            │                └─► STOPPED
   │            ├─► NOT_STARTED   (BLOCKED_PREFLIGHT / ALREADY_RUNNING / INVALID_OPTIONS)
   │            └─► LAUNCH_UNKNOWN (crash; could not prove whether an execution started) ─► NEEDS_HUMAN | EXECUTING (adopted)
   └─► (cancelled with the instance) STOPPED
```

| State | Terminal | Consumes an attempt from the budget |
|---|---|---|
| PLANNED | no | no |
| LAUNCHING | no | **yes, from this point** (a start was intended) |
| EXECUTING | no | yes |
| PAUSED_EXECUTION | no | yes |
| EXECUTION_ENDED | no | yes |
| VERIFYING | no | yes |
| PASSED | yes | yes |
| REJECTED | yes | yes |
| EXECUTION_FAILED | yes | yes |
| NEEDS_HUMAN | yes (for the attempt) | yes |
| STOPPED | yes | yes |
| NOT_STARTED | yes | **no** (BridgeEngine refused before creating a session) |
| LAUNCH_UNKNOWN | no | yes |

`NOT_STARTED` → attempt number is reused on the next start (the same attemptId), which is
safe because `BLOCKED_PREFLIGHT` / `ALREADY_RUNNING` / `INVALID_OPTIONS` return before
`SessionManager.createSession()` (docs/20 §6).

## 7. Pause, stop, timeout, retry, recovery, completion

### 7.1 Pause (PROPOSED)
- A request sets `pauseRequested = true` in the instance (a persisted flag, not a state).
- **Between executions:** the decider sees the flag at the step boundary, then goes to PAUSED.
- **During an execution:** the host calls `BridgeEngine.pause()`. It is honored at the
  next iteration boundary (EXISTING). The execution ends `PAUSED`, the attempt goes to
  `PAUSED_EXECUTION`, and the instance goes to PAUSED.
- The same constraint as today applies: a pause during iteration 0 cannot land on a
  resumable checkpoint. The workflow therefore keeps the request pending (it does not
  call `pause()`) until the execution reports iteration ≥ 1, mirroring `deriveControls`.
- **Resume:** PAUSED + attempt PAUSED_EXECUTION → `BridgeEngine.resume()` (same runId).
  PAUSED at a boundary → the next step or attempt.

### 7.2 Stop
- A user stop sets `stopRequested`. If an execution is live, it calls `BridgeEngine.stop()`,
  the execution ends `STOPPED`, and the attempt, step and instance all become STOPPED.
- Stop always wins over pause (same rule as the Orchestrator's STOPPED-over-PAUSED).

### 7.3 Timeout / deadline
- Per-CLI-call timeouts: EXISTING (`claudeTimeoutMs`, `codexTimeoutMs`) → execution ERROR
  `CLAUDE_RUN_FAILED:TIMEOUT` etc. They are classified in docs/26.
- Workflow deadline (PROPOSED `budgets.maxDurationMs`): checked at every boundary. A
  host-side watchdog also calls `BridgeEngine.stop()` when the deadline passes mid-execution.
  The attempt becomes STOPPED with `stopCause = DEADLINE`, and the instance goes to FAILED
  with `terminalReason = DEADLINE_EXCEEDED`. (A user stop gives STOPPED; a deadline stop
  gives FAILED. The difference is recorded in `stopCause`.)

### 7.4 Retry (M6)
- REJECTED / EXECUTION_FAILED + retry policy says retry + budgets allow → the step stays
  ACTIVE, and attempt n+1 goes to PLANNED. Otherwise the step goes to FAILED
  (docs/26 §4). In M5, `maxAttempts = 1`, so the step goes to FAILED.

### 7.5 Recovery (after a workflow host crash)
The reconciler maps (persisted attempt state, execution facts) → corrected attempt state
(docs/26 §6), then the instance continues RUNNING or goes to WAITING_HUMAN.

### 7.6 Completion
- COMPLETED requires every step to be SUCCEEDED. `terminalReason` is `ALL_STEPS_PASSED`,
  and `evidenceLevel` is the weakest step level (`AI_ATTESTED` < `VERIFIED`, docs/24).
- Terminal reasons (enum, PROPOSED): `ALL_STEPS_PASSED`, `STEP_FAILED`,
  `ATTEMPTS_EXHAUSTED`, `BUDGET_EXECUTIONS_EXHAUSTED`, `BUDGET_ITERATIONS_EXHAUSTED`,
  `BUDGET_TOKENS_EXHAUSTED`, `DEADLINE_EXCEEDED`, `DEFINITION_INVALID`,
  `HUMAN_MARKED_FAILED`, `STOPPED_BY_USER`.
- Evaluation priority when several apply at one boundary: STOPPED_BY_USER >
  DEADLINE_EXCEEDED > BUDGET_* > STEP_FAILED > ALL_STEPS_PASSED.

## 8. Responsibilities / Boundaries

- The transition tables live in one pure module and are enforced on every persisted change.
- Only the WorkflowEngine writes these states. Hosts request changes (start, pause, resume,
  stop, answer), and the engine decides.
- Execution phases are **displayed** next to workflow state but never drive the workflow
  table directly. Only the typed outcome, status and recovery answers from BridgeEngine
  do.

## 9. Human decisions (WAITING_HUMAN)

A human answer is a typed, persisted event:

| Answer | Effect | Allowed when |
|---|---|---|
| `resume-execution` | `BridgeEngine.resume()` of the attempt's run | `checkRecovery()` = RECOVERABLE for that runId |
| `retry` | New attempt (counts against maxAttempts) | budgets allow; M6+ (M5 allows it only as an explicit human override with maxAttempts raised for that step, OPEN QUESTION) |
| `accept-as-ai-attested` | **Not offered.** A human cannot convert a failure into success. | never |
| `fail` | Step and instance FAILED (`HUMAN_MARKED_FAILED`) | always |
| `stop` | STOPPED | always |

**OPEN QUESTION:** should a "human accepted" evidence level exist (`HUMAN_ACCEPTED`) for
steps a person verified manually? It is recommended as a FUTURE option, clearly labelled
and never counted as `VERIFIED`.

## 10. Data Flow

`events → decider → snapshot'`. Every transition appends one workflow event
(`WORKFLOW_STATE_CHANGED`, `STEP_STATE_CHANGED`, `ATTEMPT_STATE_CHANGED`) with the
from/to states (docs/27).

## 11. Failure Cases

| Case | State result |
|---|---|
| Crash while LAUNCHING | LAUNCH_UNKNOWN → reconcile (docs/26 §6) |
| Crash while EXECUTING | reconcile: execution RUNNING → re-attach/wait; INTERRUPTED → checkRecovery; terminal → adopt the outcome |
| Crash while VERIFYING | re-run verification (deterministic checks are read-only; the policy requires them to be idempotent) |
| Invalid transition attempted | Error thrown inside the engine and the instance not persisted; a bug, surfaced as an event |

## 12. Decisions

ADR-002 (separate state machines), ADR-009 (bounded loops), ADR-012 (retry = new execution).

## 13. Open Questions

- Whether `BLOCKED` should auto-retry after a doctor pass. Recommended: no; the user starts
  it again.
- `HUMAN_ACCEPTED` evidence level (§9).

## 14. Explicitly Out of Scope

Branching and parallel states, SKIPPED semantics, scheduled or cron workflows.

## 15. Risks

- State explosion: kept to 8 instance, 6 step and 13 attempt states, each justified above.
- Confusing workflow PAUSED with execution PAUSED in the UI: the UI shows both levels
  explicitly (docs/35).

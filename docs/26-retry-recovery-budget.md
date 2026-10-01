# 26 — Retry, Recovery and Budgets (M5 foundations, M6 retries, PROPOSED)

## 1. Purpose

Define retry, timeouts, iteration and attempt limits, the workflow duration limit, an
optional token guard, crash recovery, duplicate prevention, idempotency and backoff.
It also draws a hard line between **RETRY**, **RESUME** and **NEW EXECUTION**.

## 2. Current State (EXISTING)

- **No retries anywhere.** The Orchestrator "never retries and never repairs malformed
  output" (orchestrator.ts header). The only retry in Core is `AtomicJsonWriter`'s
  rename retry on EPERM/EBUSY/EACCES (up to 16 attempts, linear 5 ms steps). That is
  infrastructure, not semantic.
- Bounds: `maxIterations` 1..100 per run (`MAX_RUN_ITERATIONS`); `claudeTimeoutMs` default
  30 min; `codexTimeoutMs` default 10 min; `runProcess` output cap of 50 MB per stream;
  `pause()` waits ≤ 60 s; stop grace 10 s + force 10 s.
- Recovery: two checkpoints, everything else `RECOVERY_BLOCKED` (docs/20 §8).
- Duplicate prevention: the per-project run lock (pid liveness); ids persisted before the
  other adapter runs (`onSessionUpdate` awaited).
- Token usage is recorded per call (M4.2); there is no budget on it.

## 3. Outcome classification (PROPOSED, pure table)

Input: `ExecutionResult` (docs/23). Output: `{ attemptState, class, retryable }`.

| Execution result | attempt state | class | retryable by default |
|---|---|---|---|
| NOT_STARTED: BLOCKED_PREFLIGHT | NOT_STARTED | ENVIRONMENT | no (the user fixes it; no attempt consumed) |
| NOT_STARTED: ALREADY_RUNNING | NOT_STARTED | ENVIRONMENT | no (no attempt consumed) |
| NOT_STARTED: INVALID_OPTIONS | NOT_STARTED → step FAILED | DEFINITION | no |
| COMPLETED DONE | EXECUTION_ENDED → verify | CLAIM_DONE | n/a |
| COMPLETED STOPPED_MAX_ITERATIONS | EXECUTION_ENDED → verify only if `acceptMaxIterationsOutcome`, else REJECTED | ITERATIONS_EXHAUSTED | yes (M6) |
| COMPLETED NEED_HUMAN | NEEDS_HUMAN | HUMAN_REQUESTED | no |
| COMPLETED PAUSED | PAUSED_EXECUTION | PAUSED | n/a (resume) |
| COMPLETED STOPPED | STOPPED | STOPPED | no |
| ERROR `CLAUDE_RUN_FAILED:SPAWN_FAILED` | EXECUTION_FAILED | TRANSIENT_INFRA | yes, with backoff (no process ran, so no side effects) |
| ERROR `CLAUDE_RUN_FAILED:TIMEOUT` | EXECUTION_FAILED | EXECUTOR_TIMEOUT | policy opt-in (`retryOn`), since the workspace may be partly modified |
| ERROR `CLAUDE_RUN_FAILED:NON_ZERO_EXIT` + usage-limit text in stderr (`detectUsageLimit`, EXISTING in providers) | NEEDS_HUMAN | QUOTA | **never** (waiting on a weekly limit is a human decision) |
| ERROR `CLAUDE_RUN_FAILED:NON_ZERO_EXIT` (other) | EXECUTION_FAILED | EXECUTOR_FAILED | policy opt-in |
| ERROR `CLAUDE_RUN_FAILED:{BAD_JSON,NO_RESULT_EVENT,SESSION_MISMATCH}` | NEEDS_HUMAN | CONTRACT_ANOMALY | no |
| ERROR `REPORT_INVALID` | EXECUTION_FAILED | REPORT_MISSING_OR_INVALID | yes, once (M6; the prompt gets the validator errors) |
| ERROR `CODEX_RUN_FAILED:*` | NEEDS_HUMAN | REVIEWER_FAILED | no (Claude's work exists; re-executing it is costly and non-idempotent) |
| ERROR `RESPONSE_INVALID` | NEEDS_HUMAN | REVIEWER_OUTPUT_INVALID | no (same reason) |
| ERROR `PROMPT_INTEGRITY_FAILURE`, `REPORT_TRANSPORT_INTEGRITY_FAILURE` | EXECUTION_FAILED → step FAILED | INTEGRITY | **never** |
| ERROR `BLOCKED_API_AUTH` | NOT_STARTED-equivalent → BLOCKED | COST_GUARD | **never** |
| `RESUME_REFUSED: RECOVERY_BLOCKED / NOT_CURRENT_SESSION` | NEEDS_HUMAN | AMBIGUOUS_RECOVERY | no (a human chooses) |
| `HOST_FAILED` | reconcile first (§6) | — | — |
| Verification FAIL | REJECTED | VERIFICATION_FAILED | yes (M6) |
| Verification NEEDS_HUMAN | NEEDS_HUMAN | — | no |

The table is data and pure. It is unit-tested row by row. Unknown error codes default to
**NEEDS_HUMAN**, never to retry.

## 4. Retry (M6)

**Definition.** RETRY = create attempt n+1 of the same step, which means a **NEW
EXECUTION** (a new runId and a **fresh Claude session**, because `BridgeEngine.start()`
always mints a new session). It happens only when all of these hold:
1. The class is retryable per the table, or explicitly opted in by `retry.retryOn`.
2. `n < maxAttempts` (M5: 1; M6 default 2; hard cap 5).
3. The workflow budgets have room (§7).
4. It is not stuck (§4.2).

**Retry prompt.** The step-planner builds a new task text from the original step
instruction plus labelled sections: `## Previous attempt n result` (the deterministic
`failureSummary`), `## Reviewer suggestion` (if any, labelled as AI-generated), and
`## Workspace state` (files changed per git). Each section is capped, and the text is
hash-recorded in the attempt record. The previous Claude conversation is **not**
continued. That is deliberate: retries restart from the evidence, not from a possibly
confused context. (OPEN QUESTION: an option to retry *within* the same Claude session
would need `resume`-style semantics that BridgeEngine only offers for crashed or paused
runs; not proposed.)

**Workspace between attempts.** M5/M6 do not reset the working tree. The next attempt
starts from whatever the previous attempt left. That is recorded (HEAD and porcelain
hash before and after each attempt) and stated in the prompt. Git checkpoint and rollback
are an OPEN QUESTION (docs/19 §11 P5).

### 4.1 Backoff

Only for `TRANSIENT_INFRA`: delays of 5 s, 20 s, 60 s (at most 3 infra retries per
attempt, which do **not** consume attempts because no execution ran). No backoff for
semantic retries (they are not rate-limit problems). No automatic retry on quota errors.

### 4.2 Stuck detection (M6, adopted from OpenHands, simplified)

→ NEEDS_HUMAN when any of these holds:
- two consecutive attempts produced identical failure summaries (sha256 equal);
- an attempt ended with an unchanged workspace digest while the claim was DONE;
- the extracted next prompt was identical in two consecutive iterations of one execution
  (read from the execution artifacts; FUTURE).

## 5. Duplicate prevention and idempotency

| Layer | Mechanism | Status |
|---|---|---|
| Execution | Per-project run lock with pid liveness → `ALREADY_RUNNING` | EXISTING |
| Execution | Session and thread ids persisted before the next adapter call | EXISTING |
| Execution | Recovery only from safe checkpoints; CLAUDE_EXECUTING is never auto-resumed | EXISTING |
| Workflow | Workflow lock `.ai-bridge/state/workflow-lock` (pid): one active instance per project | PROPOSED |
| Workflow | Deterministic `attemptId`; the attempt record is created before `start()` (intent LAUNCHING, `launchedAt`) | PROPOSED |
| Workflow | `correlation = attemptId` on the run (docs/23 §8) | PROPOSED (OPEN QUESTION) |
| Workflow | **Rule:** an attempt in LAUNCHING / EXECUTING / LAUNCH_UNKNOWN is never started again automatically | PROPOSED |
| Verification | Checks must be idempotent; re-running verification is the only replay allowed | PROPOSED |
| Events | `eventId = <workflowId>#<seq>`; appending the same seq twice is detected on load | PROPOSED |

Idempotency by operation:

| Operation | Idempotent? | Consequence |
|---|---|---|
| Claude execution (edits files) | **No** | Never replayed automatically |
| Codex review (read-only) | Effectively yes | The EXISTING `RESEND_REPORT_TO_CODEX` relies on this |
| Deterministic checks | Required to be | They can be re-run after a crash |
| Journal generation | Yes (EXISTING, write-if-changed) | — |
| Workflow snapshot save | Yes (atomic replace) | — |

## 6. Crash recovery (workflow host restart)

Reconciler, per non-terminal attempt (pure decision over facts read through ExecutionPort):

| Persisted attempt | Facts from BridgeEngine | Decision |
|---|---|---|
| PLANNED | — | continue normally (nothing was started) |
| LAUNCHING, no executionId | a session with `correlation == attemptId` (option B) or `startedAt ≥ launchedAt` and no other claimant (option A) | adopt its runId → EXECUTING |
| LAUNCHING, no executionId | no session started after `launchedAt`, and the run lock free | the start never happened → back to PLANNED (safe: `createSession` precedes any CLI call) |
| LAUNCHING, no executionId | several candidates, or evidence conflicts | LAUNCH_UNKNOWN → NEEDS_HUMAN |
| EXECUTING(runId) | `status().runId == runId` and RUNNING (the lock pid alive) | re-attach: wait for it to end (poll `status()`; the events stream is lost for the detached run, so the UI falls back to polling, like RunController today) |
| EXECUTING(runId) | INTERRUPTED | `checkRecovery()`: RECOVERABLE → resume (same runId); BLOCKED → NEEDS_HUMAN (AMBIGUOUS_RECOVERY) |
| EXECUTING(runId) | a terminal status in the session summary | adopt the outcome → EXECUTION_ENDED (**never re-run**) |
| EXECUTION_ENDED / VERIFYING | — | (re-)run verification |
| PAUSED_EXECUTION | PAUSED | stay PAUSED (the user resumes) |

This answers "a crash between execution and persistence": the execution outcome is
always durable on BridgeEngine's side first (`current-session.json` final status +
`RUN_COMPLETED`/`RUN_STOPPED` event + session artifacts). The workflow copy is derived,
so losing it loses nothing.

**Crash inside an execution** (EXISTING semantics, unchanged): RESPONSE_PARSED /
PAUSED(≥1) → continue from the extracted prompt; REPORT_VALIDATED / CODEX_REVIEWING →
resend to Codex; anything else → BLOCKED → the workflow goes to NEEDS_HUMAN.

## 7. Budgets (PROPOSED values; all hard-capped, all checked at boundaries)

| Budget | Scope | Default | Hard cap | Enforcement point | Terminal reason |
|---|---|---|---|---|---|
| `maxIterations` | execution | project config (10) | 100 (EXISTING) | inside the Orchestrator (EXISTING) | STOPPED_MAX_ITERATIONS (execution) |
| `maxAttempts` | step | 1 (M5), 2 (M6) | 5 | decider, before PLANNED | ATTEMPTS_EXHAUSTED |
| `maxSteps` | definition | — | 50 | validation | DEFINITION_INVALID |
| `maxExecutions` | workflow | steps × maxAttempts | 100 | decider | BUDGET_EXECUTIONS_EXHAUSTED |
| `maxTotalIterations` | workflow (sum of iterations over executions) | 200 | 1000 | decider, before each start; `maxIterations` for the next start is clamped to the remaining budget, and the clamp is recorded | BUDGET_ITERATIONS_EXHAUSTED |
| `maxDurationMs` | workflow wall-clock | 8 h | 72 h | boundaries + a watchdog → `stop()` | DEADLINE_EXCEEDED |
| `maxReportedTokens` | workflow (optional) | unset | — | boundaries only, summing `usage.totalTokens` from the execution records | BUDGET_TOKENS_EXHAUSTED |
| check `timeoutMs` | deterministic check | required | 30 min | process-runner | evidence ERROR |

Token guard notes: it uses only CLI-reported numbers (the EXISTING evidence rule).
`usage: null` (UNKNOWN) is counted as 0 **and** flagged `tokenBudgetIncomplete: true` on
the instance, which the UI shows. The guard is advisory for unknown usage (OPEN QUESTION:
treat unknown as budget-exceeding instead). A USD budget is **not** proposed:
subscription-only billing makes it neither available nor meaningful (docs/19 §11 P22).

## 8. RETRY vs RESUME vs NEW EXECUTION

| | RETRY | RESUME | NEW EXECUTION |
|---|---|---|---|
| Trigger | classified failure of attempt n | pause, or crash with a RECOVERABLE checkpoint | the first attempt of any step, or a retry |
| runId | new | **same** | new |
| Claude session | new | same (EXISTING `--resume`) | new |
| Attempt number | n+1 | unchanged | 1 (first) or n+1 (retry) |
| Counts against maxAttempts | yes | no | yes |
| Counts against maxExecutions | yes | no | yes |
| Iterations count against the total | yes | continue counting | yes |
| Prompt | original + failure evidence | the EXISTING persisted prompt/report | step instruction (+ context) |
| API | `BridgeEngine.start()` | `BridgeEngine.resume()` | `BridgeEngine.start()` |
| Decided by | retry policy (workflow) | recovery (BridgeEngine) + workflow precondition | decider |

Every RETRY is a NEW EXECUTION; a RESUME never is.

## 9. Responsibilities / Boundaries

- The classification table, retry policy, stuck detection and budget checks are pure
  workflow-layer functions.
- Execution-level recovery stays entirely in BridgeEngine. The workflow only asks
  `checkRecovery()` and calls `resume()`.

### 9.1 Data Flow

```
ExecutionResult ─► classification table (§3) ─► {attemptState, class, retryable}
VerificationResult ─┘
{class, attempts used, budgets used, stuck signals} ─► retry policy (pure) ─► RETRY | FAIL | WAIT_HUMAN
RETRY ─► step-planner (original instruction + failureSummary + reviewer suggestion + workspace digest) ─► new ExecutionRequest
restart ─► reconciler reads execution facts (status, checkRecovery, listSessions) ─► corrected attempt state
every boundary ─► budget check ─► BUDGET_CHECKED / BUDGET_EXHAUSTED event
```

## 10. Failure Cases

Covered in §3 and §6. Additionally: clock skew. Budgets use elapsed durations measured by
the workflow host, and `launchedAt` comparisons use ISO timestamps from the same machine.
An NTP jump could affect option A reconciliation. Option B (correlation) removes this.

## 11. Decisions

ADR-009 (bounded loops), ADR-012 (retry = new execution), ADR-014 (execution outcome is
the source of truth).

## 12. Open Questions

Correlation option; treating unknown token usage as over budget; git checkpoints between
attempts; flaky-check recheck; default `maxAttempts` for M6.

## 13. Explicitly Out of Scope

Automatic waiting for quota reset; USD cost tracking; retries inside one execution; the
Orchestrator retrying CLI calls.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Retry storms burning subscription quota | Caps; NEEDS_HUMAN on quota; stuck detection |
| A retry sees a half-modified tree | Recorded digest + an explicit prompt section; OPEN QUESTION on checkpoints |
| A wrong classification retries a non-idempotent failure | Unknown → NEEDS_HUMAN; retry of executor failures is opt-in |

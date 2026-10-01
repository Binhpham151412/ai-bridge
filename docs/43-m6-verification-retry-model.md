# 43 — M6 Verification and Retry: State, Persistence, Events, Recovery, Security, Budgets (PROPOSED)

Covers items 8–13 of the M6 definition (docs/41 §0). Status legend: see docs/41.

## 1. State machines

### 1.1 Attempt (EXISTING states, docs/22 §6; M6 adds transitions, not states)

```
PLANNED ─► LAUNCHING ─► EXECUTING ─► EXECUTION_ENDED ─► VERIFYING ─┬─► PASSED            (verdict PASS)
                                                                   ├─► REJECTED          (verdict FAIL)
                                                                   ├─► NEEDS_HUMAN       (verdict NEEDS_HUMAN)
                                                                   └─► STOPPED           (NEW: stop/deadline during verification)
REJECTED / EXECUTION_FAILED ──(RetryPolicy: RETRY)──► the step's NEXT attempt PLANNED   (NEW; a new attempt, never this one)
```

New valid transitions (added to the EXISTING table in `transitions.ts`):

| From | To | Trigger |
|---|---|---|
| VERIFYING | STOPPED | `STOP_REQUESTED` (cause USER) or the deadline watchdog (cause DEADLINE) while checks/review run |
| VERIFYING | VERIFYING | the crash re-run (`runNo` 1 → 2); recorded as `RECONCILED`, not as a state change |

Invalid, rejected with `INVALID_WORKFLOW_TRANSITION` (examples):

| Attempted | Why it is forbidden |
|---|---|
| REJECTED → LAUNCHING / EXECUTING (same attempt) | A semantic retry is a **new** attempt (ADR-012) |
| REJECTED → any `RESUME_EXECUTION` | Resume is for pause and crash only; a retry never resumes |
| PASSED → VERIFYING | Verification of a passed attempt is final |
| NEEDS_HUMAN → PLANNED (next attempt) without `HUMAN_ANSWER retry` | The system never retries a human-routed attempt by itself |
| VERIFYING → PASSED while a required check has no evidence | Fail-closed: the decision rule requires all required evidence |

### 1.2 VerificationRun (PROPOSED; a record state, inside `verification.json`)

```
PENDING ─► PRECHECK ─► CHECKING(checkId…) ─► REVIEWING? ─► DECIDED
   │           │               │                   │
   │           └──► DECIDED    │ (approval missing → NEEDS_HUMAN)
   └──────────────────────────┴───────────────────┴──► ABORTED      (stop / deadline)
                                                   └──► INTERRUPTED  (host died; only ever seen by recovery)
```

| State | Durable facts | Next on recovery |
|---|---|---|
| PENDING / PRECHECK | nothing irreversible | re-run from PENDING |
| CHECKING | completed CheckRuns; the running check's `{checkId, pid, createdAt}` | reap the recorded process by identity, discard partial evidence, re-run all (`runNo+1`) |
| REVIEWING | the review correlation `<attemptId>/review/<runNo>` | adopt, watch, or re-run the review (§4) |
| DECIDED | the full result + `recordSha256` | if `VERIFICATION_COMPLETED` is missing in the log → submit it from the record (adopt), no re-run |
| ABORTED | the reason | attempt STOPPED (already decided) |

### 1.3 Step (EXISTING states; M6 semantics)

A step stays `ACTIVE` across its attempts. `SUCCEEDED` when an attempt PASSES. `FAILED` when
the RetryPolicy returns `FAIL_STEP`, or the human answers `fail`. `STOPPED` on stop.

### 1.4 Retry decision (pure, one evaluation per non-PASS terminal attempt)

```
attempt n terminal (REJECTED | EXECUTION_FAILED | NEEDS_HUMAN via answer "retry")
   ─► classify (EXISTING table, docs/26 §3; + verification failure class)
   ─► stuck?            ── yes ─► WAIT_HUMAN (options: retry, fail, stop)
   ─► retryable?        ── no  ─► FAIL_STEP (STEP_FAILED) | WAIT_HUMAN (for human-routed classes)
   ─► n < maxAttempts?  ── no  ─► FAIL_STEP (ATTEMPTS_EXHAUSTED)
   ─► budgets allow?    ── no  ─► FAIL_STEP (BUDGET_* / DEADLINE_EXCEEDED)
   ─► RETRY ─► attempt n+1 PLANNED ─► LAUNCHING (write-ahead) ─► START_EXECUTION (NEW execution)
```

### 1.5 Instance

No new instance states. `WAITING_HUMAN` gains the options `retry` (M6) and `reverify`
(OQ-M6-02). `COMPLETED`'s `evidenceLevel` is still the weakest step level (docs/22 §7.6), so a
workflow with one AI_ATTESTED step is AI_ATTESTED overall.

## 2. Persistence model

### 2.1 Layout (additive to docs/34 §3)

```
.ai-bridge/workflows/
  approvals.json                                      ApprovalRecord[] snapshot (AtomicJsonWriter)
  approvals.log.jsonl                                 append-only, hash-chained audit of approve/revoke (OQ-M6-10)
  instances/<workflowId>/attempts/<stepId>-<n>/
    task.md                                           EXISTING (M5); for n > 1 it contains the retry context
    workspace.json                                    NEW: the digests before/after (docs/42 §4)
    verification.json                                 NEW: the VerificationRun record (below)
    check-<checkId>.stdout.log / .stderr.log          NEW: ≤ 5 MB each, redacted
    review/input.md, review/result.json               NEW (R2): input as sent + the parsed ReviewResult
```

The review's execution record and raw response live in `sessions/<reviewRunId>/`
(BridgeEngine-owned, ADR-027). The attempt directory holds only the input and the parsed result,
each with a sha256.

### 2.2 `verification.json` (PROPOSED shape)

```jsonc
{ "schema": 1, "attemptId": "wf_2026-10-01_001/implement/1", "runNo": 1,
  "state": "DECIDED", "policyHash": "…", "definitionHash": "…",
  "approval": { "commandsSha256": "…", "approvedAt": "…" },
  "quiescence": { "before": "…digest…", "after": "…digest…", "held": true },
  "checks": [ { "checkId": "typecheck", "evidence": { /* EvidenceItem */ } } ],
  "running": null,                                     // {checkId, pid, createdAt} while a check runs
  "review": { "correlation": "…/review/1", "runId": "2026-10-01_004", "decision": "REJECT", "sha256": "…" },
  "result": { "verdict": "FAIL", "evidenceLevel": "NONE", "failureClass": "CHECK_FAILED", "failureSummary": "tests: exit 1 …" },
  "startedAt": "…", "decidedAt": "…" }
```

### 2.3 Write ordering (extends the EXISTING "events first, then snapshot" rule)

1. The artifact file (check output) → fsync via atomic rename.
2. `verification.json` with the new CheckRun (atomic).
3. The decider input `VERIFICATION_EVIDENCE` → events → instance snapshot.
4. At the end: `verification.json` `state: DECIDED` with `result` → `VERIFICATION_COMPLETED` input.

A crash between 2 and 3 is repaired by recovery: the record wins, the missing input is
re-submitted, and the evidence hash is compared (§4). Approval: `approvals.log.jsonl` append →
`approvals.json` rewrite.

### 2.4 Attempt record additions (instance snapshot, additive)

`verification.failureClass`, `verification.recordSha256`, `verification.runNo`,
`retryOf: <attemptId> | null`, `retryReason: RetryReason | null`, `retryContextSha256`,
`workspaceBeforeSha256`, `workspaceAfterSha256`. All are optional, so M5 attempts lack them.

## 3. Event model

M6 uses the event types that M5 already **reserved** (no new event types needed for M6 itself):

| Event | Actor | When | Payload (small scalars) | Artifacts |
|---|---|---|---|---|
| `VERIFICATION_STARTED` (EXISTING) | verification | VERIFY dispatched | `runNo`, `policyHash`, `requiredChecks` | — |
| `CHECK_COMPLETED` (reserved → used) | verification | each CheckRun ends | `checkId`, `status`, `required`, `exitCode`, `durationMs`, `timedOut` | stdout/stderr logs (sha256) |
| `REVIEW_COMPLETED` (reserved → used) | reviewer | the review parsed | `decision`, `criteriaMet`, `criteriaTotal`, `reviewRunId`, `parse` | review input/result (sha256) |
| `VERIFICATION_COMPLETED` (EXISTING) | verification | decided | `verdict`, `evidenceLevel`, `failureClass`, `runNo` | `verification.json` (sha256) |
| `RETRY_DECIDED` (reserved → used) | workflow-engine | after a non-PASS attempt | `decision`, `class`, `attemptNo`, `nextAttemptNo`, `stuck` | — |
| `BUDGET_CHECKED` (reserved → used, optional) | workflow-engine | before each retry start | the budget name, used, limit | — |
| `HUMAN_INPUT_RECEIVED` (EXISTING) | human | `retry` / `reverify` answers | `answer` | — |
| `RECONCILED` (EXISTING) | workflow-engine | a verification crash re-run or review adoption | `finding`, `runNo` | — |

New **input types** (`VERIFICATION_EVIDENCE`, `REVIEW_ENDED`) appear in `INPUT_RECEIVED.payload.inputType`.
An M5 build cannot replay them, so it fails closed (ADR-023). Approval events live in
`approvals.log.jsonl`: `DEFINITION_APPROVED`, `APPROVAL_REVOKED` (`{definitionId, definitionHash,
commandsSha256, via, at, prevHash, hash}`).

## 4. Recovery model (extends docs/26 §6; ADR-030)

The reconciler rule stays: **execution facts win, and nothing that may have run is started again
for the same attempt**. Verification is the only replay allowed, and only because checks are
required to be idempotent and read-mostly.

| Persisted state after a Workflow Host crash | Facts read | Decision |
|---|---|---|
| attempt VERIFYING, record PENDING/PRECHECK | — | re-run verification (`runNo+1`), `RECONCILED` |
| record CHECKING, `running = {pid, createdAt}` | Is that pid alive **with the same creation time**? (the M5.10 identity rule) | if alive: kill that process tree (`taskkill /T /F` of the verified pid, identity re-checked immediately before). Then discard partial evidence (recorded), re-run all checks |
| record CHECKING, `running = null` | — | re-run |
| record REVIEWING | `ReviewPort.find(correlation)`: the review run RUNNING / ended / absent | RUNNING → WATCH, then adopt; ended → adopt the parsed result (re-parse the raw response; never re-ask); absent → re-run the review once (bounded, §6) |
| record DECIDED, `VERIFICATION_COMPLETED` missing | the record's hash matches its content | submit `VERIFICATION_COMPLETED` from the record (adopt), no re-run |
| attempt REJECTED, `RETRY_DECIDED` logged, attempt n+1 LAUNCHING | EXISTING M5 LAUNCHING reconciliation by correlation `attempt n+1 id` | LINK / NOT_STARTED / WAIT / UNRESOLVABLE (M5.6, unchanged) |
| `runNo` would exceed 2 | — | NEEDS_HUMAN (`QUIESCENCE_LOST` or `VERIFICATION_UNSTABLE`) |

Two guarantees:

- The REJECTED decision, `RETRY_DECIDED`, attempt n+1 `PLANNED` and `LAUNCHING` are **one decider
  batch**. There is never a window where attempt n is rejected but the intent for n+1 is not
  durable. So a crash can never cause a second retry.
- Attempt n's execution is never touched again after REJECTED. Even `resume-execution` (OQ-M6-11)
  is offered only for attempts in `NEEDS_HUMAN` whose execution is RECOVERABLE, never for REJECTED.

Stop / pause / deadline during verification:

- **STOP**: `ABORT_VERIFICATION` → the running check's tree is killed → the record is ABORTED →
  the attempt is STOPPED (cause USER) → the instance is STOPPED.
- **PAUSE**: it is not applied mid-verification. Verification is bounded (§6), and the pause lands
  at the next boundary (after DECIDED, before a retry's LAUNCHING, or between steps). It is
  recorded as pending, like the EXISTING iteration-0 rule.
- **Deadline**: the watchdog triggers `ABORT_VERIFICATION` → the attempt is STOPPED (cause
  DEADLINE) → the instance FAILED / DEADLINE_EXCEEDED (EXISTING priority rule).

## 5. Security boundaries

| Boundary | Rule | Enforced by |
|---|---|---|
| What runs | Only CheckSpecs of an **approved** `(definitionId, definitionHash)`. The renderer can never supply or edit a command | ApprovalStore + validator + IPC validation |
| How it runs | No shell; refused interpreters; fixed cwd; timeout; capped, redacted output; tree kill; `with-parent` lifetime | CheckRunner over `runProcess` |
| File checks | Project-relative, contained, no `.git/**` / `.ai-bridge/**`, symlinks re-checked | the path rules (docs/42 §3.2) |
| Integrity of checks | `path-untouched` detects edits to check configuration; the digest brackets every phase | WorkspaceProbe |
| Reviewer | Read-only provider sandbox; a digest before/after (a change → discarded); input labelled as data; fail-closed parser; citations machine-checked; executor ≠ reviewer provider | ReviewPort, parser |
| Approvals | Host-owned confirmation only (the CLI prompt, or Main's native dialog listing the commands read from disk); hash-pinned; audited | hosts |
| Evidence tampering | Records hash-chained through workflow events; artifact sha256; `verification.json` sha256 in `VERIFICATION_COMPLETED` | store |
| Secrets | `redactSecrets` on every persisted stdout/stderr tail, review text and summary | CheckRunner, ReviewPort |
| Cost | Checks are not provider calls; the review is, and passes the EXISTING cost guard | BridgeEngine |

Known limitation: AI Bridge cannot sandbox a check's filesystem or network access on native
Windows. The approval step is the control (OQ-M6-12).

## 6. Budgets and hard limits (M6 values; EXISTING caps unchanged)

| Limit | Scope | Default | Hard cap | Enforced | On exceed |
|---|---|---|---|---|---|
| `retry.maxAttempts` | step | — (the field is required, as in M5) | **5** | validator, RetryPolicy | ATTEMPTS_EXHAUSTED |
| infra retries (`TRANSIENT_INFRA`, 5 s/20 s/60 s) | attempt | 3 | 3 | RetryPolicy | EXECUTION_FAILED |
| checks per step | step | — | 20 | validator | DEFINITION_INVALID |
| check `timeoutMs` | check | required | 30 min | validator, runProcess | ERROR timedOut → FAIL / CHECK_TIMEOUT |
| verification wall time (the sum of check timeouts + review) | attempt | the computed sum | 2 h | validator (sum of timeouts) + watchdog | ABORTED → NEEDS_HUMAN |
| check output per stream | check | — | 5 MB | runProcess cap | captured to the cap; `OUTPUT_CAPPED` → ERROR |
| evidence tail in a record | evidence item | — | 4 KB / stream | CheckRunner | truncated flag |
| failureSummary | attempt | — | 8 KB | builder | truncated flag |
| review input | review | — | 256 KB | ReviewPort | sections truncated, flagged |
| review response | review | — | 64 KB | parser | NEEDS_HUMAN |
| review runs per verification run | attempt | 1 | 1 + 1 crash re-run | engine | NEEDS_HUMAN |
| verification runs (crash re-runs, `reverify`) | attempt | 1 | 2 automatic + 2 `reverify` | reconciler, decider | NEEDS_HUMAN |
| criteria | step | — | 20 × 500 chars | validator | DEFINITION_INVALID |
| retry context | attempt | — | 18 KB (8 + 2 + 8) inside the EXISTING 256 KB task cap | step-planner | truncated flags |
| `maxExecutions` | workflow | steps × maxAttempts | 100 (EXISTING) | decider | BUDGET_EXECUTIONS_EXHAUSTED |
| `maxTotalIterations` | workflow | 200 | 1000 (EXISTING) | decider (clamp recorded) | BUDGET_ITERATIONS_EXHAUSTED |
| `maxDurationMs` | workflow | 8 h | 72 h (EXISTING) | boundaries + watchdog (now also during verification) | DEADLINE_EXCEEDED |
| `maxReportedTokens` | workflow | unset | — | boundaries | BUDGET_TOKENS_EXHAUSTED (unknown usage flagged) |

**Termination rules** (a workflow always ends, in bounded time and bounded executions):

1. Every attempt ends in a terminal attempt state; every retry consumes an attempt; attempts are ≤ 5 per step and ≤ 100 executions per workflow.
2. Every execution is bounded by `maxIterations` (≤ 100) × the per-call timeouts (EXISTING).
3. Every verification is bounded by its summed timeouts (≤ 2 h) and at most 2 automatic runs.
4. Stuck detection (docs/26 §4.2) converts non-progress into WAIT_HUMAN before the caps are reached.
5. The workflow deadline (≤ 72 h) stops everything, including verification.
6. No path converts UNKNOWN, ERROR or an invalid review into PASS, so no loop can "succeed its way out" of a failure.

# 41 — M6 Verification: Architecture (PROPOSED — documentation only)

Status legend used in docs 41–58: **EXISTING** = in the code base (committed `27fb871` plus the
uncommitted M5.1–M5.9 working tree, re-read 2026-09-30) · **PROPOSED** = defined by this document
set, not yet accepted · **FUTURE** = a later phase · **OPEN QUESTION** = needs an explicit
decision. Nothing here is implemented. ADR numbers ADR-021 and higher are **PROPOSED** and are
defined in docs/58. docs/38 is still the authoritative register for ADR-001 to ADR-020.

This document **extends** docs/24 (verification), docs/25 (reviewer) and docs/26 (retry, recovery,
budgets). It supersedes none of them. Where it refines a rule of theirs, it says so and points to
a PROPOSED ADR.

## 0. Section map (the 25 required items for M6)

| # | Item | Where |
|---|---|---|
| 1–4 | Purpose, problem, scope, non-goals | this doc §1–§5 |
| 5–6 | Architectural changes, domain concepts | this doc §6–§7 |
| 7 | Contracts / interfaces | docs/42 |
| 8–13 | State machines, persistence, events, recovery, security, budgets | docs/43 |
| 14–19 | CLI, Main, renderer, testing, real E2E, failure modes | docs/44 |
| 20–24 | Backward compatibility, dependencies, open questions, ADRs | this doc §9–§13 |
| 25 | Acceptance criteria | docs/44 §8 |

## 1. Purpose

Make "a step is done" depend on **evidence produced by AI Bridge itself**, not on a model's claim.
Add a bounded **semantic retry**: a rejected attempt can be followed by a new attempt, which is
always a **new execution**.

```
M5:  Workflow → Execute → OutcomeOnly verification → AI_ATTESTED → Done
M6:  Workflow → Execute → Deterministic verification → (Reviewer) → PASS / FAIL
                                                         └─ FAIL → bounded retry decision → NEW execution → …
```

## 2. Problem being solved

Facts about M5 (EXISTING):

1. The only acceptance signal is the inner-loop reviewer's `DONE` verdict (Codex). The workflow
   records it as class `CLAIM_DONE`, and `outcomeOnlyVerifier` turns it into
   `PASS / AI_ATTESTED` (`src/core/workflow/verification.ts`). No command, file, test or git fact
   is checked.
2. A DONE claim can be false: tests not run, tests edited to pass, files missing, the tree
   unchanged. None of these is detected today.
3. A failed step ends the workflow (`maxAttempts = 1`, ADR-020). A human can only `fail` or
   `stop` it (`M5_ANSWERS`, `src/core/workflow/controls.ts`).
4. The workspace git evidence planned for M5.5 (docs/39: "read-only git evidence per attempt") was
   **not implemented**. There is no `porcelain`/HEAD capture anywhere under `src/core/workflow/`.
   M6 must add it, because several checks and the retry context depend on it.

## 3. Current state relevant to M6 (EXISTING, verified in code)

| Fact | Where |
|---|---|
| `VerificationPort { verify(attempt): Promise<VerificationOutcome> }`, where `VerificationOutcome = {verdict, evidenceLevel, failureSummary}`. The file's comment says "M6 replaces the implementation, not the call site" | `core/workflow/verification.ts` |
| The decider emits a `VERIFY` command; the engine calls the port and feeds `VERIFICATION_COMPLETED` back as an input | `decider.ts`, `engine.ts` |
| `VerificationVerdict = PASS \| FAIL \| NEEDS_HUMAN`; `EvidenceLevel = NONE \| AI_ATTESTED \| VERIFIED` | `types.ts` |
| Event vocabulary already reserves `CHECK_COMPLETED`, `REVIEW_COMPLETED`, `RETRY_DECIDED`, `BUDGET_CHECKED`. They are **not emitted** in M5. `VERIFICATION_STARTED` and `VERIFICATION_COMPLETED` are emitted | `types.ts`, `decider.ts` |
| The event log rejects an event whose `type` is not in `WORKFLOW_EVENT_TYPES` | `event-log.ts:121` |
| The validator rejects M6 fields with `RESERVED_FEATURE` naming M6: `verification.checks` must be `[]`, `acceptAiOnly` must be true, `requireReviewer`/`acceptMaxIterationsOutcome` must be false, `retry.maxAttempts` must be 1, `retry.retryOn` must be `[]` | `validator.ts:364–391` |
| Outcome classes and retryability exist as data (informational in M5) | `outcome-mapper.ts`, `types.ts` |
| `HUMAN_ANSWER` accepts `retry` / `resume-execution` in the type, but the decider refuses them with `NOT_IN_M5` | `decider.ts:229–230` |
| `runProcess`: no shell, `windowsHide`, timeout, per-stream byte cap, `taskkill /T /F` of the child on timeout | `src/automation/process-runner.ts` |
| Report text is read from the session's hash-verified copy; `reports/` stays shared (ADR-019) | session-history, docs/34 §7 |
| Process lifetimes: Workflow Host `with-parent`, Execution Host `independent`, CLIs `with-parent` of their Execution Host | docs/23 §11.1, `process-lifetime.ts` |

## 4. Scope (M6)

- Deterministic verification with **five check kinds**: `command` (tests, typecheck, build,
  lint, custom project checks), `file-exists` (including build artifacts), `file-contains`,
  `git-state`, `path-untouched`.
- Workspace evidence: read-only git facts before and after each attempt, check and review
  (ADR-029).
- An evidence model, a verification policy and a verification result. The M5 `VerificationPort`
  is kept and extended additively (docs/42 §5).
- Approval of check commands, pinned to the definition hash (ADR-026).
- The step-level Reviewer (docs/25) through a review-only execution mode (option R2, ADR-027).
  It is gated: if ADR-027 is not accepted, M6 ships without it and `requireReviewer` stays
  reserved.
- Semantic retry: `maxAttempts` 1..5, retry classes, `retryOn`, stuck detection, an
  evidence-augmented task text. Every retry is a new execution (ADR-012, ADR-028).
- Attempt history, verification artifacts, retry reasons, and recovery during verification and
  retry (ADR-030).
- The human answer `retry` becomes available.
- CLI, desktop and UI surfaces for all of the above (docs/44).

## 5. Explicit non-goals

- No change to the inner loop: the Orchestrator, the Claude report contract, the Codex template
  and parser are untouched.
- No resuming a rejected attempt's execution. A semantic retry is never a resume (ADR-012).
- No git checkpoint, commit, stash, reset or branch. AI Bridge does not mutate git in M6
  (ADR-029). Rollback between attempts is still OPEN (OQ-M6-01).
- No parallel checks, no multi-reviewer voting (M9), no reviewer that edits code.
- No coverage thresholds, benchmarks, network-dependent checks, or dependency-installing checks
  (docs/24 §11).
- No capability selection (M7), no memory (M8), no alternative providers (M9).
- No USD budgets (docs/26 §7, P22).
- No human answer that turns a failure into a success (docs/22 §9: `accept-as-ai-attested` is
  never offered).

## 6. Architectural changes

```
                 ┌──────────── Workflow Host process (EXISTING, with-parent) ─────────────┐
 decider (pure)  │ WorkflowEngine (EXISTING)                                              │
  EXISTING+ext.  │   │ VERIFY command                                                     │
                 │   ▼                                                                    │
                 │ VerificationEngine  (PROPOSED; implements the EXISTING VerificationPort) │
                 │   ├─ PolicyResolver     (pure)  definition → VerificationPolicy + hash  │
                 │   ├─ WorkspaceProbe     (read-only git: HEAD, porcelain digest, paths)  │
                 │   ├─ CheckRunner        (process-runner; with-parent children, ADR-025) │
                 │   ├─ ApprovalStore      (read; writes only via a host approval action)  │
                 │   ├─ ReviewPort ───────────────fork──► Execution Host (independent)     │
                 │   │                                     BridgeEngine.review() (ADR-027) │
                 │   └─ decideVerification (pure)  evidence + policy → VerificationResult  │
                 │ RetryPolicy (pure, PROPOSED) · StepPlanner retry context (EXISTING+ext.) │
                 └────────────────────────────────────────────────────────────────────────┘
```

| Component | Layer | Change | Status |
|---|---|---|---|
| Definition validator | L3 | Accepts the M6 fields (docs/42 §2) and adds cross-field rules. Still schema 1 (ADR-022) | PROPOSED (extends EXISTING) |
| Decider | L3 | New inputs (`VERIFICATION_EVIDENCE`, `REVIEW_ENDED`), retry transitions, the `retry` answer, stuck signals. Pure and replay-compatible (ADR-021) | PROPOSED (extends EXISTING) |
| VerificationEngine | L4 | New. It implements the EXISTING `VerificationPort` | PROPOSED |
| CheckRunner | L4 | New; wraps EXISTING `runProcess` | PROPOSED |
| WorkspaceProbe | L4 | New; read-only `git` via `runProcess` | PROPOSED |
| ApprovalStore | L4 | New; `workflows/approvals.json` + an audit log | PROPOSED |
| ReviewPort + review-only execution | L4 → L2 | New port. It needs **one additive BridgeEngine API** (ADR-027) | PROPOSED (gated) |
| RetryPolicy | L3 | New pure function over the EXISTING classification table | PROPOSED |
| StepPlanner | L3 | Adds retry-context sections to the task text of attempt n+1 | PROPOSED (extends EXISTING) |
| Reconciler | L3 | Handles `VERIFYING` states and review runs by correlation | PROPOSED (extends EXISTING) |
| Hosts / IPC / UI | hosts, desktop | Approval flow, verification reads, attempt history (docs/44) | PROPOSED |
| BridgeEngine / Orchestrator | L2 | **Unchanged** except the gated ADR-027 addition | — |

## 7. New domain concepts

### 7.1 The six things M6 keeps apart

| Concept | What it is | Produced by | Example | Can make a step pass? |
|---|---|---|---|---|
| **Execution outcome** | The typed result of one execution (`BridgeRunOutcome` → `ExecutionResultSummary`): a fact about the *process*, containing a *claim* about the work | BridgeEngine (EXISTING) | `finalStatus: DONE`, 2 iterations | No. It is a claim (ADR-003) |
| **Evidence** | An observation that AI Bridge itself made or recorded, with provenance and a hash | CheckRunner, WorkspaceProbe, ReviewPort, the execution record | `check typecheck: exit 0 in 41 s`; `porcelain digest changed`; `review REJECT citing check:tests` | Only `DETERMINISTIC` evidence can lift the level to VERIFIED |
| **Verification** | A **pure** decision over the evidence under the step's policy → verdict + evidence level + failure class | `decideVerification` | `FAIL / CHECK_FAILED / "tests: exit 1"` | This *is* the pass/fail decision for the attempt |
| **Review** | An AI judgement of the attempt against human-written criteria. It is one evidence item (`AI_REVIEW`) | the step-level Reviewer via ReviewPort | `REJECT`, criterion 2 not met | No. It can only remove a PASS (ADR-015) |
| **Retry decision** | A **pure** policy decision after a non-PASS attempt: `RETRY`, `FAIL_STEP`, `WAIT_HUMAN` or `BACKOFF_INFRA` | RetryPolicy | `RETRY (attempt 2 of 3), class VERIFICATION_FAILED` | No |
| **Workflow decision** | The decider's state change: attempt/step/instance transitions, the next command, terminal reasons | decider (EXISTING, extended) | step stays ACTIVE, attempt 2 PLANNED → LAUNCHING | It applies the other five and nothing else |

### 7.2 Glossary

| Term | Meaning |
|---|---|
| **VerificationPolicy** | The step's `verification` object plus its canonical hash (`policyHash`). It is pinned with the definition hash |
| **CheckSpec** | One declared check (docs/42 §3) |
| **Required check** | A CheckSpec with `required: true`. Only these gate PASS and only these can produce VERIFIED |
| **CheckRun** | One execution of one CheckSpec, recorded with process identity (pid + creation time), timings and outputs |
| **EvidenceItem** | A record `{evidenceId, source, status, observed, artifact}` (docs/42 §4) |
| **Evidence source** | `EXECUTION_CLAIM` · `DETERMINISTIC` · `WORKSPACE` · `AI_REVIEW` · (`HUMAN`, FUTURE, OQ-M6-07) |
| **VerificationRun** | One pass of verification for one attempt: an id, a state machine (docs/43 §1.2) and a record file |
| **VerificationResult** | `{verdict, evidenceLevel, failureClass, failureSummary, evidence[], policyHash}` |
| **FailureSummary** | Deterministic text built only from FAIL/ERROR evidence (never model text). It is used in the retry context |
| **WorkspaceDigest** | `{head, porcelainSha256, changedPaths[], capturedAt}`, captured read-only |
| **Quiescence** | The precondition for trustworthy checks: no execution running in the project, and the digest stable across the checks |
| **Approval** | A human's hash-pinned consent to run a definition's command checks (ADR-026) |
| **ReviewRequest / ReviewResult / ReviewDecision** | docs/25 §3.2, constrained further in docs/42 §7 |
| **RetryDecision / RetryReason** | docs/42 §8; the reason is an `OutcomeClass` or verification `failureClass`, plus a short deterministic text |
| **StuckSignal** | A detected non-progress pattern (docs/26 §4.2) that forces `WAIT_HUMAN` |

### 7.3 Evidence-level rule (summary; the normative version is docs/42 §6, ADR-024)

- **VERIFIED** iff the verdict is PASS **and** at least one required deterministic check passed
  **and** no required check failed or errored **and** quiescence held.
- **AI_ATTESTED** iff the verdict is PASS with **zero** required checks. That is only allowed
  with `acceptAiOnly: true`, which is the M5 case.
- **NONE** otherwise.
- A reviewer APPROVE never raises a level. A reviewer REJECT or NEEDS_HUMAN removes the PASS.

## 8. End-to-end flow (one step, with a retry)

```
attempt 1  PLANNED → LAUNCHING → EXECUTING (execution E1) → EXECUTION_ENDED (claim DONE)
           → VERIFYING:
               precheck: approval ok · quiescence ok · WorkspaceDigest(after-attempt)
               checks (sequential): typecheck PASS · tests FAIL(exit 1) · no-test-edits PASS
               review (if required): runs even after a deterministic FAIL, for the suggestion only
               decideVerification → FAIL / CHECK_FAILED, summary "tests: exit 1 …"
           → REJECTED
RetryPolicy(class VERIFICATION_FAILED, n=1 < maxAttempts=2, budgets ok, not stuck) → RETRY
attempt 2  PLANNED (task = instruction + "Previous attempt 1 result" + reviewer suggestion
           [AI-generated] + workspace state) → LAUNCHING → EXECUTING (execution E2 ≠ E1, fresh
           Claude session) → … → VERIFYING → PASSED (VERIFIED) → step SUCCEEDED → next step
```

The decision of attempt 1 (REJECTED + RETRY_DECIDED + attempt 2 PLANNED + LAUNCHING) is
persisted as **one decider batch** (events first, then the snapshot) before execution E2 is
started. That is the M5 write-ahead rule, unchanged (docs/43 §4).

## 9. Backward compatibility (item 20)

1. **M5 definitions keep their exact meaning.** A schema-1 definition with M5 values (`checks: []`,
   `acceptAiOnly: true`, `maxAttempts: 1`) is verified by the same rule as `outcomeOnlyVerifier`:
   PASS / AI_ATTESTED for `CLAIM_DONE`, FAIL / NONE otherwise. The M6 verifier must reproduce the
   M5 outcome bit for bit for such steps (a test over the M5 fixtures).
2. **M5 instances replay identically** under the M6 decider (ADR-021). No existing input changes
   meaning. New behavior is reachable only through new inputs or new definition values.
3. **Additive contracts.** `VerificationPort.verify(attempt)` keeps its shape. The context
   parameter and the extra result fields are optional (docs/42 §5). `VERIFICATION_COMPLETED` gains
   only optional fields.
4. **Additive files.** New files under `workflows/instances/<id>/attempts/<step>-<n>/…` and
   `workflows/approvals.json` (docs/34 §3 already reserves both). No EXISTING path changes.
5. **Downgrade is not supported.** An M5 build opening an M6 instance fails closed (unknown event
   types / RESERVED_FEATURE → BROKEN or INVALID, read-only). No data is lost (ADR-023).
6. **BridgeEngine**: unchanged unless ADR-027 is accepted. If it is, the change is one additive
   API. The existing start/resume/stop/pause semantics, files and tests stay unchanged.
7. **IPC**: the existing channels are unchanged; new ones are appended (docs/44 §2).

## 10. Dependencies on previous phases (item 21)

| Needs | From | Why |
|---|---|---|
| M5 released (M5.10 real E2E PASS + release audit) | M5 | M6 extends the decider, validator and engine; the baseline must be proven and committed first. M5.10 is **not** passed yet (2026-09-29: blocked on Claude CLI authentication) |
| Write-ahead attempts, correlation (ADR-017), reconciler (M5.6) | M5.4–M5.6 | Retry attempts and review runs reuse them |
| Process-lifetime model | M5.8.1 | Check processes are `with-parent`; review Execution Hosts are `independent` |
| Hash-chained events, journal | M5.3, M5.7 | Evidence is audited through them; the journal shows attempt history |
| Controls derived in Core, IPC pattern | M5.8/M5.9 | New controls (`retry`, approval) follow it |

## 11. Dependencies on later phases (item 22)

M6 depends on **nothing later**. Later phases depend on M6:

- **M7:** reviewer/executor agent selection plugs into ReviewPort and the resolution. The
  `verifier` permission profile (docs/33 §4) formalizes the check-command approvals.
- **M8:** verification failures and reviewer suggestions can become memory *proposals*, never
  memory facts.
- **M9:** join steps verify merged trees with the M6 engine; cross-agent verification reuses
  ReviewPort.

## 12. Open questions (item 23)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-M6-01 | Git checkpoint/rollback between attempts (docs/19 §14.4, docs/26 §4) | Not in M6. Record digests; the retry context states the tree is not reset | no |
| OQ-M6-02 | Re-run verification without re-execution (`reverify` human answer; flaky checks, docs/24 §7) | Allow only as a human answer after `CHECK_ENVIRONMENT`. It does not consume an attempt. Bounded to 2 per attempt | M6.4 design |
| OQ-M6-03 | Shell interpreters as check commands under explicit trust (docs/24 §3.6) | Refuse in M6. Revisit with M7 trust tiers | no |
| OQ-M6-04 | A check that modifies the tree: WARNING (docs/24) or FAIL? | WARNING by default. FAIL if it touches a path covered by a `path-untouched` check | M6.2 |
| OQ-M6-05 | Pin the resolved executable path (and its hash) at approval time? | Record the resolved path in every CheckRun. Re-approval if the path changes; hash pinning is FUTURE | M6.2 |
| OQ-M6-06 | Same-provider reviewer fallback when only one provider is ready (docs/25 §3.5) | No. `requireReviewer` + no eligible reviewer → NEEDS_HUMAN | M6.3 |
| OQ-M6-07 | A `HUMAN_ACCEPTED` evidence level (docs/22 §9) | FUTURE. Never counted as VERIFIED | no |
| OQ-M6-08 | Use Codex `--output-schema <FILE>` to constrain the review output (listed in `codex exec --help`, 0.155.0-alpha; behavior unverified) | Evaluate in M6.3. The fail-closed parser stays mandatory either way | M6.3 |
| OQ-M6-09 | Treat unknown token usage as over budget (docs/26 §12) | Keep advisory + flagged | no |
| OQ-M6-10 | Approval storage format (snapshot + chained log) | docs/43 §2.3 | M6.2 |
| OQ-M6-11 | Ship the `resume-execution` human answer (deferred from M5.6) in M6.5? | Yes, only when `checkRecovery()` = RECOVERABLE for that runId | no |
| OQ-M6-12 | Network use by check commands cannot be prevented by AI Bridge on Windows | Document it as a limitation; approval shows the commands | no |

## 13. ADRs required (item 24)

ADR-021 (decider replay compatibility), ADR-022 (definition schema evolution), ADR-023 (event
vocabulary evolution), ADR-024 (verdict and evidence semantics), ADR-025 (where checks run),
ADR-026 (command approval), ADR-027 (reviewer invocation R2), ADR-028 (retry policy), ADR-029
(read-only workspace evidence), ADR-030 (verification recovery). All are PROPOSED, with full
text in docs/58.

## 14. Risks

| Risk | Mitigation |
|---|---|
| The agent edits the files that define a check (e.g. `package.json` `"test": "exit 0"`) | `path-untouched` checks. The validator warns when command checks have no protection for their config files (docs/42 §3.3) |
| Retry storms consuming quota | maxAttempts ≤ 5, the QUOTA class is never retried, stuck detection, budgets (docs/43 §6) |
| Slow checks × attempts | Per-check timeout ≤ 30 min; per-verification wall-time cap |
| Reviewer rubber-stamping | Citations are machine-checked; APPROVE can't lift the level; approval-rate events (docs/25 §5) |
| M6 decider changes breaking M5 replay | ADR-021 golden replay suite |

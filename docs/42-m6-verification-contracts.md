# 42 — M6 Verification: Contracts (PROPOSED — documentation only)

All interfaces are **documentation examples** (TypeScript-like). None of them exists in `src/`.
Every contract lists **why** it exists (§11). Status legend: see docs/41.

## 1. Conventions

- Every record is plain JSON, has a `schema` number, is written atomically (`AtomicJsonWriter`),
  and is small. Large text goes into artifact files referenced by `{path, sha256, bytes,
  truncated}` (the docs/27 §5 rule).
- Ids are deterministic and derived from the `attemptId` (`<workflowId>/<stepId>/<n>`), so a crash
  never produces two ids for the same thing.
- Model text never enters a field that a decision reads, except the review decision itself, and
  that passes through the fail-closed parser of §7.
- Free text persisted from a check or review is redacted (`redactSecrets`, EXISTING) before it is
  written.

## 2. Definition additions (schema 1, additive — ADR-022)

M6 gives meaning to the fields M5 reserved. It adds **one** new field name,
`verification.criteria`. The definition stays `schema: 1`. An M5 build refuses such a definition
with `RESERVED_FEATURE` (M6) or `UNKNOWN_FIELD`, so it fails closed (docs/41 §9).

```jsonc
"verification": {
  "checks": [ /* CheckSpec[] — §3; max 20 */ ],
  "acceptAiOnly": false,                 // EXISTING field; meaning in §6
  "acceptMaxIterationsOutcome": false,   // EXISTING reserved field
  "requireReviewer": false,              // EXISTING reserved field; true only if ADR-027 is accepted
  "criteria": ["All unit tests pass", "No public API renamed"]   // NEW, for the Reviewer; ≤ 20 × 500 chars
},
"retry": {
  "maxAttempts": 2,                      // EXISTING field, 1..5 (hard cap 5); still required
  "retryOn": ["VERIFICATION_FAILED", "REPORT_MISSING_OR_INVALID"]  // EXISTING reserved field; opt-in classes
}
```

Validation rules (PROPOSED, added to the EXISTING validator):

| # | Rule | Error code |
|---|---|---|
| V1 | `checks.length ≤ 20`; check ids kebab-case and unique within the step | `TOO_MANY` / `DUPLICATE_ID` |
| V2 | If a step has **no required check**, `acceptAiOnly` must be `true` (otherwise the step could never pass) | `UNVERIFIABLE_STEP` |
| V3 | `acceptAiOnly: true` never converts a failed required check into a PASS. With ≥ 1 required check the field has no effect, and the validator emits a **warning** | warning `NO_EFFECT` |
| V4 | `acceptMaxIterationsOutcome: true` requires ≥ 1 required deterministic check. Such an outcome can only pass as VERIFIED | `UNVERIFIABLE_OUTCOME` |
| V5 | `requireReviewer: true` requires a non-empty `criteria` and an accepted ADR-027 implementation; otherwise it stays `RESERVED_FEATURE` | `RESERVED_FEATURE` / `MISSING_CRITERIA` |
| V6 | `retry.maxAttempts` is an integer 1..5 | `OUT_OF_RANGE` |
| V7 | `retryOn` values ⊆ the **opt-in** classes of the classification table: `EXECUTOR_TIMEOUT`, `EXECUTOR_FAILED`, `ITERATIONS_EXHAUSTED`, `VERIFICATION_FAILED`, `REPORT_MISSING_OR_INVALID`. Never `QUOTA`, `INTEGRITY`, `COST_GUARD`, `CONTRACT_ANOMALY`, `AMBIGUOUS_RECOVERY`, `UNKNOWN` | `NOT_RETRYABLE_CLASS` |
| V8 | A step with `command` checks and no `path-untouched` check covering at least one of the check's config files (§3.3) → **warning**, not an error | warning `UNPROTECTED_CHECK_CONFIG` |
| V9 | Every path/glob obeys §3.2 | `INVALID_PATH` |

Warnings are shown by `validate` and in the approval prompt. They never block.

## 3. Deterministic checks

### 3.1 CheckSpec (extends docs/24 §3.2)

```ts
// Documentation example — NOT in source.
type CheckSpec =
  | { kind: 'command'; id: string; required: boolean;
      command: string;               // an executable name or a project-relative path; never a shell (§3.4)
      args: string[];                // literal argv; no interpolation of any kind
      timeoutMs: number;             // required, 1 000 .. 1 800 000 (30 min)
      expectExitCode?: 0 }           // M6: only 0
  | { kind: 'file-exists'; id: string; required: boolean; path: string }          // includes build artifacts, e.g. "dist/index.js"
  | { kind: 'file-contains'; id: string; required: boolean; path: string; literal: string }   // literal ≤ 1 000 chars, no regex
  | { kind: 'git-state'; id: string; required: boolean;
      expect: 'changed' | 'unchanged' | 'clean';   // relative to the attempt's before-digest; 'clean' = porcelain empty
      paths?: string[] }                           // optional globs restricting what counts
  | { kind: 'path-untouched'; id: string; required: boolean; globs: string[] };     // e.g. ["tests/**", "package.json"]
```

Typical mappings (examples, not presets): tests → `command pnpm ["test"]`; typecheck →
`command pnpm ["typecheck"]`; build → `command pnpm ["build"]` + `file-exists dist/...`; lint →
`command pnpm ["lint"]`; custom project checks → `command node ["scripts/check-x.mjs"]`.
`artifact existence` = `file-exists`. AI Bridge's own execution artifacts are not checked here,
because the execution already validated them (`REPORT_INVALID` exists).

### 3.2 Path and glob rules

- Project-relative, forward slashes, normalized. No `..`, no absolute paths, no drive letters, no
  UNC paths, no NUL. The resolved real path must stay inside the project root, and symlinks are
  resolved and re-checked.
- Never under `.git/**` or `.ai-bridge/**`. Those are AI Bridge- and git-owned, not work products.
- Globs: `*`, `**`, `?` only. No braces, no negation, no character classes. Matched by a small
  deterministic matcher with no dependency. The match set is recorded in the evidence.

### 3.3 Protecting the checks from the executor

A command check is only as trustworthy as the files that define it (`package.json` scripts,
`tsconfig*.json`, test configuration, the test files themselves). The executor has write access
to all of them. The contract is therefore:

- `path-untouched` compares the attempt's **before-digest** with the digest at verification time,
  per matched path (content hash). Any change → FAIL with class `CHECK_TAMPER`.
- V8 warns when command checks exist and no `path-untouched` covers any of `package.json`,
  lockfiles, `tsconfig*.json`, or the check command's own path when it is a project file.

### 3.4 Command execution contract (ADR-025)

| Aspect | Rule |
|---|---|
| Process | Spawned by the Workflow Host through EXISTING `runProcess`: argv array, **no shell**, `windowsHide` |
| Lifetime | `with-parent` (docs/23 §11.1): a check never outlives the Workflow Host |
| Executable | `command` is resolved to an absolute path (PATH lookup, `.exe` preferred, the EXISTING discovery rules). The resolved path is recorded in the CheckRun (OQ-M6-05) |
| Refused commands | `cmd`, `cmd.exe`, `powershell`, `pwsh`, `bash`, `sh`, `wsl`, `wscript`, `cscript`, `mshta`, `rundll32`, `regsvr32` (case-insensitive, with or without extension). OQ-M6-03 decides any trusted override |
| cwd | the project root, always |
| Environment | the Workflow Host environment minus `ELECTRON_RUN_AS_NODE` and AI Bridge-internal variables. Nothing is added. Secrets in the output are redacted, never in the input (the command is the user's) |
| Timeout | required per check; on timeout the process tree is killed (EXISTING) and the status is `ERROR (timedOut)` |
| Output | captured to `check-<id>.stdout.log` / `.stderr.log`, ≤ 5 MB per stream (docs/34 §5), redacted; a ≤ 4 KB tail goes into the evidence item |
| Order | sequential, in declaration order; all checks run, even after a failure (full evidence, docs/24 §3.3) |
| Quiescence | before the first check and after the last: `status()` shows no RUNNING execution for the project, and the digest before equals the digest after (except the WARNING of OQ-M6-04) |
| Approval | a command check runs only if an approval exists for `(definitionId, definitionHash)` (§9); otherwise the check is not run and the verification is `NEEDS_HUMAN` with class `APPROVAL_MISSING` |

## 4. Evidence

```ts
type EvidenceSource = 'EXECUTION_CLAIM' | 'DETERMINISTIC' | 'WORKSPACE' | 'AI_REVIEW';   // 'HUMAN' is FUTURE (OQ-M6-07)
type EvidenceStatus = 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED' | 'WARNING' | 'INFO';

interface EvidenceItem {
  schema: 1;
  evidenceId: string;             // "<attemptId>/claim" | "<attemptId>/check/<checkId>" | "<attemptId>/workspace/<phase>" | "<attemptId>/review"
  source: EvidenceSource;
  status: EvidenceStatus;
  required: boolean;              // true only for required deterministic checks
  observed: {
    exitCode?: number | null; timedOut?: boolean; durationMs?: number;
    errorKind?: 'NOT_FOUND' | 'SPAWN_FAILED' | 'REFUSED_COMMAND' | 'NOT_APPROVED' | 'OUTPUT_CAPPED' | 'QUIESCENCE_LOST';
    matched?: string[];           // file / glob checks (capped list + count)
    stdoutTail?: string; stderrTail?: string;   // ≤ 4 KB each, redacted
  };
  artifacts: { path: string; sha256: string; bytes: number; truncated: boolean }[];
  process?: { pid: number; createdAt: string; resolvedExecutable: string };  // identity for recovery (docs/43 §4)
  at: string;
}

interface WorkspaceDigest {                      // ADR-029: read-only git
  head: string | null;                           // `git rev-parse HEAD`; null if not a repo / unborn
  porcelainSha256: string | null;                // sha256 of `git status --porcelain=v1 -z` output
  changedPaths: string[];                        // capped at 500, plus a count
  pathHashes?: Record<string, string>;           // only for paths matched by path-untouched globs
  capturedAt: string;
}
```

Digest phases per attempt: `before` (at LAUNCHING, before the execution), `after` (at
EXECUTION_ENDED), `pre-checks`, `post-checks`, `pre-review`, `post-review`.

## 5. VerificationPort (EXISTING, extended additively)

```ts
// EXISTING (M5):   verify(attempt: WorkflowAttempt): Promise<VerificationOutcome>
// PROPOSED (M6):   the same call site, plus an optional context; extra result fields are optional.
interface VerificationPort {
  verify(attempt: WorkflowAttempt, ctx?: VerificationContext): Promise<VerificationOutcome>;
}
interface VerificationContext {
  signal?: AbortSignal;                              // STOP / deadline aborts running checks (tree kill)
  onEvidence?: (item: EvidenceItem) => void;         // → decider input VERIFICATION_EVIDENCE (§10)
  runNo: number;                                     // 1, or 2 after a crash re-run (docs/43 §4)
}
interface VerificationOutcome {                      // EXISTING fields first
  verdict: 'PASS' | 'FAIL' | 'NEEDS_HUMAN';
  evidenceLevel: 'NONE' | 'AI_ATTESTED' | 'VERIFIED';
  failureSummary: string | null;
  // PROPOSED, optional:
  failureClass?: VerificationFailureClass | null;
  policyHash?: string;
  recordPath?: string;                               // attempts/<step>-<n>/verification.json
  recordSha256?: string;
  evidenceIds?: string[];
}
```

The M6 implementation (`VerificationEngine`) receives its dependencies at construction
(definition, the ExecutionPort's read-only methods, CheckRunner, WorkspaceProbe, ApprovalStore,
ReviewPort, clock). It builds the docs/24 `VerificationRequest` internally. This keeps the M5
promise that "M6 replaces the implementation, not the call site".

## 6. Decision rule v2 and verdict semantics (pure; ADR-024)

`decideVerification(policy, claim, evidence[], review | null, quiescence) → VerificationResult`

```
0. Non-DONE outcomes never reach verification (EXISTING outcome mapper), except
   STOPPED_MAX_ITERATIONS when acceptMaxIterationsOutcome (V4).
1. Precheck: approval missing for a command check        → NEEDS_HUMAN / APPROVAL_MISSING (no check runs)
2. Quiescence lost (a run started, or the tree moved)    → UNKNOWN (internal) → re-run once, then NEEDS_HUMAN
3. Any required check FAIL                               → FAIL / CHECK_FAILED          (a later rule never undoes this)
   Any required check ERROR with timedOut                → FAIL / CHECK_TIMEOUT
   Any required check ERROR (NOT_FOUND, SPAWN_FAILED, REFUSED_COMMAND, OUTPUT_CAPPED) → FAIL / CHECK_ENVIRONMENT
   Any path-untouched FAIL                               → FAIL / CHECK_TAMPER
4. requireReviewer:
     review REJECT (valid parse)                         → FAIL / REVIEW_REJECTED
     review NEEDS_HUMAN | INVALID | unavailable | modified workspace → NEEDS_HUMAN / REVIEW_*
5. PASS. evidenceLevel = VERIFIED if ≥ 1 required deterministic check PASS, else AI_ATTESTED
   (the latter reachable only when there are zero required checks and acceptAiOnly, V2).
```

| Verdict | Meaning | Persisted? | What happens next |
|---|---|---|---|
| **PASS** | Every gate above passed | yes | attempt PASSED → step SUCCEEDED |
| **FAIL** | A deterministic or reviewer gate rejected the work, and the evidence is determinate | yes, with `failureClass` + `failureSummary` | attempt REJECTED → RetryPolicy (§8) |
| **NEEDS_HUMAN** | The evidence or the review is not trustworthy enough to decide automatically | yes | attempt NEEDS_HUMAN → instance WAITING_HUMAN |
| **UNKNOWN** | Verification could not reach a determinate result (crash mid-run, quiescence lost) | **never as a verdict**; only as a record state (`INTERRUPTED`) | re-run once (`runNo = 2`), then NEEDS_HUMAN. **UNKNOWN never maps to PASS** |

Check-level ↔ verdict-level: `ERROR` is the check-level form of "unknown". It never counts as
PASS. `SKIPPED` exists only for checks not run because the verification was aborted. `WARNING`/`INFO`
never gate.

```ts
type VerificationFailureClass =
  | 'EXECUTION_NOT_DONE' | 'CHECK_FAILED' | 'CHECK_TIMEOUT' | 'CHECK_ENVIRONMENT' | 'CHECK_TAMPER'
  | 'REVIEW_REJECTED' | 'REVIEW_NEEDS_HUMAN' | 'REVIEW_INVALID' | 'REVIEW_UNAVAILABLE' | 'REVIEW_MODIFIED_WORKSPACE'
  | 'APPROVAL_MISSING' | 'QUIESCENCE_LOST';
```

`failureSummary` is built **only** from FAIL/ERROR evidence: `"<checkId>: exit <code> (<ms> ms)\n<stderr tail ≤ 1 KB>"`
per failing item, ≤ 8 KB in total. Model text never goes into it. The reviewer's suggestion
travels separately (§8).

## 7. Reviewer: ReviewPort, input construction, output constraints

### 7.1 ReviewPort

```ts
interface ReviewPort {                                           // the Verification Engine's only way to a reviewer
  review(req: ReviewRequest, ctx: { signal?: AbortSignal; correlation: string }): Promise<ReviewPortResult>;
  find(correlation: string): Promise<ReviewRunFacts | null>;     // for recovery (docs/43 §4)
}
type ReviewPortResult =
  | { kind: 'REVIEWED'; runId: string; result: ReviewResult }
  | { kind: 'NOT_STARTED'; reason: 'BLOCKED_PREFLIGHT' | 'ALREADY_RUNNING' | 'NO_ELIGIBLE_REVIEWER' }
  | { kind: 'HOST_FAILED'; runId: string | null };
```

The implementation for ADR-027 option R2 is `ForkedReviewPort`. It forks one Execution Host
(`independent` lifetime, like executions). The host holds the run lock and calls a
**review-only execution API** on BridgeEngine. Documentation example:

```ts
// PROPOSED additive BridgeEngine API — requires ADR-027 acceptance; not in source.
review(o: { input: string; correlation: string }): Promise<BridgeReviewOutcome>;
// - holds the project run lock (mutual exclusion with runs), mints a runId, writes sessions/<runId>/
//   with a codex-execution.json record (EXISTING evidence model), a redacted raw response file and
//   the review input file; never calls Claude; Codex in the EXISTING read-only sandbox; cost guard
//   and forbidden-flag checks unchanged; correlation "<attemptId>/review/<runNo>" as in ADR-017.
```

### 7.2 Input construction (AI Bridge assembles it; nothing is model-composed)

Order is fixed (evidence first, as an anti-sycophancy measure, docs/25 §3.2). Every section is a
labelled data block (`--- BEGIN <NAME> --- … --- END <NAME> ---`, the EXISTING framing), capped,
and hashed into the review record.

| # | Section | Source | Cap |
|---|---|---|---|
| 1 | Role + output contract (fixed template, versioned `prompt:step-reviewer@1`) | BUILTIN template | — |
| 2 | Step goal | definition `instruction` (inputs substituted as labelled blocks) | 8 KB |
| 3 | Acceptance criteria, numbered | definition `criteria` | 20 × 500 chars |
| 4 | Deterministic evidence table (id, status, exit code, duration, ≤ 1 KB tail each) | EvidenceItems | 32 KB |
| 5 | Workspace change summary (changed paths + a diff excerpt from `git diff` of tracked files, head-limited) | WorkspaceProbe | 64 KB |
| 6 | The execution's final validated report (verbatim) | session-history's hash-verified copy (ADR-019) | 64 KB |

Total ≤ 256 KB. Truncation is marked inside the block and recorded as `truncated: true`. The
reviewer is told that everything after section 1 is **data, not instructions**.

### 7.3 Output constraints (fail closed)

The response must contain exactly one block:

```
<STEP_REVIEW>
{"decision":"APPROVE|REJECT|NEEDS_HUMAN",
 "criteria":[{"index":1,"met":"YES|NO|UNKNOWN","citation":"check:tests | path/to/file.ts:12"}],
 "suggestedCorrection":"… ≤ 2 000 chars …"}
</STEP_REVIEW>
```

| Rule | Violation → |
|---|---|
| exactly one block; valid JSON; known keys only; `criteria.length` = the number of criteria | `INVALID` → NEEDS_HUMAN |
| `APPROVE` only if every criterion is `met: YES` with a valid citation | treated as `REJECT` |
| a citation must name an evidence id present in section 4, or a path present in section 5 (with an optional `:line`) | that criterion counts as `UNKNOWN` |
| `suggestedCorrection` ≤ 2 000 chars, plain text | truncated, flagged |
| workspace digest `pre-review` ≠ `post-review` | the review is discarded → NEEDS_HUMAN / REVIEW_MODIFIED_WORKSPACE |
| response > 64 KB, or the review timed out | NEEDS_HUMAN |

Codex `--output-schema` (OQ-M6-08) may be added to shape the output. The parser above stays
mandatory either way. The executor provider may not review its own attempt
(`reviewer.provider ≠ executor.provider`, docs/25 §3.5; ADR-045 generalizes this in M9).

## 8. RetryPolicy and retry context (pure; ADR-028)

```ts
interface RetryInput {
  attempt: { attemptNo: number; outcomeClass: OutcomeClass; verification: VerificationOutcome | null };
  policy: { maxAttempts: number; retryOn: OutcomeClass[] };
  budgets: { executionsLeft: number; iterationsLeft: number; deadlineAt: string | null; tokensLeft: number | null };
  history: { failureSummarySha256: string[]; workspaceAfterSha256: string[]; claims: string[] };  // earlier attempts, oldest first
  now: string;
}
type RetryDecision =
  | { kind: 'RETRY'; nextAttemptNo: number; reason: RetryReason }
  | { kind: 'FAIL_STEP'; reason: RetryReason; terminal: 'ATTEMPTS_EXHAUSTED' | 'STEP_FAILED' | 'BUDGET_EXECUTIONS_EXHAUSTED' | 'BUDGET_ITERATIONS_EXHAUSTED' | 'DEADLINE_EXCEEDED' }
  | { kind: 'WAIT_HUMAN'; reason: RetryReason; options: ('retry' | 'fail' | 'stop' | 'reverify')[] }
  | { kind: 'BACKOFF_INFRA'; delayMs: 5000 | 20000 | 60000; infraRetryNo: 1 | 2 | 3 };   // TRANSIENT_INFRA only; no attempt consumed
interface RetryReason { class: OutcomeClass | VerificationFailureClass; text: string; stuck?: 'REPEATED_FAILURE' | 'NO_WORKSPACE_CHANGE' }
```

Decision order: stuck signals → `WAIT_HUMAN`; non-retryable class → `FAIL_STEP` or `WAIT_HUMAN`
(following the docs/26 §3 table; `CHECK_ENVIRONMENT` → `WAIT_HUMAN`); retryable and in `retryOn`
(or retryable by default) and `attemptNo < maxAttempts` and budgets allow → `RETRY`; otherwise
`FAIL_STEP / ATTEMPTS_EXHAUSTED`.

**Retry context** (the step-planner, the task text of attempt n+1; each section capped and
hashed; the whole task ≤ 256 KB, the EXISTING cap):

```
<original step instruction, as in attempt 1>
--- BEGIN PREVIOUS ATTEMPT n RESULT (deterministic, from AI Bridge) ---   ≤ 8 KB   failureSummary
--- BEGIN REVIEWER SUGGESTION (AI-generated, unverified) ---              ≤ 2 KB   suggestedCorrection, if any
--- BEGIN WORKSPACE STATE (from git, not reset between attempts) ---      ≤ 8 KB   changed paths vs attempt 1 before-digest
```

The previous Claude session is **not** continued. `BridgeEngine.start()` mints a new one
(ADR-012).

## 9. ApprovalStore (ADR-026)

```ts
interface ApprovalRecord {
  schema: 1;
  definitionId: string; definitionHash: string;
  commands: { checkId: string; command: string; args: string[] }[];   // exactly what was shown
  commandsSha256: string;
  approvedAt: string; approvedVia: 'cli' | 'desktop';                  // the host that showed the confirmation
  revokedAt: string | null;
}
interface ApprovalStore {
  get(definitionId: string, definitionHash: string): Promise<ApprovalRecord | null>;   // Workflow Host, verification
  // Writes are host actions only (CLI command / Main after a native confirmation); never the renderer, never an engine.
}
```

## 10. Decider contract additions (pure; replay-compatible, ADR-021/ADR-023)

| Addition | Kind | Emits events | Notes |
|---|---|---|---|
| `VERIFICATION_EVIDENCE {attemptId, runNo, evidence: EvidenceSummary}` | input (new) | `CHECK_COMPLETED` (reserved type, first use) | one per check; `EvidenceSummary` = id, status, required, artifact hashes |
| `REVIEW_ENDED {attemptId, runNo, result: ReviewSummary \| failure}` | input (new) | `REVIEW_COMPLETED` (reserved type, first use) | the decision + criteria counts + sha256 of the raw response |
| `VERIFICATION_COMPLETED` | input (EXISTING) | `VERIFICATION_COMPLETED` (EXISTING) | adds optional `failureClass`, `policyHash`, `recordSha256`, `runNo` |
| retry | decider-internal | `RETRY_DECIDED` (reserved type, first use) + the EXISTING `ATTEMPT_PLANNED` / `ATTEMPT_LAUNCHING` | emitted in the same batch as REJECTED |
| `HUMAN_ANSWER retry` | input (EXISTING type, newly accepted) | `HUMAN_INPUT_RECEIVED` (EXISTING) | only if attempts and budgets remain; it never raises `maxAttempts` |
| `HUMAN_ANSWER reverify` | input (new answer value, OQ-M6-02) | `HUMAN_INPUT_RECEIVED` | re-runs verification of the same attempt; no new execution |
| `VERIFY` | command (EXISTING) | — | carries `runNo` |
| `ABORT_VERIFICATION` | command (new) | — | STOP / deadline during VERIFYING |

No M5 input changes meaning (ADR-021).

## 11. Why each contract exists

| Contract | Reason it is needed (not speculative) |
|---|---|
| Definition additions | M5 reserved exactly these fields for M6. `criteria` is required by the reviewer contract (docs/25) |
| CheckSpec | The five kinds cover the required check list (tests, typecheck, build, lint, file existence, exit status, git state, artifact existence, custom checks) and nothing more |
| EvidenceItem / WorkspaceDigest | VERIFIED must be derivable from recorded facts; recovery needs process identity; retry context and tamper detection need digests |
| VerificationPort extension | Keeps the M5 call site; adds abort (STOP/deadline) and per-check evidence events |
| decideVerification | Makes PASS/FAIL a pure, table-tested function (like the decider) |
| ReviewPort + BridgeEngine.review | The workflow layer must never spawn CLIs (ADR-001); review must reuse execution guarantees (docs/25 R2) |
| RetryPolicy | Retry must be pure, bounded and auditable (ADR-009, ADR-012) |
| ApprovalStore | Commands come from files the executor may influence; running them needs hash-pinned human consent (docs/33 §5) |
| Decider additions | Every decision must be a logged, replayable input (docs/27 §3.2) |

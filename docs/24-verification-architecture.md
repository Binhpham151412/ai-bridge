# 24 — Verification Architecture (M6, PROPOSED; M5 slot only)

## 1. Purpose

Define how AI Bridge decides that a step is actually done:

```
EXECUTE
  ↓
VERIFY
  ├── PASS → DONE (step SUCCEEDED)
  └── FAIL → RETRY (if the policy and budgets allow) → otherwise FAILED / NEEDS_HUMAN
```

It covers the request, result, evidence and policy types, deterministic vs AI-based
verification, and how false DONE is prevented.

## 2. Current State (EXISTING)

- The only acceptance signal is Codex's parsed `<STATUS>DONE</STATUS>` (docs/20 §6).
- Deterministic checks that exist are **transport/format checks only**: the report
  structure (`ReportValidator`), response structure (`CodexResponseParser`), prompt/report
  hashes (`integrity.ts`). None of them checks the *work*.
- The report contract asks Claude to write `## TESTS` and to mark unverified work
  `UNKNOWN`/`NOT VERIFIED` (`templates.ts`). That text is a model's claim, not evidence.
- `process-runner` can run arbitrary commands safely (no shell, timeout, tree kill, output
  cap). It is the right primitive for deterministic checks.

## 3. Proposed Design

### 3.1 Principle

**An execution result is a claim; verification produces evidence.** Only evidence
produced by AI Bridge itself (exit codes, file facts, hashes) can make a step `VERIFIED`.
Model output can lower confidence but never raise it above what the deterministic
evidence shows.

### 3.2 Types (documentation examples only)

```ts
interface VerificationRequest {
  verificationId: string;            // <attemptId>/verification
  attemptId: string;
  executionId: string | null;        // runId
  executionClaim: {                  // from BridgeRunOutcome — a claim
    finalStatus: 'DONE' | 'STOPPED_MAX_ITERATIONS' | string;
    iterations: number;
    reviewerVerdict: 'DONE' | 'CONTINUE' | 'NEED_HUMAN' | null;   // last Codex STATUS
  };
  workspace: { projectPath: string; gitHeadBefore: string | null; gitHeadAfter: string | null;
               porcelainHashBefore: string | null; porcelainHashAfter: string | null };
  policy: VerificationPolicy;        // copied from the definition (hash-pinned)
}

interface VerificationPolicy {
  checks: DeterministicCheck[];      // may be empty
  requireReviewer: boolean;          // M6 step-level Reviewer (docs/25)
  acceptAiOnly: boolean;             // must be explicitly true when checks is empty
  acceptMaxIterationsOutcome: boolean; // may STOPPED_MAX_ITERATIONS be verified? default false
}

type DeterministicCheck =
  | { kind: 'command'; id: string; command: string; args: string[]; cwd?: 'project';
      timeoutMs: number; expectExitCode: 0; required: boolean }
  | { kind: 'file-exists'; id: string; path: string; required: boolean }         // project-relative, validated
  | { kind: 'file-contains'; id: string; path: string; literal: string; required: boolean }
  | { kind: 'git-changed'; id: string; expect: 'changed' | 'unchanged'; required: boolean }
  | { kind: 'path-untouched'; id: string; glob: string; required: boolean };     // e.g. do not edit tests/**

interface VerificationEvidence {
  checkId: string;
  source: 'DETERMINISTIC' | 'AI_REVIEW' | 'EXECUTION_CLAIM';
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  observed: { exitCode?: number | null; durationMs?: number; timedOut?: boolean;
              stdoutTail?: string; stderrTail?: string; sha256?: string };   // redacted, capped
  artifact: string | null;           // file with full captured output
  at: string;
}

interface VerificationResult {
  verificationId: string;
  verdict: 'PASS' | 'FAIL' | 'NEEDS_HUMAN';
  evidenceLevel: 'VERIFIED' | 'AI_ATTESTED' | 'NONE';
  evidence: VerificationEvidence[];
  failureSummary: string | null;     // deterministic text built from the FAIL evidence; used in the retry prompt
  policyHash: string;
}
```

### 3.3 Decision rule (pure function, PROPOSED)

```
1. If executionClaim.finalStatus ∉ {DONE} and not (STOPPED_MAX_ITERATIONS and acceptMaxIterationsOutcome)
      → FAIL (evidence: EXECUTION_CLAIM), unless the outcome mapper already routed it to NEEDS_HUMAN.
2. Run all deterministic checks (always all, even after a failure — full evidence).
3. If any required deterministic check is FAIL or ERROR → FAIL.   ← no later rule can undo this
4. If requireReviewer: reviewer REJECT → FAIL; reviewer NEEDS_HUMAN or invalid output → NEEDS_HUMAN.
5. If checks is empty and !acceptAiOnly → the definition is rejected at validation time (never reached at runtime).
6. PASS. evidenceLevel = VERIFIED if ≥1 required deterministic check passed, else AI_ATTESTED.
```

### 3.4 Deterministic vs AI-based verification

| | Deterministic | AI-based |
|---|---|---|
| Examples | `pnpm test` exit 0; `tsc --noEmit` exit 0; a file exists; no edits under `tests/**`; git tree changed | Codex's DONE verdict (EXISTING inner loop); M6 step-level Reviewer judgement |
| Executed by | AI Bridge (`process-runner`) | A provider CLI |
| Reproducible | yes (same tree, same command) | no |
| Can make a step VERIFIED | **yes** | **no** |
| Can fail a step | yes | yes |
| Can override the other | a deterministic FAIL overrides any AI PASS | never overrides a deterministic FAIL |

### 3.5 M5 slot (PROPOSED)

M5 ships the `VerificationPort` with a single implementation, `OutcomeOnlyVerifier`:
rule 1 only, `evidenceLevel = AI_ATTESTED`, no checks executed. The definition format
already accepts `verification.checks` (docs/36), but M5 validation **rejects** a
definition with non-empty `checks`, so no one believes checks are running when they are
not.

### 3.6 Command-check safety (M6)

- Commands come only from the definition. They are shown to the user and approved when
  the definition is first used; the approval is pinned to `definitionHash` (docs/33 §5).
- `spawn` with no shell (EXISTING `runProcess`), `cwd` fixed to the project, per-check
  timeout (required, ≤ 30 min), output capped and redacted.
- The same allowlist philosophy as `permission-mode.ts`: `command` must resolve to an
  executable path; shell metacharacters are irrelevant because there is no shell, but
  `cmd.exe`, `powershell`, `bash` and `sh` as the *command* are refused by default
  (OPEN QUESTION: allow with explicit trust?).
- Checks are required to be **idempotent / read-mostly** (test runners, linters,
  typecheckers). A check that modifies the tree is detected by comparing the porcelain
  hash before and after the check, and recorded as a WARNING evidence item.

## 4. Responsibilities

- **The Verification Engine owns** running checks, collecting evidence, applying the
  decision rule, and persisting `verification.json` plus the check output files.
- **It does not own** retry decisions (docs/26), execution, or reviewer prompting (docs/25).

## 5. Boundaries

- Input: `VerificationRequest` built by the WorkflowEngine from the attempt, the execution
  artifacts (read-only via BridgeEngine) and the definition.
- Output: `VerificationResult`, consumed by the decider.
- Writes: `.ai-bridge/workflows/instances/<wfId>/attempts/<step>-<n>/verification.json`
  and `check-<id>.stdout.log` / `.stderr.log`.

## 6. Data Flow

```
attempt (EXECUTION_ENDED) ─► build request (claims + workspace digest + policy)
   ─► run checks sequentially (process-runner) ─► evidence[]
   ─► (M6) Reviewer with evidence ─► AI evidence
   ─► decision rule ─► VerificationResult ─► decider (PASS → next step | FAIL → retry policy)
```

## 7. Failure Cases

| Case | Handling |
|---|---|
| Check command not found | Evidence ERROR → treated as FAIL if required (it is *not* treated as a skip) |
| Check times out | ERROR (timedOut) → FAIL if required |
| Crash during verification | Re-run verification from scratch on recovery (checks are idempotent). Partial evidence is discarded, and the discard is recorded. |
| Reviewer invocation fails | NEEDS_HUMAN (fail closed) |
| Execution said DONE but the tree is unchanged and the policy expects a change | `git-changed` check FAIL |
| Flaky test | FAIL; M6 retry policy may retry the *verification only* once (`recheckOnFail: 1`, OPEN QUESTION), without re-executing |

## 8. How verification prevents false DONE

1. DONE from Codex is recorded as `EXECUTION_CLAIM` evidence, never as the verdict.
2. Required deterministic checks gate PASS, and a model can't overrule them (rule 3).
3. With no deterministic checks, the best possible label is `AI_ATTESTED`, shown in the
   UI, the journal and the final report. The words "verified" and "passed tests" are
   reserved for `VERIFIED`.
4. Fail-closed: missing, invalid or timed-out evidence counts as FAIL or NEEDS_HUMAN, never PASS.
5. `path-untouched` checks catch "tests edited to pass" (a known agent failure mode).

## 9. Decisions

ADR-003 (verification separate from execution), ADR-009.

## 10. Open Questions

- Whether a flaky-check recheck is allowed without re-execution (§7).
- Whether shell interpreters may be check commands under explicit trust (§3.6).
- Whether verification checks may run concurrently. Recommended: no (sequential,
  deterministic order).

## 11. Explicitly Out of Scope

Coverage thresholds, performance benchmarks, network-dependent checks, and checks that
install dependencies (they are not idempotent). Also any change to the inner-loop Codex
review.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Users define no checks, so everything is AI_ATTESTED | Visible labelling; the definition template ships with typecheck/test examples |
| Malicious check commands in a shared definition | Approval pinned to the definition hash; trust tiers (docs/33) |
| Slow test suites multiply by attempts | Per-check timeout; the attempts cap |

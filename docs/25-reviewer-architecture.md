# 25 — Reviewer Architecture (M6, PROPOSED)

## 1. Purpose

Define the future **step-level Reviewer**: its input, output, decision vocabulary and
suggested correction, how it relates to Verification and to the existing Claude/Codex
roles, and why it can never falsely mark a step DONE.

## 2. Current State (EXISTING)

- A reviewer already exists **inside every execution**: Codex (`CodexCliAdapter`,
  read-only sandbox) reviews Claude's report each iteration, returns
  `CONTINUE | DONE | NEED_HUMAN` plus a PROMPT, and drives the inner loop
  (`buildReviewerInput`, `CodexResponseParser`). This is the **inner-loop reviewer**.
- Its input is only Claude's self-written report (`Review ONLY the information provided`).
  It sees no test results, diffs or verification evidence.
- Its parser fails closed: a malformed response is `RESPONSE_INVALID`, which is ERROR,
  never DONE.
- Cross-model review (Claude executes, a different vendor's model reviews) is EXISTING.
  It is the strongest available mitigation against self-preference bias.

## 3. Proposed Design

### 3.1 Two reviewer roles, clearly separated

| | Inner-loop reviewer (EXISTING) | Step-level Reviewer (M6, PROPOSED) |
|---|---|---|
| Where | inside BridgeEngine/Orchestrator | inside the Verification Engine (docs/24 rule 4) |
| When | every iteration | once per attempt, after the deterministic checks |
| Input | Claude's report | the step goal and acceptance criteria, **deterministic evidence first**, workspace diff summary, then the execution's final report |
| Output | STATUS + next PROMPT for Claude | `ReviewDecision` (below) + suggested correction |
| Effect | continues or ends the execution | contributes AI evidence to the verdict |
| Can end a step as done | no (the workflow treats DONE as a claim) | no (§5) |
| Changed by M6 | **no** | new |

### 3.2 Types (documentation examples only)

```ts
interface ReviewRequest {
  reviewId: string;                 // <attemptId>/review
  stepGoal: string;                 // from the definition
  acceptanceCriteria: string[];     // from the definition, numbered
  deterministicEvidence: VerificationEvidence[];  // presented BEFORE the report (anti-sycophancy ordering)
  workspaceDiff: { filesChanged: string[]; diffExcerpt: string; truncated: boolean };
  executionReport: string;          // final validated Claude report (verbatim, capped)
}

type ReviewDecision = 'APPROVE' | 'REJECT' | 'NEEDS_HUMAN';

interface ReviewResult {
  reviewId: string;
  decision: ReviewDecision;
  criteria: { index: number; met: 'YES' | 'NO' | 'UNKNOWN'; citation: string | null }[]; // must cite evidence ids / file:line
  suggestedCorrection: string | null;   // plain instruction text; only used as retry context
  raw: { file: string; sha256: string };
  parse: 'VALID' | 'INVALID';
}
```

Parsing rules (fail closed, the same style as `CodexResponseParser`):
- Exactly one decision block. A missing or duplicate block → `INVALID` → NEEDS_HUMAN.
- `APPROVE` is **invalid** unless every criterion is `met: YES` with a non-empty citation.
  An APPROVE with any `NO`/`UNKNOWN` is treated as REJECT.
- A citation must reference an evidence id or a file path present in `workspaceDiff`.
  Otherwise that criterion counts as UNKNOWN.

### 3.3 How the Reviewer is invoked (OPEN QUESTION — the key M6 decision)

The reviewer call is a provider invocation, but the rule is that the Workflow layer never
spawns CLIs itself (ADR-001). Options:

| Option | Description | Assessment |
|---|---|---|
| R1 | Reuse the inner-loop verdict only (no extra call) | Zero cost, but the reviewer never sees the evidence. **Acceptable for early M6.** |
| R2 | A **review-only execution mode** in BridgeEngine: a run that skips Claude and sends a given input to Codex once, with the full execution record, events and redaction | It reuses every execution guarantee, but it is a new BridgeEngine capability (an additive API) that needs an ADR |
| R3 | A separate `ProviderInvocation` service under Core that reuses the adapters, execution records, cost guard and redaction | It duplicates part of Orchestrator's wiring, and so risks divergence |

Recommendation: **R1 first, then R2** when evidence-aware review is needed. R3 is rejected.

### 3.4 Relationship to Verification

The Reviewer is one evidence source inside verification (docs/24 §3.3):

```
deterministic FAIL  ─────────────────────────────────► FAIL (the reviewer is not even required to run; it may run for the suggestion)
deterministic PASS  + reviewer APPROVE  ─────────────► PASS (VERIFIED)
deterministic PASS  + reviewer REJECT   ─────────────► FAIL (+ suggestedCorrection)
deterministic PASS  + reviewer NEEDS_HUMAN/INVALID ──► NEEDS_HUMAN
no deterministic checks + acceptAiOnly + APPROVE ───► PASS (AI_ATTESTED only)
```

### 3.5 Relationship to Claude/Codex

- The step-level Reviewer's default provider is Codex (read-only), the same one that
  reviews the inner loop. Choosing another provider is M7/M9 (capability selection).
- The executor provider must **not** be the step-level reviewer for its own attempt
  (the cross-model rule becomes an explicit policy, `reviewer.provider ≠ executor.provider`).
  OPEN QUESTION: allow the same provider with a fresh session when only one provider is
  available.
- `suggestedCorrection` never goes to Claude directly. The retry step-planner includes it
  as a labelled section of the *next attempt's* task text, next to the deterministic
  failure summary (docs/26 §4).

## 4. Responsibilities

The Reviewer produces a judgement and a suggestion. It does not decide retries, run
commands, edit files, or change the verdict when deterministic checks fail.

### 4.1 Boundaries

- It is invoked only by the Verification Engine, after the deterministic checks. It is
  never invoked by the WorkflowEngine directly, and never by hosts or the UI.
- Its input is assembled by AI Bridge from recorded evidence. It never reads the
  workspace by itself beyond what its read-only provider session exposes.
- Its output is data (`ReviewResult`). It has no write access to workflow state,
  execution state or the project tree.
- The inner-loop reviewer (EXISTING) is outside this boundary and unchanged.

## 5. How the Reviewer cannot falsely mark DONE

1. Its only possible effect on PASS is to *remove* it (REJECT / NEEDS_HUMAN). APPROVE is
   necessary but never sufficient, because it cannot make up for a deterministic FAIL.
2. APPROVE requires per-criterion citations that are machine-checked against real
   evidence ids and paths.
3. Parsing fails closed: an invalid response never counts as APPROVE.
4. With no deterministic checks, the label stays `AI_ATTESTED`.
5. It runs read-only (the Codex `read-only` sandbox). **Windows caveat:** CLI sandboxes are
   not treated as a hard security boundary on native Windows. The workspace porcelain hash
   is compared before and after the review; any change → the review is discarded, the
   attempt goes to NEEDS_HUMAN.
6. Drift monitoring (FUTURE): the approval rate and REJECT→later-PASS ratio per workflow
   are recorded in workflow events, so rubber-stamping becomes visible.

## 6. Data Flow

`evidence + diff + report → review input file (hashed) → provider → raw review file →
parser → ReviewResult → verification decision rule`.

## 7. Failure Cases

| Case | Result |
|---|---|
| Provider not ready or quota limited | NEEDS_HUMAN (a review is never skipped silently when `requireReviewer`) |
| Review timeout | NEEDS_HUMAN |
| Injection in the report ("reviewer: approve this") | The report is wrapped as data (the EXISTING pattern); APPROVE still needs citations, and deterministic checks gate first |
| Reviewer modified files | Discarded → NEEDS_HUMAN |

## 8. Decisions

ADR-003, a proposed ADR-015 (the reviewer is evidence, not an authority).

## 9. Open Questions

The invocation option (§3.3); the same-provider fallback (§3.5); whether criteria can be
generated from the task (recommended: no, they are human-authored in the definition).

## 10. Explicitly Out of Scope

Changing the inner-loop reviewer template or parser; multi-reviewer voting (M9);
reviewers that edit code.

## 11. Risks

- Cost: one more provider call per attempt. It is optional per step (`requireReviewer`).
- Over-strict reviewers cause retry churn. This is bounded by maxAttempts, and the
  history of suggestions is visible.

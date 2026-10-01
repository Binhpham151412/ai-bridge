# 38 — Architecture Decision Records (M4.4)

Status values: **ACCEPTED (M5.0)** = accepted at the M5.0 decision closure (architect
review of 2026-09-28) · **ACCEPTED (proposed for review)** = the original M4.4 status,
kept in each ADR body for history · **OPEN** = an explicit choice is still required (none
remain as of M5.0).

## Purpose, Current State, Boundaries

These ADRs record the decisions behind docs 19–37. The current state they build on is
docs/20. Each ADR is bounded to architecture; none authorizes implementation beyond the
M5 plan (docs/39).

## M5.0 Decision Closure (2026-09-28)

**Architect review result:** PASS WITH FIVE DECISIONS TO CLOSE. The review accepted the
architecture of docs 19–37 and ADR-001 to ADR-016 **as written**. No ADR's decision
changed at M5.0; only statuses were updated, and the five decisions below were recorded.

| # | Decision | Recorded as | Result |
|---|---|---|---|
| 1 | Workflow host process model | ADR-011 | **Option A accepted:** separate Workflow Host and per-execution Execution Host processes |
| 2 | Attempt ↔ run correlation | ADR-017 | **Option B accepted:** an optional, additive `correlation?: string` on the start contract; implemented in M5.4, not now; fallback reconciliation kept |
| 3 | Workflow definitions location | ADR-018 (new record) | `<project>/.ai-bridge/workflows/definitions/`, project-scoped JSON, canonical hash; the project-local file is the source of truth |
| 4 | Shared `reports/` directory | ADR-019 (new record) | Kept as-is for M5; no report-contract change; the session-history copy is the forensic, hash-verified copy |
| 5 | M5 scope | ADR-020 (new record) | Scope locked: maxAttempts = 1, OutcomeOnly verification, `AI_ATTESTED`; M6–M9 features excluded |

ADR-018 to ADR-020 introduce no new architecture. They record, as numbered decisions,
choices that docs 26, 34, 36 and 39 had already proposed.

**Supersession note (authoritative).** docs/38 overrides any other document on these
points. The following passages were written before M5.0 and still describe these items
as open or undecided. They are superseded by the ADRs named, and were intentionally not
edited in this checkpoint:
- docs/19 §10 Q18 ("OPEN QUESTION, docs/23 §8") → ADR-017 accepted.
- docs/19 §13 ("Still OPEN: ADR-011 … ADR-017") → both accepted.
- docs/19 §14 items 1, 2, 3 and 5 → ADR-011, ADR-017, ADR-019 and ADR-018 respectively.
  Item 4 (git checkpoints) remains open for M6 and is not an M5 blocker.
- docs/23 §8 heading "(OPEN QUESTION)" and §13 first bullet → ADR-017 accepted (option B;
  option A as fallback).
- docs/26 §5 table row "`correlation = attemptId` … PROPOSED (OPEN QUESTION)" and §12
  "Correlation option" → ADR-017 accepted.
- docs/37 E5 "PROPOSED (OPEN QUESTION)" and §8 (E5) → ADR-017 accepted, implemented in
  M5.4. E9 (reviewer invocation) remains an M6 question.
- docs/39 M5.0 describes this closure as future work → done (this section).

## Decisions (summary)

| ADR | Decision | Status |
|---|---|---|
| 001 | The Workflow Engine sits above BridgeEngine, not in place of it | ACCEPTED (M5.0) |
| 002 | Workflow state is separate from execution state | ACCEPTED (M5.0) |
| 003 | Verification is separate from execution; DONE is a claim | ACCEPTED (M5.0) |
| 004 | Provider-agnostic upper layers; concrete execution until M9 | ACCEPTED (M5.0) |
| 005 | Capabilities are task-selected and deterministically resolved | ACCEPTED (M5.0) |
| 006 | Memory is optional (Null port; human-promoted writes) | ACCEPTED (M5.0) |
| 007 | AI interactions are auditable (records + hash-chained events) | ACCEPTED (M5.0) |
| 008 | Local-first file storage, no database | ACCEPTED (M5.0) |
| 009 | Bounded loops with nested hard caps | ACCEPTED (M5.0) |
| 010 | UI does not own orchestration | ACCEPTED (M5.0) |
| 011 | Workflow host process model: separate Workflow Host + per-execution Execution Host (option A) | **ACCEPTED (M5.0)** (was OPEN) |
| 012 | Retry = new execution; resume = same execution | ACCEPTED (M5.0) |
| 013 | JSON definitions, no expression language | ACCEPTED (M5.0) |
| 014 | Execution files are the source of truth for execution outcomes | ACCEPTED (M5.0) |
| 015 | The Reviewer is evidence, not authority | ACCEPTED (M5.0) |
| 016 | Agents are configurations, not processes | ACCEPTED (M5.0) |
| 017 | Attempt ↔ run correlation: optional additive `correlation` field (option B), fallback reconciliation kept | **ACCEPTED (M5.0)** (was OPEN); implementation in M5.4 |
| 018 | Workflow definitions live in `<project>/.ai-bridge/workflows/definitions/` | ACCEPTED (M5.0) |
| 019 | Shared `reports/` directory kept as-is for M5 | ACCEPTED (M5.0) |
| 020 | M5 scope lock | ACCEPTED (M5.0) |

---

## ADR-001 — The Workflow Engine does not replace BridgeEngine
**Status:** ACCEPTED (proposed for review)
**Context:** BridgeEngine plus the Orchestrator already provide a hardened execution: lock,
preflight, cost guard, integrity, execution records, crash recovery with real-crash tests,
stop semantics (docs/20). M5 needs multi-step orchestration.
**Decision:** The Workflow Engine is a new layer **above** BridgeEngine. It uses only
BridgeEngine's public API through ExecutionPort (docs/23). The execution responsibilities
in docs/19 §10 Q17 stay in BridgeEngine.
**Reason:** It reuses the proven guarantees, avoids two execution implementations, and
keeps the M4 regression surface unchanged.
**Alternatives:** (a) extend the Orchestrator with steps. This was rejected: it mixes
workflow and execution state, and the M3/M3.5 recovery proofs would need to be redone.
(b) Rewrite as a general engine. Rejected by the project's own rule.
**Consequences:** Workflows can't influence mid-execution behavior except through
pause/stop. The task text is the only input channel. An execution is an opaque activity.

## ADR-002 — Workflow state is separate from execution state
**Status:** ACCEPTED (proposed for review)
**Context:** `current-session.json` holds one run's phase and is overwritten per run.
Workflows span many runs.
**Decision:** There are separate state machines, files and writers (docs/22 §3). The
workflow stores only references plus derived copies of execution outcomes.
**Reason:** Single-writer files; independent recovery; no schema change to the execution state.
**Alternatives:** Put workflow fields into `current-session.json` (rejected: overwritten
per run, and two writers).
**Consequences:** Reconciliation is needed (docs/26 §6), with a defined precedence
(ADR-014).

## ADR-003 — Verification is separate from execution
**Status:** ACCEPTED (proposed for review)
**Context:** Today DONE = Codex's verdict. LLM judges are known to accept bad work too
often (research in docs/19 §11 P10).
**Decision:** An execution's DONE is a claim. A separate Verification Engine (M6) produces
evidence. Deterministic checks gate PASS, and AI review can only lower the result.
Evidence levels are `VERIFIED` / `AI_ATTESTED`.
**Reason:** It prevents false DONE and keeps the execution engine unchanged.
**Alternatives:** Run tests inside the Orchestrator loop (rejected: changes M4 behavior,
mixes concerns). Trust the reviewer (rejected).
**Consequences:** Extra time per attempt; user-authored checks become a security surface
(docs/33).

## ADR-004 — Provider-agnostic architecture, concrete execution until M9
**Status:** ACCEPTED (proposed for review)
**Context:** The diagnostics layer is already agnostic. The execution layer is typed to
two concrete adapters. Providers differ materially (docs/30 §3).
**Decision:** The upper layers (workflow, capability registry) reference roles and
feature requirements, never provider names. The execution layer stays concrete until M9
introduces adapter interfaces under its own ADR. The capability matrices are explicit
static data.
**Reason:** It avoids a speculative abstraction of the hardened core while keeping the
upper layers future-proof.
**Alternatives:** Abstract the Orchestrator now (rejected: risk without a second
executor to validate it).
**Consequences:** Until M9, "provider choice" in workflows is fixed to Claude executor +
Codex reviewer.

## ADR-005 — Capabilities are task-selected
**Status:** ACCEPTED (proposed for review)
**Context:** Future agents, skills, tools and MCP servers must not be hard-wired or chosen
by an LLM.
**Decision:** Steps declare requirements. The Capability Registry resolves them
deterministically and records the id and hash. There is no auto-install. (docs/28)
**Reason:** Reproducibility, auditability, security.
**Alternatives:** LLM routing (rejected); hard-coding (rejected for M7+).
**Consequences:** Requirements vocabulary maintenance; a constant resolver until M7.

## ADR-006 — Memory is optional
**Status:** ACCEPTED (proposed for review)
**Decision:** MemoryPort with a Null default; M5–M7 contain no memory code; reserved
definition fields are rejected until M8; writes are human-promoted proposals; a graph is a
derived projection. (docs/31)
**Reason:** Correctness must not depend on mutable knowledge; poisoning risk.
**Alternatives:** Agent-written memory (rejected); a graph as source of truth (rejected:
the observed staleness of the dev repo's `graphify-out/`).
**Consequences:** M8 adds context quality, not correctness.

## ADR-007 — AI interactions are auditable
**Decision:** Every AI interaction is (a) an execution record (EXISTING), (b) linked from
a hash-chained workflow event stream (PROPOSED), and (c) reproducible to the bytes sent
(the persisted task text and prompts plus hashes). Journals are views, never sources. (docs/27)
**Reason:** Local, independent verification of what was sent, received and decided.
**Alternatives:** A database or telemetry service (rejected: local-first, no new dependency).
**Consequences:** Storage growth, handled by docs/34.

## ADR-008 — Local-first storage
**Decision:** All state lives in JSON/JSONL/Markdown under `<project>/.ai-bridge/` and app
userData. No database, no cloud. Explicit retention with dry-run cleanup. (docs/34)
**Reason:** It matches the EXISTING design and is inspectable by the user.
**Consequences:** No cross-machine history; manual backup is the user's choice.

## ADR-009 — Bounded autonomous loops
**Decision:** Nested hard caps (iterations ≤ 100 per execution, attempts ≤ 5 per step,
steps ≤ 50, executions ≤ 100, total iterations ≤ 1000, duration ≤ 72 h). Configuration
beyond a cap is rejected, never clamped silently. Budget clamps of the next execution's
`maxIterations` are recorded. Stuck detection → NEEDS_HUMAN. (docs/26 §7)
**Reason:** Subscription quota and user trust; the EXISTING M4.2 rule "never an unbounded
loop, never silently clamped".
**Consequences:** Very long tasks need multiple workflows or human continuation.

## ADR-010 — The UI does not own orchestration
**Decision:** The renderer renders Core snapshots and events and sends intents. Main
controllers route and host processes. Controls are derived in Core or shared by pure
functions. (docs/35)
**Reason:** The EXISTING principle, proven in M4 (`deriveControls`, RunController).
**Consequences:** A new UI feature needs a Core field first.

## ADR-011 — Workflow host process model
**Status:** ACCEPTED (M5.0, 2026-09-28). Previously OPEN; option A was the recommendation.
**Context:** `BridgeEngine.stop()` kills the lock holder's process tree.
**Options:** (A) The WorkflowEngine runs in a *workflow host* process and every execution
runs in its own *execution host* child (reusing `serveRunHost`). (B) The WorkflowEngine
runs inside the same process as `start()`.
**Decision:** **Option A.** The Workflow Host and the Execution Host are separate
processes:

```
Workflow Host                (owns workflow orchestration: WorkflowEngine, store, workflow lock)
    |
    +-- Execution Host       (one per execution; holds the project run lock)
    |      +-- BridgeEngine  (start()/resume() for exactly one run, then the host exits)
    |
    +-- Execution Host       (the next execution, strictly after the previous one ended; sequential in M5)
           +-- BridgeEngine
```

**Reason:** `BridgeEngine.stop()` kills the execution (lock holder) process tree. The
Workflow Host must survive an execution STOP so that it can persist the workflow terminal
state and continue or reconcile. Option B would make every stop kill the workflow engine,
leaving it to depend on post-hoc reconciliation.
**Alternatives:** Option B (rejected, per the reason above).
**Lifetime addendum (M5.8.1):** On Windows a forked child ends with its parent unless it is
detached. Execution Hosts are therefore forked with the `independent` lifetime, so they survive a
Workflow Host crash as this ADR assumes. The Workflow Host and the M4 run host keep the default
lifetime. See docs/23 §11.1.
**Consequences:** One more process layer. A non-Electron execution host entry is needed for
the CLI (docs/23 §13, docs/39 M5.4). Execution hosts run one at a time per project in M5,
which is not a parallelism decision (parallelism remains M9, ADR-020).

## ADR-012 — Retry is a new execution
**Status:** ACCEPTED (proposed for review)
**Decision:** RETRY = a new attempt = a new `start()` = a new runId and a fresh Claude
session, with an evidence-augmented task text. RESUME = the same runId via `resume()`.
(docs/26 §8)
**Reason:** BridgeEngine offers only these two primitives. A fresh session avoids carrying
a confused context. Recovery semantics stay unchanged.
**Alternatives:** Continue the same Claude session for retries (rejected: needs new
BridgeEngine semantics).
**Consequences:** Retries lose the conversational context, so the retry prompt must carry
the evidence.

## ADR-013 — JSON workflow definitions, no expression language
**Decision:** JSON schema v1, a hand-written validator (no dependency), canonical hashing,
placeholders only, reserved fields rejected until their milestone. (docs/36)
**Alternatives:** YAML (dependency plus typing pitfalls), TypeScript (code execution) — both rejected for user definitions.
**Consequences:** Less expressive; branching and parallelism require schema v2 (M9).

## ADR-014 — The execution outcome's source of truth is BridgeEngine's persistence
**Decision:** For any fact about an execution, BridgeEngine's files and read APIs win over
the workflow's cached copy. Reconciliation always reads from execution to workflow.
**Reason:** It answers the "crash between execution and persistence" case without
duplicate execution.
**Consequences:** The workflow depends on the read APIs' stability (EXISTING, typed).

## ADR-015 — The Reviewer is evidence, not authority
**Decision:** The step-level Reviewer can only downgrade PASS. APPROVE requires
machine-checked citations; its parsing fails closed. (docs/25)
**Consequences:** Reviewers cannot compensate for missing deterministic checks.

## ADR-016 — Agents are configurations, not processes
**Decision:** An agent = provider + role + prompt contract + permission profile + limits.
Only providers are processes. (docs/29)
**Consequences:** Multi-agent is scheduling of configurations over the same execution
engine.

## ADR-017 — Correlation between workflow attempts and runs
**Status:** ACCEPTED (M5.0, 2026-09-28). Previously OPEN; option B with fallback A was the recommendation.
**Context:** After a Workflow Host crash between "attempt intent persisted" and
"`RUN_STARTED` received", the workflow must identify which run, if any, belongs to the
attempt (docs/23 §8, docs/26 §6).
**Options:** (A) time-window reconciliation only, with no BridgeEngine change; (B) an
optional additive `correlation` field.
**Decision:** **Option B.** An optional field `correlation?: string` is added to
`BridgeStartOptions` (and to the matching start contract, the run host `HostCommand`
`start`) and carried through:

```
attemptId → correlation → BridgeEngine.start() → RUN_STARTED (extra field) + current-session.json → executionId / runId
```

- It is **additive and backward compatible**: optional; absent for every existing caller
  (CLI, RunController); old state files lack it (the same pattern as `maxIterations` in M4);
  `BridgeEvent` already allows extra fields.
- **Implementation belongs to M5.4** (docs/39). M5.0 records the decision only, and no
  code is changed now.
- **Fallback reconciliation (option A) is kept** for executions without a correlation
  (runs started before M5.4, or by callers that don't set it). If it stays ambiguous →
  LAUNCH_UNKNOWN → NEEDS_HUMAN (docs/26 §6).

**Reason:** Exact attribution removes the clock and time-window ambiguity, at the cost of
one optional pass-through field.
**Alternatives:** Option A only (kept as the fallback, not as the primary mechanism).
**Consequences:** This is the single BridgeEngine change budgeted for M5 (docs/23 §8,
docs/40 E2). It must be an isolated M5.4 commit, and the existing tests must pass unchanged.

## ADR-018 — Workflow definitions location
**Status:** ACCEPTED (M5.0, 2026-09-28)
**Context:** docs/36 §8 and docs/34 §3 left the location open (project `.ai-bridge/`, a
committed repo path, or app userData).
**Decision:** Workflow definitions are **project-scoped** and live in
`<project>/.ai-bridge/workflows/definitions/<definitionId>.json`. They are JSON (ADR-013)
with canonical hashing (docs/36 §3.5). The **project-local definition file is the
source of truth** for a definition. App userData is not the primary store for workflow
definitions. An instance pins the `definitionHash` it was started with (docs/36 §6).
**Reason:** It keeps the definition next to the project it operates on, inside the
directory AI Bridge already owns, and it is consistent with ADR-008 (local-first).
**Alternatives:** A committed repo path (e.g. `ai-bridge/workflows/`): not chosen.
App userData: not chosen as the primary store.
**Consequences:** `.ai-bridge/` is gitignored in this repository and may be in target
projects, so users who want to share definitions copy them explicitly. Nothing is
synchronized automatically.

## ADR-019 — Shared `reports/` directory in M5
**Status:** ACCEPTED (M5.0, 2026-09-28)
**Context:** Every run writes its report to `.ai-bridge/reports/NNN-report.md`, which later
runs overwrite (docs/20 §7, docs/34 §7). Workflows run many executions.
**Decision:** For M5, **keep the existing `reports/` directory as-is.** BridgeEngine's
report contract is not changed in M5. `reports/NNN-report.md` may still be overwritten
by later runs. The per-session copy resolved by session-history (the verbatim,
hash-verified report inside `sessions/<runId>/NNN-chatgpt-input.md`) remains the
forensic copy.
**Reason:** No Core change is needed. The workflow lock and the run lock guarantee that
nothing reads a report while another run could overwrite it. The forensic copy already
exists and is hash-checked.
**Alternatives:** Per-session report paths (a report-contract change): a possible future
migration, **explicitly not part of M5**.
**Consequences:** Workflow views and journals must reference the session-history copy (by
runId), never `reports/NNN-report.md` by path.

## ADR-020 — M5 scope lock
**Status:** ACCEPTED (M5.0, 2026-09-28)
**Decision:** M5 includes the Workflow Engine (docs/21–23, 26 §5–6, 27, 35, 36) under
these explicit limits:

| Item | M5 | Deferred to |
|---|---|---|
| `maxAttempts` | **= 1** (the validator rejects other values) | M6 |
| Verification | **OutcomeOnly** (`OutcomeOnlyVerifier`) | full Verification Engine: M6 |
| Evidence label | **`AI_ATTESTED`** (never "verified") | `VERIFIED`: M6 |
| Semantic retries | **none** | M6 |
| Deterministic verification checks | **none** (non-empty `checks` rejected) | M6 |
| Step-level Reviewer | **none** | M6 |
| Capability Registry | **not implemented** (`requires` must be empty) | M7 |
| Memory | **not implemented** (`context.memory` must be empty) | M8 |
| Graphify | **not implemented** | M8 |
| Multi-agent / parallel execution | **none** (sequential steps, one execution at a time) | M9 |
| Multi-provider execution abstraction | **none** (the Claude executor + Codex reviewer pair unchanged) | M9 |

**Reason:** A bounded, reviewable first increment. Retries, checks and review depend on a
working workflow core.
**Consequences:** Every M5 result carries `AI_ATTESTED`. The M5 definition validator
rejects reserved fields by naming their milestone (docs/36 §3.2).

---

## Failure Cases / Data Flow / Responsibilities

Per the referenced documents. The ADRs define no runtime behavior themselves.

## Open Questions (ADR-level)

**No ADR-level question blocks M5** (closed at M5.0: ADR-011, ADR-017, ADR-018, ADR-019,
ADR-020). Open questions that remain are scoped to later milestones and don't affect M5
code: git checkpoints between attempts (docs/26, M6), reviewer invocation R1/R2 (docs/25,
M6), a future per-session report path migration (ADR-019, post-M5), Claude global-config
isolation (docs/33, M7).

## Explicitly Out of Scope

Implementation itself. M5.0 records decisions; implementation starts with M5.1 under
docs/39. M6–M9 features are excluded from M5 (ADR-020).

## Risks

The superseded passages listed in "M5.0 Decision Closure" could be read in isolation.
Mitigation: this document is authoritative, and docs/40 repeats the pointer.

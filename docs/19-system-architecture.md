# 19 — System Architecture: M4.x Foundation → M5–M9 Orchestration Layer

Status legend used in docs 19–40:
**EXISTING** = in the code today (see docs/20) · **PROPOSED** = recommended design,
not built · **FUTURE EXTENSION** = a boundary only, for a later milestone ·
**OPEN QUESTION** = needs an architect's decision before implementation.

## 1. Purpose

Define how AI Bridge grows from a single bounded Claude→Codex execution loop (M4.x) into a
local-first **AI Agent Orchestration Layer**:

```
Workflow → Execute → Verify → Review → Retry → Continue → Done
```

This must happen **without replacing** the M4.2/M4.3 foundation. This document is the
entry point to docs 20–40. It fixes the layers, the dependency direction, the control,
data, event and persistence flows, and it answers the 18 critical questions (§10).

## 2. Current State (EXISTING — summary of docs/20)

```
┌──────────────────────── Hosts ────────────────────────┐
│ CLI (cli.ts)          Electron Main (RunController)    │
│                       └─ run host child (1 run)        │
│ Renderer (React) ◄─ IPC (17 invoke + 2 push) ─► Main   │
└───────────────┬───────────────────────────────────────┘
                ▼
        BridgeEngine  (per project; lock, preflight, session, state, events, journal)
                ▼
        Orchestrator  (one run = bounded loop of iterations)
                ▼
  ClaudeCodeCliAdapter (executor)   CodexCliAdapter (reviewer, read-only)
                ▼
        process-runner (spawn, no shell, timeout, tree kill)

Side module, not wired: core/providers (ProviderRegistry: diagnostics only)
```

The largest unit of work that exists today is **one run** (runId `YYYY-MM-DD_NNN`): one
task, up to `maxIterations` (1–100) Claude→Codex rounds, ending in DONE / NEED_HUMAN /
ERROR / STOPPED / STOPPED_MAX_ITERATIONS / PAUSED. DONE is decided by Codex's verdict
alone; nothing is verified deterministically.

## 3. Target Architecture (PROPOSED / FUTURE)

```
┌──────────────────────────── Hosts (EXISTING, extended) ─────────────────────────────┐
│ CLI                     Electron Main: RunController + WorkflowController (M5)        │
│                         └─ workflow host child (M5)  ─┐                              │
│ Renderer: Run/Journal/Artifacts/Settings/System + Workflow view (M5) — consumer only  │
└──────────────────────────────────────────────────────┼──────────────────────────────┘
                                                       ▼
L4  Orchestration services (M6)   Verification Engine · Reviewer · Retry Policy
L3  Workflow Engine (M5)          definitions · instances · steps · attempts · budgets
    │  ExecutionPort (contract, docs/23)       │ VerificationPort (docs/24)
    ▼                                          ▼
L2  Execution Engine (EXISTING)   BridgeEngine + Orchestrator — UNCHANGED core loop
L1  Provider adapters (EXISTING)  Claude Code CLI, Codex CLI  (+ future adapters, M9)
L0  Platform (EXISTING)           process-runner, AtomicJsonWriter, integrity, redact, events

Cross-cutting registries/services:
  Provider Registry (EXISTING M4.3, diagnostics) ─► wrapped by Capability Registry (M7)
  Event & Audit (EXISTING run events + PROPOSED workflow events, docs/27)
  Storage Manager (FUTURE, docs/34)
  Memory (FUTURE M8, optional, read-only to workflows by default, docs/31)
  Multi-agent scheduler (FUTURE M9, docs/32)
```

The key rule is that **L3 and L4 call L2 through a contract and never reach into it.**
The Workflow Engine never spawns a CLI, never writes to `.ai-bridge/state/` or
`sessions/`, and never makes execution-level recovery decisions. Those stay in
BridgeEngine.

## 4. Layer Boundaries and Dependency Direction

| Layer | May depend on | Must never depend on |
|---|---|---|
| Renderer | preload API types, shared contract types | Core runtime, Node, any decision logic |
| Main / CLI hosts | Core public APIs (BridgeEngine, WorkflowEngine), host protocols | Orchestrator internals, adapters |
| Workflow host (M5, PROPOSED) | WorkflowEngine, ExecutionPort impl | Electron, renderer |
| L4 Verification/Review/Retry (M6) | L3 domain types, process-runner (for deterministic checks), Provider/Capability lookups | BridgeEngine internals, renderer |
| L3 Workflow Engine | L2 **public** API via ExecutionPort, AtomicJsonWriter, integrity, redact | Orchestrator, adapters, `.ai-bridge/state/*`, `sessions/*` writes |
| L2 BridgeEngine/Orchestrator | L1, L0 | **anything in L3/L4** (no upward imports, ever) |
| Provider/Capability registries | L0 | L2 execution internals |
| Memory (M8) | L0 | L2, L3 internals; memory is injected, never imported by L2 |

The proposed enforcement mirrors the existing `tests/architecture.test.ts`: a new test
fails if any file under `src/core/{orchestrator,bridge-engine.ts,adapters}` imports from
`src/core/workflow/**` (or from M6+ directories). **PROPOSED** for M5.1.

## 5. Control Flow (target, one workflow)

```
User/CLI/UI ──start(definitionRef, inputs)──► WorkflowEngine (in workflow host)
  validate definition (pure) → create instance (persist) → for each step in order:
    check budgets & stop/pause requests at the step boundary
    plan attempt n (persist intent: LAUNCHING)
    ExecutionPort.start({task, maxIterations, correlation}) ─► BridgeEngine.start()  [separate execution process]
        ... EXISTING loop: Claude → report → Codex → verdict ... (events forwarded)
    ◄─ BridgeRunOutcome (COMPLETED finalStatus / BLOCKED_* / …)
    map outcome → attempt result (pure table, docs/26)
    VerificationPort.verify(attempt evidence)          [M5: outcome-only; M6: deterministic + AI]
    (M6) Reviewer.review(...) — advisory, cannot override deterministic FAIL
    decide: PASS → next step | FAIL → retry (new attempt = new execution) | NEED_HUMAN → wait | budget exhausted → FAILED
  all steps passed → COMPLETED (with verification evidence level)
```

## 6. Data Flow

- **Down (Workflow → Execution):** only `task` text, `maxIterations` and (PROPOSED) an
  opaque `correlation` tag. The Workflow Engine composes the task text: the step
  instruction plus bounded, labelled context (earlier step outputs, verification failures
  on retries).
- **Up (Execution → Workflow):** the typed `BridgeRunOutcome`, plus read-only access to
  that run's artifacts through the existing BridgeEngine read APIs (`getSessionArtifacts`,
  `getJournal`, `status`, `checkRecovery`).
- **Sideways (Verification):** reads the project working tree and runs allowlisted
  commands (M6). Writes only verification records under `.ai-bridge/workflows/…`.
- **Never:** execution artifacts modified by upper layers; workflow data written into
  `sessions/`.

## 7. Event Flow

```
Orchestrator ─► BridgeEngine.logEvent ─► logs/events.jsonl        (EXISTING, unchanged)
                     │ subscribe()
                     ▼
         execution host ─IPC─► workflow host ─► WorkflowEngine
                                                 └─► workflows/<wfId>/events.jsonl   (PROPOSED)
                                                        (envelope with eventId, seq, correlation, hash)
workflow host ─IPC─► Main (WorkflowController) ─► renderer push `workflow:snapshot` / `workflow:event` (PROPOSED)
```

Workflow events **reference** run events by `(runId, iteration, event, timestamp)`; they
never copy or rewrite them (docs/27).

## 8. Persistence Flow

| Owner | Files | Rule |
|---|---|---|
| BridgeEngine (EXISTING) | `.ai-bridge/state/*`, `sessions/<runId>/*`, `reports/*`, `logs/*` | unchanged; single writer |
| WorkflowEngine (PROPOSED) | `.ai-bridge/workflows/instances/<wfId>/{instance.json, events.jsonl, attempts/*.json}` | AtomicJsonWriter for snapshots; append-only events; write-ahead attempt intent before every `start()` |
| Verification (M6) | `.ai-bridge/workflows/instances/<wfId>/verification/*` | immutable per attempt |
| Capability Registry (M7) | `.ai-bridge/capabilities/*` (project) and app userData (global) | manifests hash-pinned |
| Memory (M8) | `.ai-bridge/memory/*` | optional; human-promoted |

The workflow snapshot is authoritative for **workflow** decisions. BridgeEngine's files
are authoritative for **execution** outcomes. On disagreement after a crash, the workflow
reconciles *from* the execution files, never the other way around (docs/26 §6).

## 9. Responsibilities

- **BridgeEngine (unchanged):** everything about one run — preflight, lock, CLI
  invocation, per-iteration state, execution recovery, run events, run journal.
- **WorkflowEngine (M5):** definitions, instances, step ordering, attempts, workflow
  budgets, workflow pause/stop/resume orchestration, reconciliation, workflow events.
- **Verification Engine (M6):** evidence collection and PASS/FAIL judgement per policy.
- **Reviewer (M6):** an advisory AI assessment and a suggested correction.
- **Retry Policy (M6):** a pure decision function from (attempt result, budgets) to
  (retry | fail | wait).
- **Hosts:** process lifecycle and transport only.
- **Renderer:** presentation only.

## 10. Critical Questions — Answers

| # | Question | Answer (details in) |
|---|---|---|
| 1 | Who owns Workflow state? | The **WorkflowEngine**, persisted in `.ai-bridge/workflows/instances/<wfId>/instance.json` (single writer: the workflow host). Hosts and UI only read it. (21, 22) |
| 2 | Who owns Execution state? | **BridgeEngine/Orchestrator**, exactly as today (`state/current-session.json`, `sessions/<runId>/`). The workflow stores only a *reference* (runId) and a derived copy of the final outcome. (20, 23) |
| 3 | Can one Workflow Step create multiple executions? | **Yes, sequentially.** Each *attempt* of a step is at most one execution (one runId). Retries create new attempts, and therefore new executions. Resuming an interrupted execution does **not** create a new one. Never in parallel within one step in M5–M8. (21, 26) |
| 4 | What is the resume unit? | Two levels. **Execution resume** = BridgeEngine's iteration checkpoint of the current session (EXISTING, unchanged). **Workflow resume** = the attempt in progress: re-attach, resume its execution through `BridgeEngine.resume()`, or, if the execution already ended, adopt its outcome. The workflow never resumes mid-step logic on its own. (22, 26) |
| 5 | What happens after a crash between execution and persistence? | The execution outcome is already durable in BridgeEngine's files (final state + `RUN_COMPLETED` event). On restart, reconciliation reads it through the read APIs and records it in the attempt. The attempt's execution is **never** re-run. If the crash happened after the attempt intent was written but before any runId was recorded, the execution is identified by correlation / start time; if that stays ambiguous, the workflow goes to WAITING_HUMAN and never relaunches blindly. (26 §6) |
| 6 | How do we prevent duplicate execution? | Five layers: (1) EXISTING per-project run lock; (2) PROPOSED per-project workflow lock (one active instance); (3) a write-ahead attempt intent persisted before `start()`; (4) a deterministic attempt id plus a correlation tag on the run; (5) a rule that an attempt with a possibly started execution is never auto-relaunched. (26 §5) |
| 7 | What is retry? | A **new attempt of the same step**, i.e. a **new execution** (new runId, fresh Claude session), started because the previous attempt ended with a *classified retryable* failure. It is bounded by `maxAttempts` and the workflow budgets, and its prompt is augmented with the recorded failure evidence. (26) |
| 8 | What is resume? | Continuing the **same** execution (same runId, same Claude session/Codex thread) from BridgeEngine's persisted checkpoint through `BridgeEngine.resume()`, after a pause or crash. It does not consume an attempt. (26) |
| 9 | What is a new execution? | Any `BridgeEngine.start()` call, which gets a new runId. It happens for the first attempt of a step, for every retry, and for every later step. (23, 26) |
| 10 | How are loops bounded? | Nested hard caps: iterations per execution (EXISTING, ≤ 100); attempts per step (PROPOSED default 1 in M5, cap 5); steps per workflow (cap 50); total executions per workflow (cap 100); a wall-clock deadline per workflow; optional reported-token budget. Every cap is checked at a boundary and the reason is recorded. No unbounded configuration value is accepted. (26) |
| 11 | How does verification prevent false DONE? | An execution's DONE is treated as a **claim**. A step passes only when its `VerificationPolicy` passes: in M6, every required deterministic check (commands and exit codes run by AI Bridge, not reported by a model) must pass. A step with no deterministic checks can pass only as `AI_ATTESTED`, and that label is shown everywhere. (24) |
| 12 | How does the Reviewer interact with Verification? | The Reviewer is **one evidence source inside verification**, weighted by policy. It can turn a PASS into FAIL or NEED_HUMAN, but it can **never** turn a deterministic FAIL into PASS, and it cannot mark a step DONE by itself. (25) |
| 13 | How does the Capability Registry integrate later? | Through lookups by the Workflow Engine at *plan time*. A step declares required capabilities (role, features) and the registry resolves them to a registered provider, agent or tool. The M4.3 ProviderRegistry becomes the registry's source for `provider` entries through an adapter; it is not rewritten. Nothing is auto-installed. (28, 29) |
| 14 | How does Memory integrate later without becoming an M5 dependency? | Through an optional `MemoryPort` with a null implementation. Workflows declare memory reads as optional context inputs, and writes are proposals pending human promotion. M5 ships with no MemoryPort at all; the definition format reserves the field. (31) |
| 15 | How does multi-agent execution integrate later? | The Workflow Engine acts as a deterministic **supervisor**. Parallel steps run only in separate working trees (separate project paths, so separate BridgeEngine instances and locks), and results are joined by an explicit join step. There is no free-form agent chat. (32) |
| 16 | How does Electron observe everything without owning orchestration? | Main runs a thin WorkflowController (a sibling of RunController) that forwards commands to the workflow host and publishes a `WorkflowSnapshot` computed in Core, including allowed controls. The renderer renders snapshots and events only. (35) |
| 17 | What must NEVER be moved out of BridgeEngine? | The run lock; preflight/cost guard; CLI invocation and the adapters; the Orchestrator loop and its transition table; execution state persistence; execution recovery decisions (`decideRecoveryStrategy`, `planRecovery`); prompt and report integrity checks; execution records and redaction of CLI output; stop/pause mechanics for a run; run events and the run journal. (23, 38 ADR-001) |
| 18 | What existing M4.2/M4.3 code should remain untouched? | `orchestrator.ts`, `transitions.ts`, `recovery.ts`, both adapters, `process-runner.ts`, `execution-record.ts`, `report-validator.ts`, `codex-response-parser.ts`, `templates.ts`, `journal.ts`, `session-history.ts`, `atomic-json-writer.ts`, `run-lock.ts`, `cost-guard.ts`, `permission-mode.ts`, `core/providers/*`, the existing 17 IPC channels and their payloads. BridgeEngine is untouched except for one optional, additive, backward-compatible `correlation` field (OPEN QUESTION, docs/23 §8). (39, 40) |

## 11. External Patterns Considered

Research sources: LoopFlow (README, repo tree, and targeted reads of `runner.ts`,
`verdict.ts`, `budget.ts`, `prompt.ts`, `claude.ts`, `memory.ts`, `worktree.ts`,
`schema.ts`), Temporal, LangGraph, Inngest/Restate, MCP, Claude Code
(hooks/subagents/skills/sandboxing), Aider, SWE-agent, OpenHands, GitHub Actions,
CrewAI/AutoGen, OpenTelemetry GenAI conventions. The fetch tool summarizes pages, so
details of LoopFlow's `runner.ts` are **UNCERTAIN** at line level. The two short files
`verdict.ts` and `budget.ts` were read verbatim.

**What LoopFlow actually is:** a small (about 30 KB) TypeScript CLI. A YAML loop is a
list of steps, and each step is one headless `claude -p` call, prompt on stdin. Gate
steps must end with `VERDICT: PASS|FAIL`; the last match wins and a missing verdict is
FAIL. When a gate fails, the whole step list restarts at step 1 with the gate feedback
injected, until `max_iterations` (hard maximum 20). It tracks a USD budget and passes the
*remaining* budget as `--max-budget-usd` to each call, appends Markdown memory per loop
after each run, and optionally uses a git worktree that it keeps if dirty. It has **no**
persisted state, crash recovery, resume, timeouts or retry of transient failures, and
both roles are Claude. It is therefore *less* robust than AI Bridge's current engine, and
useful mainly for its definition format and its fail-closed verdict ideas.

| # | Pattern (source) | Problem solved | AI Bridge needs it? | Verdict |
|---|---|---|---|---|
| P1 | Workflow vs activity separation, pure decision function (Temporal) | Replay-safe orchestration logic | Yes | **ADAPT**: workflow transitions and retry decisions are pure functions (like the existing `decideRecoveryStrategy`); every CLI call and command is an "activity" recorded before the state advances. No replay engine. |
| P2 | Durable step memoization / idempotency keys (Inngest, Restate) | Re-running finished steps after a crash | Yes | **ADAPT**: deterministic attempt ids, a write-ahead intent, adopt-by-reconciliation. Memoization never re-runs file-editing work. |
| P3 | Full event-sourced replay (Temporal) | Rebuild state from history | Partially | **REJECT** replay; **ADOPT** a hybrid: atomic snapshot as source of truth, plus an append-only event log with `seq`, and `lastEventSeq` in the snapshot. |
| P4 | Retry policy + non-retryable error classes (Temporal) | Transient vs permanent failure | Yes (M6) | **ADOPT with finite caps**: an error taxonomy mapped from existing error codes; no unlimited attempts. |
| P5 | Checkpoint including the workspace (LangGraph, LoopFlow worktree) | Rollback / deterministic recovery of file state | Later | **ADAPT (FUTURE)**: M5 records read-only git evidence (HEAD, porcelain hash) per attempt. Commits or stash refs in the user's repo are an OPEN QUESTION for M6. |
| P6 | Timeouts + heartbeats (Temporal, MCP) | Hung processes | Partly exists | **ADOPT**: keep the per-call timeouts (EXISTING), add a workflow deadline (M5) and an inactivity timeout (FUTURE; runProcess buffers output, so it needs streaming). |
| P7 | Human-in-the-loop interrupts (LangGraph `interrupt`) | Durable wait for a human decision | Yes | **ADOPT semantics**: WAITING_HUMAN with a typed request and a typed, logged answer; resume only at step boundaries. |
| P8 | Stuck detection (OpenHands) | Budget burned without progress | Yes (M6) | **ADOPT, simplified**: repeated identical next prompt, unchanged workspace digest, or repeated identical verification failure → NEED_HUMAN. |
| P9 | Deterministic verifier before the LLM judge (Aider, SWE-agent) | Unreliable "it works" claims | Yes | **ADOPT** (M6): AI Bridge runs the checks itself; a deterministic FAIL cannot be overridden by any model. |
| P10 | Critic loop and rubber-stamp mitigation (AutoGen reflection; LLM-judge bias research) | Reviewers tend to approve | Yes | **ADAPT**: keep cross-model review (EXISTING); require evidence citations; fail-closed parsing; track approval rate. |
| P11 | Fail-closed structured verdicts (LoopFlow `parseVerdict`, MCP output schemas) | Ambiguous output read as success | Already partly | **ADOPT**: EXISTING parser already fails closed; extend the same rule to verification and review. |
| P12 | Composable termination reasons (AutoGen, LoopFlow outcomes) | Many reasons to stop | Yes | **ADOPT as an enum** with a fixed priority. |
| P13 | Declarative definitions (LoopFlow YAML + Zod, GitHub Actions) | User-authored flows, auditable | Yes | **ADAPT**: JSON with a hand-written validator (no new dependency), a small vocabulary, no expression language, the definition hash recorded. |
| P14 | Typed step outputs + bounded context (GH Actions outputs, LoopFlow caps) | Prompt bloat, implicit coupling | Yes | **ADOPT**: explicit outputs, per-section caps, truncation recorded. |
| P15 | Capability manifests / negotiation (MCP `initialize`, Claude subagent frontmatter) | Knowing what a component can do | Yes (M7) | **ADOPT**: manifest with `provides/requires/permissions/hash`. |
| P16 | Progressive disclosure (Claude skills) | Token cost of capability descriptions | Later | **ADAPT (M7)**. |
| P17 | Least-privilege permission profiles (Claude permission modes, Codex sandbox) | Over-privileged steps | Yes | **ADOPT**: per-role profile; record the effective profile. On native Windows, CLI sandboxes are not treated as a security boundary. |
| P18 | Worktree isolation (LoopFlow, Claude subagents) | Parallel runs colliding | M9 | **ADAPT (FUTURE M9)**: required for parallelism; not default in M5 (it changes the user's repo layout). |
| P19 | Trust tiers for third-party plugins / MCP (MCP spec, Claude managed hooks) | Malicious extensions | Yes (M7) | **ADAPT**: BUILTIN / FIRST_PARTY / USER_LOCAL / THIRD_PARTY tiers; third-party disabled by default and hash-pinned. |
| P20 | Lifecycle hooks (Claude Code hooks) | Policy without forking the engine | Later | **ADAPT (FUTURE)**: internal typed hooks first; user command hooks only under trust tiers. |
| P21 | Trace/span correlation (OpenTelemetry GenAI) | Linking runs, steps, calls | Yes | **ADAPT**: `correlationId/causationId/eventId` in files only; no collector, no dependency. |
| P22 | Layered budgets; per-call `--max-budget-usd` (LoopFlow) | Runaway spend | Partly | **ADAPT**: iteration/attempt/time/reported-token budgets. **REJECT USD budgets** for now: AI Bridge refuses API-key billing, and the flag is UNCERTAIN for subscription logins and unverified in this repo. |
| P23 | Supervisor vs peer delegation (CrewAI, AutoGen, Claude subagents) | Coordinating several agents | M9 | **ADAPT**: a deterministic engine as supervisor. **REJECT** an LLM manager as orchestrator and free-form group chat. |
| P24 | Memory layers with provenance (LangGraph Store, LoopFlow memory) | Knowledge across runs | M8 | **ADAPT**: run / project / long-term; human promotion; graph as a rebuildable projection. |
| P25 | Dry-run / prompt preview (LoopFlow `--dry-run`) | Debug definitions for free | Yes | **ADOPT** in M5 validation. |
| P26 | LoopFlow "restart from step 1 on gate failure" | Re-running upstream steps | No | **REJECT**: AI Bridge retries only the failed step; earlier verified steps are not redone. |
| P27 | Embedded expression/scripting language in definitions | Flexibility | No | **REJECT**: security and determinism cost. |

## 12. Failure Cases (system level)

| Failure | Layer that handles it | Behavior |
|---|---|---|
| CLI failure inside a run | L2 (EXISTING) | Run ends ERROR with a code; L3 classifies it (docs/26). |
| Crash of the execution process | L2 recovery (EXISTING) + L3 reconciliation | INTERRUPTED → workflow resumes the same run if RECOVERABLE, else WAITING_HUMAN. |
| Crash of the workflow host | L3 reconciliation | On restart, adopt the execution outcome; never re-run. |
| Crash of Electron Main | hosts | (Corrected in M5.8.1, docs/23 §11.1.) On Windows, children forked by Main end with it: the workflow host and an ordinary run host end. A workflow's in-flight execution host is `independent` and keeps running; it is reconciled on the next resume. |
| Verification command hangs | L4 | Per-check timeout → FAIL(TIMEOUT) evidence. |
| Budget exceeded | L3 | Terminal FAILED with reason BUDGET_*; a running execution is stopped via `BridgeEngine.stop()` only for a deadline. |
| Definition invalid | L3 validation | Rejected before any execution. |

## 13. Decisions

See docs/38 (ADR-001 to ADR-017). Key: ADR-001 (the Workflow Engine sits above
BridgeEngine), ADR-012 (retry = new execution), ADR-013 (JSON definitions),
ADR-014 (execution outcome source of truth). Still OPEN: ADR-011 (workflow host process
model; a separate process is recommended) and ADR-017 (run correlation).

## 14. Open Questions

1. Workflow host process model: separate workflow host plus per-execution child (recommended), or the workflow engine inside the run host. (ADR-011)
2. Correlation: add an optional `correlation` field to `BridgeStartOptions` (additive), or rely on reconciliation by start time only. (docs/23 §8)
3. Should `reports/` become per-session before multi-execution workflows, given that workflows multiply overwrites? (docs/34)
4. Workspace evidence: is read-only git evidence enough for M6 retries, or are git checkpoints needed? (docs/26)
5. Where do workflow definitions live: in the project (`.ai-bridge/workflows/definitions/`), in the repo (committed), or in app userData? (docs/36)

## 15. Explicitly Out of Scope

Implementation of anything; changing BridgeEngine behavior; parallel execution on one
working tree; cloud or remote execution; API-key billing; USD budgets; automatic capability
installation; Memory/Graphify implementation.

## 16. Risks

| Risk | Mitigation |
|---|---|
| The workflow layer starts re-implementing execution concerns (retrying CLI calls, parsing CLI output) | ExecutionPort is the only path down; the proposed architecture test; ADR-001. |
| Two sources of truth (workflow snapshot vs execution files) disagree | A defined precedence: execution files win for execution facts; reconciliation is a pure function and is tested. |
| Cost multiplication (retries × iterations × steps) | Nested hard caps; M5 default is 1 attempt per step; real E2E needs explicit approval. |
| False DONE from AI-only acceptance | The `AI_ATTESTED` label; deterministic checks required for `VERIFIED`. |
| Scope creep from external frameworks | Adopt/adapt/reject table (§11); no framework imports. |

# 32 — Multi-Agent / Multi-Model Architecture (M9, ARCHITECTURE ONLY)

## 1. Purpose

Explain how AI Bridge could later support multiple agents and providers, specialist
agents, parallel execution and delegation, while keeping the single-writer, bounded,
auditable properties of the current engine.

## 2. Current State (EXISTING)

- It is already multi-model in a fixed shape: Claude (executor) plus Codex (reviewer),
  different vendors, alternating strictly within one run.
- The hard constraints that shape M9:
  - **One run lock per project directory** (`state/lock`) and **one current session per
    project** (`current-session.json`). Two executions cannot share a working tree.
  - `BridgeEngine` is scoped to one `projectPath`.
  - The Orchestrator is typed to the two concrete adapters (docs/30 §2).
  - `stop()` kills the lock holder's process tree.

## 3. Proposed Design

### 3.1 Supervisor model (ADAPT from CrewAI/AutoGen; REJECT LLM manager)

The **Workflow Engine is the supervisor**. It is deterministic, persisted and bounded.
Agents are invoked only as steps. There is no LLM "manager agent" deciding who runs next,
and no free-form agent-to-agent chat.

### 3.2 Specialist agents

Specialists are agent configurations (docs/29): for example `executor-frontend` (Claude +
UI skill text), `executor-tests` (Claude + test-writing skill), `reviewer-security`
(Codex + security review template). A step selects one by requirement (docs/28). Each
specialist still runs through BridgeEngine, as the executor role of a run.

### 3.3 Parallel execution (FUTURE)

```
step "fan-out" ─► branch A: worktree A (project path A) ─► BridgeEngine(A).start
               └► branch B: worktree B (project path B) ─► BridgeEngine(B).start
step "join"    ─► deterministic merge check (git merge --no-commit in a scratch worktree, or a human)
               ─► verification on the merged tree
```

- Parallelism = **separate working trees = separate project paths**. This gives
  separate BridgeEngine instances, separate locks and separate `.ai-bridge/` state,
  reusing the EXISTING per-project isolation unchanged.
- Worktree creation and cleanup is a workflow-host responsibility (keep-if-dirty, as in
  LoopFlow). OPEN QUESTION: `.ai-bridge/` placement per worktree vs the main repo.
- Concurrency cap: the number of parallel branches ≤ N (PROPOSED 2), because subscription
  quota is shared per account.
- Workflow state stays single-writer: branches report results to the supervisor, which
  alone updates `instance.json`.

### 3.4 Delegation

- An agent may *propose* sub-tasks in its report (e.g. `## REMAINING WORK`). Turning
  proposals into steps requires either (a) a definition that declares a "dynamic steps"
  slot with a fixed maximum and allowed agent kinds, validated before execution, or (b)
  human approval. Delegated steps count against the same budgets.
- Delegation depth cap: 1 (a delegated step cannot delegate further). OPEN QUESTION whether to allow 2.

### 3.5 Multiple providers per role

- M9 introduces the `ExecutorAdapter`/`ReviewerAdapter` interfaces (docs/30 §4.3). The
  Orchestrator is parameterized by interface, not by class. This is the single M4-core
  change planned for M9, and it needs its own ADR and a full regression run.
- Multi-reviewer voting (optional): N reviewers, and APPROVE requires all (a "minority
  veto"), because judges reject bad work less reliably than they accept good work
  (docs/19 §11 P10).

## 4. Responsibilities

The supervisor (WorkflowEngine) owns scheduling, joins and budgets. The branches
(BridgeEngine instances) own their executions. Verification runs on joined results.

## 5. Boundaries

- No shared mutable state between branches except the supervisor's records.
- No branch may write another branch's `.ai-bridge/`.

## 6. Data Flow

Supervisor → per-branch ExecutionPort (a different projectPath each) → outcomes → join
step → verification → continue.

## 7. Failure Cases

| Case | Handling |
|---|---|
| One branch fails | Policy: fail-fast (stop the other branches via their own `stop()`) or wait-all; recorded |
| Merge conflict at join | Join step FAIL → NEEDS_HUMAN (never auto-resolved by an agent in the first M9 version) |
| Quota exhausted mid fan-out | QUOTA class → NEEDS_HUMAN for affected branches |
| A crash with parallel branches | Per-branch reconciliation (docs/26 §6), each against its own project path |

## 8. Decisions

ADR-004, ADR-005, ADR-009; a future ADR for Orchestrator interface extraction.

## 9. Open Questions

Worktree placement and cleanup policy; the join strategy; the concurrency cap; whether
different providers may share a worktree sequentially within one step.

## 10. Explicitly Out of Scope

Any implementation; agents communicating directly; distributed or multi-machine execution.

## 11. Risks

- Cost and quota multiplication: caps plus quota classification.
- Merge complexity: explicit join steps and human fallback.
- Premature generalization of the Orchestrator: deferred until M9 is scheduled.

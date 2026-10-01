# 53 — M9 Multi-Agent / Multi-Model / Parallel Execution: Architecture (PROPOSED — documentation only)

Extends docs/32 (multi-agent), docs/30 §4.3 (the future execution adapter contract) and docs/29
(agents are configurations, ADR-016). Status legend: see docs/41. PROPOSED ADRs: ADR-039 …
ADR-045 (docs/58).

## 0. Section map (the 25 required items for M9)

| # | Item | Where |
|---|---|---|
| 1–6 | Purpose, problem, scope, non-goals, changes, concepts, responsibilities | this doc §1–§8 |
| 7 | Contracts | docs/54 |
| 8–13 | State machines, persistence, events, recovery, security, hard limits | docs/55 |
| 14–19, 25 | CLI, Main, UI, testing, real E2E, failure modes, acceptance | docs/56 |
| 20–24 | Compatibility, dependencies, open questions, ADRs | this doc §9–§13 |

## 1. Purpose

Allow one workflow to use **several agents, sessions and (later) providers**, including **bounded
parallel branches** in isolated git worktrees and **cross-agent verification**, while keeping
the Workflow Engine the only, deterministic supervisor.

## 2. Problem being solved

Independent sub-tasks (frontend and backend, or implementation and tests) run strictly one after
the other. Every step uses the same executor configuration. Reviews always come from one
provider. And nothing can use a second Claude or Codex session concurrently, because the M5
architecture is deliberately single-execution per project.

## 3. Current constraints (EXISTING, verified — M9 must respect or explicitly extend them)

| Constraint | Where | Consequence for M9 |
|---|---|---|
| One run lock per project path (`.ai-bridge/state/lock`); one current session (`current-session.json`) | BridgeEngine | two concurrent executions need **two project paths** → worktrees |
| `BridgeEngine` is scoped to one `projectPath` | bridge-engine.ts | one BridgeEngine (and one ExecutionPort) **per worktree** |
| One Workflow Host per project (`state/workflow-lock`), single writer of the instance | M5.3, M5.8 | stays: the supervisor remains **one** process and writer |
| `ForkedExecutionPort` refuses a second concurrent execution (`EXECUTION_PORT_BUSY`) | forked-execution-port.ts | stays per port; M9 uses **several ports** |
| The decider plans at most one live attempt (`liveAttempt()`) | decider.ts | M9 generalizes this **only inside a parallel group** (ADR-040) |
| The Orchestrator is typed to the two concrete adapters | orchestrator.ts | multi-provider needs the interface extraction (ADR-041) |
| `ExecutionRecord.agent` is `'claude' \| 'codex'` | execution-record.ts | identity generalization (ADR-042) |
| Execution Hosts are `independent`; the Workflow Host is `with-parent` | M5.8.1 | N branch Execution Hosts survive a Workflow Host or Main crash and are reconciled one by one |

## 4. Scope (M9)

- **Multiple sessions**: several Claude executions and Codex reviews in one workflow, concurrently
  only in separate worktrees, and sequentially otherwise.
- **Specialized agents**: agent configurations (M7) per step or branch.
- **Supervisor**: the WorkflowEngine plans branches, applies budgets, joins and verifies.
- **Reviewer agents and cross-agent verification**: the reviewer provider ≠ the executor provider;
  optional multi-reviewer with a minority veto (ADR-045).
- **Parallel execution**: definition schema 2 parallel groups (fan-out → branches → join),
  bounded concurrency (ADR-040).
- **Worktree isolation**: one git worktree per code-changing branch; opt-in git mutation
  (ADR-039, ADR-044).
- **Merge / conflict / verification** at the join (ADR-043).
- **Future providers**: the `ExecutorAdapter` / `ReviewerAdapter` interfaces (ADR-041) and
  provider identity (ADR-042). Adding a real third provider is a separate milestone that uses
  them.

## 5. Explicit non-goals

- **No LLM workflow manager**, no agent-chosen next step, no free-form agent-to-agent chat (docs/32
  §3.1, P23).
- No unbounded or recursive delegation. Delegation depth is ≤ 1, and every delegated step is
  validated before it runs (docs/32 §3.4).
- No distributed or multi-machine execution; no cloud workers.
- No automatic conflict resolution by an agent in M9.0 (conflicts → NEEDS_HUMAN).
- No API-key (HTTP) providers. The subscription-only rule (docs/30 §11) is unchanged.
- No shared mutable state between branches other than the supervisor's records.
- No pushing, no remote branches, no changes to the user's checked-out branch (ADR-044).

## 6. Architectural changes

```
                              Workflow Host (single writer; EXISTING process model)
 ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 │ WorkflowEngine + decider (schema-2 groups, bounded live attempts)                        │
 │   ├─ WorktreeManager (NEW): create / inspect / retain / remove worktrees (opt-in)       │
 │   ├─ BranchPortFactory (NEW): one ExecutionPort + ReviewPort per worktree path           │
 │   ├─ JoinCoordinator (NEW): deterministic merge in a scratch worktree → M6 verification  │
 │   └─ VerificationEngine (M6) · CapabilityResolver (M7) · ContextAssembler (M8, optional) │
 └──────┬─────────────────────────────┬────────────────────────────┬───────────────────────┘
        │ fork (independent)          │ fork (independent)         │ fork (independent)
        ▼                             ▼                            ▼
 Execution Host A (worktree A)  Execution Host B (worktree B)  Review Host (merge worktree)
 BridgeEngine(A) + adapters     BridgeEngine(B) + adapters     BridgeEngine(M).review()
```

| Component | Change | Status |
|---|---|---|
| Definition schema | **schema 2**: `parallel` groups, `join`, `failurePolicy`, `maxConcurrency` (ADR-040, per ADR-013's own consequence) | PROPOSED |
| Decider | multiple live attempts **inside one group**, bounded by `maxConcurrency`; group/branch states; join | PROPOSED (a major decider change; ADR-021 replay guard) |
| WorktreeManager | new; git worktree add/remove/list via `runProcess`; opt-in | PROPOSED |
| Execution ports | per worktree (reusing `ForkedExecutionPort` unchanged, each with its own `projectPath`) | PROPOSED |
| Orchestrator | typed against `ExecutorAdapter`/`ReviewerAdapter`, **behavior identical** (ADR-041) | PROPOSED (M4-core change) |
| Execution records | `agent` → a provider id + agent ref + model (reported or UNKNOWN) (ADR-042) | PROPOSED (a record schema bump) |
| Hosts / UI | N owned executions, branch lanes, merge results | PROPOSED |

## 7. Domain concepts

| Concept | Meaning |
|---|---|
| **Supervisor** | The WorkflowEngine (deterministic, persisted, bounded). The only planner and writer |
| **Agent** | A configuration (ADR-016): provider + role + profile + prompts + limits, from the M7 registry |
| **Agent identity** | `agentRef = agent:<name>@<version>#<contentHash>` (M7) |
| **Provider / model identity** | `providerRef = provider:<adapterId>@<cliVersion>`; `model` = what the CLI reports for the call, else `UNKNOWN` (ADR-042) |
| **Parallel group** | A schema-2 construct: N branches started together, then a join |
| **Branch** | An ordered list of steps executed sequentially in one worktree |
| **Worktree** | A git worktree created from the group's recorded base commit; one per code-changing branch |
| **Join** | The group's end: collect branch results, merge deterministically, verify the merged tree |
| **Scratch (merge) worktree** | The worktree where the join merge happens; never the user's working tree |
| **Cross-agent verification** | A review of an attempt by an agent whose provider differs from the executor's; optionally N reviewers with a minority veto |
| **Artifact envelope** | The only inter-agent communication: a typed reference to an artifact with its producer identity and hash (docs/54 §3) |
| **Delegation proposal** | An agent's suggested sub-task in its report. It becomes a step only through a declared slot or a human (docs/54 §6) |

## 8. Responsibilities

| Role | Does | Never does |
|---|---|---|
| **Supervisor** (WorkflowEngine) | plans groups/branches/steps; enforces budgets and concurrency; provisions worktrees (via WorktreeManager); starts, stops and reconciles executions through ports; joins; triggers verification; decides retries; writes all workflow state | ask a model what to do next; let a branch write workflow state |
| **Agent** (a configuration running as a provider CLI) | performs one step's task in its worktree; writes its report; proposes follow-ups as text | talk to other agents; read or write another worktree; change workflow state |
| **Execution** (BridgeEngine per worktree) | runs one execution with the EXISTING loop, lock, records, recovery | know about branches, groups or other executions |
| **Verification** (M6 engine) | verifies each branch attempt in its worktree and the merged tree at the join; runs cross-agent reviews | merge; resolve conflicts; raise evidence levels from reviews |

## 9. Backward compatibility (item 20)

1. Schema-1 definitions run exactly as before: sequential, one live attempt, one project path,
   no worktree, no git mutation.
2. ADR-041's interface extraction must keep the Orchestrator's behavior, argv, files and all
   EXISTING tests unchanged (an isolated commit, a full regression, the M5 real E2E re-run).
3. Execution record schema bump (ADR-042): readers accept v1 (`agent: 'claude'|'codex'`) and v2;
   v1 records are shown with `model: UNKNOWN`.
4. Worktrees are created only when a project opts in **and** a schema-2 definition asks for them.
5. Downgrade: an M8 build rejects schema 2 (the validator requires `schema: 1`), failing closed.

## 10. Dependencies on previous phases (item 21)

| Needs | From | Why |
|---|---|---|
| M6 released | M6 | join verification, per-branch retries, ReviewPort for cross-agent review |
| M7 released | M7 | agent identities, deterministic resolution, execution profiles, provider manifests |
| M8 | optional | per-agent memory keys; not required |
| M5.8.1 lifetime model, ADR-017 correlation | M5 | per-branch reconciliation after crashes |

## 11. Dependencies on later phases (item 22)

None within M5–M9. A real third provider (for example another vendor's CLI) is a **post-M9**
milestone built on ADR-041/042. Remote execution is out of scope.

## 12. Open questions (item 23)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-M9-01 | Worktree placement: a sibling directory (`<project>/../.ai-bridge-worktrees/<wf>/<branch>`), app userData, or inside `.ai-bridge/`? | A sibling or userData directory, never inside the project tree (avoid nested repositories); decide in M9.0 | **M9.0** |
| OQ-M9-02 | Join strategy: git merge of branch commits, sequential patch application, or human? | A deterministic `git merge --no-ff --no-commit` in the scratch worktree, in declared branch order; conflicts → NEEDS_HUMAN | M9.6 |
| OQ-M9-03 | The concurrency default and cap vs per-account quota | Default 2, hard cap 4 (docs/32 proposed 2) | M9.5 |
| OQ-M9-04 | Delegation depth 1 or 2 (docs/32 §3.4) | 1 | no |
| OQ-M9-05 | Different providers sharing one worktree sequentially within a step | Allowed only sequentially (e.g. executor then reviewer), never concurrently | no |
| OQ-M9-06 | Who commits branch work so it can be merged? | The supervisor commits in the **branch worktree** on a dedicated `ai-bridge/<wf>/<branch>` branch after verification (git mutation → ADR-044 opt-in) | M9.3 |
| OQ-M9-07 | Model identity evidence: does each CLI report the model per call? | Record it if reported (the stream-json init/result events are candidates, UNVERIFIED); else UNKNOWN | M9.1 |
| OQ-M9-08 | Quit dialog semantics with N owned executions | The same two choices; STOP stops every branch through its BridgeEngine | M9.9 |
| OQ-M9-09 | Where each worktree's `.ai-bridge/` lives, and how journals link across worktrees (docs/32 §3.3) | Each worktree has its own `.ai-bridge/` (separate locks); the supervisor records absolute worktree paths plus runIds; journal links through recorded paths | M9.3 |

## 13. ADRs required (item 24)

ADR-039 (parallelism = per-branch worktrees; single supervisor writer), ADR-040 (definition
schema 2 with bounded groups), ADR-041 (the execution adapter interface extraction), ADR-042
(agent/provider/model identity in records), ADR-043 (join and merge policy), ADR-044 (opt-in
git mutation, never push, never touch the user's branch), ADR-045 (the cross-agent verification
policy). All are PROPOSED.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Quota multiplication | Concurrency cap; the QUOTA class is never retried; a `maxReportedTokens` budget is strongly recommended for schema 2 |
| Merge complexity | Deterministic join; human fallback; verification of the merged tree |
| Git surprises in the user's repository | Opt-in; dedicated branch namespace; no push; keep-if-dirty; a worktree registry |
| Premature generalization of the Orchestrator | ADR-041 is limited to typing; behavior is frozen by tests |
| The decider complexity jump | Groups are the only place with >1 live attempt; ADR-021 replay guard; an exhaustive crash matrix |

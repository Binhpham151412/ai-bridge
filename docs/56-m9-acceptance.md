# 56 — M9 Multi-Agent / Parallel: Hosts, UI, Testing, Real E2E, Failure Modes, Increments, Acceptance (PROPOSED)

Covers items 14–19 and 25 of the M9 definition (docs/53 §0). Status legend: see docs/41.

## 1. CLI implications (item 14)

- `workflow run` of a schema-2 definition: refused unless the project opt-in (`gitMutation`) is
  set; `validate` prints the groups, branches, concurrency, worktree plan and git commands that
  will be used.
- `workflow status`: per group → branches → steps/attempts, with `executionKey`, worktree path
  and state, and merge results.
- `ai-bridge worktree list|discard <worktreeId>` (NEW): shows RETAINED worktrees; `discard` removes
  one after confirmation (only for terminal workflows).
- The CLI process remains the single Workflow Host; it forks N Execution Hosts (`independent`).

## 2. Electron / Main implications (item 15)

- WorkflowController is unchanged in role. Snapshots grow group/branch sections (Core-derived).
- The quit dialog lists the number of live branch executions; "STOP workflow và thoát" stops all
  of them through each branch's BridgeEngine, then quits (M5.8.1 rule; OQ-M9-08).
- A Main crash → the Workflow Host dies → all branch Execution Hosts survive → on relaunch the
  workflow shows INTERRUPTED; RESUME reconciles every branch (docs/55 §8).
- New IPC reads: `workflow:getGroup {workflowId, groupStepId}`, `workflow:listWorktrees`; an
  action `workflow:discardWorktree {worktreeId}` (Main native confirmation).

## 3. Renderer / UI implications (item 16)

- Branch lanes inside a group card: each lane shows its steps, attempts, agent/provider/model
  identity (`model: UNKNOWN` shown as such), worktree state.
- A join panel: merge order, per-branch result (CLEAN/CONFLICT, conflicted paths), merged-tree
  verification with its evidence level.
- A worktrees panel: RETAINED worktrees with their paths and a discard action.
- Still a pure consumer: concurrency, availability and merge outcomes come from Core.

## 4. Testing strategy (item 17)

| Area | Tests |
|---|---|
| Schema 2 validator | groups, branch limits, nesting refused, cross-branch output references refused, caps |
| Decider | group/branch/worktree machines; ≤ `maxConcurrency` live attempts; fail-fast vs wait-all; stop cascade; pause per branch; exhaustive tables |
| ADR-021 | all M5–M8 golden logs replay identically under the M9 decider |
| Adapter extraction (ADR-041) | every EXISTING Orchestrator/BridgeEngine test unchanged; argv byte-identical; fake adapters implementing the interfaces |
| Identity (ADR-042) | v1/v2 execution records readable; `executionKey` uniqueness across worktrees with colliding runIds |
| WorktreeManager | temp git repos: create/commit/merge/conflict/remove/retain; never touches the main worktree's HEAD/branch (asserted) |
| Crash matrix | kill the Workflow Host with 2 live branches → both reconciled (WATCH/ADOPT), zero duplicate executions; kill during a merge → redone deterministically |
| Windows lifetime | two independent Execution Hosts survive a Workflow Host and a Main crash (the M5.8.1 test pattern, N=2) |
| Security | `--add-dir` still refused; agents cannot see sibling worktrees; no git remote commands issued (a spawn audit) |
| UI | branch lanes from snapshots; UNKNOWN model shown |

## 5. Real E2E strategy (item 18; quota — explicit approval; about 2× M6 cost)

| Scenario | Must show |
|---|---|
| P1 two read-only branches | 2 worktrees, 2 concurrent executions (distinct `executionKey`s, overlapping lifetimes), join CLEAN, merged verification |
| P2 two editing branches, disjoint files | CLEAN merge; merged-tree checks VERIFIED; the user's branch untouched |
| P3 conflicting branches (same file) | CONFLICT → WAITING_HUMAN; worktrees RETAINED |
| P4 Workflow Host crash with 2 live branches | both adopted; zero duplicates |
| P5 Main crash with 2 live branches | both survive; relaunch → RESUME → both adopted |
| P6 fail-fast | one branch fails → the sibling is stopped (no orphan) |
| P7 cross-agent review | reviewer provider ≠ executor provider enforced; minority veto demonstrated with a forced REJECT fixture where possible (else recorded honestly) |

## 6. Failure modes (item 19)

| Failure | Result |
|---|---|
| The opt-in is missing | the schema-2 run is refused before any git command |
| The main worktree is dirty in the touched paths | the group BLOCKED at PROVISIONING |
| `git worktree add` fails (path exists, lock) | the group BLOCKED; nothing ran |
| Two worktrees produce the same runId | disambiguated by `executionKey` (by design) |
| A merge conflict | WAITING_HUMAN; RETAINED worktrees |
| Quota exhausted mid fan-out | QUOTA → the group waits; never retried |
| A branch Execution Host dies | the per-branch M5.6 decision (RESUME if RECOVERABLE, else NEEDS_HUMAN) |
| Disk full while creating a worktree | BLOCKED (ENVIRONMENT); the registry intent is cleaned |
| Leftover worktrees after a crash | listed as RETAINED/RELEASED-pending; never deleted while dirty |

## 7. Implementation increments (M9.0 – M9.11)

| Inc. | Objective | Depends on |
|---|---|---|
| **M9.0** | Decision closure (ADR-039 … 045), OQ-M9-01/02/06/07/09 answered | M6 + M7 released |
| **M9.1** | Identity: execution record v2, `executionKey`, provider/model identity (UNKNOWN rules) | M9.0 |
| **M9.2** | Adapter interface extraction (ADR-041), behavior-frozen, isolated commit + full regression + M5 real E2E re-run | M9.0 |
| **M9.3** | WorktreeManager + the opt-in + the registry (no parallelism yet; single-branch "worktree mode" tested) | M9.1 |
| **M9.4** | Per-worktree BranchPorts (ExecutionPort/ReviewPort unchanged) | M9.3 |
| **M9.5** | Schema 2 validator + decider groups/branches + concurrency + budgets | M9.4 |
| **M9.6** | Join: commit, deterministic merge, conflict handling, merged-tree verification (M6) | M9.5 |
| **M9.7** | Cross-agent verification (ADR-045) + multi-reviewer | M9.2, M6 ReviewPort |
| **M9.8** | Recovery: the per-branch crash matrix, merge redo, worktree reconciliation | M9.5, M9.6 |
| **M9.9** | CLI + desktop + UI | M9.5–M9.8 |
| **M9.10** | Real E2E (§5) | all |
| **M9.11** | Release audit | M9.10 |

M9.2 (adapter extraction) is independent of M9.3–M9.6 and may be done first, because it is the
riskiest M4-core change.

## 8. Acceptance criteria (item 25)

| ID | Criterion |
|---|---|
| AC-M9-01 | Schema-1 definitions behave exactly as in M8 (sequential, no worktrees, no git mutation) |
| AC-M9-02 | The adapter extraction leaves every EXISTING test, the argv and the files unchanged; the M5 real E2E still passes |
| AC-M9-03 | Concurrency never exceeds `maxConcurrency` ≤ 4; each branch has ≤ 1 live execution; outside groups ≤ 1 overall |
| AC-M9-04 | The Workflow Host remains the only writer of workflow state; no branch writes supervisor files (an architecture test) |
| AC-M9-05 | Parallel branches run only in separate worktrees; the user's worktree HEAD/branch is never modified; no remote git command is issued |
| AC-M9-06 | Merges are deterministic (the same branch commits → the same merge result); conflicts → WAITING_HUMAN; never auto-resolved |
| AC-M9-07 | The merged tree is verified by M6 before the group succeeds; the evidence rules are unchanged |
| AC-M9-08 | Every crash scenario (Workflow Host, Main, one branch host) ends with zero duplicate executions and per-branch reconciliation |
| AC-M9-09 | Cross-agent verification enforces reviewer provider ≠ executor provider; minority veto |
| AC-M9-10 | Records carry the agent/provider identity and the model, or UNKNOWN (never guessed) |
| AC-M9-11 | All hard limits of docs/55 §10 enforced; no LLM chooses a step, agent or branch |
| AC-M9-12 | The real E2E P1, P2, P3, P4, P5, P6 pass; P7 recorded honestly; zero orphan processes and zero unexpected worktrees |
| AC-M9-13 | The full regression is green; all earlier golden logs replay identically |

## 9. M9.0 entry gate (READY FOR IMPLEMENTATION, M9)

- [ ] M6 and M7 released (M8 optional)
- [ ] ADR-039 … ADR-045 ACCEPTED
- [ ] OQ-M9-01, 02, 06, 07, 09 answered
- [ ] Model-identity evidence verified on the installed CLIs (or UNKNOWN accepted in writing)
- [ ] The git-mutation opt-in UX reviewed (what the user is told before the first worktree is created)

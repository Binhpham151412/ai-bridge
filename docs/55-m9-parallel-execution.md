# 55 — M9 Parallel Execution: Groups, Worktrees, Join, State, Persistence, Recovery, Security, Limits (PROPOSED)

Covers items 8–13 of the M9 definition (docs/53 §0). Status legend: see docs/41.

## 1. Definition schema 2: parallel groups (ADR-040)

```jsonc
{ "schema": 2, "id": "feature-fanout", "version": 1, "title": "Frontend + backend in parallel",
  "requires": { "gitMutation": true },                        // the per-project opt-in must also be on (ADR-044)
  "steps": [
    { "id": "plan", "...": "a normal schema-1-style step" },
    { "id": "build-both", "parallel": {
        "maxConcurrency": 2,                                  // ≤ the global cap (4)
        "failurePolicy": "fail-fast",                         // or "wait-all"
        "branches": [
          { "name": "backend",  "steps": [ { "id": "api",  "...": "..." } ] },
          { "name": "frontend", "steps": [ { "id": "ui",   "...": "..." } ] }
        ],
        "join": { "order": ["backend", "frontend"],           // the deterministic merge order
                  "verification": { "checks": [ /* M6 CheckSpecs on the merged tree */ ], "acceptAiOnly": false } } } },
    { "id": "document", "...": "sequential again, sees the merged tree" }
  ] }
```

Rules: no nested groups; no expressions, conditions or loops (ADR-013 holds); branches are
lists of ordinary steps; step ids are unique across the whole definition; outputs flow into
later steps only via the join (a branch cannot read a sibling's outputs); `maxConcurrency` ≤ the
branch count ≤ 4.

## 2. State machines

### 2.1 Group

```
PENDING ─► PROVISIONING (worktrees) ─► RUNNING (branches) ─► JOINING (merge) ─► VERIFYING (merged tree) ─► SUCCEEDED
   │              │                         │                    │                     │
   │              └── worktree failure ─────┴── fail-fast/stop ──┴── conflict ─────────┴──► FAILED | WAITING_HUMAN | STOPPED
```

### 2.2 Branch

```
PENDING ─► RUNNING(step k of n; attempts as in M6, one live attempt per branch) ─► SUCCEEDED ─► COMMITTED (supervisor commit on ai-bridge/<wf>/<branch>)
                 └──► FAILED | STOPPED | CANCELLED (a sibling failed under fail-fast)
```

### 2.3 Worktree

```
ABSENT ─► CREATED (git worktree add <path> -b ai-bridge/<wf>/<branch> <baseCommit>) ─► IN_USE ─► RELEASED
                                                                                       ├─► REMOVED  (clean, merged, policy allows)
                                                                                       └─► RETAINED (dirty, failed, or conflict: keep-if-dirty)
```

### 2.4 Instance / step invariants

- The instance states are unchanged. A group is one step from the instance's point of view.
- At most `maxConcurrency` live attempts exist, **only inside one RUNNING group**, and at most one
  per branch. Outside groups the M5 invariant (≤ 1 live attempt) still holds.
- Pause: it applies at branch step boundaries (each branch pauses independently); the group is
  PAUSED when every branch has paused or ended.
- Stop: it cascades to every live branch execution through **its own** `BridgeEngine.stop()`.

## 3. Worktree isolation

| Aspect | Rule |
|---|---|
| Opt-in | a per-project setting (`config.json` field, default false) **and** schema-2 `requires.gitMutation`. Both are required (ADR-044) |
| Base | the group records `baseCommit = HEAD` of the main worktree at PROVISIONING; the main worktree must be clean for the paths the group touches (else BLOCKED) |
| Placement | outside the project tree (OQ-M9-01); a path derived from `worktreeId`, never caller-supplied |
| Branch names | `ai-bridge/<workflowId>/<branchName>`; never an existing branch; never the user's checked-out branch |
| `.ai-bridge/` | each worktree has its own (its own run lock, sessions and state); the supervisor's state stays in the main project |
| Git commands | `git worktree add/list/remove`, `git commit` (branch worktrees only), `git merge --no-ff --no-commit` (scratch worktree only), `git diff`. Via `runProcess`, no shell. **Never** `push`, `fetch`, `reset --hard` on the user's worktree, `checkout` in the main worktree, `stash`, or `rebase` |
| Cleanup | REMOVED only if clean and merged, or explicitly discarded by the user; otherwise RETAINED and listed in the UI |

## 4. Join, merge, conflict, verification (ADR-043)

1. Every branch SUCCEEDED (or, under `wait-all`, every branch ended) → JOINING.
2. The supervisor commits each branch's verified tree on its branch (`COMMITTED`), recording the
   commit sha as evidence.
3. It creates the scratch worktree at `baseCommit` and merges the branches **in the declared
   order**, with `--no-ff --no-commit`, recording each merge result.
4. Any conflict → group WAITING_HUMAN (options: `fail`, `stop`, and FUTURE `resolve-manually`).
   Nothing is auto-resolved.
5. A clean merge → VERIFYING. The M6 engine runs `join.verification` on the scratch worktree
   (quiescence, digests, checks, optional cross-agent review). The level rules are those of ADR-024.
6. PASS → the merged result is committed on `ai-bridge/<wf>/merged`. **Integrating it into the
   user's branch is a human action** (M9 never touches the user's branch; FUTURE option:
   fast-forward on explicit confirmation).
7. The following sequential steps run in the merge worktree (their project path is the merge
   worktree) or, by definition choice, stop so the human can integrate first.

## 5. Failure and cancellation semantics

| Event | fail-fast | wait-all |
|---|---|---|
| A branch attempt fails and its retries are exhausted | the siblings are stopped (`BridgeEngine.stop()` per worktree) → CANCELLED; the group FAILED | the siblings continue; the group FAILED at the join |
| A branch NEEDS_HUMAN | the group waits (the siblings continue to their next step boundary, then pause) | the same |
| QUOTA in any branch | the class is never retried; the whole group pauses at boundaries → WAITING_HUMAN | the same |
| User STOP | every live branch stopped; the worktrees RETAINED | the same |
| Deadline | the watchdog stops all; FAILED DEADLINE_EXCEEDED | the same |
| Worktree creation fails | the group BLOCKED (ENVIRONMENT) before any execution | the same |

## 6. Persistence model

```
<project>/.ai-bridge/workflows/instances/<wf>/
  instance.json            + groups[] {groupId, state, baseCommit, branches[] {branchId, state, worktreeId, steps[] …}}
  worktrees.json           registry: {worktreeId, path, branch, baseCommit, state, createdAt, lastCommit}  (AtomicJsonWriter)
  groups/<groupStepId>/join.json   merge results per branch, conflicts, merged commit, verification ref
  attempts/<step>-<n>/…    as in M6; the attempt record adds {branchId, worktreeId, executionKey}
<worktree>/.ai-bridge/…    BridgeEngine's own files for executions in that worktree (EXISTING layout)
```

Write order: the `worktrees.json` intent (CREATED-pending) → `git worktree add` → the registry
confirmed → the decider batch. All attempts keep the M5 write-ahead rule.

## 7. Event model (new types, ADR-023)

`GROUP_STARTED`, `WORKTREE_CREATED`, `BRANCH_STARTED`, `BRANCH_ENDED`, `BRANCH_COMMITTED`,
`JOIN_STARTED`, `MERGE_COMPLETED {branch, result: CLEAN|CONFLICT, conflictedPaths[]}`,
`GROUP_ENDED`, `WORKTREE_RELEASED {result: REMOVED|RETAINED}`. Every event carries `groupId`,
`branchId` and `worktreeId` where applicable; attempt events carry `executionKey`.

## 8. Recovery model (extends docs/26 §6 per branch)

| After a Workflow Host crash / Main crash | Facts | Decision |
|---|---|---|
| The group PROVISIONING, a registry entry CREATED-pending | `git worktree list` | exists → confirm; absent → retry the creation once (nothing ran) |
| Branch attempts LAUNCHING / EXECUTING (N of them) | per worktree: `BridgeEngine(worktree).status()`, sessions by correlation | the M5.6 reconciler **per branch**, independently: LINK / WATCH / ADOPT / RESUME / UNRESOLVABLE; zero relaunch of an existing execution |
| JOINING, merge partially done | the scratch worktree status | discard the scratch worktree (it is derived) and redo the merge from the recorded branch commits (deterministic) |
| VERIFYING the merged tree | the M6 recovery (docs/43 §4) | re-run verification |
| Orphan worktrees (registry says RELEASED-pending) | `git worktree list` | finish the release by policy; never delete a dirty worktree automatically |

Each branch's Execution Host is `independent`, so all of them survive a supervisor crash, and each
is reconciled against **its own** project path. The single Workflow Host re-attaches by
watching N executions.

## 9. Security boundaries

- Git mutation is opt-in, namespaced and non-destructive (§3); no remote operations.
- A branch agent's filesystem scope is its worktree (the M7 profile `fs.write` project = the
  worktree path). `--add-dir` stays forbidden, so no agent sees a sibling's worktree.
- Only the supervisor reads across worktrees, via recorded paths with sha256 checks.
- The merge runs in a scratch worktree; the user's working tree is never written by M9.
- Cross-agent verification enforces reviewer provider ≠ executor provider (ADR-045).

## 10. Hard limits

| Limit | Default | Hard cap | Notes |
|---|---|---|---|
| concurrent agents / live executions per workflow | 2 | 4 | one per branch |
| branches per group | — | 4 | = the concurrency cap |
| groups per definition | — | 5 | no nesting |
| worktrees per workflow | branches + 1 (merge) | 9 | RETAINED ones count until removed |
| worktrees per project (all workflows) | — | 12 | refuse new groups beyond this |
| delegated steps per workflow | 0 (needs a slot) | 3 per slot, depth 1 | docs/54 §6 |
| reviewers per cross-review | 1 | 3 | ADR-045 |
| total executions | steps × maxAttempts | 100 (EXISTING) | counts every branch |
| total iterations | 200 | 1000 (EXISTING) | summed over branches |
| total duration | 8 h | 72 h (EXISTING) | wall-clock of the workflow |
| total attempts | — | 5 per step (M6) | per step, across branches |
| total reported tokens | recommended to set for schema 2 | — | unknown usage flagged (EXISTING rule) |
| total cost in USD | **not measurable** (subscription-only; docs/26 §7, P22) | — | bounded by executions, iterations, tokens and duration |

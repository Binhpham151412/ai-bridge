# 23 — Execution ⇄ Workflow Contract (PROPOSED)

All interfaces below are **documentation examples only** (TypeScript-like). None of them
exists in `src/`, and this document does not add them.

## 1. Purpose

Define the single boundary between the **Workflow Engine** (M5) and the **Execution
Engine** (the EXISTING BridgeEngine): what goes down, what comes up, which ids exist,
which state belongs where, and how errors, cancellation and resume cross the boundary.

## 2. Current State (EXISTING)

- BridgeEngine's public API (docs/20 §5.1) is already typed, JSON-serializable and
  exception-free for normal outcomes. It is the contract M5 builds on.
- The run host protocol (`HostCommand`/`HostMessage`) already carries
  `start|resume` down and `event|outcome|failed` up between processes.
- Gaps relevant to a caller that must survive its own crash: `start()` returns the
  runId only at the end (as `sessionDir`); no caller reference is stored with a run.

## 3. Proposed Design — ExecutionPort

```ts
// Documentation example — NOT in source.
interface ExecutionPort {
  /** Starts one execution. Resolves when it ends (same semantics as BridgeEngine.start). */
  start(req: ExecutionRequest, onEvent: (e: BridgeEvent) => void): Promise<ExecutionResult>;
  /** Resumes the given execution iff it is the project's current, recoverable session. */
  resume(ref: { executionId: string }, onEvent: (e: BridgeEvent) => void): Promise<ExecutionResult>;
  pause(): Promise<BridgePauseOutcome>;            // pass-through, EXISTING semantics
  stop(): Promise<BridgeStopOutcome>;              // pass-through, EXISTING semantics
  status(): Promise<BridgeStatus>;                 // pass-through
  checkRecovery(): Promise<BridgeRecoveryCheck>;   // pass-through
  artifacts(executionId: string): Promise<SessionArtifacts | null>;  // pass-through
  findExecutions(filter: { startedAfter: string }): Promise<SessionSummary[]>; // listSessions + filter
}

interface ExecutionRequest {
  attemptId: string;          // wf_2026-10-01_001/implement/1
  task: string;               // composed by the workflow (docs/21 §3.2 step-planner)
  maxIterations: number;      // 1..100 (validated again by BridgeEngine: INVALID_OPTIONS)
  correlation?: string;       // PROPOSED additive, see §8
}

type ExecutionResult =
  | { kind: 'ENDED'; executionId: string; outcome: BridgeRunOutcome }     // COMPLETED
  | { kind: 'NOT_STARTED'; reason: 'BLOCKED_PREFLIGHT' | 'ALREADY_RUNNING' | 'INVALID_OPTIONS'; outcome: BridgeRunOutcome }
  | { kind: 'RESUME_REFUSED'; reason: 'NO_STATE' | 'RECOVERY_BLOCKED' | 'NOT_CURRENT_SESSION'; detail: string }
  | { kind: 'HOST_FAILED'; executionId: string | null; message: string };  // execution process died without an outcome
```

Implementations (PROPOSED):

| Impl | Where | Used by |
|---|---|---|
| `ForkedExecutionPort` | Forks one execution host per `start`/`resume` (reuses `run-host.ts` `serveRunHost` + `HostCommand` protocol); in-process BridgeEngine for the read/pause/stop pass-throughs | production (workflow host) |
| `InProcessExecutionPort` | Calls `BridgeEngine` directly | tests with fake CLIs (the `deps.claudeCommandArgsPrefix` pattern) |
| `FakeExecutionPort` | Scripted outcomes | pure workflow-engine unit tests |

**Why the forked execution host:** `BridgeEngine.stop()` kills the process tree of the
lock holder (docs/20 §8). If the workflow engine lived in the same process as `start()`,
a stop would kill the workflow engine too. With one execution host per execution, the
existing stop semantics apply unchanged and the workflow host survives (ADR-011).

## 4. What Workflow sends / what Execution returns

| Direction | Content | Notes |
|---|---|---|
| ↓ start | `task`, `maxIterations`, (`correlation`) | That is the entire execution input. Timeouts, permission mode and report size come from the project `config.json`, owned by BridgeEngine. |
| ↓ resume | nothing but the intent | BridgeEngine resumes its *current* session; the port first checks `status().runId === executionId`, otherwise `RESUME_REFUSED: NOT_CURRENT_SESSION`. |
| ↓ pause/stop | nothing | Pass-through. |
| ↑ events | every `BridgeEvent`, unchanged | The first `RUN_STARTED` gives the executionId. |
| ↑ result | typed `ExecutionResult` wrapping the unchanged `BridgeRunOutcome` | `executionId` = basename of `sessionDir` or the `RUN_STARTED` runId. |
| ↑ artifacts | `SessionArtifacts` for the runId | Read-only. Verification and the journal use these. |

## 5. Identifiers

| Id | Minted by | Format | Stored in |
|---|---|---|---|
| `workflowId` | WorkflowEngine | `wf_YYYY-MM-DD_NNN` | instance.json, every workflow event |
| `stepId` | Definition author | kebab-case | definition, attempt records |
| `attemptId` | WorkflowEngine | `<workflowId>/<stepId>/<n>` | attempt record, `correlation` |
| `executionId` | **BridgeEngine** (EXISTING runId) | `YYYY-MM-DD_NNN` | attempt record (set on RUN_STARTED) |
| `iteration` | Orchestrator (EXISTING) | 1..100 | run events |
| Claude session id / Codex thread id | CLIs (EXISTING) | UUID / CLI-defined | execution records only; **the workflow never uses them** |
| `eventId` | WorkflowEngine | `<workflowId>#<seq>` | workflow events (docs/27) |
| `correlationId` | WorkflowEngine | = `workflowId` | workflow events; = `correlation` on the run (PROPOSED) |

## 6. State ownership

| State | Owner | Other layer's access |
|---|---|---|
| Iteration phase, Claude/Codex ids, pids, lastReportPath, the execution's maxIterations | BridgeEngine | Workflow: read via `status()` |
| Run lock, pause marker | BridgeEngine | Workflow: never touches them |
| Execution artifacts and records | BridgeEngine | Workflow/verification: read-only |
| Instance / step / attempt state, budgets, workflow lock | WorkflowEngine | BridgeEngine: **no knowledge of them at all** |
| Final execution outcome | BridgeEngine (source of truth) | Workflow: a cached copy in the attempt record, reconciled from the source |

## 7. Errors, cancellation, resume

### 7.1 Error propagation

- BridgeEngine never throws for run outcomes. Its typed outcome is wrapped unchanged in
  `ExecutionResult`.
- Classification (retryable or not) happens **only** in the workflow layer, from
  `finalStatus` + `errorCode` + `diagnostics` (docs/26 §3). BridgeEngine is not asked to
  classify.
- An infrastructure failure of the port itself (the execution host exited without an
  outcome, IPC broken) → `HOST_FAILED`. The workflow then calls `status()`/`checkRecovery()`
  to learn the truth from disk before deciding anything.
- Secrets: diagnostics are already redacted by Core. The workflow redacts again
  (`redactSecrets`) before persisting any free text (defense in depth, the existing pattern).

### 7.2 Cancellation

- Workflow stop → `ExecutionPort.stop()` → `BridgeEngine.stop()` (EXISTING escalation:
  graceful, then `taskkill /T /F` of the execution host). The execution records STOPPED,
  and the execution host exits. `start()` then resolves as `HOST_FAILED`, or as `ENDED`
  with STOPPED if the outcome was flushed. Either way, the workflow reads `status()` and
  records STOPPED.
- There is no cancellation mid-CLI-call other than this. No cooperative-cancellation API
  is added to BridgeEngine.

### 7.3 Resume

- Execution resume = `ExecutionPort.resume({executionId})`. Preconditions checked by the
  port: `status().runId === executionId` **and** `checkRecovery().kind === 'RECOVERABLE'`.
- The decision of *how* to resume (CONTINUE_FROM_PROMPT vs RESEND_REPORT_TO_CODEX) stays
  inside BridgeEngine (EXISTING `planRecovery`).
- If the current session is no longer this attempt's run (for example, the user started a
  different run from the CLI), the resume is refused and the attempt goes to NEEDS_HUMAN.
  The workflow never resumes someone else's run.

## 8. Correlation — the one proposed BridgeEngine addition (OPEN QUESTION)

**Problem:** after a workflow-host crash between "intent LAUNCHING persisted" and
"RUN_STARTED received", the workflow must find which run (if any) belongs to the attempt.

| Option | Change to BridgeEngine | Reliability |
|---|---|---|
| A. Time-window reconciliation only | none | Good when one workflow per project plus the run lock. Ambiguous if a user starts a CLI run in the same window → NEEDS_HUMAN. |
| B. Optional `correlation?: string` in `BridgeStartOptions`, persisted in `current-session.json` and on the `RUN_STARTED` event as an extra field | **additive, optional, backward compatible**. `BridgeEvent` already allows extra fields, and older state files lack it (the same pattern as `maxIterations` in M4). | Exact. |

Recommendation: **Option B**, implemented in M5.4 behind its own test set, with option A
as the fallback for runs without a correlation. If the architect rejects any BridgeEngine
change, option A alone is acceptable, with the NEEDS_HUMAN fallback.

## 9. Responsibilities / Boundaries

- The port is thin: validation of preconditions, process hosting, pass-through.
- **It contains no retry loop, no output parsing and no CLI knowledge.**
- It is the *only* module in the workflow layer allowed to import `bridge-engine.ts`
  (PROPOSED architecture test).

## 10. Data Flow

```
WorkflowEngine ──ExecutionRequest──► ExecutionPort ──HostCommand{start}──► execution host ──► BridgeEngine.start
       ▲                                  │◄──HostMessage{event}── (RUN_STARTED → persist executionId)
       └────────ExecutionResult──────────┘◄──HostMessage{outcome}
```

## 11. Failure Cases

| Case | Result |
|---|---|
| The execution host crashes mid-run | `HOST_FAILED` → `status()` = INTERRUPTED → `checkRecovery()` → resume or NEEDS_HUMAN |
| The workflow host crashes mid-run | The execution host keeps running — it is forked with the `independent` lifetime (§11.1); after restart the reconciler re-attaches by status/lock (WATCH), or adopts the outcome (ADOPT) |
| The outcome message is lost but the process exited 0 | `status()` shows a terminal status → adopt |
| Two ports started concurrently (a bug) | The EXISTING run lock → ALREADY_RUNNING for the second |

### 11.1 Process lifetime (IMPLEMENTED, M5.8.1)

**Windows fact.** Node/libuv assigns every child that is forked or spawned without `detached` to a
job object its parent owns, with kill-on-close. When the parent process ends (normally or not), the
child is terminated, and with it the child's own children. This is verified on Windows by
`tests/workflow/process-lifetime.windows.test.ts`. Before M5.8.1 this made every host die with its
parent, contrary to the row above.

**Contract.** A lifetime is chosen in one place only (`src/desktop/main/process-lifetime.ts`, with
`src/hosts/execution-host-spawn.ts` as its single `independent` caller):

| Process | Forked by | Lifetime | Ends when |
|---|---|---|---|
| Workflow Host | Electron Main (or it *is* the CLI process) | `with-parent` | its workflow rests; or Main / the CLI process ends |
| Execution Host | the Workflow Host | **`independent`**: detached, no stdio pipes, only the IPC channel | its one run ends (bounded by maxIterations × the per-call CLI timeouts); or `BridgeEngine.stop()` |
| Claude/Codex CLI | the Execution Host (process-runner) | `with-parent` | its call ends; or its Execution Host ends |
| M4 run host (ordinary runs) | Electron Main | `with-parent` (unchanged) | its run ends; or Main ends |

- **Ownership.** An Execution Host is owned by the run lock it holds (`.ai-bridge/state/lock`,
  pid). The attempt records its pid (`hostPid`) and the run's correlation (ADR-017). Any process
  can stop it, CLI tree included, through `BridgeEngine.stop()`: a graceful attempt, then
  `taskkill /T /F` of the lock holder.
- **Workflow Host crash** (killed, crashed, CLI interrupted with Ctrl+C, terminal closed). The
  Execution Host and its CLI keep running. The instance shows INTERRUPTED. The next Workflow Host
  reconciles it (M5.6, unchanged): WATCH while the run is RUNNING, then ADOPT of its outcome.
  The execution id stays the same and nothing is relaunched.
- **Execution Host death.** Its CLI dies with it. M5.6 decides as before: RESUME at a resumable
  checkpoint, ADOPT if it completed, WAITING_HUMAN otherwise.
- **Explicit STOP.** WorkflowEngine → `ExecutionPort.stop()` → `BridgeEngine.stop()` → the
  Execution Host and its CLI are terminated → the attempt/workflow is STOPPED.
- **Electron Main.** The Workflow Host ends with Main. On a **normal quit** while this app owns a
  Workflow Host, Main asks the user first, as it does for runs: cancel, or STOP the workflow and
  quit. A deliberate quit never leaves an execution running unattended; PAUSE first to keep
  progress. On a **Main crash** the Workflow Host ends, and the in-flight Execution Host and CLI
  keep running until the run ends (the Workflow Host crash case). The workflow advances again only
  after `resume`.
- **Not changed.** The M4 run host still ends with Main, so a Main crash interrupts an ordinary
  run, which then recovers through L2 as before.

## 12. Decisions

ADR-001, ADR-011, ADR-014 (execution outcome source of truth).

## 13. Open Questions

- §8 correlation option.
- Where the Node-only execution host entry lives (the existing entry is under
  `src/desktop/main/`; the CLI workflow host needs a non-Electron entry). Proposed:
  `src/hosts/execution-host-entry.ts` reusing `serveRunHost`.

## 14. Explicitly Out of Scope

Streaming partial CLI output across the boundary (FUTURE); a review-only execution mode
(docs/25); multiple concurrent executions per project.

## 15. Risks

- Leaking execution concerns upward through "convenience" methods on the port.
  Mitigation: the port surface is exactly §3; additions need an ADR.
- The resume precondition race (the user starts a CLI run between `status()` and
  `resume()`): the run lock makes `resume()` return ALREADY_RUNNING, and the attempt
  goes to NEEDS_HUMAN.

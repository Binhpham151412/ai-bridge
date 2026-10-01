# 35 — Electron UI and Orchestration Observability (PROPOSED)

## 1. Purpose

Design how the future UI observes workflows, steps, executions, verification, review,
retries and events. The renderer stays a pure consumer of Core state, and neither the
renderer nor Main owns orchestration logic.

## 2. Current State (EXISTING)

- Renderer: views Run / Journal / Artifacts / Settings / System. `BridgeProvider` holds the
  pushed `BridgeSnapshot` and a merged event list. `run-summary.ts` maps Core values to
  fixed sentences. Controls come from `snapshot.controls`, derived in Main by
  `deriveControls` from Core's `status()` and `checkRecovery()`.
- Main: `RunController` sequences Core calls, forks the run host, polls status (1 s / 5 s),
  and publishes snapshots and events. Its header comment says it "holds no orchestration
  logic".
- IPC: 17 invoke channels + 2 push channels, frozen preload, sender check, validation.

## 3. Proposed Design

### 3.1 Process topology (M5)

```
Renderer ─IPC─► Main: RunController (EXISTING, unchanged)
                     WorkflowController (NEW, sibling) ─fork/IPC─► workflow host (WorkflowEngine)
                                                                        └─fork─► execution host (BridgeEngine.start/resume)
```

- The **WorkflowController**, like RunController, only sequences calls, owns the child
  process lifecycle and publishes snapshots. Every decision comes from the WorkflowEngine
  (in the workflow host) or BridgeEngine.
- Mutual exclusion: while a workflow is active, `RunController.canStart` is false. That is
  derived from Core (the workflow lock is held, via a new Core read `workflowStatus()`),
  not from renderer state. Resume and stop of the *execution* stay available through the
  workflow controls, not the Run controls, so the user doesn't drive one run behind the
  workflow's back (OPEN QUESTION: allow a direct execution stop as an emergency control).

### 3.2 WorkflowSnapshot (documentation example)

```ts
interface WorkflowSnapshot {
  instance: { workflowId: string; definitionId: string; version: number; state: string; displayState: string;
              terminalReason: string | null; evidenceLevel: 'VERIFIED' | 'AI_ATTESTED' | 'NONE' | null } | null;
  steps: { stepId: string; title: string; state: string; attempts: number; maxAttempts: number;
           current: { attemptId: string; state: string; executionId: string | null } | null;
           lastVerification: { verdict: string; evidenceLevel: string } | null }[];
  budgets: { name: string; used: number; limit: number; incomplete?: boolean }[];
  waitingFor: { kind: 'HUMAN' | 'ENVIRONMENT'; question: string; options: string[] } | null;
  controls: { canStart: boolean; canPause: boolean; canResume: boolean; canStop: boolean; canAnswer: string[] };  // derived in Core
  execution: BridgeSnapshot['status'];   // the active run's EXISTING status, for the live Run panel
}
```

`controls` is computed by a pure `deriveWorkflowControls` in Core or shared, mirroring
`deriveControls`. The renderer never computes whether an action is allowed.

### 3.3 New IPC surface (PROPOSED; same security pattern)

Invoke: `workflow:list`, `workflow:get` ({workflowId}), `workflow:getEvents`
({workflowId, afterSeq, limit}), `workflow:getAttempt` ({attemptId}), `workflow:getJournal`,
`workflow:listDefinitions`, `workflow:start` ({definitionId, definitionHash, inputs}),
`workflow:pause`, `workflow:resume`, `workflow:stop`, `workflow:answer` ({workflowId,
answer: enum}).
Push: `workflow:snapshot`, `workflow:event`.

Validation rules: ids must match strict patterns (`wf_YYYY-MM-DD_NNN`, kebab-case step
ids); `answer` is an enum; `inputs` is validated against the definition's declared input
schema **in Main** before it is forwarded; the renderer can never send command strings,
paths or prompts other than declared inputs. The existing 17 channels are unchanged.

### 3.4 Views (UI; no redesign of existing views)

- A new **Workflow** view: a step list with state badges, attempt history per step,
  verification evidence (deterministic vs AI, with the evidence level label always
  visible), a retry reason, budgets, and a WAITING_HUMAN panel with the typed options.
- A step or attempt links to the existing Run, Journal and Artifacts views through
  `NavTarget {runId, iteration}` (EXISTING navigation), so execution detail reuses what exists.
- Plain-language sentences come from fixed tables keyed by Core values (the EXISTING
  `run-summary.ts` approach). Nothing is inferred.

### 3.5 Live vs detached observation

- Attached (this app started the workflow): the pushed workflow events + the forwarded run
  events.
- Detached (started from the CLI, or the app restarted): the WorkflowController polls
  `workflow:get` (1 s active / 5 s idle, like RunController) and reads the events by
  `afterSeq`. There are no live run events for detached executions (the EXISTING M4
  limitation, unchanged).

## 4. Responsibilities

| Layer | Does | Never does |
|---|---|---|
| Renderer | render snapshots and events; send user intents | decide availability, compose prompts, read files, retry |
| Main WorkflowController | route intents, host processes, publish snapshots | classify outcomes, decide retries, write workflow state |
| Workflow host | run the WorkflowEngine | talk to the renderer directly |

## 5. Boundaries

- The renderer bundle imports only types plus zero-dependency runtime constants
  (the EXISTING `journal-types.ts` lesson: no Node imports reach the browser bundle).
- The existing security tests extend to the new channels (the sender check, allowlist and
  payload tests).

## 6. Data Flow

`workflow host events → Main → renderer push`; `renderer intent → Main validate → workflow
host command → engine decides → snapshot → push`.

## 7. Failure Cases

| Case | UI behavior |
|---|---|
| The workflow host dies | The snapshot shows `INTERRUPTED` (derived in Core from the workflow lock pid); the Resume control is enabled by Core |
| Main crashes | (M5.8.1, docs/23 §11.1) The workflow host ends with Main; the in-flight execution host and its CLI keep running to the end of their run; on relaunch the workflow shows `INTERRUPTED` and Resume reconciles it (WATCH → ADOPT) |
| Main quits normally with a workflow host it started | (M5.8.1) The same rule as for runs: the user cancels, or the workflow is STOPPED through the WorkflowEngine before quitting; PAUSE first to keep progress |
| Invalid IPC payload | The EXISTING rejection path (`INVALID_REQUEST`) |
| Long pause pending (iteration 0) | The UI shows "pause requested, will apply after round 1" (a fixed sentence keyed by Core state) |

## 8. Decisions

ADR-010 (UI does not own orchestration), ADR-011 (process model).

## 9. Open Questions

Emergency direct execution stop while a workflow runs; whether the Run view hides its own
Start button or shows it disabled with a reason while a workflow is active; definition
editing in the UI (recommended: not in M5, since files are authored outside).

## 10. Explicitly Out of Scope

Visual redesign; the dark theme and label issues listed in docs/18; a definition editor;
notifications.

## 11. Risks

- Two controllers fighting over one project: mutual exclusion is derived from the Core
  locks.
- UI wording implying verification in M5: the evidence label is mandatory in every step
  row.

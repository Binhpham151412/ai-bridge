# 27 — Events, Audit and Observability (PROPOSED, building on EXISTING)

## 1. Purpose

Make every meaningful AI interaction **observable, traceable and locally auditable**
across workflows, steps, attempts and executions. The goal is to do this without changing
the existing run event stream, execution records or journal, and without adding a
collector or a dependency.

## 2. Current State (EXISTING)

| Asset | Content | Gaps |
|---|---|---|
| `logs/events.jsonl` | `BridgeEvent {timestamp, runId, iteration, phase, event, detail?, …extra}`, 24 types, append-only, rotation at 10 MB with one backup | no eventId, no schema version, no correlation; ITERATION_COMPLETED/TIMEOUT never emitted; project-wide (all runs in one file) |
| `logs/ai-bridge.log` | human line per event | — |
| `logs/YYYY-MM-DD-session.log` | one JSON line per CLI call (`LogEvent`) | never rotated |
| `sessions/<runId>/NNN-*-execution.json` | per-call evidence (ids, delivery, process, usage) | per run only |
| `sessions/<runId>/NNN-integrity.json` | 5 hashes per iteration | not chained |
| Journal (`session.md`, `final-report.md`, …) | derived Markdown | per run only |

## 3. Proposed Design

### 3.1 Two streams, linked, never merged

1. **Run stream (EXISTING, unchanged):** `logs/events.jsonl`. BridgeEngine stays its only writer.
2. **Workflow stream (PROPOSED):** `workflows/instances/<wfId>/events.jsonl`, one file per
   instance. The WorkflowEngine is its only writer.

A workflow event **references** run events. It never copies them. The link is the
executionId (= runId), plus the optional `correlation` on `RUN_STARTED` (docs/23 §8).

### 3.2 Workflow event envelope (documentation example)

```ts
interface WorkflowEvent {
  schema: 1;
  eventId: string;          // "<workflowId>#<seq>", seq = 1,2,3… gap-free per instance
  seq: number;
  timestamp: string;        // ISO-8601 UTC, from the workflow host clock
  workflowId: string;       // also the correlationId
  correlationId: string;    // = workflowId (root of everything in this instance)
  causationId: string | null; // eventId that caused this one (e.g. ATTEMPT_PLANNED ← STEP_ACTIVATED)
  stepId: string | null;
  attemptId: string | null;
  executionId: string | null; // runId, when the event concerns an execution
  actor: 'workflow-engine' | 'verification' | 'reviewer' | 'human' | 'host';
  provider: 'claude-code' | 'codex' | null;   // when an AI interaction is involved
  type: WorkflowEventType;
  payload: Record<string, string | number | boolean | null | string[]>; // small, non-secret; large data by artifact reference
  artifacts: { path: string; sha256: string }[];   // files this event vouches for
  prevHash: string | null;  // sha256 of the previous event line (hash chain)
  hash: string;             // sha256 over (canonical line without `hash`)
}
```

`WorkflowEventType` (PROPOSED initial set): `WORKFLOW_CREATED`, `WORKFLOW_STATE_CHANGED`,
`STEP_STATE_CHANGED`, `ATTEMPT_PLANNED`, `ATTEMPT_LAUNCHING`, `EXECUTION_LINKED`
(runId known), `EXECUTION_ENDED`, `ATTEMPT_STATE_CHANGED`, `VERIFICATION_STARTED`,
`CHECK_COMPLETED`, `REVIEW_COMPLETED`, `VERIFICATION_COMPLETED`, `RETRY_DECIDED`,
`BUDGET_CHECKED`, `BUDGET_EXHAUSTED`, `HUMAN_INPUT_REQUESTED`, `HUMAN_INPUT_RECEIVED`,
`PAUSE_REQUESTED`, `STOP_REQUESTED`, `RECONCILED`, `WORKFLOW_COMPLETED`.

**`INPUT_RECEIVED` (IMPLEMENTED in M5.3).** Every decision the pure decider accepts is
persisted as one batch that starts with `INPUT_RECEIVED`: its payload holds the input type
and the exact input as canonical JSON (`payload.input`), and the other events of the batch
have the INPUT_RECEIVED event as their `causationId`. This makes the log replayable: the
store re-derives a snapshot by feeding the logged inputs back through the decider and
checking that each batch is exactly what the decider produces (§7). Inputs the decider
rejects, or that change nothing, are not logged.

### 3.3 Mapping to the requested fields

| Requested | Field / source |
|---|---|
| event ID | `eventId` (workflow); run events: the tuple `(runId, timestamp, event, iteration)`, since they have no id (EXISTING) |
| workflow ID | `workflowId` |
| step ID | `stepId` |
| execution ID | `executionId` = runId |
| correlation ID | `correlationId` (= workflowId); on the run: `correlation` = attemptId (PROPOSED) |
| timestamps | `timestamp`; execution records carry process start/end (EXISTING) |
| actor | `actor` |
| provider | `provider`; per-call detail in the execution records (EXISTING) |
| event type | `type` |
| payload | `payload` + `artifacts` |
| integrity | `prevHash`/`hash` chain + artifact sha256 |

### 3.4 Integrity

- **Hash chain per instance file.** On load, the store verifies the chain. A break means
  tampering or a torn write. A torn *last* line (a crash mid-append) is truncated and
  recorded as a `RECONCILED` event; a break anywhere else → the instance is marked
  `auditIntegrity: BROKEN` and becomes read-only (no further steps).
- The snapshot `instance.json` records `lastEventSeq` and `lastEventHash`, so the snapshot
  and the log are cross-checked (docs/19 §11 P3).
- Artifacts referenced by events carry sha256, the same practice as `NNN-integrity.json`.
- There is no signature or external timestamping (a local-first threat model: the goal is
  detecting accidental corruption and casual edits, not a malicious machine owner). This
  is recorded as a limitation.

### 3.5 Relationship with the existing journal

- The run journal (M4.2) stays as is, per execution.
- PROPOSED **workflow journal**: `workflows/instances/<wfId>/workflow.md`, generated by
  the same rules (derived only from verified records, idempotent, `UNKNOWN` when missing,
  never model-summarized). Content: a steps table (state, attempts, evidence level),
  per-attempt links to the run journal (`sessions/<runId>/session.md`), verification
  evidence summaries, retry decisions with reasons, budgets consumed, and the terminal
  reason.
- The journal is a *view*. The events and records are the audit source.

### 3.6 Observability for the UI

The UI consumes: (a) the workflow snapshot (state + controls), (b) workflow events
(pushed), (c) run events for the active execution (the EXISTING push), (d) on-demand reads
of records. There is no polling of raw files from the renderer (docs/35).

### 3.7 Optional OpenTelemetry mapping (FUTURE EXTENSION)

`workflowId` → trace, attempt → span, execution → child span, CLI call → leaf span
(`gen_ai.operation.name` ≈ `invoke_agent`). It would be an exporter over the files; no
dependency is added in M5–M8. The GenAI conventions are experimental upstream.

## 4. Responsibilities

- The WorkflowEngine writes workflow events; BridgeEngine writes run events; verification
  writes its records, and its events go through the engine.
- Hosts forward events; they never write them.

## 5. Boundaries

- No change to `BridgeEvent`, `EVENT_TYPES` or `events.jsonl` in M5. Emitting the declared
  but unused `ITERATION_COMPLETED`/`TIMEOUT` is a separate BridgeEngine decision, not
  required by M5.
- Payloads are small, non-secret and redacted. Big text goes into artifact files.

## 6. Data Flow

```
decider event ─► store.appendEvent (seq, prevHash, hash) ─► workflows/<wfId>/events.jsonl
             └─► host push ─► Main ─► renderer
run events (EXISTING) ─► execution host ─► workflow host ─► EXECUTION_LINKED / EXECUTION_ENDED references
```

## 7. Failure Cases

| Case | Handling |
|---|---|
| Crash mid-append | The last line is torn → truncated on load, and a `RECONCILED` event is written |
| Event appended but the snapshot not saved | The snapshot's `lastEventSeq` < the log → the snapshot is re-derived by replaying the logged `INPUT_RECEIVED` inputs through the decider (M5.3); a batch cut short by the crash is completed from the replayed decision, and a `RECONCILED` event records the repair |
| Snapshot saved but the event not appended | Not allowed: order = append event, then save snapshot |
| Run events rotated away (10 MB) | Workflow events keep the references; the execution records and artifacts in `sessions/` are unaffected by rotation |

## 8. Decisions

ADR-007 (AI interactions are auditable), ADR-008 (local-first).

## 9. Open Questions

- Should workflow event files rotate? Recommended: no (per instance, bounded by the
  budget caps; an estimated ≤ 2 MB each), and handled by the retention manager (docs/34).
- Should BridgeEngine events gain `eventId`/`schema`? It is additive; recommended as a
  FUTURE, low-priority change.

## 10. Explicitly Out of Scope

Remote telemetry, analytics, cryptographic signing, cross-machine audit.

## 11. Risks

- A payload leaking a secret: redaction plus a payload type restricted to scalars, with
  large text only via redacted artifacts.
- The event volume per workflow: bounded by the caps (≤ 100 executions × ~20 events).

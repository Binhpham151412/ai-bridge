# AI Bridge — Electron Integration Contract (M3.5)

This is the contract a future Electron main process (or any other future caller) uses to
drive AI Bridge without knowing CLI syntax, the `.ai-bridge/` filesystem layout, or any
process-tree detail. Everything here is `core/bridge-engine.ts`'s actual, already-tested
public surface — nothing here is aspirational.

```text
Electron Main
      │  new BridgeEngine(projectPath)
      ▼
BridgeEngine
      │  engine.subscribe(listener)  ──────────►  live events
      │  engine.start()/pause()/resume()/stop()
      │  engine.status()/logs()/reset()/doctor()
      ▼
Renderer  (via IPC — Electron's own concern, out of scope here)
```

Electron never talks to `claude`/`codex` CLIs, state files, locks, or internal JSON
directly — only through this API. If a future need genuinely requires bypassing it,
that's a sign this contract is incomplete and should be extended, not worked around.

## Constructing an engine

```typescript
import { BridgeEngine } from './core/bridge-engine.ts';

const engine = new BridgeEngine(projectPath);
```

One instance per project directory. Stateless between calls (each method re-reads
`.ai-bridge/state/` from disk) — safe to construct a fresh instance per IPC call, or keep
one alive for a project's lifetime; both work identically since no in-memory state is
cached across calls except the `subscribe()` listener set.

## Lifecycle methods

```typescript
doctor(): Promise<DoctorReport>
start(options: BridgeStartOptions): Promise<BridgeRunOutcome>
resume(): Promise<BridgeRunOutcome>
pause(): Promise<BridgePauseOutcome>
stop(): Promise<BridgeStopOutcome>
status(): Promise<BridgeStatus>
logs(lines?: number): Promise<string[]>
reset(): Promise<BridgeResetOutcome>
subscribe(listener: (event: BridgeEvent) => void): () => void
```

- **`doctor()`** — runs every preflight check (Node version, cost-guard env vars,
  claude/codex presence and auth mode, git, config validity, git-repository cleanliness)
  and returns the full `DoctorReport` (`{ checks: DoctorCheckResult[], overall }`). Safe
  to call anytime, including while a session is running — read-only.
- **`start(options)`** — `options: { task: string; maxIterations?: number }`. Runs
  `doctor()` internally and refuses if not `PASS` (see Error Model). Acquires the run
  lock, creates a new session, and drives the loop to completion, resolving only when the
  run reaches a terminal state (`DONE`/`NEED_HUMAN`/`ERROR`/`STOPPED`/
  `STOPPED_MAX_ITERATIONS`/`PAUSED`). For a long-running task, call `subscribe()` first
  and `status()` from a timer/IPC poll to show live progress — `start()`'s promise won't
  resolve until the whole run ends.
- **`resume()`** — no arguments; reads whatever session state is on disk and decides how
  (or whether) it's safely resumable via the same `decideRecoveryStrategy` logic the CLI
  uses. Works identically whether the prior run ended via a real crash or a `pause()`.
- **`pause()`** — cooperative only. Never kills or interrupts Claude/Codex; requests a
  pause and waits (bounded, ~60s) for the running session to reach a safe boundary.
- **`stop()`** — forceful. Escalates from a graceful signal to a full process-tree kill if
  needed (see `docs/06-recovery-design.md` for the Windows specifics).
- **`status()`** — always resolves immediately; never throws for "no session" (returns
  `status: 'NOT_STARTED'` instead). Safe to poll on a timer.
- **`logs(lines)`** — tail of the human-readable log, `[]` if none exist yet.
- **`reset()`** — clears `.ai-bridge/state/` (lock + current-session.json) only; refuses
  while a session is running. Never touches project code, reports, sessions, or logs.
- **`subscribe(listener)`** — returns an unsubscribe function. Listener exceptions are
  swallowed (never break the run or other subscribers).

## `BridgeStatus`

```typescript
interface BridgeStatus {
  runId: string | null;
  status: string;       // NOT_STARTED | RUNNING | INTERRUPTED | PAUSED | DONE |
                         // NEED_HUMAN | ERROR | STOPPED | STOPPED_MAX_ITERATIONS
  iteration: number;
  currentPhase: string | null;   // the orchestrator's exact internal phase name
  claude: { pid: number | null; sessionId: string | null };
  codex: { pid: number | null; threadId: string | null };
  startedAt: string | null;
  updatedAt: string | null;
  lastReportPath: string | null;
}
```

Read-only, plain data — never a live reference into any internal object. `status` is the
session's own terminal status if it reached one; otherwise `RUNNING` if the process is
confirmed alive, else `INTERRUPTED` (crash detected: process gone, no terminal state
reached).

## `BridgeRunOutcome` (returned by `start()` and `resume()`)

A discriminated union — check `.kind` before reading the rest:

```typescript
type BridgeRunOutcome =
  | { kind: 'BLOCKED_PREFLIGHT'; doctorReport: DoctorReport }
  | { kind: 'ALREADY_RUNNING'; pid: number; doctorReport: DoctorReport }
  | { kind: 'NO_STATE' }                                    // resume() only
  | { kind: 'RECOVERY_BLOCKED'; reason: string; doctorReport: DoctorReport }  // resume() only
  | {
      kind: 'COMPLETED';
      finalStatus: 'DONE' | 'NEED_HUMAN' | 'ERROR' | 'STOPPED' | 'STOPPED_MAX_ITERATIONS' | 'PAUSED';
      errorCode: string | null;
      errorMessage: string | null;
      iterations: number;
      sessionDir: string;
      claudeSessionId: string | null;
      codexThreadId: string | null;
      doctorReport: DoctorReport;
    };
```

`kind: 'COMPLETED'` does not mean "succeeded" — check `finalStatus` for that (`DONE` is
the only unambiguous success; `PAUSED` means a `pause()` request landed mid-run).

## `BridgePauseOutcome` / `BridgeStopOutcome` / `BridgeResetOutcome`

```typescript
type BridgePauseOutcome =
  | { kind: 'NOT_RUNNING' }
  | { kind: 'PAUSED' }
  | { kind: 'STILL_RUNNING' }                       // 60s elapsed, not yet honored
  | { kind: 'ENDED_BEFORE_PAUSE'; finalStatus: string };  // run finished on its own first

type BridgeStopOutcome =
  | { kind: 'NOT_RUNNING' }
  | { kind: 'STOPPED'; reason: 'GRACEFUL_STOP' | 'FORCE_KILLED' | 'STOP_FAILED'; ok: boolean };

type BridgeResetOutcome =
  | { kind: 'REFUSED_RUNNING'; pid: number }
  | { kind: 'RESET' };
```

Every outcome is a plain, JSON-serializable object — safe to pass across an Electron IPC
boundary without any special marshaling.

## Event stream (`subscribe`)

`BridgeEvent` (`src/core/observability/events.ts`):

```typescript
interface BridgeEvent {
  timestamp: string;
  runId: string;
  iteration: number;
  phase: string;
  event: EventType;   // see below
  detail?: string;
  [extra: string]: unknown;
}
```

`EventType` (`EVENT_TYPES`, exhaustive):

```text
RUN_STARTED       RUN_STOPPED       RUN_COMPLETED
CLAUDE_STARTED    CLAUDE_EXITED
REPORT_DETECTED   REPORT_VALIDATED
CODEX_STARTED     CODEX_EXITED
RESPONSE_PARSED   PROMPT_SENT       ITERATION_COMPLETED
ERROR             TIMEOUT
RECOVERY_STARTED  RECOVERY_COMPLETED
PAUSE_REQUESTED   PAUSED
```

This is delivered **live** (synchronously, as it happens) to every `subscribe()`
listener, in addition to being durably appended to `events.jsonl`/`ai-bridge.log` — a UI
never needs to poll or tail a file for real-time updates; `status()` polling is only for
point-in-time snapshots (e.g. rendering the current PID/iteration on a dashboard refresh).

## Error model

`doctor()`'s `DoctorReport.overall` is `PASS | FAIL | BLOCKED`. `start()`/`resume()`
return `BLOCKED_PREFLIGHT` with the full report attached when preflight isn't `PASS` —
inspect `doctorReport.checks` for which check failed and why (`status`: `PASS | FAIL |
WARNING | BLOCKED | UNKNOWN`, `detail`: human-readable reason, never a secret value).

Runtime failures surface as `BridgeRunOutcome.errorCode` (a short machine-readable string,
e.g. `REPORT_INVALID`, `RESPONSE_INVALID`, `CLAUDE_RUN_FAILED:<adapter-error-code>`,
`CODEX_RUN_FAILED:<adapter-error-code>`, `PROMPT_INTEGRITY_FAILURE`,
`REPORT_TRANSPORT_INTEGRITY_FAILURE`, `BLOCKED_API_AUTH`) plus `errorMessage` (free-text
detail, safe to display — never contains a credential or env var value). `BridgeEngine`
never throws for an expected/classifiable failure — it always resolves with a typed
outcome. It can still reject its promise for a genuinely unexpected error (e.g. a disk
write failure); a caller should still wrap calls in a try/catch as defense in depth.

## Recovery

`resume()` calls the same `decideRecoveryStrategy` (`core/recovery/recovery.ts`) the CLI
uses — there is exactly one recovery decision implementation in the whole codebase, shared
by every caller. See [docs/06-recovery-design.md](06-recovery-design.md) for exactly which
checkpoints are resumable and why; see
[docs/11-m3.5-electron-preparation-report.md](11-m3.5-electron-preparation-report.md) for
the real crash-recovery test proving this works end-to-end through `BridgeEngine` directly
(no CLI involved), including a real bug this exact testing found and fixed.

## Pause / Resume

Identical mechanism whether called from Electron or the CLI: `pause()` writes a cooperative
marker file; the running session's own loop checks for it only at safe boundaries (never
mid-Claude/Codex-call) and transitions to `PAUSED`. `resume()` treats `PAUSED` (with at
least one completed iteration) exactly like a crash-interrupted `RESPONSE_PARSED` state —
same code path, same guarantees. Proven for real in M3.5's real pause/resume test (see the
report referenced above): SHA-256-verified prompt continuity across the pause boundary,
driven entirely through `BridgeEngine`.

## M4 additions (used by the desktop app)

Added while building the Electron app, so the UI never has to read `.ai-bridge/` itself
(the rule at the top of this document). All read-only unless stated; all tested in
`tests/bridge-engine-m4.test.ts`.

```typescript
checkRecovery(): Promise<BridgeRecoveryCheck>        // what resume() would do, without doing it
listSessions(): Promise<SessionSummary[]>            // newest first, from sessions/ + events.jsonl
getSessionArtifacts(runId: string): Promise<SessionArtifacts | null>   // null for invalid/unknown ids
recentEvents(limit?: number): Promise<BridgeEvent[]> // newest N structured events, oldest first
getConfig(): Promise<BridgeConfigView>               // .ai-bridge/config.json (+ validation errors)
saveConfig(raw: unknown): Promise<BridgeSaveConfigOutcome>   // validated by validateConfig; refused while running

type BridgeRecoveryCheck =
  | { kind: 'NONE' }                                 // no state, or a terminal status
  | { kind: 'RUNNING'; runId }                       // never offer resume for a live run
  | { kind: 'RECOVERABLE'; runId; iteration; status; strategy: 'CONTINUE_FROM_PROMPT' | 'RESEND_REPORT_TO_CODEX' }
  | { kind: 'BLOCKED'; runId; iteration; status; reason };
```

- `checkRecovery()` and `resume()` share one private `planRecovery()` (strategy from
  `decideRecoveryStrategy` + the on-disk checkpoint file it needs) — there is still exactly
  one recovery decision in the codebase.
- `BridgeStatus` gained `maxIterations: number | null` (persisted in state since M4; `null`
  for older state files) and `activity: { claude: 'IDLE'|'WAITING'|'EXECUTING'; codex:
  'IDLE'|'WAITING'|'REVIEWING' }` (`core/status/agent-activity.ts`).
- `getSessionArtifacts()` only accepts `YYYY-MM-DD_NNN` run ids (no path traversal). Each
  text artifact is returned byte-for-byte (capped at 512 KB, `truncated` flagged) with its
  SHA-256. Because `.ai-bridge/reports/NNN-report.md` is shared by all sessions of a
  project, a report is only returned from that file when it provably belongs to the
  session (integrity `reportHash`, or verbatim inside what was sent to Codex); otherwise it
  is recovered from `NNN-chatgpt-input.md` (`source: 'CODEX_INPUT'`).
- Behaviour fixes: `start()`/`resume()` clear a stale pause marker once they hold the lock;
  `stop()` records a confirmed user stop as `STOPPED` (+`RUN_STOPPED`) instead of leaving
  it to read as `INTERRUPTED`; `resume()` keeps the run's original `maxIterations`.

## M4.1 additions (execution transparency)

- `BridgeRunOutcome.COMPLETED.diagnostics: ExecutionDiagnostics | null` — redacted, capped
  context of the CLI call behind an error (bridge session, iteration, CLI session id +
  evidence + continuity, exit code, duration, prompt SHA-256/bytes, stdin delivery,
  Claude's final message, stderr/stdout tails).
- `getExecutionOutput(runId, iteration, agent: 'claude'|'codex', stream: 'stdout'|'stderr')`
  → last 256 KB of that call's persisted (redacted) CLI output, or null.
- `IterationArtifacts` gained `claudeExecution` / `codexExecution` (`ExecutionView`:
  the `<NNN>-<agent>-execution.json` record + effective status) and `codexVerdict`;
  `SessionSummary` gained `claudeSessionId` / `codexThreadId`.
- New events: `PROMPT_PERSISTED`, `CLAUDE_PROCESS_STARTED`, `CLAUDE_SESSION_RESUMED`,
  `CLAUDE_FAILED`, `CODEX_PROCESS_STARTED`, `CODEX_FAILED`; `PROMPT_SENT` is now emitted
  (prompt written to Claude's stdin and stdin closed — pipe-level evidence only).
- Details and evidence rules: [docs/12-m4.1-session-execution-transparency-report.md](12-m4.1-session-execution-transparency-report.md).

## M4.2 additions (development journal & custom review rounds)

```typescript
getJournal(runId: string): Promise<JournalIndex | null>          // null for invalid/unknown ids
getJournalEntry(runId: string, kind: JournalEntryKind, iteration: number | null): Promise<JournalEntry | null>

type JournalEntryKind =
  | 'SESSION_INDEX' | 'FINAL_REPORT'                              // iteration: null
  | 'CLAUDE_REPORT' | 'CHATGPT_REVIEW' | 'CLAUDE_PROMPT' | 'NEXT_PROMPT' | 'RAW_CODEX_RESPONSE';  // iteration: number

interface JournalIndex {
  runId: string;
  status: string;
  maxIterations: number | null;
  rounds: { iteration: number; state: RoundState; verdict: string | null; available: JournalEntryKind[] }[];
  hasSessionIndex: boolean;
  hasFinalReport: boolean;
}
// JournalEntry = ArtifactText & { kind: JournalEntryKind; iteration: number | null }
```

- `getJournal()`/`getJournalEntry()` are read-only views over Markdown Core generates from
  already-verified artifacts (execution records, the validated report, Codex's raw
  response) — never a second source of truth, never model-summarized. Regenerated
  (idempotently) on each `getJournal()` call unless the session is the live `RUNNING` one,
  in which case the run's own background rebuild (scheduled at safe transitions) owns it.
- `BridgeStartOptions.maxIterations` is now validated against `[1, MAX_RUN_ITERATIONS]`
  (100) **before** preflight/lock acquisition; out-of-range input returns a new outcome
  kind instead of `COMPLETED`:
  ```typescript
  | { kind: 'INVALID_OPTIONS'; reason: string }
  ```
- Details: [docs/13-m4.2-development-journal.md](13-m4.2-development-journal.md).

## What's intentionally NOT in this contract

- UI concerns — the desktop app built against this contract in M4 lives in `src/desktop/`
  and is documented in [docs/11-m4-electron-react-report.md](11-m4-electron-react-report.md).
- No IPC serialization format is prescribed — every type above is already plain,
  JSON-serializable data, so whatever Electron IPC mechanism is chosen (`ipcMain.handle`,
  a custom bridge, etc.) can pass these values through unchanged.
- No authentication/authorization layer — `BridgeEngine` assumes its caller is already
  trusted (the same assumption the CLI makes today). If Electron ever needs to gate who
  can call `start()`/`stop()` on a shared machine, that's a UI-layer concern, not Core's.

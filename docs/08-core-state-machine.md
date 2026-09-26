# AI Bridge — Core State Machine (M3)

## States

Names follow the existing M1/M2 `OrchestratorState` where an equivalent already existed
(M3 spec §9 explicitly permits this). Two states are new in M3: `PAUSED`, `RECOVERING`.

| This project's state | Roughly equivalent M3-spec name | Meaning |
|---|---|---|
| `IDLE` | `IDLE` | Before anything happens |
| `RECOVERING` | — (new) | This `run()` call was started via `resume` (a `resumeState` was supplied) |
| `PREFLIGHT` | `STARTING` | Cost-guard check passed; about to begin |
| `CLAUDE_EXECUTING` | `CLAUDE_EXECUTING` | `claude -p` spawned for this iteration |
| `REPORT_DETECTED` | `CLAUDE_COMPLETED` (+ report found) | Claude exited 0; report file about to be validated |
| `REPORT_VALIDATED` | `REPORT_VALIDATED` | Report passed `ReportValidator` |
| `CODEX_REVIEWING` | `CODEX_EXECUTING` | `codex exec` spawned |
| `CODEX_RESPONSE_RECEIVED` | `CODEX_COMPLETED` | Codex exited 0; about to parse |
| `RESPONSE_PARSED` | `RESPONSE_PARSED` | `<AI_BRIDGE_RESPONSE>` parsed successfully |
| `PAUSED` | `PAUSED` | Cooperative pause honored at a safe boundary |
| `DONE` / `NEED_HUMAN` / `ERROR` / `STOPPED` / `STOPPED_MAX_ITERATIONS` | same | Terminal |

`PROMPT_PERSISTED`/`PROMPT_READY`/`WAITING_FOR_CLAUDE`/`ITERATION_COMPLETED` from the spec's
list don't have their own state in this implementation — they're covered by the 8 named
**crash-injection points** instead (see below), which are finer-grained than a full state
transition and don't need their own line in `.ai-bridge/state/current-session.json`.

## Transition table

Source of truth: `src/core/state-machine/transitions.ts`. Every entry was derived by
tracing each `push()` call site in `src/core/orchestrator/orchestrator.ts` (not designed
abstractly and hoped to match) — see that file's own comments for the exact line
references at the time of writing.

```text
IDLE          -> RECOVERING | PREFLIGHT | ERROR
RECOVERING    -> PREFLIGHT
PREFLIGHT     -> CLAUDE_EXECUTING | REPORT_DETECTED | ERROR | STOPPED | PAUSED | STOPPED_MAX_ITERATIONS
CLAUDE_EXECUTING          -> REPORT_DETECTED | ERROR
REPORT_DETECTED           -> REPORT_VALIDATED | ERROR
REPORT_VALIDATED          -> CODEX_REVIEWING | ERROR
CODEX_REVIEWING           -> CODEX_RESPONSE_RECEIVED | ERROR
CODEX_RESPONSE_RECEIVED   -> RESPONSE_PARSED
RESPONSE_PARSED -> CLAUDE_EXECUTING | DONE | NEED_HUMAN | ERROR | STOPPED | PAUSED | STOPPED_MAX_ITERATIONS
PAUSED          -> CLAUDE_EXECUTING | REPORT_DETECTED | STOPPED
DONE, NEED_HUMAN, ERROR, STOPPED, STOPPED_MAX_ITERATIONS -> (terminal, no outgoing edges)
```

`REPORT_DETECTED` reachable from both `CLAUDE_EXECUTING` (normal) and `PREFLIGHT`/`PAUSED`
(the two "skip Claude, resume by re-sending an existing report" cases) is intentional —
see `docs/06-recovery-design.md`.

## Enforcement

`isValidTransition(from, to)` is a pure predicate; `assertValidTransition` throws
`INVALID_STATE_TRANSITION: <from> -> <to> is not allowed` and leaves no state changed
(the throw happens *before* the transition is recorded). `Orchestrator`'s internal
`push()` calls `assertValidTransition` on every transition as a safety net — proven never
to actually fire across the full regression suite (including every error branch, resume,
pause, and all 8 crash-injection points), which is strong evidence the hand-traced table
above is accurate, not just asserted.

14 dedicated unit tests in `tests/state-transitions.test.ts` cover: the full happy-path
sequence transition-by-transition, the spec's own literal example
(`IDLE -> DONE` rejected, `IDLE -> STARTING -> CLAUDE_EXECUTING -> CLAUDE_COMPLETED`
accepted — translated to this project's equivalent names), every terminal state having no
outgoing edge, `PAUSED` only reachable from a safe boundary (never mid-flight), and a
mutation check (temporarily making `isValidTransition` always return `true` — the
transition-integrity tests correctly failed, proving the table is load-bearing, not
decorative).

## Crash-injection points (real recovery testing)

`CRASH_POINTS` (`src/core/orchestrator/orchestrator.ts`) — 8 named points where a
`crashInjection` option can force a real self-terminate (`process.exit()` in production;
a recorded callback in tests), used to prove recovery against an actual interruption
rather than a simulated one:

```text
AFTER_CLAUDE_STARTED    AFTER_CLAUDE_COMPLETED    AFTER_REPORT_VALIDATED
AFTER_CODEX_STARTED     AFTER_CODEX_COMPLETED     AFTER_RESPONSE_PARSED
AFTER_PROMPT_PERSISTED  BEFORE_PROMPT_SENT
```

Wired into the CLI via `AI_BRIDGE_CRASH_AT` (test-only; inert unless explicitly set — see
`docs/06-recovery-design.md` for the real crash test this enabled, and the two real bugs
it found and fixed).

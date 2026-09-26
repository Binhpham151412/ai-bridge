# AI Bridge — Recovery Design

How `ai-bridge stop`/`status`/`resume` work, what they're proven to do (real tests, not
just unit tests with fakes), and — just as important — what they deliberately don't try
to do.

## Process termination on Windows

Windows has no real cross-process signal delivery equivalent to POSIX `SIGTERM` for a
headless console process. `taskkill /PID <pid>` (without `/F`) is the closest analogue,
but a Node process with no window and no message loop generally ignores it.

`requestStop` (`src/core/process-manager/process-manager.ts`) therefore always has a real
fallback: attempt the graceful signal, poll for up to `gracefulTimeoutMs`, and if the
process is still alive, force-kill the **whole process tree** rooted at that one PID via
`taskkill /PID <pid> /T /F` (the same primitive `process-runner.ts` already used for
per-call timeouts, now exported as `killProcessTree`), then poll again to confirm.

**Confirmed in the M2 sprint's real smoke test:** `ai-bridge stop` against a real running
`start` session (with a real `claude` process as its child) returned `FORCE_KILLED`, and
the target PID was verified dead afterward. `stop` never targets any PID other than the
one recorded in the project's own `.ai-bridge/state/lock` file.

## Why `stop` almost always says `FORCE_KILLED`, not `GRACEFUL_STOP`

This is expected, not a bug: see the Windows limitation above. `GRACEFUL_STOP` is reachable
in the code (and is exercised by `requestStop`'s unit tests, where the fake `isPidAlive`
dependency simulates a process that exits on its own) but is unlikely in practice for a
headless `claude`/`codex` child. `FORCE_KILLED` is still a fully verified kill of the whole
tree — not a degraded outcome.

## Crash/interruption detection (`status`)

`.ai-bridge/state/current-session.json` is written **incrementally** — on every
`Orchestrator` state transition (`onTransition`), every PID becoming known
(`onPidUpdate`), and every Claude/Codex session/thread id becoming known
(`onSessionUpdate`) — not just once at the end of a run. This is what makes crash
detection possible: `status` compares the state file's last-known phase against whether
the lock file's PID is still alive. If the phase never reached a terminal value (`DONE`,
`NEED_HUMAN`, `ERROR`, `STOPPED`, `STOPPED_MAX_ITERATIONS`) and the process is gone,
`status` reports `INTERRUPTED`.

**Bug found and fixed during real testing:** the first implementation only wrote
`claudeSessionId`/`codexThreadId` into the state file at the very end of the run. A
session force-killed mid-run (e.g. while Codex was reviewing) would then have `null` for
`claudeSessionId` in its persisted state — even though Claude had already produced a real
session id — which would have made resuming Claude's session (the `RESPONSE_PARSED` case
below) silently start a **new** Claude session instead of continuing the old one. Fixed by
adding `Orchestrator.onSessionUpdate`, called the instant each id becomes known (before
the *other* adapter is ever invoked), wired to an incremental state write in `cli.ts`.
Covered by a dedicated orchestrator test and re-verified against a real interrupted
session.

## Resume: exactly two supported checkpoints

The M2 sprint spec names two concrete interruption points (§15); this is deliberately a
narrower scope than "resume from anywhere," because guessing at an ambiguous crash point
risks re-running Claude blindly or duplicating work — which the spec explicitly forbids.

### Case 1 — crash between `REPORT_VALIDATED`/`CODEX_REVIEWING` and Codex responding

Claude already finished and produced a **valid** report for iteration N; the crash
happened while Codex was reviewing it (or just before). Nothing was lost: the report file
on disk is still exactly what Codex needs to see.

`resume` re-sends that same report to Codex — via `Orchestrator`'s `resumeState:
{ startIteration: N, skipClaudeThisIteration: true, claudeSessionId, codexThreadId }` —
without invoking Claude again for iteration N. If Codex's thread was never started
(`codexThreadId` is `null`), a fresh thread starts; otherwise the existing thread resumes.

**Confirmed for real** (M2 sprint): a live session was killed mid-`CODEX_REVIEWING`,
`ai-bridge resume` correctly skipped Claude, re-validated the existing `001-report.md`,
sent it to Codex fresh, and the run completed with `finalStatus: DONE` — no duplicate
report, no second Claude invocation (verified via the human log and the session
directory's file listing).

### Case 2 — crash between `RESPONSE_PARSED` and the next iteration's Claude call

Codex already produced the next `<PROMPT>` (status `CONTINUE`) and it was written to
`<sessionDir>/<NNN>-extracted-prompt.md`; the crash happened before Claude iteration N+1
started.

`resume` reads that exact file and continues via `resumeState: { startIteration: N+1,
skipClaudeThisIteration: false, claudeSessionId, codexThreadId }` — Claude resumes the
**same session** (`--resume <claudeSessionId>`) with the **same prompt text**, byte for
byte, that Codex produced.

**Verified for real in M3** (this was M2's single biggest honestly-flagged gap — see
`docs/03-m2-development-report.md`'s Known Limitations). Using the crash-injection
mechanism below, a real session was force-crashed at `AFTER_PROMPT_PERSISTED` in
`sandbox/m3-recovery-test/`, the process actually exited (`process.exit(137)`, verified
gone from the process list), and `ai-bridge resume` was run against the surviving state
and prompt file. Confirmed: SHA-256 of the prompt text persisted before the crash equals
the SHA-256 of the prompt text Claude actually received after `resume` — proving the exact
mechanism this section describes, not a simulation of it. Getting to that clean result
required finding and fixing three separate real bugs (state-file corruption, a Windows
`rename()` race, and a stale-write durability gap) — see "Real crash recovery test" below.

### Everything else → `RECOVERY_BLOCKED`

Mid-`CLAUDE_EXECUTING`, mid-`CODEX_REVIEWING` before Codex's process actually exits,
`IDLE`/`PREFLIGHT` (never really started), or any terminal status — `resume` refuses and
asks for human intervention. Re-running Claude while its previous invocation's outcome is
unknown risks duplicate file writes or a report that doesn't match what the orchestrator
expects next; the spec's own words are "không chạy Claude lại một cách mù quáng" (don't
blindly re-run Claude), which this directly honors.

Since M3, this decision (`CONTINUE_FROM_PROMPT` / `RESEND_REPORT_TO_CODEX` / `BLOCKED`) is
made by a pure function, `decideRecoveryStrategy` (`src/core/recovery/recovery.ts`), not
inline in `cli.ts`. `cmdResume` calls it and then only performs the file I/O the returned
strategy calls for — the "is this state resumable, and how" logic is Core, not CLI, so a
future Electron UI can call the same function directly. `PAUSED` states feed the same
function (see Pause/Resume below): `PAUSED` at iteration ≥ 1 decides identically to
`RESPONSE_PARSED`; `PAUSED` at iteration 0 is `BLOCKED` (nothing was ever persisted to
resume from).

## Crash-injection mechanism (M3)

`Orchestrator` accepts an optional `crashInjection: { at: CrashPoint; onTrigger: () => void }`.
`CrashPoint` is one of 8 named points (`src/core/orchestrator/orchestrator.ts`,
`CRASH_POINTS`) bracketing every phase boundary — see `docs/08-core-state-machine.md` for
the full list. Each point fires `onTrigger` **at most once ever** per orchestrator instance
(a `crashFired` guard), and only if `crashInjection.at` matches.

In production wiring (`cli.ts`), this is inert unless the test-only environment variable
`AI_BRIDGE_CRASH_AT` is set to one of the 8 valid point names — normal `start`/`resume`
runs never pass a `crashInjection` option at all. When set, `onTrigger` is a literal
`process.exit(137)` — the orchestrator's **own** process self-terminates; nothing calls
`process.kill`/`taskkill` on any other process. This is what let M3 prove real interruption
recovery without ever touching a process outside the test's own run tree.

## Real crash recovery test (M3)

Target: `AFTER_PROMPT_PERSISTED` (Case 2 above), run twice in `sandbox/m3-recovery-test/`
because the first run surfaced real bugs that needed fixing before the second, clean run:

1. `AI_BRIDGE_CRASH_AT=AFTER_PROMPT_PERSISTED ai-bridge start ...` — the process
   self-exits with code 137 right after persisting iteration N's extracted prompt.
2. **First attempt** — `.ai-bridge/state/current-session.json` was corrupted (trailing
   garbage bytes after a complete JSON object): three fire-and-forget `writeState()` calls
   from different callbacks overlapped. Fixed with `AtomicJsonWriter` (temp file + atomic
   rename + an internal promise chain that serializes all writes to one file).
3. `AtomicJsonWriter`'s own concurrency stress test then hit a genuine Windows-only
   `EPERM` on `rename()` under concurrent readers — not a reproducibility artifact, an
   actual observed OS behavior (POSIX `rename()` has no such transient failure mode).
   Fixed with a bounded retry (`renameWithRetry`, 15 attempts, linear backoff).
4. **Second attempt** (after both fixes) — the state file was now valid JSON but *stale*:
   `status: "CODEX_REVIEWING"` instead of `"RESPONSE_PARSED"`, `codexThreadId: null`
   despite Codex having already responded. `AtomicJsonWriter` serializes writes that are
   actually *issued*, but a fire-and-forget (`void writeState(...)`) call can still be
   sitting unexecuted in the microtask queue when `process.exit()` runs synchronously.
   Fixed by making `Orchestrator.onTransition`/`onSessionUpdate` return
   `void | Promise<void>` and `await`ing them at every one of the 18 real call sites inside
   the orchestrator's `push()`, and making `cli.ts`'s corresponding callbacks
   `async`/`await writeState(...)` instead of `void writeState(...)`. This directly
   implements the M3 spec's "persist before any external side effect" principle — the fix
   is *why* that principle now holds in practice, not just in intent.
5. **Result (clean re-run):** state file correctly showed `RESPONSE_PARSED` after the
   crash; `ai-bridge resume` read the persisted prompt file for iteration N, resumed
   Claude's real session, and iteration N+1 completed normally to `DONE`. SHA-256 of the
   prompt persisted pre-crash == SHA-256 of the prompt Claude actually received
   post-resume — verified by direct hash comparison, not inferred.

## Pause / Resume (M3)

Pause is strictly **cooperative** — it never interrupts an in-flight Claude or Codex call.
`ai-bridge pause` writes a marker file (`.ai-bridge/state/pause-request`); the running
orchestrator's loop checks `shouldPause` (polling for that file) at exactly the same safe
boundaries `shouldStop` already used (top of the iteration loop, between phases — never
mid-spawn). When honored, the orchestrator transitions to `PAUSED` and returns.

`cmdPause` then polls the session's state file for up to a bounded timeout, waiting for
`status: "PAUSED"` to appear. **Bug found and fixed during real testing:** the polling
loop's `while (... && isPidAlive(lockPid))` condition could see the process already exited
(clean exit right after reaching `PAUSED`) in the same tick the loop was about to re-check
status, exiting the loop with a false "pause was missed" — even though the state file
already said `PAUSED`. Fixed by re-reading the state file once more *after* the loop exits,
before concluding the pause wasn't reached.

`ai-bridge resume` is unchanged in shape from Case 1/2 above — it calls the same
`decideRecoveryStrategy` regardless of whether the prior run ended via `PAUSED` or via an
actual crash; only the printed message differs ("Resuming from a pause." vs. "Recovering
from an interruption.") since the underlying resumability logic is identical by design.

**Verified for real** in `sandbox/m3-pause-test/`: `start` → `pause` (while Claude/Codex
were actively iterating) → `status` correctly reported `PAUSED` → `resume` continued from
the exact next prompt and completed to `DONE`. SHA-256-verified prompt continuity across
the pause boundary, the same way the crash test verified it across a crash boundary.

## Still not built

- **Resuming Codex mid-review** (crash literally while `codex exec` is running and its
  exit status is unknown) — treated as `RECOVERY_BLOCKED`, not attempted. Unchanged from
  M2; still considered correctly out of scope, not a gap — the spec explicitly prefers
  refusing over guessing here.

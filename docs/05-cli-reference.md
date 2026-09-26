# AI Bridge — CLI Reference

All commands: `node src/cli.ts <command> [flags]` (or `pnpm ai-bridge <command> [flags]`,
per the `ai-bridge` script in `package.json`). Flags are `--name value` pairs; a flag with
no following value is a parse error, not silently dropped (`src/cli-args.ts`).

## `doctor`

```bash
ai-bridge doctor --project <path>
```

| Check | PASS condition | Other outcomes |
|---|---|---|
| `node` | always | — |
| `api-key-env` | none of `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY`/`CODEX_API_KEY` set | `BLOCKED` if any is set (never prints the value) |
| `claude-cli` | `claude` resolved via `where.exe` | `FAIL` if not found |
| `claude-auth` | `claude auth status` reports a subscription | `BLOCKED` if API-key/Console mode, `FAIL` if logged out, `UNKNOWN` if unparseable |
| `codex-cli` | `codex` resolved via `where.exe`, or the newest `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` | `FAIL` if neither found |
| `codex-auth` | `codex login status` reports "Logged in using ChatGPT" | `BLOCKED` if API-key mode, `FAIL` if logged out, `UNKNOWN` if unparseable |
| `git` | `git --version` succeeds | `FAIL` if not found |
| `project-directory` | the `--project` path exists and is a directory | `FAIL` otherwise |
| `config` | `.ai-bridge/config.json` is absent (defaults apply) or valid | `FAIL` with the specific schema error(s) |
| `git-repository` | clean working tree | `WARNING_NOT_GIT_REPOSITORY` / `WARNING_UNCOMMITTED_CHANGES` (escalate to `FAIL` if `requireGitRepository`/`stopOnUncommittedChanges` is set in config) |

Overall status: `BLOCKED` (if any check is `BLOCKED`) > `FAIL` (if any check is `FAIL`/`UNKNOWN`) > `PASS`.
Exit code: `0` if `PASS`, `1` otherwise.

## `start`

```bash
ai-bridge start --project <path> --task "<text>" [--max-iterations N] [--claude-timeout-ms N] [--codex-timeout-ms N]
```

Required: `--project`, `--task` (the exact text Claude receives on iteration 1 — never
rewritten). `--max-iterations` overrides `.ai-bridge/config.json`'s value for this run
only. Runs `doctor` first and refuses to start unless it's `PASS` (exit `2` if `BLOCKED`,
`1` otherwise). Acquires `.ai-bridge/state/lock`; a second `start` on the same project
while the first is alive prints `ERROR_ALREADY_RUNNING` and exits `2`. Blocks in the
foreground until `DONE`/`NEED_HUMAN`/`STOPPED`/`STOPPED_MAX_ITERATIONS`/`ERROR`; exit code
`0` only on `DONE`. Ctrl+C requests a cooperative stop at the next iteration boundary.

## `stop`

```bash
ai-bridge stop --project <path>
```

Run from a different terminal than the one running `start`. Reads the PID from the lock
file; if none, prints "No running ai-bridge session found" and exits `0`. Otherwise:
attempts a graceful signal, polls for up to 10s, then force-kills the whole process tree
(`taskkill /PID <pid> /T /F`) if still alive, polling again for up to another 10s to
confirm. Prints one of `NOT_RUNNING` / `GRACEFUL_STOP` / `FORCE_KILLED` / `STOP_FAILED`.
Releases the lock itself if the target process couldn't clean up after itself. **Windows
limitation:** the "graceful" attempt (`taskkill /PID <pid>` without `/F`) generally has no
effect on a headless console Node process — there is no real cross-process signal delivery
on Windows for this case — so in practice the result is almost always `FORCE_KILLED`. This
is still a real, verified kill (confirmed in the M2 sprint's real smoke test), just not
"graceful" in the deepest sense.

**Since M4:** once `stop` has confirmed the session's process is gone, a state file still
showing a mid-flight phase is recorded as `STOPPED` (terminal, with a `RUN_STOPPED` event,
detail `Stopped by user (<reason>)`) instead of being left to read as a crash
(`INTERRUPTED`) — an explicit stop is never offered for `resume`. Any pending pause
request is cleared at the same time. Use `pause` if you want to continue later.

## `status`

```bash
ai-bridge status --project <path>
```

Reads `.ai-bridge/state/current-session.json` (fails with "No session state found" and
exit `1` if absent). Prints: `Status`, `Session`, `Iteration`, `Current phase`,
`Claude PID`, `Codex PID`, `Elapsed`, `Last report`. `Status` is the session's own
terminal status if it reached one; otherwise `RUNNING` if the lock file's PID is still
alive, else `INTERRUPTED` (the process died without reaching a terminal state — a genuine
crash or a kill from outside AI Bridge; since M4 an `ai-bridge stop` is recorded as
`STOPPED` instead).

## `pause` (M3)

```bash
ai-bridge pause --project <path>
```

Run from a different terminal than the one running `start`/`resume`. If no live session is
found (no lock, or the lock's PID is dead), prints "No running ai-bridge session found for
this project." and exits `1`. Otherwise writes a marker file
(`.ai-bridge/state/pause-request`) and polls the state file for up to 60s waiting for
`status: "PAUSED"`. **Strictly cooperative** — never sends any signal to, or kills, the
Claude/Codex process tree; if Claude or Codex is mid-call, that call finishes first, and
only then does the orchestrator check for the pause request at the next safe boundary. One
of three outcomes is printed: `PAUSED.` (reached in time), "Still waiting for a safe
boundary..." (60s elapsed, session still running), or "The session ended (final status:
...) before a pause was reached" (the session reached a terminal state, e.g. `DONE`, before
noticing the pause request). **Known gap:** only the first "no session found" case sets a
non-zero exit code (`1`); the latter two both exit `0` even though the pause wasn't
necessarily achieved — a caller must read the printed status (or run `ai-bridge status`
afterward) rather than rely on the exit code alone for those two outcomes.

## `resume`

```bash
ai-bridge resume --project <path>
```

Reads the state file, runs `doctor` (same gating as `start`), acquires the lock, then calls
`decideRecoveryStrategy` (`src/core/recovery/recovery.ts`) with `state.status` and
`state.iteration`:

| Last known phase | What resume does |
|---|---|
| `RESPONSE_PARSED`, or `PAUSED` with iteration ≥ 1 | Codex had already produced the next `<PROMPT>` (or the run was paused after at least one full iteration). Reads `<sessionDir>/<NNN>-extracted-prompt.md` and continues at iteration N+1 with that exact text, resuming the same Claude session (`--resume`) and Codex thread. Prints "Resuming from a pause." or "Recovering from an interruption." depending on which. |
| `REPORT_VALIDATED` or `CODEX_REVIEWING` | Claude had already produced a valid report for iteration N before the crash. Re-sends that existing report to Codex without re-invoking Claude. |
| `PAUSED` with iteration 0 | Paused before any iteration completed — nothing was ever persisted to resume from. `RECOVERY_BLOCKED`, exits `3`. |
| anything else (including mid-`CLAUDE_EXECUTING`/`CODEX_REVIEWING` in a way that can't be distinguished from "still running", `IDLE`, `PREFLIGHT`, a terminal status) | Prints `RECOVERY_BLOCKED` and the reason, exits `3`. Never guesses, never re-runs Claude "just in case." |

## `logs`

```bash
ai-bridge logs --project <path> [--lines N]
```

Prints the last `N` (default 50) lines of `.ai-bridge/logs/ai-bridge.log`. See
[docs/03-m2-development-report.md](03-m2-development-report.md) for the full set of log
artifacts a session produces.

## `reset`

```bash
ai-bridge reset --project <path>
```

Refuses if a session is currently running (checks the lock's PID). Otherwise deletes only
`.ai-bridge/state/lock` and `.ai-bridge/state/current-session.json`. Never touches project
code. Never touches `.ai-bridge/reports/`, `.ai-bridge/sessions/`, or `.ai-bridge/logs/`
— those are the audit trail and are only ever left alone by `reset`, regardless of flags.

## Exit codes (all commands)

This project keeps the small 0–3 convention established in M2 rather than adopting the
M3 spec's larger suggested 0–8 scheme (the spec explicitly permits keeping an existing,
fully-documented convention). Every code below is genuinely distinguishable by a caller
without parsing stdout — except `pause`'s two non-error outcomes, noted above, which is
the one deliberate gap.

| Code | Meaning | Used by |
|---|---|---|
| `0` | Success (or, for `doctor`, overall `PASS`) | all commands |
| `1` | General failure — bad usage, `FAIL`, non-`DONE` final status, missing state, no running session | all commands |
| `2` | `BLOCKED` (cost guard or auth) on preflight, or `ERROR_ALREADY_RUNNING` | `start`, `resume` |
| `3` | `RECOVERY_BLOCKED` — last known phase isn't a safely resumable checkpoint | `resume` |

## `AI_BRIDGE_CRASH_AT` (test-only)

Not a normal-use flag — an environment variable read by `start`/`resume` (`src/cli.ts`)
that, when set to one of the 8 crash-point names in
[docs/08-core-state-machine.md](08-core-state-machine.md), makes the process
`process.exit(137)` itself immediately after reaching that point. Used exclusively to
prove real crash recovery in a disposable sandbox (see
[docs/06-recovery-design.md](06-recovery-design.md)); inert/unset in every normal
invocation and never documented to end users as a supported feature.

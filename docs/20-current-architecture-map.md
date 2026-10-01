# 20 — Current Architecture Map (M4.2 + M4.3 Phase 1, as built)

Status: **EXISTING** — describes only what is in the repository on 2026-09-28 (`main` at
`27fb871`, which includes the UI/UX refactor `3a22247` and M4.3 Phase 1; see docs/18).
Nothing here is proposed.
This is the baseline against which every later architecture document (21–40) must be
reviewed. When a claim in an older document disagrees with the code, the code wins and the
difference is listed in §12.

## 1. Purpose

- Give reviewers a precise, file-level map of what exists: modules, responsibilities,
  dependencies, public boundaries, execution flow, persistence and IPC.
- Mark what already exists so later documents can't present an existing mechanism as
  new, or assume one that does not exist.
- Record the gaps that only reading the code reveals (declared but unused items,
  documentation drift) as facts, without fixing them.

## 2. Current State — repository layout

```
src/
  cli.ts, cli-args.ts                 CLI host (thin adapter over BridgeEngine)
  core/
    bridge-engine.ts                  BridgeEngine — the single Core entry point (976 lines)
    orchestrator/orchestrator.ts      Orchestrator — the Claude→Codex loop (638 lines)
    state-machine/transitions.ts      Transition table + assertValidTransition
    recovery/recovery.ts              decideRecoveryStrategy (pure)
    state-manager/atomic-json-writer.ts  AtomicJsonWriter (tmp+rename, serialized queue)
    session-manager/session-manager.ts   SessionManager.createSession (runId allocation)
    lock/run-lock.ts                  Per-project run lock (pid-based stale detection)
    process-manager/process-manager.ts   requestStop escalation (graceful → force)
    observability/events.ts           EVENT_TYPES, BridgeEvent, appendEvent, rotation
    logger/logger.ts                  appendLogLine (per-day JSONL call log)
    execution/execution-record.ts     M4.1 ExecutionRecord, TokenUsage, diagnostics
    integrity/integrity.ts            sha256Text, prompt/report transport integrity
    journal/journal.ts, journal-types.ts  M4.2 Development Journal (Markdown, derived)
    session-history/session-history.ts   Read-only views over sessions/events/artifacts
    config/config.ts                  AiBridgeConfig, validateConfig, MAX_RUN_ITERATIONS
    cost-guard.ts                     API-key env guard, auth-status parsers
    preflight/{doctor,executable-resolver,git-safety,permission-mode}.ts
    security/redact.ts                redactSecrets
    status/agent-activity.ts          describeAgentActivity
    providers/                        M4.3 Phase 1 — diagnostics only (isolated)
      provider-types.ts, cli-provider.ts, claude-code-provider.ts,
      codex-provider.ts, executable-discovery.ts, provider-registry.ts
  adapters/
    claude/claude-code-cli-adapter.ts ClaudeCodeCliAdapter (claude -p stream-json)
    chatgpt/codex-cli-adapter.ts      CodexCliAdapter (codex exec [resume])
  automation/process-runner.ts        runProcess, killProcessTree (no shell)
  reports/report-validator.ts         ReportValidator (Claude report contract)
  reports/codex-response-parser.ts    CodexResponseParser (<AI_BRIDGE_RESPONSE>)
  prompts/templates.ts                buildReportContract, buildReviewerInput
  desktop/
    main/  main.ts, run-controller.ts, ipc-router.ts, run-host*.ts, fork-run-host.ts,
           app-settings.ts, project-path.ts, redaction.ts
    preload/ preload.ts, bridge-api.ts
    shared/  ipc-contract.ts, controls.ts, messages.ts
    renderer/ main.tsx, components/*, lib/*, state/*
scripts/desktop/{build,cdp,package-win,smoke,real-e2e}.ts, scripts/real/bridge-engine-driver.ts
tests/  49 test files, 535 tests (node:test + happy-dom), fake CLIs under tests/fixtures/
```

Source size: about 6.6k lines of `src/`, about 12k lines including tests and scripts.
Zero runtime dependencies beyond Node/Electron/React (devDependencies only).

## 3. Module responsibilities (actual)

| Module | Responsibility (what the code does) | Depends on |
|---|---|---|
| `BridgeEngine` | Per-project facade. Runs preflight (`realRunDoctor`), acquires the run lock, allocates the session (`SessionManager`), builds the adapters, constructs and runs `Orchestrator`, persists `current-session.json` through `AtomicJsonWriter` on every transition, appends events, schedules journal rebuilds, and exposes read APIs (status, sessions, artifacts, journal, config). | nearly all of `core/`, both adapters, `process-runner` |
| `Orchestrator` | One run's loop, `iteration = start..maxIterations`: write the prompt and verify its hash → Claude → validate the report → build the reviewer input and verify transport integrity → Codex → parse the response → write the extracted prompt and `NNN-integrity.json` → DONE / NEED_HUMAN / next iteration. Checks `shouldStop`/`shouldPause` at iteration boundaries. Never retries, never repairs output. | adapters (concrete classes), validator, parser, templates, integrity, transitions, execution-record |
| `transitions.ts` | Static table of the valid `BridgeState` transitions; `assertValidTransition` is called in `Orchestrator.push()` as a safety net. | — |
| `recovery.ts` | Pure: from the persisted `{status, iteration, ids}`, returns `CONTINUE_FROM_PROMPT` (status RESPONSE_PARSED, or PAUSED with iteration ≥ 1), `RESEND_REPORT_TO_CODEX` (REPORT_VALIDATED / CODEX_REVIEWING), or `BLOCKED`. | — |
| `ClaudeCodeCliAdapter` | `claude -p --output-format stream-json --verbose --session-id|--resume <id> [--append-system-prompt] [--permission-mode] [--allowedTools] [--disallowedTools]`, prompt via stdin. Error codes SPAWN_FAILED / TIMEOUT / NON_ZERO_EXIT / BAD_JSON / NO_RESULT_EVENT / SESSION_MISMATCH. | `runProcess` |
| `CodexCliAdapter` | `codex exec --json -s read-only --skip-git-repo-check -o <file> -`, or `exec resume <thread> --json -c sandbox_mode="read-only" …`. Reads the response from the `-o` file. Error codes include THREAD_MISMATCH and OUTPUT_FILE_MISSING. | `runProcess` |
| `runProcess` | `spawn` with no shell; stdin input; per-stream 50 MB cap; timeout → `taskkill /T /F`; resolves and never rejects; reports stdin delivery evidence. | `node:child_process` |
| `execution-record.ts` | One `NNN-{claude,codex}-execution.json` per CLI call: written before spawn (RUNNING), rewritten on exit. Records evidence levels (session id CONFIRMED_BY_CLI / REQUESTED_NOT_CONFIRMED / UNKNOWN, continuity, stdin delivery) and token usage exactly as the CLI reported it. | atomic writer, redact |
| `session-history.ts` | Read-only: `listSessions`, `readSessionArtifacts`, `readEventLog`, `readExecutionOutput`; `RUN_ID_PATTERN` validates every caller-supplied run id before it becomes a path. | parser, integrity, events |
| `journal.ts` | Derives Markdown (`NNN-claude-report.md`, `NNN-review.md`, `session.md`, `final-report.md`) from verified artifacts; idempotent (`writeIfChanged`); never model-generated. | session-history |
| `events.ts` | 24 event types; `BridgeEvent {timestamp, runId, iteration, phase, event, detail?, …extra}`; append-only JSONL with one-backup rotation at 10 MB. | fs |
| `config.ts` | `.ai-bridge/config.json`: maxIterations (1..100), claude/codex timeouts, reportMaxBytes, stopOnUncommittedChanges, requireGitRepository; unknown fields rejected. | — |
| `cost-guard.ts` | Blocks ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / OPENAI_API_KEY / CODEX_API_KEY; parses `claude auth status` / `codex login status`. Called from doctor **and** from inside `Orchestrator.run()` (defense in depth). | — |
| `permission-mode.ts` | Allowlist `default | acceptEdits | plan`; `bypassPermissions` refused in the `Orchestrator` constructor. | — |
| `providers/*` (M4.3 P1) | `ProviderRegistry` of `ProviderAdapter`s (Claude Code, Codex): discovery, version, auth, optional execution probe, login-command description, cached `ProviderStatus`. **Not used by the execution flow**; imported only by `tests/providers/*`. | process-runner, cost-guard, redact |
| `RunController` (Main) | Holds the open project and a `BridgeEngine` for in-process read/short calls; forks the run host for `start`/`resume`; derives `BridgeSnapshot` (+ `deriveControls`); polls status (1 s active / 5 s idle); publishes snapshots and events. | BridgeEngine (types + instance), shared contract |
| Run host (`run-host*.ts`) | Child process (Electron as Node) that executes exactly one `start()`/`resume()`, forwards events, reports the outcome, exits. Exists because `stop()` kills the lock holder's process tree. | BridgeEngine |
| IPC (`ipc-contract.ts`, `ipc-router.ts`, preload) | 17 invoke channels + 2 push channels; sender-URL check → channel allowlist → payload validation → handler → error redaction. Frozen preload API, one function per channel. | shared contract |
| Renderer | React views Run / Journal / Artifacts / Settings / System; `BridgeProvider` holds the pushed snapshot and events; `useSessionData` loads artifacts/journal via IPC; `run-summary.ts` maps Core values to fixed sentences. **No orchestration logic.** | preload API (types) |

## 4. Dependency direction (actual)

```
renderer ──(window.aiBridge, IPC)──► preload ──► Main (ipc-router → RunController)
                                                     │  in-process: status/read calls
                                                     │  fork: run host ──► BridgeEngine.start/resume
                                                     ▼
cli.ts ───────────────────────────────────────► BridgeEngine (core/bridge-engine.ts)
                                                     │
                     ┌───────────────┬───────────────┼─────────────────┬──────────────┐
                     ▼               ▼               ▼                 ▼              ▼
               Orchestrator   preflight/doctor  lock/session/state   events/logger  journal/history
                     │
        ┌────────────┼──────────────┬──────────────────┐
        ▼            ▼              ▼                  ▼
  ClaudeAdapter  CodexAdapter  ReportValidator    CodexResponseParser, templates
        └─────┬──────┘
              ▼
        process-runner (spawn, no shell)

core/providers/*  ──► process-runner, cost-guard, redact      (no inbound edges except tests)
```

Structural rules enforced by `tests/architecture.test.ts`: nothing under
`core/ adapters/ reports/ prompts/` imports `cli.ts`, calls `console.*` or calls
`process.exit`. `tests/desktop/security.test.ts` enforces renderer isolation (no `fetch(`
in `src/desktop`, CSP, preload surface).

## 5. Public boundaries (actual)

### 5.1 BridgeEngine API (the execution boundary)

`new BridgeEngine(projectPath, deps?)`: one instance per project directory. `deps` exist
for tests only.

| Method | Returns | Notes |
|---|---|---|
| `doctor()` | `DoctorReport` | Real `where`, auth checks, git status. |
| `start({task, maxIterations?, crashInjection?})` | `BridgeRunOutcome` | Resolves only when the run ends. Kinds: BLOCKED_PREFLIGHT, ALREADY_RUNNING, INVALID_OPTIONS, COMPLETED{finalStatus, errorCode, iterations, sessionDir, claudeSessionId, codexThreadId, diagnostics}. |
| `resume()` | `BridgeRunOutcome` | Resumes the project's **current** session only (from `current-session.json`); adds NO_STATE, RECOVERY_BLOCKED. |
| `pause()` | NOT_RUNNING / PAUSED / STILL_RUNNING / ENDED_BEFORE_PAUSE | Writes the `state/pause-request` marker, then polls for up to 60 s. |
| `stop()` | NOT_RUNNING / STOPPED{GRACEFUL_STOP \| FORCE_KILLED \| STOP_FAILED} | Kills the **lock holder's process tree**; records STOPPED. |
| `status()` | `BridgeStatus` | Display status RUNNING / INTERRUPTED / NOT_STARTED / terminal, derived from state file + lock pid liveness. |
| `checkRecovery()` | NONE / RUNNING / RECOVERABLE{strategy} / BLOCKED{reason} | Same `planRecovery` that `resume()` uses. |
| `subscribe(listener)` | unsubscribe | In-process listener; errors swallowed. |
| `listSessions`, `getSessionArtifacts`, `getExecutionOutput`, `getJournal`, `getJournalEntry`, `recentEvents`, `getConfig`, `saveConfig`, `logs`, `reset` | read / small writes | `saveConfig` and `reset` refuse while a run is live. |

Every outcome is a plain JSON-serializable discriminated union; no exceptions cross the
boundary in normal operation.

### 5.2 Execution identity (actual)

- **runId** = `YYYY-MM-DD_NNN` (UTC date + per-day counter from scanning `sessions/`). It
  is the only execution identifier. `BridgeRunOutcome` does not carry it directly; it is
  the basename of `sessionDir`, and it appears on every `BridgeEvent` (the first one is
  `RUN_STARTED`).
- **iteration** = 1..maxIterations inside a run.
- Claude **session id**: client-assigned UUID (`--session-id`), resumed with `--resume`.
  Codex **thread id**: server-assigned, reported by `thread.started`.
- There is **no** event id, correlation id or caller-supplied reference of any kind.

### 5.3 IPC boundary (actual)

Invoke channels (17): `bridge:getSnapshot, start, pause, resume, stop, discard, doctor,
getRecentEvents, listSessions, getSessionArtifacts, getExecutionOutput, selectProject,
getSettings, saveProjectConfig, setDefaultProject, getJournal, getJournalEntry`.
Push channels: `bridge:event`, `bridge:snapshot`. The preload exposes 19 frozen functions
(17 invoke + `onEvent` + `onSnapshot`); there is no generic `invoke`/`send`.
Run host protocol: `HostCommand {start|resume}` → `HostMessage {event|outcome|failed}`,
JSON serialization, validated on both sides.

## 6. Execution flow (actual, one run)

```
start(task)
 ├─ validate maxIterations (1..100)             → INVALID_OPTIONS
 ├─ runDoctor (overall must be PASS)             → BLOCKED_PREFLIGHT
 ├─ acquireLock(state/lock)                      → ALREADY_RUNNING
 ├─ clear stale pause marker; SessionManager.createSession() → runId, sessions/<runId>/
 └─ runLoop
     ├─ write current-session.json {status: STARTING}; event RUN_STARTED
     └─ Orchestrator.run()
         IDLE → (cost guard) → PREFLIGHT
         for iteration:
           [boundary] shouldStop → STOPPED | shouldPause → PAUSED
           write NNN-claude-prompt.md, re-read, sha256 check; event PROMPT_PERSISTED
           CLAUDE_EXECUTING: NNN-claude-execution.json (RUNNING) → claude CLI → stdout/stderr files → record finalized
             fail → ERROR (CLAUDE_RUN_FAILED:<code>)
             onSessionUpdate(claudeSessionId) awaited (persisted before Codex runs)
           REPORT_DETECTED → ReportValidator(reports/NNN-report.md) → REPORT_VALIDATED | ERROR(REPORT_INVALID)
           buildReviewerInput + transport integrity → NNN-chatgpt-input.md
           CODEX_REVIEWING: NNN-codex-execution.json → codex CLI (-o NNN-chatgpt-review.md)
             fail → ERROR (CODEX_RUN_FAILED:<code>)
           CODEX_RESPONSE_RECEIVED → parse → RESPONSE_PARSED | ERROR(RESPONSE_INVALID)
           write NNN-extracted-prompt.md, NNN-integrity.json
           STATUS DONE → DONE | NEED_HUMAN → NEED_HUMAN | CONTINUE → next iteration
         after loop → STOPPED_MAX_ITERATIONS
     ├─ write final status; event RUN_COMPLETED / RUN_STOPPED; journal rebuild
 └─ releaseLock
```

Every `push()` awaits `onTransition`, which awaits the atomic state write, so the phase is
durable before the next action. Journal rebuilds are queued and never fail the run.

**Who decides DONE today:** only Codex's parsed `<STATUS>`. Claude's report field
`NEXT_ACTION` is validated for format (`CONTINUE | DONE | NEED_HUMAN`) but not used in any
decision. No deterministic verification (tests, lint, build) exists anywhere in the loop.

## 7. State and persistence (actual)

All under `<project>/.ai-bridge/` (gitignored in this repo; target projects may not
ignore it).

| Path | Writer | Lifetime | Atomic? |
|---|---|---|---|
| `config.json` | `saveConfig` | persistent | yes (AtomicJsonWriter) |
| `state/current-session.json` | BridgeEngine | overwritten per run; **only one current session per project** | yes |
| `state/lock` | run-lock | during a run | plain write |
| `state/pause-request` | `pause()` | transient marker | plain write |
| `sessions/<runId>/NNN-claude-prompt.md`, `-chatgpt-input.md`, `-chatgpt-review.md`, `-extracted-prompt.md`, `-integrity.json` | Orchestrator | persistent, unbounded count | plain writes (prompt re-read + hash-checked) |
| `sessions/<runId>/NNN-{claude,codex}-execution.json` | Orchestrator | persistent | yes |
| `sessions/<runId>/NNN-{claude,codex}-stdout.jsonl`, `-stderr.log` | Orchestrator | persistent, ≤ 50 MB each, redacted | plain |
| `sessions/<runId>/NNN-claude-report.md`, `NNN-review.md`, `session.md`, `final-report.md` | journal | derived, idempotent | write-if-changed + rename |
| `reports/NNN-report.md` | **Claude** (per the report contract) | **shared across all sessions — the next run overwrites `001-report.md`** | n/a |
| `logs/events.jsonl` (+ `.1`) | BridgeEngine | rotated at 10 MB, one backup | append |
| `logs/ai-bridge.log` (+ `.1`) | BridgeEngine | rotated at 10 MB | append |
| `logs/YYYY-MM-DD-session.log` | Orchestrator `onLog` → `appendLogLine` | **one file per day, never rotated or deleted** | append |

`session-history` compensates for the shared reports directory on the read side: when the
report file's hash no longer matches, the report is recovered verbatim from
`NNN-chatgpt-input.md` (source CODEX_INPUT) or marked OVERWRITTEN/MISSING.

## 8. Recovery (actual)

- Crash detection: state not terminal and lock pid not alive → display `INTERRUPTED`.
- Resume unit: **an iteration checkpoint of the current session.** It has exactly two
  forms. (a) After RESPONSE_PARSED, or PAUSED at iteration ≥ 1: re-run from the persisted
  `NNN-extracted-prompt.md`, resuming the same Claude session and Codex thread.
  (b) After REPORT_VALIDATED or CODEX_REVIEWING: skip Claude and resend the persisted
  report to Codex. Every other phase (notably CLAUDE_EXECUTING and REPORT_DETECTED) is
  `RECOVERY_BLOCKED` by design: refuse rather than guess, because Claude may already have
  edited files.
- `resume()` constructs a **new** Orchestrator starting at IDLE → PREFLIGHT with
  `resumeState`. The `RECOVERING` state in the transition table is never entered.
- Pause is cooperative, only at iteration boundaries; `deriveControls` offers PAUSE only
  when iteration ≥ 1, because PAUSED at iteration 0 is unrecoverable.
- Stop escalation: best-effort graceful stop → `taskkill /T /F` of the lock holder. On
  Windows it is almost always FORCE_KILLED; the state is recorded as STOPPED (terminal).

## 9. Observability, audit and integrity (actual)

- Event stream: `logs/events.jsonl`, 24 types, with no event id or schema version.
  `ITERATION_COMPLETED` and `TIMEOUT` are declared but **never emitted** by Core.
- Per-call execution records and redacted CLI output (M4.1).
- Integrity: prompt write/read hash check; report hash plus verbatim-containment check
  before Codex; `NNN-integrity.json` records 5 hashes per iteration (not chained across
  iterations, no signature).
- Development Journal (M4.2): human-readable, derived only from the above.
- Token usage: parsed from the Claude `result` / Codex `turn.completed` events; null =
  UNKNOWN; never estimated.

## 10. Security controls (actual)

Cost guard (env and auth mode); permission-mode allowlist (Claude runs with
`acceptEdits`); Codex runs `read-only`; no shell spawning; `RUN_ID_PATTERN` and fixed
journal file names (no caller-supplied paths); redaction of CLI output, errors and
events; Electron: sandbox, contextIsolation, no nodeIntegration, CSP `default-src 'none'`,
permission handlers deny all, navigation / window.open denied, IPC sender check.
**Not controlled by AI Bridge:** Claude/Codex run with the user's own global CLI
configuration (e.g. `~/.claude` settings, MCP servers, hooks, skills). AI Bridge passes no
flag that isolates or restricts these.

## 11. Tests (actual)

49 files, 535 tests: Core unit tests (orchestrator 25, report validator 28, parser 25,
state transitions 14, BridgeEngine 36, crash injection 9, execution transparency 15,
journal 14, …); fake Claude/Codex CLIs under `tests/fixtures/`; desktop tests (IPC 11,
controls 10, run controller 6, security 8, renderer ~42); providers 59. Real-CLI
verification scripts exist but are never run by `pnpm test` (`scripts/desktop/real-e2e.ts`,
`scripts/real/bridge-engine-driver.ts`); they spend real quota.

## 12. Facts that differ from documentation, and dormant code

| Item | Fact in code |
|---|---|
| docs/04 says reports are at `sessions/<id>/<NNN>-report.md` | Reports are at the shared `.ai-bridge/reports/NNN-report.md`. |
| `config.reportMaxBytes` (default 1 MB) | Never passed to `ReportValidator`, whose own default is 256 KB, so the effective cap is 256 KB. |
| `RECOVERING` state | In the transition table, never pushed. |
| `ITERATION_COMPLETED`, `TIMEOUT` events | Declared, never emitted. |
| `allowedTools` / `disallowedTools` adapter options | Supported by the Claude adapter, never passed by Orchestrator. |
| `permissionMode` | Orchestrator option; BridgeEngine never sets it, so it is always `acceptEdits`. |
| `SessionManager.writeSessionFile` / `writeState` | Unused. |
| Two discovery/auth implementations | `BridgeEngine.realRunDoctor` (doctor/preflight) and `core/providers/*` (M4.3) both locate executables and parse auth, independently. |
| `main.ts` | Calls `app.enableSandbox()` and `requestSingleInstanceLock()` twice (harmless). |

## 13. Responsibilities summary

- **Execution state** (per run): owned by BridgeEngine/Orchestrator, persisted in
  `current-session.json` plus per-session artifacts.
- **Run lifecycle hosting**: CLI process, or the Electron run host child.
- **UI state**: Main (`RunController`, `BridgeSnapshot`); the renderer only renders.
- **Provider diagnostics**: `ProviderRegistry` (not wired to anything yet).
- **Multi-run orchestration: does not exist.** There is no concept of a workflow, a step,
  a verification or a retry anywhere in the code.

## 14. Boundaries worth preserving (observed invariants)

1. Every Core outcome is typed and serializable; Core never throws across the API in
   normal operation.
2. Every durable phase is persisted before the next side effect.
3. Output is never repaired or guessed at: an invalid report or response ends the run.
4. The lock holder is exactly one process, and stop kills its whole tree.
5. The renderer holds no decision logic; controls are derived in Main from Core answers.
6. Evidence levels are explicit (CONFIRMED / REQUESTED / UNKNOWN); nothing is invented.

## 15. Data Flow

Covered in §6 (control and data), §7 (persistence) and §9 (events). In short: task text
→ prompt file → Claude stdin → report file → reviewer input file → Codex stdin → review
file → extracted prompt → next Claude stdin. Everything is hash-checked at the two
hand-offs.

## 16. Failure Cases (as handled today)

| Failure | Handling |
|---|---|
| CLI non-zero exit / timeout / bad JSON / id mismatch | ERROR with errorCode `CLAUDE_RUN_FAILED:<x>` / `CODEX_RUN_FAILED:<x>`; diagnostics carried in the outcome. |
| Invalid report / response | ERROR `REPORT_INVALID` / `RESPONSE_INVALID`; no retry. |
| Crash mid-run | INTERRUPTED; resume only from the two checkpoints. |
| Concurrent start | ALREADY_RUNNING (lock). |
| API key present | BLOCKED (doctor) and ERROR `BLOCKED_API_AUTH` (orchestrator). |
| Journal generation failure | Swallowed; the run is unaffected. |

## 17. Decisions

None; this document is descriptive. Decisions are in docs/38.

## 18. Open Questions

- Should the documentation drift in §12 be corrected in docs/04 before M5? (Recommended;
  docs-only.)
- Should `reportMaxBytes` be wired? (It is a behavior change in Core, so it is out of
  scope here; see docs/40.)

## 19. Explicitly Out of Scope

Any change to the code. Future designs (docs 21–37).

## 20. Risks

- Future documents may assume that capabilities in §12 (RECOVERING, TIMEOUT events,
  tool allowlists, provider-driven execution) work. They do not.
- The shared `reports/` directory means an older session's report survives only through
  its Codex-input copy.

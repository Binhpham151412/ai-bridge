# AI Bridge — Current Architecture (post-M4 sprint)

Snapshot as of the M4 Electron + React sprint (2026-09-26), updated from the M3.5
snapshot. Reflects what is actually built and tested — see
[docs/11-m4-electron-react-report.md](11-m4-electron-react-report.md) for the M4 delivery
record (desktop app: Electron Main, run host, preload, IPC, React renderer),
[docs/11-m3.5-electron-preparation-report.md](11-m3.5-electron-preparation-report.md) for
M3.5's, [docs/09-m3-core-hardening-report.md](09-m3-core-hardening-report.md) for M3's, and
[docs/03-m2-development-report.md](03-m2-development-report.md) for M2's. The desktop
layer's own diagram is in the M4 report's Architecture section.

## Architecture diagram

```text
                 ┌────────────────────────┐
                 │   CLI  (cli.ts)        │
                 │   Electron desktop     │  (M4 — src/desktop/: Main + run host call
                 └───────────┬────────────┘   BridgeEngine; React renderer only via typed IPC)
                              │  calls BridgeEngine.start()/pause()/resume()/stop()/status(),
                              │  subscribes to events — never touches Orchestrator or the
                              │  filesystem layout directly (M3.5)
                              ▼
                 ┌────────────────────────┐
                 │   BridgeEngine          │
                 │   core/bridge-engine.ts │  (M3.5 — see §Module map)
                 └───────────┬────────────┘
                              │
                              ▼
        ┌───────────────────────────────────────────────────┐
        │                  Bridge Core                       │
        │  ┌────────────────┐  ┌────────────────────────┐   │
        │  │ State Machine   │  │ Recovery                │   │
        │  │ transitions.ts  │  │ recovery.ts             │   │
        │  └────────────────┘  └────────────────────────┘   │
        │  ┌────────────────┐  ┌────────────────────────┐   │
        │  │ Integrity       │  │ Orchestrator             │  │
        │  │ integrity.ts    │  │ orchestrator.ts          │  │
        │  └────────────────┘  └────────────────────────┘   │
        └──────────┬───────────────────────────┬────────────┘
                    │                           │
                    ▼                           ▼
        ┌────────────────────┐     ┌────────────────────┐
        │  Claude Adapter     │     │  Codex Adapter       │
        │  claude-code-cli-   │     │  codex-cli-adapter.ts│
        │  adapter.ts         │     │                      │
        └──────────┬──────────┘     └──────────┬───────────┘
                    │                            │
                    ▼                            ▼
        ┌────────────────────┐     ┌────────────────────┐
        │  Claude Code CLI    │     │  Codex CLI           │
        │  (claude -p ...)    │     │  (codex exec ...)    │
        └──────────┬──────────┘     └──────────┬───────────┘
                    │                            │
                    └─────────────┬──────────────┘
                                   ▼
                     ┌───────────────────────────┐
                     │   Project / Files          │
                     │  .ai-bridge/{reports,      │
                     │  sessions,logs,state}/     │
                     │  + the actual project code │
                     └───────────────────────────┘
```

This matches the M3 spec's requested shape, with one adjustment: "State Machine, Recovery,
Integrity, Orchestrator" are drawn as four peer modules *inside* Bridge Core (matching how
they're actually separated under `src/core/`) rather than as a single unlabeled box, since
that separation is real in the code, not just conceptual.

## Module map

```text
src/
├── cli.ts                        Thin adapter, since M3.5: parses argv, constructs one
│                                  BridgeEngine per invocation, maps its result to
│                                  console output and an exit code. Owns no business
│                                  logic — no session/lock/adapter wiring, no recovery
│                                  decision, no orchestration.
├── cli-args.ts                   Pure argv parser (doctor/start/stop/pause/status/resume/logs/reset).
│
├── core/
│   ├── bridge-engine.ts          THE Core entry point (M3.5). `BridgeEngine` owns doctor
│   │                             gating, the run lock, session directory creation, state
│   │                             persistence, and Orchestrator wiring — everything
│   │                             `cli.ts`'s `runLoop` used to own directly. Public API:
│   │                             `doctor()/start()/pause()/resume()/stop()/status()/
│   │                             logs()/reset()/subscribe()`. No CLI dependency, no
│   │                             `console.*`, no `process.exit` — see
│   │                             `tests/architecture.test.ts`.
│   ├── orchestrator/             The control loop. Owns: report/response validation
│   │   orchestrator.ts           calls, integrity checks, prompt/report file writes,
│   │                             session/thread id tracking, cooperative stop/pause,
│   │                             resume-from-checkpoint, crash injection (test-only),
│   │                             per-iteration integrity-chain artifact (M3.5),
│   │                             PID/log/transition callbacks (all awaited — see
│   │                             docs/06-recovery-design.md).
│   ├── state-machine/            Pure transition-validity predicate + assertion, derived
│   │   transitions.ts            from the orchestrator's real `push()` call sites. (M3)
│   ├── recovery/recovery.ts      Pure function: last-known state → resumable? how? (M3)
│   │                             Called by `BridgeEngine.resume()` (M3.5) — the one
│   │                             place this decision is made, for CLI and Core alike.
│   ├── state-manager/            Serialized, atomic (temp+rename) JSON state persistence
│   │   atomic-json-writer.ts     — prevents concurrent-write corruption. (M3)
│   ├── cost-guard.ts              API-key env detection; claude/codex auth-mode parsing.
│   ├── lock/run-lock.ts           Per-project run lock with stale-PID detection.
│   ├── process-manager/           Graceful→force-kill escalation for `stop`.
│   ├── session-manager/           Session id allocation (date_NNN), session.json writes.
│   ├── logger/logger.ts           Per-adapter-call JSONL log (M1-era, kept).
│   ├── observability/events.ts    Structured events.jsonl + human-readable ai-bridge.log.
│   ├── integrity/integrity.ts     sha256-based prompt/report transport integrity checks.
│   ├── config/config.ts           .ai-bridge/config.json schema + validation + defaults.
│   └── preflight/
│       ├── doctor.ts              Aggregates named checks into PASS/FAIL/WARNING/BLOCKED.
│       ├── executable-resolver.ts `where`-based claude/codex discovery, no hardcoded paths.
│       ├── permission-mode.ts     Allowlists safe --permission-mode values (never bypass).
│       └── git-safety.ts          Read-only `git status --porcelain` check.
│
├── adapters/
│   ├── claude/claude-code-cli-adapter.ts   Drives `claude -p --output-format stream-json`.
│   └── chatgpt/codex-cli-adapter.ts        Drives `codex exec` / `codex exec resume`.
│
├── reports/
│   ├── report-validator.ts        Claude report contract validator.
│   └── codex-response-parser.ts   <AI_BRIDGE_RESPONSE> contract parser.
│
├── prompts/templates.ts           Report-contract and reviewer-input text builders.
└── automation/process-runner.ts   spawn wrapper: UTF-8 stdin, timeout, Windows tree-kill.
```

## Design principles (as actually followed)

1. **`core/` has no CLI dependency.** Nothing under `src/core/`, `src/adapters/`,
   `src/reports/`, or `src/prompts/` imports `cli.ts`/`cli-args.ts`, or calls
   `console.log`/`console.error`/`process.exit`. Every one of those modules is
   constructed with explicit options and returns data. Verified directly: `grep -rln
   "from '\.\./\.\./cli\|console\.log\|console\.error\|process\.exit(" src/core
   src/adapters src/reports src/prompts` returns nothing.
2. **External dependencies are injected, not hardcoded.** `executable-resolver.ts`,
   `git-safety.ts`, and `doctor.ts` all take `where`/`runGit`/check-function callbacks
   as parameters — the *real* implementations (calling `where.exe`, spawning `git`) live
   in `core/bridge-engine.ts` since M3.5 (previously `cli.ts`, before `BridgeEngine`
   existed). This is what lets every non-trivial piece of logic be unit-tested without
   spawning real processes, while `BridgeEngine` wires the real ones for production —
   and lets `BridgeEngine` itself accept an optional `BridgeEngineDeps` override so *it*
   can be unit-tested with fake CLIs too (`tests/bridge-engine.test.ts`).
3. **Fail-closed, everywhere.** Cost guard, permission-mode guard, integrity checks, and
   report/response validators all return `{ok:false, ...}` or throw on the first
   ambiguity — nothing is repaired, retried automatically, or "close enough."
4. **Filesystem is the audit trail.** No database. `.ai-bridge/{reports,sessions,logs,state}/`
   holds every artifact a session produces; `session.json`/`current-session.json` are the
   only "index."

## How the Electron/React desktop app plugs in (M4 — built)

`src/desktop/` imports exactly one Core entry point: `BridgeEngine`. Electron Main uses it
in-process for status/recovery-check/pause/stop/doctor/history/config; `start()`/`resume()`
run inside a forked **run host** process (`src/desktop/main/run-host.ts`) so the lock
holder Core's `stop()` kills is that host — never the app. The React renderer is sandboxed
and reaches Main only through the fixed `window.aiBridge` preload API (typed IPC allowlist,
validated in Main). Details: [docs/11-m4-electron-react-report.md](11-m4-electron-react-report.md);
the Core contract (including the M4 additions) is in
[docs/10-electron-integration-contract.md](10-electron-integration-contract.md).
`tests/desktop/security.test.ts` enforces that the dependency only points desktop → Core
and that no orchestration/recovery/process-kill logic exists under `src/desktop/`.

## Known architecture debt

- ~~The resume-case decision tree lives in `cli.ts`, not in `core/`~~ — **fixed in M3.**
- ~~No formal `BridgeEngine` class exists in `core/`~~ — **fixed in M3.5.**
  `core/bridge-engine.ts`'s `BridgeEngine` now owns session bootstrapping (lock, config,
  session directory, adapter construction, the atomic state writer) as well as the
  start/pause/resume/stop/status/logs/reset/subscribe API — `cli.ts` is a genuinely thin
  adapter over it (verified: `tests/architecture.test.ts`).
- **Artifacts aren't in the spec-literal `reports/`/`responses/`/`prompts/` subfolders.**
  The existing `.ai-bridge/sessions/<sessionId>/<NNN>-{report,extracted-prompt}.md` layout
  (M1/M2-era) was kept rather than restructured, per the project's "extend, don't rewrite"
  directive across M3 and M3.5 — each artifact is still individually SHA-256-hashed via the
  per-iteration integrity-chain artifact (M3.5 — see
  [docs/09-m3-core-hardening-report.md](09-m3-core-hardening-report.md)'s Integrity
  section and [docs/11-m3.5-electron-preparation-report.md](11-m3.5-electron-preparation-report.md)'s),
  just not split into separate top-level directories by artifact type.
- **`SessionManager`'s `sessionId` counter and `run-lock`'s lock file are per-project, not
  per-machine.** Running AI Bridge from two different checkouts of the same project path
  (e.g. two drive letters mapped to the same folder) is not guarded against. Out of scope
  for M2, M3, and M3.5 alike.

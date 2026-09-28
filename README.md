# AI Bridge

A local Windows tool that automates the loop between **Claude Code CLI** (executor) and
**Codex CLI** (reviewer, using your ChatGPT sign-in) — so a task runs to completion
without you copy-pasting between the two.

```text
Claude Code CLI  →  report  →  AI Bridge  →  Codex CLI  →  next PROMPT  →  Claude Code CLI  →  ...
```

Status: **M4.2 Development Journal & Custom Review Rounds** — see
[docs/14-m4.2-development-journal-report.md](docs/14-m4.2-development-journal-report.md)
for the full milestone report (462/462 tests, real integration test) and
[docs/13-m4.2-development-journal.md](docs/13-m4.2-development-journal.md) for the
architecture (per-run Markdown journal, validated custom review-round cap, the Markdown
viewer). Builds on
[docs/12-m4.1-session-execution-transparency-report.md](docs/12-m4.1-session-execution-transparency-report.md)
(per-call Claude/Codex session & execution transparency) and
[docs/11-m4-electron-react-report.md](docs/11-m4-electron-react-report.md) (a sandboxed
Electron/React UI on top of the same `BridgeEngine` the CLI uses, real end-to-end runs
through the app, a portable Windows build);
[docs/11-m3.5-electron-preparation-report.md](docs/11-m3.5-electron-preparation-report.md)
for the M3.5 `BridgeEngine` Core entry point it builds on,
[docs/10-electron-integration-contract.md](docs/10-electron-integration-contract.md) for
that API's full contract, [docs/09-m3-core-hardening-report.md](docs/09-m3-core-hardening-report.md)
for the M3 baseline it builds on, and
[docs/01-architecture-feasibility-report.md](docs/01-architecture-feasibility-report.md)
for why this design (CLI-first, no UI automation) was chosen.

## Cost model

**$0 extra cost, always.** AI Bridge only drives the `claude` and `codex` CLIs using your
existing Claude subscription and ChatGPT sign-in — never an API key. Before every run it
checks the environment for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
`CODEX_API_KEY` and refuses to start (`BLOCKED`) if any is set. It never buys credits,
never changes billing, never calls a paid API directly. See
[docs/07-security-model.md](docs/07-security-model.md).

## Prerequisites

- Windows, Node.js ≥ 22.18
- [Claude Code CLI](https://code.claude.com) installed and on `PATH`, signed in to a
  **Claude subscription** (not API key): `claude auth login --claudeai`
- [Codex CLI](https://developers.openai.com/codex) — either on `PATH`, or installed as
  part of the ChatGPT Windows app (AI Bridge finds it under
  `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` automatically), signed in with
  **ChatGPT** (not an API key): `codex login`
- `git` on `PATH` (optional but recommended — enables the uncommitted-changes warning)

## Installation

```bash
pnpm install
pnpm typecheck
pnpm test
```

There is no build step — `src/cli.ts` runs directly via Node's built-in TypeScript
stripping (Node ≥ 22.18).

## Authentication

AI Bridge never touches your credentials directly. `ai-bridge doctor` runs
`claude auth status` and `codex login status` and reports whether you're signed in with a
subscription (good) or an API key (blocked — see Cost model). If you need to sign in:

```bash
claude auth login --claudeai
codex login
```

## Doctor

Run this first, always:

```bash
node src/cli.ts doctor --project <path>
```

Checks: Node version, cost-risk env vars, `claude`/`codex` presence and auth mode, `git`
presence, the project directory, `.ai-bridge/config.json` validity, and git working-tree
cleanliness. Each line is `PASS`/`WARNING`/`FAIL`/`BLOCKED`/`UNKNOWN`; overall is the worst
of those (`BLOCKED` beats `FAIL` beats `WARNING`/`UNKNOWN` beats `PASS`).

## Start

```bash
node src/cli.ts start --project <path> --task "<the first thing Claude should do>" [--max-iterations N]
```

Runs preflight (same as `doctor`), refuses to start on anything but `PASS`, acquires a
per-project lock (`.ai-bridge/state/lock`) so two sessions can never run on the same
project at once, then drives the loop: Claude executes → writes a report → AI Bridge
validates it → sends it verbatim to Codex → Codex's `<PROMPT>` goes back to Claude
byte-for-byte unchanged → repeat until `DONE`, `NEED_HUMAN`, or `--max-iterations` is hit.
Ctrl+C stops it cooperatively at the next safe boundary.

## Stop

```bash
node src/cli.ts stop --project <path>
```

From a **different** terminal than the one running `start`. Reads the session's PID from
the lock file, attempts a graceful signal, then force-kills the whole process tree
(Claude/Codex included) if it's still alive after ~10s. See the Windows limitation note in
[docs/06-recovery-design.md](docs/06-recovery-design.md) — headless console processes
generally ignore the graceful attempt, so in practice `stop` almost always ends in
`FORCE_KILLED`, which is still a clean, verified kill.

## Status

```bash
node src/cli.ts status --project <path>
```

Shows `RUNNING` / `DONE` / `NEED_HUMAN` / `ERROR` / `STOPPED` / `STOPPED_MAX_ITERATIONS` /
`INTERRUPTED` (crash detected: the lock/process is gone but the session never reached a
terminal state), plus session id, iteration, current phase, live Claude/Codex PIDs,
elapsed time, and the last report path.

## Pause

```bash
node src/cli.ts pause --project <path>
```

From a **different** terminal than the one running `start`/`resume`. Requests a
**cooperative** pause — it never kills or interrupts an in-flight Claude/Codex call; the
running session finishes whatever it's currently doing and pauses at the next safe
boundary, then `ai-bridge status` shows `PAUSED`. Real, SHA-256-verified pause→resume
tested in this sprint — see [docs/06-recovery-design.md](docs/06-recovery-design.md).

## Resume

```bash
node src/cli.ts resume --project <path>
```

Continues a `PAUSED` or `INTERRUPTED` session from the same two safe checkpoints described
in [docs/06-recovery-design.md](docs/06-recovery-design.md): "Claude finished, report
validated, Codex hadn't responded yet" (re-sends the existing report, does not re-run
Claude) and "Codex already produced the next PROMPT, Claude hadn't started on it yet"
(continues with that exact PROMPT, resuming the same Claude session — now **proven with a
real forced crash**, not just a fake-CLI test, as of this sprint). Any other interruption
point returns `RECOVERY_BLOCKED` and asks for human intervention — it never guesses.

## Configuration

Optional `<project>/.ai-bridge/config.json`:

```json
{
  "maxIterations": 10,
  "claudeTimeoutMs": 1800000,
  "codexTimeoutMs": 600000,
  "reportMaxBytes": 1048576,
  "stopOnUncommittedChanges": false,
  "requireGitRepository": false
}
```

Every field is optional (defaults shown above apply); an unknown field or an out-of-range
value fails `doctor`/`start` fast with a specific error rather than being silently ignored
or coerced.

## Logs

```bash
node src/cli.ts logs --project <path> [--lines N]
```

Prints the tail of the human-readable log (`.ai-bridge/logs/ai-bridge.log`). A structured
JSONL event stream also lives at `.ai-bridge/logs/events.jsonl`, and a per-call log
(`.ai-bridge/logs/<date>-session.log`) records every Claude/Codex invocation's exit code
and duration.

## Reset

```bash
node src/cli.ts reset --project <path>
```

Clears only `.ai-bridge/state/lock` and `.ai-bridge/state/current-session.json`. It never
touches your project code and never touches `.ai-bridge/reports/` or
`.ai-bridge/sessions/` (the audit trail) — refuses outright if a session is still running.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `doctor` shows `[BLOCKED] api-key-env` | An `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/etc. is set in your shell | Unset it — AI Bridge refuses to run in API-key mode by design |
| `doctor` shows `[BLOCKED] claude-auth` or `codex-auth` | Signed in via Console/API key instead of subscription | `claude auth login --claudeai` / `codex login`, choosing the ChatGPT sign-in |
| `ERROR_ALREADY_RUNNING` on `start` | A previous session's lock is still held by a live process | `ai-bridge status` to see it, then `ai-bridge stop` |
| `status` shows `INTERRUPTED` | The process crashed or was killed from outside AI Bridge without reaching a terminal state (an `ai-bridge stop` / desktop STOP is recorded as `STOPPED` since M4) | `ai-bridge resume` — see its two supported cases above |
| `status` shows `PAUSED` | A previous `ai-bridge pause` was honored | `ai-bridge resume` — continues from the exact next step |
| `resume` prints `RECOVERY_BLOCKED` | The crash happened at a point that isn't safely resumable (e.g. mid-Claude-execution), or a pause happened before any iteration completed | Inspect `.ai-bridge/sessions/<id>/`, then `ai-bridge start` with a fresh task if needed |
| `[WARNING] git-repository` on `doctor` | Uncommitted changes, or the project isn't a git repo | Informational only by default; set `stopOnUncommittedChanges`/`requireGitRepository` in config to make it block |

## Architecture

See [docs/04-architecture-current.md](docs/04-architecture-current.md) for the module map
and architecture diagram, [docs/10-electron-integration-contract.md](docs/10-electron-integration-contract.md)
for the Core API contract, [docs/08-core-state-machine.md](docs/08-core-state-machine.md)
for the formal state machine, and [docs/07-security-model.md](docs/07-security-model.md)
for the security model. In short: `src/core/bridge-engine.ts`'s `BridgeEngine` is the one
Core entry point — `start()/pause()/resume()/stop()/status()/logs()/reset()/subscribe()` —
with no CLI-specific code anywhere under `src/core/`; `src/cli.ts` is a genuinely thin
adapter over it (parses argv, calls `BridgeEngine`, prints the result). The desktop app
(`src/desktop/`, M4) calls the exact same API — never the CLI — with the run loop hosted in
a forked child process and the React renderer reaching Main only through a typed, validated
IPC allowlist; see [docs/11-m4-electron-react-report.md](docs/11-m4-electron-react-report.md).

## Desktop app (M4)

```bash
pnpm install          # if Electron's binary was not downloaded: node node_modules/electron/install.js
pnpm desktop          # dev build + launch
pnpm package:win      # portable build → release/AI Bridge-win32-x64/AI Bridge.exe (+ .zip)
```

The app has five screens: **Run** (what is happening now), **Journal** (round-by-round
history), **Artifacts** (every file a session produced), **Settings** (project + run
configuration) and **System** (Core's `doctor`, runtime, logs). Pick a project folder
(native picker), check **System**, then **START** on **Run** with a task and the maximum
review rounds. Run shows Core's status, the round, one plain sentence derived from Core's
phase, what Claude and ChatGPT/Codex are each doing, and a milestone activity feed; the raw
detail (Core state, ids, PIDs, execution records, stdout/stderr, the full event log) is in
the collapsed **Technical details** / **Technical output** sections. **PAUSE** is
cooperative, **STOP** goes through Core's process management, and after a crash or restart
the app shows **RESUME/DISCARD** only when Core says the session is recoverable. Same $0
model as the CLI: no API keys, no network calls of its own, no telemetry. See
[docs/15-ui-ux-refactor-report.md](docs/15-ui-ux-refactor-report.md).

Since M4.1 every Claude/Codex call is traceable in the app: the AI Bridge session, the
Claude CLI session and the Codex thread are shown separately; each call's exact prompt
(SHA-256, bytes), PID, start/end, exit code, stdin delivery and CLI output/stderr are in
its execution record (Run → Technical details for the current round, Artifacts →
Technical for every round), and Artifacts → Technical → Execution trace shows a
per-iteration trace. See
[docs/12-m4.1-session-execution-transparency-report.md](docs/12-m4.1-session-execution-transparency-report.md).

Since M4.2, **START** also lets you pick the maximum number of review rounds (a preset
select — 1/2/3/5/10/20/30/50/Custom…, capped at 100 — the run still stops earlier the
moment the reviewer returns DONE), and **Journal** shows each session's Development
Journal: per round the Claude prompt, Claude report, ChatGPT review (human-readable), next
prompt and raw response (lazy-loaded one at a time), a session index, and a whole-session
final report once the run ends.
See [docs/13-m4.2-development-journal.md](docs/13-m4.2-development-journal.md).

## Known limitations

See the "Known limitations" section of
[docs/11-m4-electron-react-report.md](docs/11-m4-electron-react-report.md) (desktop app) and
the "Known Limitations"/"Electron Readiness" sections of
[docs/11-m3.5-electron-preparation-report.md](docs/11-m3.5-electron-preparation-report.md) for the
complete, honest, current list (nothing here is claimed to work that hasn't actually been
tested); [docs/03-m2-development-report.md](docs/03-m2-development-report.md) has the M2
baseline list.

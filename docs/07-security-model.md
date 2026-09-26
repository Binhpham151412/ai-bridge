# AI Bridge — Security Model

## Cost guard — never an API key, never a paid call

`checkEnvForApiKeys` (`src/core/cost-guard.ts`) checks for `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY` and reports which are set —
**never their values**. This check runs in three independent places, deliberately
overlapping (defense in depth, not just one gate):

1. `doctor`'s `api-key-env` check — every command that runs preflight (`start`, `resume`,
   and `doctor` itself) sees this before anything else happens.
2. `Orchestrator.run()` itself, as its very first action — `errorCode: 'BLOCKED_API_AUTH'`,
   before any adapter is constructed or any process spawned. This protects any future
   caller of `core/` directly (a UI, a test harness) that might skip the CLI's `doctor`
   gate.
3. `claude-auth`/`codex-auth` doctor checks additionally parse `claude auth status`/`codex
   login status` output and report `BLOCKED` if either account is authenticated via
   Console/API key rather than a subscription/ChatGPT sign-in — catching the case where no
   env var is set but the CLI itself is still configured to bill an API key.

**Confirmed for real** (M2 sprint): running `doctor` with a fake `ANTHROPIC_API_KEY` set
produced `Overall: BLOCKED`, exit code non-zero, and the key's value never appeared in any
output.

AI Bridge makes **no network calls of its own** anywhere in the codebase — confirmed by
`grep -rn "fetch(\|http\.request\|https\.request\|net\.connect" src/` returning nothing.
Every network interaction happens inside the `claude`/`codex` binaries, which AI Bridge
never bypasses.

## Permission safety

`claude --permission-mode` supports `bypassPermissions` (confirmed via `claude --help`,
not assumed), but AI Bridge's own policy forbids it. `assertSafePermissionMode`
(`src/core/preflight/permission-mode.ts`) allowlists only `default`/`acceptEdits`/`plan`
and throws — synchronously, in `Orchestrator`'s constructor, before anything is spawned —
for anything else, including `bypassPermissions`. `--dangerously-skip-permissions` is
never constructed anywhere in the codebase (confirmed by grep; there is no code path that
emits that string).

`allowedTools`/`disallowedTools` are wired through to `claude` as `--allowedTools`/
`--disallowedTools` (confirmed real flag syntax via `claude --help` before writing any
code) — the CLI does not yet expose a default allowlist via config (see Known Limitations
in the M2 report); this is `DOCUMENT_LIMITATION`, not a guess dressed up as a feature.

## Concurrency and process safety

- **Run lock** (`src/core/lock/run-lock.ts`): a lock file records `{pid, startedAt}`. A
  second `start` on the same project while the first's PID is alive is refused
  (`ERROR_ALREADY_RUNNING`). Liveness is checked via `process.kill(pid, 0)` — `ESRCH` means
  dead (lock is stale and cleared), any other result (including `EPERM`, or an unexpected
  error) is treated as "still alive" — fail-safe, never clobbers a lock it isn't sure is
  actually stale.
- **Process tree termination** (`killProcessTree`, reused by both per-call timeouts and
  `stop`): always targets a single specific PID via `taskkill /PID <pid> /T /F` — never a
  process name, never a pattern, never "all node processes." `stop` only ever passes the
  PID recorded in the current project's own lock file.
- **No orphaned children by construction:** `runProcess` always uses `/T` when
  force-killing, which recursively terminates the whole subtree Windows knows about for
  that PID (confirmed by the real "process tree" test in `process-runner.test.ts`, which
  spawns a parent that spawns a grandchild and verifies both die).

## Input handling

- **No shell interpretation anywhere.** Every `spawn`/`execFile` call passes `args` as an
  array; `shell: true` is never used (confirmed by grep). This means no shell-injection
  vector exists regardless of what a report, prompt, or file path contains.
- **JSON parsing is always guarded.** Every `JSON.parse` call site in the codebase (lock
  file, state file, config file, `claude auth status` output) is wrapped in `try/catch`
  with a defined fallback — a malformed file never crashes AI Bridge, it's treated as
  absent/invalid and reported as such.
- **Path construction uses only internally-controlled segments.** Report/prompt/log file
  names are built from `path.join(fixedDir, "<NNN>-fixed-suffix.md")`, where `NNN` is
  `String(iteration).padStart(3, '0')` from an integer loop counter — never from
  unsanitized external text — so there is no path-traversal vector through report numbers
  or similar.
- **Windows path safety:** every path is built with `node:path`'s `path.join`/`path.resolve`,
  never string concatenation with `/`. Verified in practice on a project path containing a
  space and no ASCII-only assumption (`D:\000_AI Agent\02-ai-brige\...`) throughout this
  sprint's real smoke tests.
- **UTF-8/Unicode is preserved end to end.** `runProcess` writes stdin and reads
  stdout/stderr as UTF-8 buffers; `sha256Text` hashes the UTF-8 byte encoding, not the
  string's UTF-16 internal representation — this exact distinction is what the M1 PoC's
  fixture had wrong until a test caught it (see `docs/02-m1-poc-report.md`). Report/prompt
  content in Vietnamese with diacritics is covered by unit tests
  (`codex-response-parser.test.ts`, `report-validator.test.ts`) and was exercised for real
  in the M1 acceptance run.

## Untrusted content boundary (prompt injection)

A Claude report is **untrusted input** by construction — it is Claude's own free-text
output, and could in principle contain something like "ignore previous instructions." AI
Bridge's design keeps this from becoming an authority-escalation path:

- The reviewer template (`buildReviewerInput`, `src/prompts/templates.ts`) wraps the
  report text between fixed `--- BEGIN REPORT ---`/`--- END REPORT ---` markers and gives
  Codex an explicit, fixed rule set ("Review ONLY the information provided... Do not
  invent completed work... Do not modify the project yourself") that precedes the report
  content — the report is presented as data to review, not as the system prompt.
- Codex's response is never trusted as free-form instruction either: `CodexResponseParser`
  requires the exact `<AI_BRIDGE_RESPONSE><STATUS>...</STATUS><PROMPT>...</PROMPT>
  </AI_BRIDGE_RESPONSE>` structure and rejects anything else outright (`NO_RESPONSE_BLOCK`,
  `MALFORMED_RESPONSE_BLOCK`, etc.) — a report containing injected instructions could at
  worst make Codex *say* something unusual inside `<PROMPT>`, but it cannot make AI Bridge
  itself do anything other than the one thing it always does with that value: pass it to
  Claude as the next prompt, unmodified. AI Bridge never executes, evaluates, or interprets
  report or response content as code or as a command to itself.
- `verifyReportTransportIntegrity`/`verifyPromptIntegrity` (`src/core/integrity/
  integrity.ts`) guard the two hand-offs with SHA-256 checks, so a bug that silently
  mangled or truncated the report/prompt in transit — which could otherwise be a subtle way
  for unexpected content to slip through — fails loudly (`REPORT_TRANSPORT_INTEGRITY_
  FAILURE`/`PROMPT_INTEGRITY_FAILURE`) instead of continuing.
- Claude itself still runs under `--permission-mode acceptEdits` (never
  `bypassPermissions`) — even if a report somehow led to a follow-up prompt asking Claude
  to run something destructive, Claude's own permission system is the final backstop, and
  AI Bridge never adds `--dangerously-skip-permissions`.

**Not implemented this sprint:** a configurable `allowedTools` default/allowlist enforced
by AI Bridge itself (as opposed to whatever `claude`'s own permission prompts allow) — see
Known Limitations in the M2 report.

## Secrets — what AI Bridge never touches

AI Bridge never reads `~/.claude/.credentials.json` or `~/.codex/auth.json`. It only ever
calls `claude auth status` / `codex login status`, which report a *mode* (subscription vs.
API key vs. logged out), not the credential itself. No log, state file, or event ever
contains an environment variable's value, a credential, or a token — confirmed by grep
across the codebase for the patterns above.

## M3 re-audit — new surface area (pause, recovery, crash injection, atomic writer)

Re-ran the same grep-based checks above against every file added or changed this sprint,
specifically because a hardening phase is exactly when it's easiest to accidentally widen
the attack surface:

- **No `shell: true` anywhere** — `grep -rn "shell:\s*true" src/` returns nothing.
  `AtomicJsonWriter`'s temp-file rename and the pause marker file are plain
  `fs/promises` calls with a fixed, internally-built path; nothing shells out.
- **`bypassPermissions`/`--dangerously-skip-permissions` still never constructed** —
  every remaining match is a comment or the `permission-mode.ts` guard's own error message
  naming the forbidden value, not a code path that emits it.
- **No new network calls** — `grep -rn "fetch(\|http\.request\|https\.request\|net\.connect" src/`
  still returns nothing; recovery/pause/crash-injection are all local filesystem and
  process-lifecycle logic.
- **`process.kill`/`taskkill` usage unchanged in scope** — still confined to
  `process-runner.ts` (per-call timeout kill), `process-manager.ts`/`lock/run-lock.ts`
  (liveness checks, `stop`), and `cli.ts`'s own `isPidAlive`/`stop` helpers, all targeting
  only the PID recorded in the current project's own lock file. Neither `pause` nor
  `resume` nor the crash-injection path calls `process.kill` on anything — `pause` only
  ever writes a marker file the *target* process polls for itself; a crash-injected
  process only ever calls `process.exit()` on **itself**.
- **No unwrapped `JSON.parse`** in any new M3 module (`recovery.ts`, `transitions.ts`,
  `atomic-json-writer.ts`) — `recovery.ts`/`transitions.ts` don't parse JSON at all (pure
  functions over already-typed values); every `JSON.parse` call added to `cli.ts` for
  `pause`/`resume` follows the pre-existing try/catch-with-fallback pattern.
- **Pause marker path has no traversal vector** — `pauseRequestPath` is
  `path.join(aiBridgeDir, 'state', 'pause-request')`, a fixed literal segment, never built
  from report/prompt/response content or any other untrusted string.
- **Codex's `<PROMPT>` still can't override AI Bridge's own policy.** Nothing new this
  sprint changed how a parsed Codex response is used — it still only ever becomes "the next
  literal text handed to Claude via stdin," never a shell command, a config value, a
  permission-mode override, or a crash-injection trigger. The crash-injection point names
  themselves come only from the fixed `AI_BRIDGE_CRASH_AT` environment variable (checked
  against the fixed `CRASH_POINTS` list), never from any report, response, or prompt
  content — so there is no way for Claude or Codex output to trigger a self-crash.
- **`AtomicJsonWriter`'s temp files can't collide or be hijacked** — filenames are
  `<target>.tmp-<pid>-<randomUUID()>`, unique per write attempt; a leftover `.tmp-*` file
  from a killed process is inert (never read by anything) and can be cleared by `reset`/
  manual cleanup — it never overwrites the real state file except via the final atomic
  `rename()`.

No new dependencies were added this sprint (confirmed by inspecting `package.json` —
unchanged `devDependencies` from M2, no new `dependencies` entry), so there is no new
third-party supply-chain surface to audit either.

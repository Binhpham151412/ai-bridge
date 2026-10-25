# 65 — Antigravity (`agy`) as an executor, and how to add the next one

Status: implemented; fake-CLI tests plus real runs on the development machine (2026-10-13,
Antigravity CLI 1.3.4, real Codex reviewer). Builds on docs/64.

## 1. What was found (docs/64 §5 said "not supported" — that was wrong)

`agy --help` alone suggested there was no way to learn a conversation id. Probing the real CLI showed:

| Fact | Evidence |
|---|---|
| Non-interactive run: `agy -p "<prompt>"` (the prompt is the **value** of `-p`; `--print` is not a bare switch) | `agy --print --log-file x` took `--log-file` as the prompt |
| **stdin is ignored** — the prompt must be an argument; an empty prompt is `error: … empty prompt` (exit 1) | piped text was not seen by the model; log said `promptLength=` of the argument only |
| stdout = only the final answer text, **and only when stdout is a pipe**; redirected to a *file* it printed nothing | `> out.txt` empty, `\| od -c` showed `OK\n` |
| Conversation id is **only in the log file** (`--log-file <path>`, a documented flag): `Created conversation <uuid>` for a new one | log of every run |
| `--conversation <uuid>` resumes: a real resume logs `Print mode: starting (… conversationID="<uuid>")` and creates nothing; the model recalled the earlier prompt | resume probe |
| **An unknown `--conversation` is ignored with a stderr warning and a NEW conversation is created, exit 0** | probe with an all-zero id |
| `--print-timeout` defaults to 5 minutes | `--help` |
| No model flag; the model in use appears in the log (`Propagating selected model override … label="…"`) | log |
| Failures: `error: …` on stderr, exit 1 | empty-prompt probe |
| No sign-in status command (subcommands: changelog, install, plugin, update) | `--help` |
| Bypass: `--dangerously-skip-permissions`; default is `toolPermission=request-review` | `--help`, log |

## 2. Design (what is different from Claude Code and OpenCode)

| | Claude Code | OpenCode | Antigravity |
|---|---|---|---|
| Prompt | stdin | stdin | **command-line argument** (`PromptChannel = 'argv'`) |
| Report contract | `--append-system-prompt` | prepended | prepended |
| New session id | AI Bridge makes it | CLI event | **CLI's log file** |
| Resume check | exit code + id echo | `sessionID` equals | log: no `Created conversation` **and** `started` id equals the request, else `SESSION_MISMATCH` (agy would silently start a new conversation) |
| Failure | exit ≠ 0 | exit 0 + `error` event | exit ≠ 0, or `error:` as the answer |
| Model | `--model` | `--model` | **none** — the model is read from the log and recorded as *reported* |
| Prompt delivery evidence | `STDIN_FLUSHED_AND_CLOSED` | same | **`ARGV_AT_SPAWN`** (new): the prompt was in the command line of a process that started |

Implementation: `src/adapters/antigravity/antigravity-cli-adapter.ts` (adapter, log parsing),
`src/core/providers/antigravity-provider.ts` (detection), contract additions in
`src/core/executor/executor-adapter.ts` (`PromptChannel`, `supportsModel`, `doctorChecks`,
`inputChannel`, `reportedModel`, `INPUT_TOO_LARGE`).

Decisions:
1. **The log file is AI Bridge's own temp file** (`ai-bridge-agy-<random>.log` in the OS temp dir). It is
   read after the process ends and deleted — it contains the account email and internal chatter, so it is
   never stored in session artifacts. On a failed call only its last error-level lines are appended to the
   stored stderr (redacted like every stderr).
2. **`--print-timeout` is set to the step timeout** (default would stop a development step at 5 minutes).
   AI Bridge's own timer, which kills the process tree, remains the authority.
3. **Prompt length**: Windows allows ≈ 32 767 characters for the whole command line, and `"`/`\` are
   escaped (counted twice). Over 28 000 → `INPUT_TOO_LARGE`, nothing is started. The app's task limit
   (20 000) plus the contract fits. Round-N prompts written by the reviewer are not bounded by the app;
   a very long one fails loudly instead of being truncated.
4. **Sign-in is UNKNOWN, not "not signed in"**: there is no status command and a check must not call a
   model. Detection says so (`ready: null`, badge "Đã cài (chưa rõ đăng nhập)"); the doctor check is a
   WARNING, never a failure. The first run is what tells.
5. **Permissions**: `bypass` → `--dangerously-skip-permissions`; `ask` → no flag. What agy does with a
   permission request headlessly under `ask` was not verified.
6. `agy` may create an empty `.antigravitycli` directory in the project (seen in a folder that was not a
   git repo; not seen in a git repo).
7. The prompt is visible in the process's command line (same as any argument-based CLI).

## 3. Checked on the real machine

- Detection + doctor with `executor: antigravity` → `agy.exe` found, `antigravity-auth` WARNING (by design).
- Real two-round run, Antigravity developer + Codex reviewer, task split over two rounds: round 1 NEW
  conversation, round 2 `--conversation` **RESUME, continuity VERIFIED** (both CLIs); `a.txt` = `one`,
  `b.txt` = `two`; final `DONE`. Record: `provider: antigravity`, `input.delivery: ARGV_AT_SPAWN`,
  permission `--dangerously-skip-permissions`, model *reported* `Gemini 3.8 Flash (High)` (read from the log).
- Multi-line, Vietnamese, quote and backslash text arrives byte for byte (fake CLI echo test).
- `agy` auto-updated 1.0.3 → 1.3.4 during the session; the behaviours above were re-seen on 1.3.4.

## 4. Known limitations

- Token usage is UNKNOWN (agy prints none).
- stdout is empty when the *parent* redirects it to a file; AI Bridge always uses a pipe, so it is not
  affected, but running `agy -p … > file` by hand shows nothing.
- Labels in the activity log / Journal still say "Claude" for the developer slot (docs/64 §6).

## 5. How to add the next executor (the extension recipe)

A CLI qualifies if it can run one prompt non-interactively, can **resume** a session, and gives AI Bridge
a **trustworthy way to learn the session id** (an event, a log, a flag). If the only way to continue is
"the most recent session", it does not qualify — continuity would be a guess.

1. `src/core/executor/executor-adapter.ts`: add the id to `EXECUTOR_PROVIDERS` and a row to
   `EXECUTOR_PROVIDER_INFO` (display name, executable, `configKey`, who assigns session ids, prompt
   channel, whether it has a model flag, hint texts, doctor check names).
2. `src/core/permissions/permission-policy.ts`: add the `configKey` to `PERMISSION_PROVIDERS`
   (defaults follow). Update the tests that spell out the default permission object.
3. An adapter in `src/adapters/<name>/` implementing `ExecutorAdapter`: `run`, `permissionArgs`,
   `findReportedModel`, `commandLabel`, `permissionCapability` (only modes the CLI really has, from
   `--help`). Return the distinct error codes; never accept a resume you cannot verify.
4. `src/core/providers/<name>-provider.ts` for detection (never a model call) and register it in
   `createDefaultProviderRegistry`.
5. `src/core/bridge-engine.ts`: `createExecutorAdapter` branch, an auth check in `executorDoctorChecks`,
   the capability in `getConfig`. A model flag also needs a `models.<key>` entry in `config.ts`.
6. UI: the picker lists `EXECUTOR_PROVIDERS` automatically; add a model section in `Settings.tsx` if it
   has a model setting, labels in `SystemView.tsx`.
7. A fake CLI in `tests/fixtures/` that mirrors **observed** behaviour (including its failure quirks),
   adapter tests, an engine-level run in `tests/pluggable-executor.test.ts`.
8. Run it for real once with a small two-round task and read the execution record.

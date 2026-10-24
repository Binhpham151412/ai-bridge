# 64 — Pluggable executor (the AI that writes the code)

Status: implemented and tested with fake CLIs, then with real runs on the development machine
(2026-10-11): OpenCode 1.14.30 (failure path) and OpenCode 1.19.0 (successful runs, §9).

## 1. Why

AI Bridge always drove Claude Code as the developer and Codex (ChatGPT sign-in) as the reviewer.
Tools such as OpenDesign or 9router let the user see which AI CLIs are installed and click the one
to use. The same is wanted here, for the **developer only**: the reviewer stays Codex/ChatGPT.

## 2. What changed for the user

- **Settings → Run configuration → "Developer AI (executor)"**: one card per supported CLI with what
  was detected on this machine — *Sẵn sàng* / *Đã cài, chưa đăng nhập* / *Chưa cài* — its version, and
  the sign-in command when it is not ready. Click a card to choose it; **Dò lại** detects again.
  Detection only runs `--version` and a login-status command. It never calls a model and spends no quota.
- The model field, the permission fieldset and the bypass warning follow the chosen executor
  (plus the reviewer). OpenCode models are written `provider/model`.
- Start dialog, Run view, sidebar, execution panel and System check name the real executor.
- Default is unchanged: a project with no `executor` setting uses Claude Code exactly as before.

```json
{ "executor": { "provider": "opencode" },
  "models": { "opencode": "anthropic/claude-opus-5-5" },
  "permissions": { "opencode": "bypass" } }
```

`executor.provider` ∈ `claude-code` | `opencode`; `models.opencode` null/absent = no `--model`;
`permissions.opencode` defaults to `bypass` like every provider (docs/61).

## 3. Design

| Piece | Where |
|---|---|
| Contract: `ExecutorAdapter`, run options/result, provider table (`EXECUTOR_PROVIDER_INFO`) | `src/core/executor/executor-adapter.ts` (no runtime imports; reaches the renderer through `src/desktop/shared/executor-providers.ts`) |
| Claude Code adapter (now implements the contract; behaviour unchanged) | `src/adapters/claude/claude-code-cli-adapter.ts` |
| OpenCode adapter | `src/adapters/opencode/opencode-cli-adapter.ts` |
| Detection (version + credential count) | `src/core/providers/opencode-provider.ts`, registered in the default `ProviderRegistry` |
| Orchestrator calls the slot through the contract | `src/core/orchestrator/orchestrator.ts` |
| Executor chosen from config; doctor, permissions, model, adapter | `src/core/bridge-engine.ts` |
| `providers:list` IPC → picker data | `src/desktop/main/executor-providers.ts`, `ipc-contract.ts`, preload `listExecutorProviders()` |

The contract exists because the two CLIs differ in ways the orchestrator must not hide:

| | Claude Code | OpenCode |
|---|---|---|
| New session id | made by AI Bridge (`--session-id`) | made by the CLI (`ses_…`), read from its events |
| Resume | `--resume <id>` | `--session <id>` |
| Report contract | `--append-system-prompt` | no such flag → prepended to the prompt on stdin |
| Prompt | stdin | stdin (an empty message is refused; piped stdin is read) |
| Bypass | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` |
| Ask | `--permission-mode acceptEdits` | no flag (OpenCode's own configuration) |
| Failure | non-zero exit | **exit code 0** + an `error` event |
| Model reported | yes (`init` event) | no — only the requested model is recorded |
| Token usage | parsed from `result` | not parsed (UNKNOWN) |

## 4. Decisions worth knowing

1. **The developer slot keeps its historical names.** `claudeSessionId`, the `claude` permission
   slot, `CLAUDE_EXECUTING`, `NNN-claude-execution.json` and the `claude` agent literal are *not*
   renamed: state files, execution records, resume, IPC and 960 tests depend on them. Which CLI filled
   the slot is recorded in `state.executor`, `RUN_STARTED.executor` and each execution record's
   `provider`. (The earlier plan said "rename"; it was dropped as unsafe for resume of existing runs.)
2. **A run is resumed with the executor it started with**, never the project's current setting —
   its session ids belong to that CLI. State written before this feature has no `executor` and
   resumes as Claude Code. The doctor checks that executor (`runDoctor(path, { executor })`).
3. **Exit code 0 is not success for OpenCode.** An `error` event ends the call as
   `CLI_REPORTED_ERROR` and the CLI's own message becomes the run's `errorMessage`.
4. **A cli-assigned new session with no reported id fails** (`NO_SESSION_ID`): it could never be resumed.
5. **Doctor for OpenCode**: `opencode-cli` (executable found) is required; `opencode-auth` reads
   `opencode auth list` → "N credentials" and is only a WARNING when 0 or unreadable, because OpenCode
   can be configured without stored credentials and its free/local models need none.
6. **Executable discovery**: an npm install of OpenCode puts only `opencode` / `opencode.cmd` shims on
   PATH, which a no-shell spawn cannot run. `findNativeExecutableNextToNpmShim` finds the packaged
   `opencode.exe` (non-baseline build preferred). Claude and Codex resolution is unchanged.
7. **The "$0" footer claim is shown only for Claude Code.** OpenCode credentials are per-provider API
   keys; AI Bridge cannot know whether a chosen model bills.

## 5. Not supported (and why)

- **Antigravity (`agy`)**: `agy --help` shows `--print` (one prompt, non-interactive) and
  `--conversation <id>` (resume), but no machine-readable output format and no way for the caller to
  choose or read back a conversation id. AI Bridge's session tracking, continuity evidence and
  recovery would be guesses, so it is not offered. Adding it needs a CLI that exposes the id.
- **Gemini CLI, Cursor CLI, …**: not installed here, so nothing was verified. The contract is the
  extension point: add the id to `EXECUTOR_PROVIDERS`, a row to `EXECUTOR_PROVIDER_INFO`, a permission
  provider, an adapter, a detection adapter, and the doctor branch.
- Reviewer other than Codex/ChatGPT.

## 6. Known limitations (not hidden)

- Wording that is not provider-aware yet: the activity log / event labels (`Claude CLI started`),
  Journal headings (`Claude Report`, `Claude Prompt`), Artifacts column titles, workflow screens and
  the STOP confirmation still say "Claude" for the developer slot. The Core event *details* are
  provider-aware; the renderer's fixed label tables are not.
- Token usage is `UNKNOWN` for OpenCode runs (its stream has a different shape; not parsed).
- OpenCode does not report the model it used.
- With `ask`, whether OpenCode refuses or auto-rejects a permission request in a headless run was not
  verified (only `--help` was read).

## 7. Tests

`tests/pluggable-executor.test.ts` (config, full 2-round run with OpenCode incl. NEW → `--session`
resume, default unchanged, ask policy, error-event failure, answer-in-chat, resume keeps the run's
executor, pre-feature state resumes as Claude), `tests/opencode-cli-adapter.test.ts`,
`tests/providers/opencode-provider.test.ts`, `tests/providers/npm-shim-discovery.test.ts`,
`tests/desktop/executor-providers.test.ts`, `tests/desktop/renderer/executor-picker.test.tsx`;
existing config / permission / model / registry / IPC / preload tests updated for the new shape.
Fixtures: `tests/fixtures/fake-opencode/`, `tests/fixtures/fake-provider/fake-opencode-diag.mjs`.

## 8. Checked on the real machine (no quota)

- `opencode.exe` resolved from the npm shim; `providers:list` → Claude Code 2.1.161 ready,
  OpenCode 1.14.30 ready (8 credentials); doctor with `executor: opencode` → PASS.
- A real `BridgeEngine.start` with the real `opencode.exe` and `opencode/big-pickle`: stdin delivered,
  argv as designed, the CLI's refusal (exit 0 + `error` event, "OpenCode 1.18.0 or newer is required
  to use the free tier") stopped the run as `CLAUDE_RUN_FAILED:CLI_REPORTED_ERROR` with that message,
  and the session id the CLI reported was recorded as `CONFIRMED_BY_CLI`. Codex was never reached.

## 9. Real successful runs (OpenCode 1.19.0, free model `opencode/big-pickle`, real Codex reviewer)

After the CLI was upgraded from 1.14.30 (whose free tier was refused) to 1.19.0:

- The real success stream matches what the adapter assumes: `step_start` → `text` (`part.text`) →
  `step_finish` (`part.tokens`, `cost`), every event carrying `sessionID`.
- Run 1: one round, `DONE`; OpenCode wrote the file and the contract-conformant report, Codex reviewed it.
- Run 2 (two-part task): round 1 NEW session, round 2 `--session <id>` **RESUME with continuity
  VERIFIED** for both OpenCode and Codex; both files created; final `DONE`.
- Token usage for OpenCode stays `UNKNOWN` (the stream has `tokens`, but it is not parsed yet).

Still not verified: `ask` permission behaviour in a headless run (only `--help` was read), and any
model other than `opencode/big-pickle`.

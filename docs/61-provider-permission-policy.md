# 61 — Provider Permission Policy (M5.10.1)

Status: implemented and tested with fake CLIs only (2026-10-01). No real Claude/Codex execution
was performed for this change. Final state: **READY FOR REAL M5.10** (M5.10 itself is not PASS).

## 1. Motivation

AI Bridge drives Claude Code and Codex **headless**: nobody sits in front of either CLI to answer
a permission prompt. Before M5.10.1 the permission behaviour was hard-wired and not visible to the
user:

- Claude Code always ran with `--permission-mode acceptEdits`, and a Core guard
  (`src/core/preflight/permission-mode.ts`, now removed) refused `bypassPermissions` outright.
- Codex always ran in a read-only sandbox (`-s read-only`, `-c sandbox_mode="read-only"` on resume).

There was no setting, no per-execution record of what was in force, and no way to change it.

## 2. Problem discovered during the first real M5.10 run

The first REAL M5.10 workflow, executed against `bdsdanang`, progressed
Claude → Claude Report → Codex Review → **NEEDS_HUMAN**. AI Bridge itself did not fail. The stop
came from the providers needing permissions that a headless run under the fixed policy could not
grant:

- starting an Astro development server;
- localhost access;
- browser / Chrome DevTools automation.

Under `acceptEdits` Claude Code refuses such actions instead of asking (there is no one to ask),
and Codex's read-only sandbox blocks them. The task could therefore not be validated end to end.
The gap is a missing **product capability** — a user-configurable, auditable provider permission
policy — not an execution bug. It is recorded in the M5.10 report, docs/59 §25.

## 3. Policy model

Provider-neutral, in `src/core/permissions/permission-policy.ts` (zero imports):

| Value | Meaning |
|---|---|
| `bypass` | The provider runs the operations its CLI supports without interactive permission prompts. **Default.** |
| `ask` | The provider's normal permission behaviour. Because runs are headless, nothing is actually asked: whatever would need approval is refused by the provider and reported back. |
| `inherit` | Execution-level request only: use the project's setting for that provider. |

Where it lives:

- **Project setting** (the "global provider setting" for that project, used by the desktop app,
  the CLI and every workflow alike): `.ai-bridge/config.json`
  ```json
  { "permissions": { "claude": "bypass", "codex": "ask" } }
  ```
  Validated by Core's `validateConfig` (unknown provider or value → config error, the run is
  blocked by preflight; nothing is coerced).
- **Execution override**: `BridgeStartOptions.permissionPolicy` / `ExecutionRequest.permissionPolicy`
  / the run-host `start` command, each optional, `inherit | ask | bypass`.

Resolution (`resolvePermissionPolicy`): request `ask`/`bypass` → that value (source
`execution-override`); `inherit` or omitted → the provider's setting (source `provider-setting`);
missing setting → `bypass`. Anything unknown → `UNSUPPORTED_PERMISSION_POLICY` (fail closed).

## 4. Default = bypass

An explicit product requirement. `DEFAULT_CONFIG.permissions = { claude: "bypass", codex: "bypass" }`.
Existing projects and config files written before M5.10.1 (no `permissions` field) are still valid
and resolve to `bypass` with no migration step. A partial object (`{"codex": "ask"}`) keeps the
default for the provider it omits.

## 5. "Ask" behaviour

- **Claude Code**: `--permission-mode acceptEdits` — exactly the pre-M5.10.1 behaviour. File edits
  are accepted (the run must be able to write its report); other privileged actions are refused by
  the CLI.
- **Codex**: `codex exec` has **no interactive approval channel** (`-a/--ask-for-approval` exists
  only on the top-level interactive `codex`). The closest supported restricted mode is the read-only
  sandbox AI Bridge always used; the Settings UI labels it honestly as "Restricted: read-only
  sandbox (no approval prompts in codex exec)" rather than pretending to ask.

## 6. Provider-specific mapping (verified, no task executed)

Only `--help` was run; no provider task, no quota.

**Claude Code 2.1.161** — `claude --help`: `--permission-mode <mode>` with choices
`acceptEdits, auto, bypassPermissions, default, dontAsk, plan`; also `--dangerously-skip-permissions`
and `--allow-dangerously-skip-permissions`.

| Policy | argv (fresh and `--resume` alike) |
|---|---|
| `bypass` | `--permission-mode bypassPermissions` |
| `ask` | `--permission-mode acceptEdits` |

The dedicated mode flag was chosen over `--dangerously-skip-permissions` because AI Bridge already
selects the mode through `--permission-mode`; one mechanism, one audit string.

**Codex (codex-cli 0.159.2)** — the only `codex.exe` present under
`%LOCALAPPDATA%\OpenAI\Codex\bin\*`. `codex exec --help` and `codex exec resume --help` both list
`--dangerously-bypass-approvals-and-sandbox`; `exec` lists `-s/--sandbox
read-only|workspace-write|danger-full-access`; `exec resume` does not accept `-s`.

| Policy | `codex exec` | `codex exec resume` |
|---|---|---|
| `bypass` | `--dangerously-bypass-approvals-and-sandbox` | `--dangerously-bypass-approvals-and-sandbox` |
| `ask` | `-s read-only` | `-c sandbox_mode="read-only"` |

Bypass **replaces** the sandbox flags; the two are never combined.

The mapping lives in the adapters (`claudePermissionArgs`, `codexPermissionArgs`) together with a
declared `ProviderPermissionCapability` (modes, labels, CLI mechanism, CLI version verified
against). The Orchestrator refuses — in its constructor, before any process exists — a policy the
provider's capability does not declare, or a policy filed under the wrong provider.

The provider **diagnostics** probes (M4.3, `src/core/providers/*`) are not executions of user work
and keep their fixed read-only, ephemeral invocation.

## 7. Workflow inheritance

```
WorkflowEngine ─ ExecutionRequest{permissionPolicy?} ─ ExecutionPort ─ Execution Host
  ─ BridgeEngine.start({permissionPolicy?}) ─ resolve per provider ─ Orchestrator
  ─ Claude/Codex adapter ─ provider-specific flags
```

- The WorkflowEngine knows only the neutral words and today sends nothing (= `inherit`); it was not
  changed. No workflow-definition schema change was needed — existing definitions stay valid.
- `ForkedExecutionPort` forwards an override into the host `start` command only when one is given;
  `isHostCommand` rejects a malformed value.
- The override is persisted in `current-session.json` (`permissionPolicy`), so `resume` keeps it.
  The provider setting itself is re-read on resume; every execution records what was actually used.

## 8. Execution audit

Every `<NNN>-claude-execution.json` / `<NNN>-codex-execution.json` (written before the process is
spawned) carries:

```json
"permission": {
  "provider": "claude",
  "requested": "inherit",
  "resolved": "bypass",
  "source": "provider-setting",
  "reason": "Global provider permission policy (claude) = bypass",
  "cliArgs": ["--permission-mode", "bypassPermissions"]
}
```

So "Why did this Claude execution not ask for permission?" is answered by the record itself:
*Global provider permission policy = bypass*, with the exact flags. The same line appears in:

- the journal: `NNN-claude-report.md` (`- Permission policy: …`) and `NNN-review.md`
  (`- Codex permission policy: …`);
- the desktop execution panel (row "Permission policy");
- `RUN_STARTED` in `events.jsonl` (`permissions: { claude, codex }` resolved values).

Records written before M5.10.1 have no `permission` field; the UI and journal show `UNKNOWN`
rather than guessing. Only the fields above are recorded — no environment, credentials or
provider output (tested).

## 9. Settings UI

Settings → Run configuration → **AI Execution Permissions**:

- one radio group per provider, built from the capabilities Core reports (`getConfig()` →
  `permissionCapabilities`) — only modes the installed CLI declares are shown, each with its CLI
  mechanism and the CLI version it was verified against;
- the statement "Bypass permissions allows the AI provider to execute supported operations without
  interactive permission prompts.";
- while any provider is on bypass (the default), the warning "Permission bypass is enabled by
  default. AI providers may execute commands and access project resources without interactive
  approval." — informational, it never blocks a run. The Start Run dialog shows the active policy
  and the same warning.

Saving uses the existing typed `bridge:saveProjectConfig` channel; Core validates in Main and
refuses while a run is active. No new IPC channel, no Node/Electron API in the renderer, and the
renderer never imports an adapter or spawns a provider (tested).

## 10. Security implications

- **Bypass is the default, deliberately.** With the default policy, Claude Code skips its permission
  checks and Codex runs **without its sandbox** (and is no longer read-only as a reviewer). Both can
  run commands and reach the network and project resources as the user. Use `ask` for projects
  where that is unacceptable.
- Bypass is reachable **only** through the typed policy: there is no free-form permission string
  anywhere in the execution path any more, and unknown values fail closed at config validation,
  `start()` (`INVALID_OPTIONS`, before any lock/session), the host protocol, and the Orchestrator.
- Unchanged: no API keys (cost guard still blocks `*_API_KEY` env), no credential storage, no
  browser-login automation, one active run lock, process-tree management, IPC validation, renderer
  isolation.

## 11. CLI capability limitations

- The flags were verified against `--help` output only. Their runtime behaviour under bypass was
  **not** exercised here (no real execution was allowed); the first real run after this change is
  where it gets observed.
- Codex has no real "ask" in `codex exec`; `ask` is "restricted (read-only sandbox)".
- `--approve-for-me` (codex 0.159.2: "route approval requests through automatic review using the
  workspace-write sandbox") and Claude's `auto`/`dontAsk` modes exist but are **not** exposed — they
  are neither `ask` nor `bypass`, and adding them would be a new policy value.
- Capabilities are declared per adapter for the verified versions; AI Bridge does not probe the
  installed CLI's `--help` at runtime. A future CLI that drops a flag would surface as a CLI error
  in the execution record, not a silent downgrade.

## 12. Future extension points

- A new provider: add it to `PERMISSION_PROVIDERS`, implement `<provider>PermissionArgs` and a
  `ProviderPermissionCapability` in its adapter; resolution, config validation, audit and Settings
  pick it up.
- More policy values (e.g. `workspace-write`, Codex `--approve-for-me`, Claude `auto`) would extend
  `PERMISSION_POLICIES`; providers that cannot honour one must not declare it, and the Orchestrator
  will refuse it.
- A per-step workflow override: the contract already carries `permissionPolicy`; only the workflow
  definition/step-planner would need to set it (not done — out of scope, no schema change).
- Runtime capability detection (parsing `--help` during doctor) to replace the static declaration.

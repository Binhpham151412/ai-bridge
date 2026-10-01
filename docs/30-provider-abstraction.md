# 30 — Provider Abstraction (PROPOSED; builds on EXISTING M4.3)

## 1. Purpose

Define a provider abstraction for Claude, Codex and future providers that **models
capabilities explicitly** instead of assuming every provider supports the same features.
It separates what exists (diagnostics) from what is proposed (execution capability
modelling), and states when the execution layer may become provider-agnostic.

## 2. Current State (EXISTING)

Two separate provider layers exist:

| Layer | Code | Used for | Provider-agnostic? |
|---|---|---|---|
| Diagnostics | `core/providers/*`: `ProviderAdapter.diagnose/loginCommand`, `ProviderRegistry`, `CliProviderSpec` | discovery, version, auth, optional quota probe | **yes** (register any adapter) |
| Execution | `ClaudeCodeCliAdapter`, `CodexCliAdapter`, typed concretely in `OrchestratorOptions` | running the loop | **no** (concrete classes, fixed roles) |

Also EXISTING, and duplicating the diagnostics layer: `BridgeEngine.realRunDoctor` has its
own executable resolution and auth parsing (docs/20 §12).

## 3. Capability matrix (facts from the code, not assumptions)

| Capability | Claude Code CLI (as used) | Codex CLI (as used) | Evidence |
|---|---|---|---|
| Role | executor | reviewer | orchestrator.ts |
| File edits | yes (`--permission-mode acceptEdits`) | no (`-s read-only` / `sandbox_mode="read-only"`) | adapters |
| Session id assignment | **client-assigned** (`--session-id <uuid>`) | **server-assigned** (`thread.started.thread_id`) | adapters |
| Resume | `--resume <id>` | `exec resume <thread>` | adapters |
| Resume verification | reported `session_id` must equal the requested one (else SESSION_MISMATCH) | reported thread must equal the requested one (else THREAD_MISMATCH) | adapters |
| Input channel | stdin prompt + `--append-system-prompt` (a separate channel) | stdin only | adapters |
| Output format | stream-json NDJSON on stdout; final `result` event | `--json` events on stdout; response text via the `-o` file | adapters |
| Streaming to AI Bridge | **no** (AI Bridge buffers until exit) | **no** (buffered) | process-runner |
| Usage reporting | `result.usage` (input/output/cache creation/cache read) | `turn.completed.usage` (input/output/cached/reasoning) | execution-record.ts |
| Tool control | `--allowedTools`/`--disallowedTools` supported by the adapter, **unused** | not modelled | claude adapter |
| Auth status | `claude auth status` JSON (`loggedIn`, `authMethod`: claude.ai / console) | `codex login status` text on stderr (ChatGPT / API key / not logged in); no account info | cost-guard, providers |
| API-key billing | refused (env guard + auth-mode check) | refused | cost-guard |
| Quota signal | usage-limit phrases in error text (`detectUsageLimit`) | same | cli-provider.ts |
| Execution probe | opt-in, spends quota | opt-in, spends quota | providers |
| Windows specifics | `where claude` may list an unspawnable npm shim; `.exe` preferred | `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` fallback | executable-discovery, bridge-engine |

## 4. Proposed Design

### 4.1 Capability flags (documentation example)

```ts
interface ProviderExecutionCapabilities {
  roles: ('executor' | 'reviewer')[];
  fileEdits: 'none' | 'project-scoped';
  sandbox: { readOnly: boolean; enforcedOn: ('win32'|'darwin'|'linux')[] | 'unknown' };
  session: { assignment: 'client' | 'server' | 'none'; resume: boolean; resumeVerifiable: boolean };
  input: { stdin: boolean; separateSystemChannel: boolean };
  output: { structuredEvents: 'ndjson' | 'none'; responseFile: boolean; liveStreaming: boolean };
  usage: 'reported' | 'none';
  toolControl: 'allow-deny-flags' | 'none';
  auth: { statusCommand: boolean; accountInfo: boolean; apiKeyBillingDetectable: boolean };
  quotaSignal: 'error-text' | 'none';
}
```

These flags are **static data per adapter version**, reviewed by hand. They are never
inferred from marketing claims. Unknown is expressed as `'unknown'` / `'none'`, not as true.

### 4.2 Where the abstraction is used, by milestone

| Milestone | Use |
|---|---|
| M5 | None in execution. The workflow may display the provider statuses (EXISTING registry) and pre-check readiness through `doctor()`. |
| M7 | The Capability Registry exposes `provider:*` manifests whose `provides` are derived from these flags. Workflow steps require features (`resume:session`, `execute:file-edit`); resolution checks them. |
| M9 | The execution layer accepts an `ExecutorAdapter`/`ReviewerAdapter` interface instead of the concrete classes. That is the **only** point at which Orchestrator typing changes, and it needs its own ADR, because it touches the M4 core (docs/32). |

### 4.3 Future execution adapter contract (FUTURE EXTENSION, documentation example)

```ts
interface ExecutorAdapter {
  capabilities: ProviderExecutionCapabilities;
  run(o: { cwd: string; prompt: string; session: { id: string | null; resume: boolean };
           systemContract?: string; timeoutMs: number; profile: PermissionProfile;
           onSpawn?: (pid: number) => void; onInputFlushed?: (b: number) => void }): Promise<ExecutorRunResult>;
}
```

`ExecutorRunResult` must provide everything `finalizeExecutionRecord` needs today
(`ProcessOutcome`), so the existing evidence model is preserved for every provider. A
provider that cannot report a session id gets `continuity: UNKNOWN` (the EXISTING rule).
It is never faked.

### 4.4 Consolidating the duplicate discovery (OPEN QUESTION)

`realRunDoctor` and `core/providers` both discover and parse auth. Options: (a) keep both
(no risk to M4 behavior); (b) M4.3 Phase 2 makes doctor call the ProviderRegistry for the
cli/auth checks while keeping the same `DoctorReport` names. (b) is recommended, but it is
a Phase 2 decision, not M5, and it must keep the doctor output byte-compatible with
existing tests.

## 5. Responsibilities

- Diagnostics adapters: readiness only. They never run tasks.
- Execution adapters: run one call and report evidence. They never decide the loop.
- The Capability Registry (M7): feature-based selection.

## 6. Boundaries

- A provider is never selected by a model.
- Adding a provider = a new diagnostics adapter (EXISTING extension point
  `ProviderRegistry.register`) + (M9) a new execution adapter + a static capability matrix
  + fake-CLI tests. It never involves branching on a provider name inside the Orchestrator.

## 7. Data Flow

`ProviderRegistry.getProviderStatus` → `ProviderStatus` (installation/auth/readiness) →
(M7) manifest `provides` → resolution → (M9) adapter selection → execution record
(`agent` field extended from `'claude'|'codex'` to a provider id, FUTURE).

## 8. Failure Cases

| Case | Handling |
|---|---|
| A provider lacks resume | Steps requiring `resume:session` do not resolve; a workflow using it cannot use pause/resume (the UI disables it) |
| A provider reports no usage | Token budget incomplete (docs/26 §7) |
| A provider's sandbox is unenforced on Windows | Treated as advisory; workspace digest checks around read-only roles (docs/25 §5) |
| The CLI version changes the output format | The adapter's strict parse fails → ERROR with a code (EXISTING behavior); the capability matrix pinned to a version range (M7) |

## 9. Decisions

ADR-004 (provider-agnostic architecture, concrete execution until M9).

## 10. Open Questions

The duplicate discovery consolidation (§4.4); whether `ExecutionRecord.agent` becomes a
free provider id (a schema bump); live streaming of stdout (it would enable heartbeats and
a live UI, but changes runProcess buffering).

## 11. Explicitly Out of Scope

Implementing new providers; API-based (HTTP) providers, which would violate the
subscription-only cost rule unless explicitly designed; changing the adapters.

## 12. Risks

- Premature abstraction of the Orchestrator: deferred to M9 on purpose.
- Capability matrices going stale with CLI updates: version ranges plus doctor version
  reporting.

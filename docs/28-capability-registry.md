# 28 — Capability Registry (M7, DESIGN ONLY)

## 1. Purpose

Design a future registry that describes every component AI Bridge may use to perform
work: **Agent, Skill, Tool, MCP server, Provider, Workflow, Prompt**. It covers metadata,
versioning, trust, permissions, compatibility, discovery, selection and lifecycle, so that
workflows select capabilities by task instead of hard-coding them. Nothing here is built
in M5.

## 2. Current State (EXISTING)

- The only registry is `ProviderRegistry` (M4.3 Phase 1, `src/core/providers/`). It holds
  `ProviderAdapter`s with a `ProviderDescriptor {id, displayName, roles: executor|reviewer,
  capabilities: status-check|execution-probe|cli-login|reports-account|reports-subscription,
  executableName}`, and caches `ProviderStatus`. It is not used by execution.
- Execution is hard-wired: `BridgeEngine.runLoop` constructs `ClaudeCodeCliAdapter` and
  `CodexCliAdapter` directly.
- Prompts are code constants (`templates.ts`). There are no skills, tools or MCP concepts
  in AI Bridge. Claude Code uses the user's *own* skills, MCP servers and hooks from its
  global configuration, without AI Bridge knowing about them (docs/20 §10).

## 3. Proposed Design

### 3.1 Capability manifest (documentation example)

```ts
interface CapabilityManifest {
  schema: 1;
  id: string;                    // "provider:claude-code", "workflow:implement-and-test", "prompt:reviewer-v2"
  kind: 'agent' | 'skill' | 'tool' | 'mcp' | 'provider' | 'workflow' | 'prompt';
  version: string;               // semver of the capability definition
  displayName: string;
  description: string;           // ≤ 300 chars (progressive disclosure: only this is shown by default)
  source: { type: 'builtin' | 'project-file' | 'user-file' | 'git' | 'cli-discovered';
            location: string; contentHash: string };        // sha256 of the manifest + payload files
  provides: string[];            // feature tags, e.g. "execute:file-edit", "review:read-only", "resume:session"
  requires: { capabilities?: string[]; cliVersion?: { executable: string; range: string }; os?: ('win32'|'darwin'|'linux')[] };
  permissions: Permission[];     // docs/33 §4
  trust: TrustTier;              // assigned by the registry, NOT by the manifest author
  lifecycle: LifecycleState;
  evaluation: { at: string; by: 'system' | 'human'; notes: string; checks: { name: string; status: 'PASS'|'FAIL'|'UNKNOWN' }[] } | null;
}
type TrustTier = 'BUILTIN' | 'FIRST_PARTY' | 'USER_LOCAL' | 'THIRD_PARTY' | 'UNTRUSTED';
type LifecycleState = 'INSPECTED' | 'EVALUATED' | 'CLASSIFIED' | 'ADAPTED' | 'REGISTERED' | 'DISABLED' | 'REJECTED';
```

### 3.2 Lifecycle: INSPECT → EVALUATE → CLASSIFY → ADAPT → REGISTER

| Stage | Action | Output | Automatic? |
|---|---|---|---|
| INSPECT | Read the candidate *as data* (manifest, files, CLI `--version`/`--help`). Nothing is executed except the fixed, side-effect-free probes already used by providers (version and auth status). | Parsed manifest + content hash; INSPECTED | yes (read-only) |
| EVALUATE | Check `requires` (CLI version range, OS), compare the declared permissions to the policy maximum for its kind, and optionally run a dry-run (docs/36 §6). A human reviews the diff of permissions and commands. | Evaluation record; EVALUATED or REJECTED | checks automatic; **approval human** |
| CLASSIFY | Assign the trust tier (§3.3) and kind; compute the effective permissions = declared ∩ tier maximum | CLASSIFIED | automatic, from rules |
| ADAPT | Bind to an AI Bridge adapter: a provider → a `ProviderAdapter` (existing interface); a workflow → a validated definition; a prompt → a template with declared variables; a tool/MCP → a *declaration* used to build CLI flags (e.g. `--allowedTools`, which the adapter already supports but nothing passes today) | Adapter binding; ADAPTED | automatic, for supported kinds only |
| REGISTER | Store the manifest in the registry index, pinned by `contentHash` | REGISTERED | human confirms for tiers below FIRST_PARTY |

A content-hash change → back to INSPECTED (re-approval). Nothing is ever downloaded or
installed by the registry. Candidates arrive only as files the user placed, or as CLIs the
user installed (discovered by the EXISTING executable discovery).

### 3.3 Trust tiers

| Tier | Examples | Default state | Max permissions |
|---|---|---|---|
| BUILTIN | AI Bridge's own prompts and workflows shipped in the app | enabled | as designed |
| FIRST_PARTY | the official Claude Code CLI, the official Codex CLI (discovered, signed-in accounts) | enabled once doctor passes | executor: file edits in the project; reviewer: read-only |
| USER_LOCAL | workflow/prompt files in the user's project or userData | disabled until approved | no network permission; commands only from the approved list |
| THIRD_PARTY | content from a git repo or shared file (skills, MCP server configs, workflows) | **disabled** | the most restrictive profile; outputs marked untrusted in prompts |
| UNTRUSTED | failed evaluation, or a hash changed without re-approval | cannot be enabled | none |

### 3.4 Discovery and selection

- **Discovery sources:** built-ins; the M4.3 ProviderRegistry (each registered
  `ProviderAdapter` becomes a `provider:*` manifest, with `provides` derived from the
  descriptor roles/capabilities plus the static provider feature matrix in docs/30);
  `.ai-bridge/capabilities/*.json` (project); an app userData capabilities folder (global).
- **Selection is task-driven:** a workflow step declares a *requirement*, not an
  implementation:

  ```json
  "executor": { "role": "executor", "requires": ["execute:file-edit", "resume:session"] }
  ```

  The registry resolves it deterministically: filter REGISTERED + enabled + compatible, then
  prefer an explicitly pinned id in the step, then trust tier, then the lexical id. The
  resolution result, including the manifest hash, is recorded in the attempt record. No LLM
  chooses capabilities.
- **Compatibility:** `requires.cliVersion` ranges are checked against the provider status
  `version` (EXISTING field). A mismatch → the step is BLOCKED with a clear reason, never
  run silently.

### 3.5 Integration with the Workflow Engine (M7)

Plan-time only: before an attempt, the decider emits `RESOLVE_CAPABILITIES`. The result is
attached to the attempt. In M5/M6 this resolver is a constant: executor = Claude via
BridgeEngine, reviewer = Codex. The definition format reserves `requires` (docs/36), so no
migration is needed.

## 4. Responsibilities

The registry owns manifests, lifecycle state, trust, effective permissions and
resolution. It does **not** execute capabilities (execution stays behind BridgeEngine or
ports), and it does not manage CLI installation or login (login is described, never run:
the EXISTING `ProviderLoginCommand` rule).

## 5. Boundaries

- The ProviderRegistry is wrapped, not rewritten: `ProviderRegistryCapabilitySource` reads
  `listProviders()`/`getCachedStatus()`.
- The registry never writes into the user's global Claude/Codex configuration.

## 6. Data Flow

`file/CLI → INSPECT (read) → EVALUATE (checks + human) → CLASSIFY → ADAPT → REGISTER
(index.json) → resolve(requirements) → attempt record (id + hash)`.

## 7. Failure Cases

| Case | Handling |
|---|---|
| Manifest hash changed | UNTRUSTED until re-approved; steps requiring it are BLOCKED |
| No capability satisfies a requirement | Step BLOCKED (`CAPABILITY_UNRESOLVED`) |
| Two equally ranked candidates | Deterministic tiebreak (lexical id) + a warning event |
| Provider installed but not authenticated | Resolution fails with the provider status reason (EXISTING state `INSTALLED_NOT_AUTHENTICATED`) |

## 8. Decisions

ADR-005 (capabilities are task-selected), ADR-004 (provider-agnostic).

## 9. Open Questions

- Whether AI Bridge should pass `--strict-mcp-config`-style isolation flags to Claude to
  exclude the user's global MCP servers from workflow executions (the flag's existence and
  semantics are UNCERTAIN; they must be verified against the installed CLI).
- A global vs per-project registry precedence.
- The manifest format for Claude Code skills or agents shipped by third parties: map it,
  or ignore it and leave it to Claude?

## 10. Explicitly Out of Scope

Automatic installation, a marketplace, network fetches, LLM-driven capability choice,
executing MCP servers from AI Bridge itself.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Registry complexity before real need | M7 only; M5/M6 use a constant resolver |
| Users approving permissions without reading them | Diff-style approval showing only new permissions/commands |
| Hidden capabilities via the user's global Claude config | Documented limitation (docs/33); an isolation flag is an open question |

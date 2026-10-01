# 45 — M7 Capability Registry: Architecture (PROPOSED — documentation only)

Extends docs/28 (capability registry), docs/29 (concept model — **the glossary; its definitions
are kept**), docs/30 (provider abstraction) and docs/33 (security). Status legend: see docs/41.
PROPOSED ADRs: ADR-031 … ADR-035 (docs/58).

## 0. Section map (the 25 required items for M7)

| # | Item | Where |
|---|---|---|
| 1–6 | Purpose, problem, scope, non-goals, changes, concepts | this doc §1–§7 |
| 7 | Contracts / interfaces | docs/46 §5 |
| 8–13 | State machines, persistence, events, recovery, security, limits | docs/47 |
| 14–19, 25 | CLI, Main, UI, testing, real E2E, failure modes, acceptance | docs/48 |
| 20–24 | Compatibility, dependencies, open questions, ADRs | this doc §8–§12 |

## 1. Purpose

Give AI Bridge an **explicit, auditable inventory** of what it may use to perform work, and a
**policy-driven, deterministic** way to select from it per workflow step. The inventory covers
providers, agents, skills, tools, MCP servers, workflows and prompts. Lifecycle:

```
Inspect → Evaluate → Classify → Adapt → Register   (docs/28 §3.2; nothing is ever loaded automatically)
```

## 2. Problem being solved

1. **Execution is hard-wired** (EXISTING): `BridgeEngine.runLoop` constructs `ClaudeCodeCliAdapter`
   and `CodexCliAdapter` directly. A step cannot ask for "a read-only reviewer" or "an executor
   without network tools".
2. **An uncontrolled surface** (EXISTING fact, docs/33 §2): Claude Code runs with the user's
   *global* configuration (settings, hooks, skills, plugins, MCP servers). AI Bridge neither sees
   nor controls what a workflow execution can do beyond `--permission-mode acceptEdits`.
3. **No trust model** for content from other people: a skill, MCP configuration or workflow from
   a GitHub repository would be indistinguishable from the user's own files.
4. **No record** of which configuration produced an execution, so audits cannot answer "which
   tools and servers could this attempt use?"

## 3. Current state (EXISTING, verified)

| Fact | Where / evidence |
|---|---|
| `ProviderRegistry` with `ProviderAdapter {descriptor, diagnose, loginCommand}`, used for diagnostics only | `src/core/providers/` (M4.3) |
| The Claude adapter supports `--allowedTools` / `--disallowedTools`; nothing passes them | claude adapter (docs/30 §3) |
| The permission-mode allowlist refuses `bypassPermissions`; the Codex adapter always runs `read-only` | `permission-mode.ts`, codex adapter |
| The M5 validator reserves `executor.requires` for M7 (`RESERVED_FEATURE`, M7) | `validator.ts:335` |
| The installed **Claude Code 2.1.161** `--help` lists: `--mcp-config`, `--strict-mcp-config`, `--setting-sources <user,project,local>`, `--settings`, `--tools`, `--allowedTools`, `--disallowedTools`, `--disable-slash-commands` ("Disable all skills"), `--agents <json>`, `--plugin-dir`, `--plugin-url`, `--add-dir`, `--model`, `--system-prompt`, `--bare` | `claude --help`, 2026-09-30 |
| The installed **Codex 0.155.0-alpha.16.4** `exec --help` lists: `-s/--sandbox`, `-c key=value`, `-p/--profile`, `-m/--model`, `--ignore-user-config` ("auth still uses CODEX_HOME"), `--ignore-rules`, `--ephemeral`, `--output-schema`, `--dangerously-bypass-approvals-and-sandbox` | `codex exec --help`, 2026-09-30 |

The flags above are **observed in help text only**. Their runtime behavior (for example whether
`--setting-sources project` really excludes user hooks) is **UNVERIFIED** until M7.0 tests it
(OQ-M7-03 … 05, 07).

## 4. Scope (M7)

- A capability manifest v1 for 7 kinds, with identity, version, source, content hash, provides,
  requires, permissions and compatibility (docs/46).
- A registry: project and global stores, lifecycle states, enable/disable, hash-pinned approvals,
  and an append-only audit log (docs/47).
- Static inspection of local candidates, including repositories that **the user** cloned or
  downloaded from GitHub (ADR-035).
- Trust tiers assigned by source (ADR-032), effective permissions, risk classes.
- Explicit selection: a step declares requirements and optional pins; resolution is deterministic
  and pinned per instance (ADR-033).
- **Execution profiles**: an agent's permission profile maps to vetted CLI flags (permission mode,
  tool allow/deny, MCP isolation, settings-source isolation, skill disabling) through one additive
  optional start option (ADR-034).
- Skills delivered as labelled text in the task (never as permissions); MCP servers as
  declarations that the executor loads only through `--mcp-config` + `--strict-mcp-config`.
- CLI, desktop and UI for inspecting, approving, enabling and disabling (docs/48).

## 5. Explicit non-goals

- **No automatic loading** of any skill, tool, MCP server or plugin. Registration ≠ use; only
  selection by a step uses a capability.
- No download, install, update, marketplace or network fetch (docs/28 §10). `--plugin-url` is a
  **forbidden** flag.
- No JavaScript plugin loading into AI Bridge (docs/37 §9).
- AI Bridge is not an MCP client or server; it never starts MCP servers itself.
- No LLM chooses capabilities (ADR-005).
- No multi-provider execution. Execution stays Claude executor + Codex reviewer through the
  concrete adapters until M9 (ADR-004). M7 parameterizes *their flags only*.
- No edits to the user's global Claude/Codex configuration files.
- No per-user multi-tenant permissions (docs/33 §13).

## 6. Architectural changes

```
                  Capability Layer (NEW, Core, PROPOSED path src/core/capabilities/)
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ Sources ─► Inspector (static) ─► Evaluator (checks + human) ─► Classifier (tier, pure) │
 │   builtin · ProviderRegistry wrapper · project files · user files · local dir (repo)   │
 │ ─► Adapter binding (per kind) ─► Registry store (index + manifests + audit log)        │
 │ Policy (pure): effective permissions = declared ∩ tier max ∩ approval                  │
 │ Resolver (pure): step requirements + pins → Resolution {ids, versions, hashes, profile} │
 └──────────────────────────────────────────────────────────────────────────────────────┘
        │ resolution snapshot (pinned at instance start)            │ profile id + flag set
        ▼                                                           ▼
 Workflow Engine (EXISTING): instance pins the resolution;   BridgeEngine (EXISTING): optional
 step-planner injects skills as labelled text                 `profile` → adapter flags (ADR-034)
```

| Component | Change | Status |
|---|---|---|
| `src/core/capabilities/*` | new: manifest validator, store, lifecycle, policy, resolver, inspector, sources | PROPOSED |
| ProviderRegistry | **wrapped, not rewritten**: `ProviderRegistryCapabilitySource` (docs/28 §5) | PROPOSED |
| Definition validator | `executor.requires` accepted; new optional fields `executor.agent`, `context.skills`, `verification.reviewer.agent` (schema 1, additive, ADR-022) | PROPOSED |
| Decider | `RESOLVE_CAPABILITIES` before the first `START`; resolution pinned in the instance; drift → BLOCKED | PROPOSED |
| Step-planner | skills as labelled blocks with provenance | PROPOSED |
| BridgeEngine | one optional `profile` on `BridgeStartOptions` / `HostCommand.start` / review; persisted with the run so `resume()` reuses it; forbidden-flag enforcement | PROPOSED (ADR-034) |
| Adapters | map a profile to flags already modelled (tools, permission mode) + isolation flags (§3) | PROPOSED |
| Hosts / IPC / UI | registry views, the approval flow, the capability columns in attempt records | PROPOSED |

## 7. Domain concepts

The docs/29 definitions (Provider, Agent, Skill, Tool, MCP server, Workflow, Prompt) are kept
**unchanged**. M7 adds:

| Concept | Meaning |
|---|---|
| **Capability** | Anything in the inventory: one manifest of one kind |
| **Capability id** | `<kind>:<name>` (e.g. `agent:executor-default`), unique per registry scope |
| **Capability ref** | `<kind>:<name>@<semver>#<contentHash>` (the exact, pinned identity recorded in attempts) |
| **Source** | Where the candidate came from: `builtin`, `provider-registry`, `project-file`, `user-file`, `local-directory` (a user-acquired repository). It determines the trust tier |
| **Trust tier** | BUILTIN · FIRST_PARTY · USER_LOCAL · THIRD_PARTY · UNTRUSTED (docs/28 §3.3). Assigned by AI Bridge, never self-declared |
| **Permission** | A typed right (docs/33 §4, extended in docs/47 §2) |
| **Effective permissions** | declared ∩ tier maximum ∩ human approval |
| **Risk class** | LOW · MEDIUM · HIGH · CRITICAL, computed from the effective permissions (docs/47 §3). It determines the approval depth |
| **Requirement** | A feature tag a step needs (`execute:file-edit`, `review:read-only`, `resume:session`, …) |
| **Resolution** | The deterministic mapping of a step's requirements and pins to capability refs + one execution profile. Recorded and pinned |
| **Execution profile** | A named, vetted set of CLI flags for one provider role (`executor-default`, `executor-no-network-tools`, `reviewer-readonly`). It is what an agent's permission profile becomes at the CLI |
| **Evaluation report** | The static findings for one candidate (files, detected kinds, commands, network endpoints, risk) plus the human decision |
| **Approval** | A hash-pinned human decision that enables a capability at a given tier and permission set |
| **Lifecycle state** | INSPECTED → EVALUATED → CLASSIFIED → ADAPTED → REGISTERED, plus DISABLED, REJECTED (docs/28), with UNTRUSTED as the tier after hash drift |

## 8. Backward compatibility (item 20)

1. **A definition without M7 fields** resolves through the **constant resolver**. `executor` →
   `agent:executor-default` (BUILTIN: Claude, `acceptEdits`, the report contract); reviewer →
   `agent:reviewer-readonly` (BUILTIN: Codex, `read-only`). **The argv they produce must be
   byte-identical to M5/M6** (test), so M5/M6 behavior is unchanged.
2. `BridgeStartOptions.profile` is optional. Absent means today's behavior; existing callers (CLI
   `start`, RunController) never set it.
3. Registry files are new (`.ai-bridge/capabilities/`, app userData). No EXISTING path changes.
4. The attempt records gain an optional `capabilities` field; M5/M6 attempts lack it
   (UNKNOWN / "constant resolver").
5. Instances created before M7 have no pinned resolution. On resume they use the constant
   resolver, never a newly registered capability (determinism).
6. Downgrade: an M6 build refuses definitions with M7 fields (`RESERVED_FEATURE` / `UNKNOWN_FIELD`),
   so it fails closed (ADR-023).

## 9. Dependencies on previous phases (item 21)

- **M5**: the definition format, the step-planner, attempt records, ADR-017 correlation, the
  pinned definitionHash pattern.
- **M6**: the `verifier` permission (command approvals) becomes a permission kind; the reviewer
  agent selection plugs into ReviewPort; the tier model reuses ADR-026's approval ledger design.
- **M4.3**: ProviderRegistry and provider statuses (readiness gates resolution).

## 10. Dependencies on later phases (item 22)

None. M8 uses M7 to register the graph indexer as a `tool` capability (optional). M9 uses agent
identities, provider manifests and profiles, and extends providers to new adapters.

## 11. Open questions (item 23)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-M7-01 | Project vs global registry precedence (docs/28 §9) | Project wins for the same id; global THIRD_PARTY entries never shadow BUILTIN/FIRST_PARTY | M7.2 |
| OQ-M7-02 | Map third-party Claude Code skills/agents/plugins into manifests, or leave them to Claude? | Map **skills** (text) and **MCP configs** (declarations) only. Plugins and `--agents` JSON are not supported in M7 (forbidden flags) | M7.4 |
| OQ-M7-03 | The isolation default for workflow executions: `--setting-sources project`? `--strict-mcp-config` with an empty or declared config? | Test the behavior in M7.0 on the installed CLI. Adopt only verified effects; record the CLI version range | **M7.0** |
| OQ-M7-04 | What exactly `--disable-slash-commands` ("Disable all skills") disables | Verify in M7.0 | M7.6 |
| OQ-M7-05 | Evidence that isolation took effect (e.g. the stream-json init event listing tools/MCP servers — UNCERTAIN) | Record it if the CLI reports it; else `isolation: UNVERIFIED` in the attempt record | M7.6 |
| OQ-M7-06 | A semver range subset without a dependency | Support `x.y.z`, `>=`, `<`, `^`; nothing else | M7.1 |
| OQ-M7-07 | Codex `--ignore-user-config` / `--ignore-rules` for the reviewer: auth still works (help text) — side effects? | Verify in M7.0 | M7.6 |
| OQ-M7-08 | Risk thresholds per permission combination | docs/47 §3 initial table; review after M7.9 | no |
| OQ-M7-09 | Allow `--model` pinning in agent configs (quota/plan impact) | Allowed only as a declared agent field; UNKNOWN whether the plan permits it — the provider reports the error | M7.5 |

## 12. ADRs required (item 24)

ADR-031 (manifest v1, identity, content-hash pinning), ADR-032 (trust tiers by source; hash
drift → UNTRUSTED), ADR-033 (explicit deterministic selection; no auto-loading), ADR-034
(execution profiles as an additive start option; forbidden flags), ADR-035 (external
repositories: user-acquired, statically evaluated, never executed). All are PROPOSED.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Isolation flags behave differently than their help text suggests | M7.0 behavior verification; version-ranged profiles; `UNVERIFIED` labels |
| Approval fatigue | Diff-only approvals (new permissions/commands only); hash pinning avoids re-asking |
| Registry complexity before real need | Constant resolver default; M7 ships only kinds with a working adapter binding |
| A THIRD_PARTY skill text steering the agent | Labelled untrusted blocks; skills carry no permissions; M6 deterministic checks gate DONE |

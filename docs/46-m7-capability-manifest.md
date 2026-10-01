# 46 — M7 Capability Manifest and Registry Contracts (PROPOSED — documentation only)

Extends docs/28 §3.1. All types are documentation examples. Status legend: see docs/41.

## 1. Manifest v1 — common fields (ADR-031)

```ts
// Documentation example — NOT in source.
interface CapabilityManifest {
  schema: 1;
  id: string;                    // "<kind>:<name>", name kebab-case ≤ 64
  kind: 'provider' | 'agent' | 'skill' | 'tool' | 'mcp' | 'workflow' | 'prompt';
  version: string;               // semver x.y.z of the capability definition (not of a CLI)
  displayName: string;           // ≤ 80
  description: string;           // ≤ 300 (progressive disclosure: only this is shown by default)
  provides: string[];            // feature tags (§4)
  requires: {
    capabilities?: string[];     // other capability ids (+ optional semver range "agent:x@^1.2.0")
    cliVersion?: { executable: 'claude' | 'codex'; range: string };   // OQ-M7-06 subset
    os?: ('win32' | 'darwin' | 'linux')[];
  };
  permissions: Permission[];     // DECLARED (docs/47 §2); the effective set is computed, never trusted from here
  payload: KindPayload;          // §2
  $comment?: string;
}
// Assigned by AI Bridge at registration — NEVER read from the manifest file:
interface RegistryEntry {
  ref: string;                   // "<id>@<version>#<contentHash>"
  source: { type: 'builtin' | 'provider-registry' | 'project-file' | 'user-file' | 'local-directory'; location: string };
  contentHash: string;           // §3
  tier: 'BUILTIN' | 'FIRST_PARTY' | 'USER_LOCAL' | 'THIRD_PARTY' | 'UNTRUSTED';
  lifecycle: 'INSPECTED' | 'EVALUATED' | 'CLASSIFIED' | 'ADAPTED' | 'REGISTERED' | 'DISABLED' | 'REJECTED';
  effectivePermissions: Permission[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  approval: { at: string; via: 'cli' | 'desktop'; contentHash: string; permissionsSha256: string } | null;
  evaluationReport: string | null;   // path to the report (docs/47 §6)
}
```

## 2. Kind payloads

| Kind | Payload (documentation example) | Adapter binding (ADAPT stage) | Notes |
|---|---|---|---|
| `provider` | `{ adapterId: 'claude-code' \| 'codex'; roles: ('executor'\|'reviewer')[]; capabilities: ProviderExecutionCapabilities }` | the EXISTING diagnostics adapter + the EXISTING execution adapter | generated from ProviderRegistry; `capabilities` is the static docs/30 §4.1 matrix per CLI version range |
| `agent` | `{ provider: 'provider:claude-code'; role: 'executor' \| 'reviewer'; profile: string /* execution profile id */; prompts: string[] /* prompt ids */; limits: { maxIterations?: number } ; model?: string /* OQ-M7-09 */ }` | the resolver maps it to (provider, profile, prompts) | ADR-016: a configuration, not a process |
| `skill` | `{ files: { path: string; sha256: string }[]; entry: string /* e.g. SKILL.md */; maxChars: number }` | the step-planner injects the text as a labelled block | carries **no** permissions (docs/29 rule 5) |
| `tool` | `{ provider: string; toolPattern: string /* e.g. "Bash(pnpm test)" */; effect: 'allow' \| 'deny' }` | contributes to a profile's `--allowedTools` / `--disallowedTools` | a declaration only; AI Bridge never invokes tools |
| `mcp` | `{ configFile: { path: string; sha256: string }; servers: { name: string; command: string; argsSha256: string; envKeys: string[] /* never values */ }[] }` | a profile passes `--mcp-config <file> --strict-mcp-config` | AI Bridge never starts the server; the provider does |
| `workflow` | `{ definitionId: string; definitionHash: string }` | the EXISTING definition loader | a definition inherits its registry tier (docs/33 §5) |
| `prompt` | `{ template: { path: string; sha256: string }; variables: string[] }` | the step-planner / reviewer template | BUILTIN prompts only in M7 (OQ) |

## 3. Identity, versioning and content hash

- **Identity**: the `id` is stable across versions. `version` changes when the author changes the
  capability. The **content hash** changes whenever any byte changes.
- **contentHash** = sha256 over the canonical JSON of the manifest (the EXISTING
  `canonical-json.ts` rules) followed, for each referenced file sorted by path, by
  `path \0 sha256(bytes) \n`. The raw bytes are hashed; there is no line-ending normalization, so
  a CRLF change is a change.
- **Pinning**: resolution records `ref = id@version#contentHash`. A later change in the source →
  a new contentHash → the entry drops to tier UNTRUSTED and lifecycle INSPECTED until
  re-approved (ADR-032). Pinned instances then BLOCK with `CAPABILITY_DRIFT` instead of running
  changed content.
- **Versions side by side**: several versions of one id may be REGISTERED; a pin selects one;
  without a pin the highest compatible version wins (§6).

## 4. Feature-tag vocabulary (initial, closed list)

`provides` and step `requires` use only these tags in M7 (adding a tag is an ADR-level change):

| Tag | Meaning | Initial providers |
|---|---|---|
| `execute:file-edit` | can edit project files | `agent:executor-default` |
| `execute:read-only` | executes without edits | (none in M7) |
| `review:read-only` | reviews in a read-only sandbox | `agent:reviewer-readonly` |
| `resume:session` | its executions can be resumed with continuity evidence | Claude, Codex |
| `usage:reported` | reports token usage | Claude, Codex |
| `isolation:mcp-strict` | the profile runs with only declared MCP servers | a profile with `--strict-mcp-config` (after OQ-M7-03) |
| `isolation:settings-project` | the profile loads no user-level settings | a profile with `--setting-sources` (after OQ-M7-03) |
| `tools:no-network-shell` | the profile denies declared network-capable tools | a profile with a deny list |

## 5. Contracts

```ts
interface CapabilitySource {                         // one per source type
  readonly type: RegistryEntry['source']['type'];
  list(): Promise<{ manifest: unknown; location: string; files: string[] }[]>;   // READ ONLY; returns raw data
}
interface CapabilityInspector {                      // static; never executes anything (ADR-035)
  inspect(candidate: { manifest: unknown; location: string; files: string[] }): Promise<InspectionResult>;
}
interface CapabilityPolicy {                         // pure
  tierFor(source: RegistryEntry['source']): RegistryEntry['tier'];
  effective(declared: Permission[], tier: RegistryEntry['tier'], approved: Permission[] | null): Permission[];
  risk(effective: Permission[]): RegistryEntry['risk'];
}
interface CapabilityRegistry {
  list(filter?: { kind?: string; lifecycle?: string }): Promise<RegistryEntry[]>;
  get(ref: string): Promise<{ entry: RegistryEntry; manifest: CapabilityManifest } | null>;
  // Mutations are host actions only (CLI command / Main after a native confirmation):
  register(inspectionId: string, approval: HostApproval): Promise<RegistryEntry>;
  disable(ref: string, reason: string, by: HostApproval): Promise<void>;
}
interface CapabilityResolver {                       // pure over a registry snapshot
  resolve(step: StepRequirements, snapshot: RegistrySnapshot, providerStatus: ProviderStatusSnapshot): ResolutionResult;
}
interface StepRequirements { role: 'executor' | 'reviewer'; requires: string[]; pin?: string; skills?: string[] }
type ResolutionResult =
  | { ok: true; agent: string /* ref */; provider: string; profile: ExecutionProfileRef; skills: string[]; prompts: string[] }
  | { ok: false; code: 'CAPABILITY_UNRESOLVED' | 'CAPABILITY_DISABLED' | 'CAPABILITY_UNTRUSTED' | 'PROVIDER_NOT_READY' | 'INCOMPATIBLE'; detail: string };
interface ExecutionProfileRef { id: string; version: string; flagsSha256: string }
```

Why each exists: sources separate *where* from *what*; the inspector is the only reader of
untrusted content; policy and resolver are pure so they can be table-tested (like the decider);
registry mutations are host actions so that neither an engine nor the renderer can grant trust.

## 6. Resolution algorithm (pure, deterministic; ADR-033)

1. Candidates = entries with lifecycle REGISTERED, tier ≠ UNTRUSTED, kind `agent`, role match.
2. Drop candidates whose `provides` ⊉ `requires`, whose `requires.os/cliVersion` doesn't match the
   provider status, or whose provider status is not READY (the EXISTING statuses).
3. If `pin` is set: exactly that ref must survive, else `CAPABILITY_UNRESOLVED` (never a
   substitute).
4. Otherwise order by tier (BUILTIN > FIRST_PARTY > USER_LOCAL > THIRD_PARTY), then the highest
   version, then the lexical id. Take the first. A tie in the first two keys → a warning event.
5. Skills: each listed id must resolve exactly (pinned by the definition); unlisted skills are
   **never** added.
6. The result + the registry snapshot hash are recorded. The instance pins it at `START`; every
   later attempt (including retries) reuses the pinned result.

No step without explicit M7 fields ever resolves to anything but the constant BUILTIN agents.

## 7. Definition additions (schema 1, additive, ADR-022)

```jsonc
"executor": { "role": "executor", "maxIterations": 10,
              "requires": ["execute:file-edit", "isolation:mcp-strict"],   // EXISTING reserved field
              "agent": "agent:executor-tests@1.2.0" },                    // NEW optional pin
"context":  { "skills": ["skill:repo-test-guide@1.0.0"] },               // NEW optional, ≤ 5
"verification": { "reviewer": { "agent": "agent:reviewer-security@1" } } // NEW optional (M6 ReviewPort)
```

## 8. Registry index (persistence summary; details in docs/47 §8)

```jsonc
// .ai-bridge/capabilities/index.json  (AtomicJsonWriter; a snapshot, derived from the audit log)
{ "schema": 1, "snapshotSha256": "…", "entries": [ /* RegistryEntry[] */ ] }
```

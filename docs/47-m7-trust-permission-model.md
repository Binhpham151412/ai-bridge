# 47 — M7 Trust, Permissions, Lifecycle, Persistence and Recovery (PROPOSED — documentation only)

Covers items 8–13 of the M7 definition (docs/45 §0). Extends docs/33. Status legend: see docs/41.

## 1. Trust tiers (ADR-032; docs/28 §3.3 kept, rules made explicit)

| Tier | Assigned when the source is | Default state after registration | Maximum permissions |
|---|---|---|---|
| BUILTIN | compiled into AI Bridge (agents `executor-default`, `reviewer-readonly`, BUILTIN prompts) | enabled | as designed |
| FIRST_PARTY | the official Claude Code / Codex CLIs discovered by the EXISTING discovery | enabled once doctor passes | executor: `fs.write` project (excl. `.git/**`, `.ai-bridge/**`); reviewer: read-only |
| USER_LOCAL | a file the user created under the project's `.ai-bridge/capabilities/` or in app userData | **disabled until approved** | no `network`; `process.exec` only for listed commands; `provider.invoke` only with a vetted profile |
| THIRD_PARTY | a `local-directory` inspection (a repository the user acquired), or a file copied from one (its provenance stays recorded) | **disabled** | the most restrictive profile; its text always labelled untrusted |
| UNTRUSTED | a failed evaluation, **or** any content-hash change since approval | cannot be enabled until re-inspected and re-approved | none |

Rules: (1) a tier is never read from a manifest; (2) copying a THIRD_PARTY file into the project
does not upgrade it (the inspector keeps the origin in the evaluation report, and the user must
re-approve it explicitly as USER_LOCAL); (3) a hash change always drops the tier to UNTRUSTED;
(4) a tier can only go down automatically, never up.

## 2. Permissions (extends docs/33 §4)

```ts
type Permission =
  | { kind: 'fs.read'; scope: 'project' }
  | { kind: 'fs.write'; scope: 'project'; exclude: string[] }                  // always ⊇ ['.git/**', '.ai-bridge/**']
  | { kind: 'process.exec'; commands: { executable: string; args: string[] }[] }  // M6 verification checks
  | { kind: 'provider.invoke'; provider: string; role: 'executor' | 'reviewer'; profile: string }
  | { kind: 'tool.allow' | 'tool.deny'; provider: string; patterns: string[] }  // CLI tool patterns
  | { kind: 'mcp.load'; configSha256: string; servers: string[] }              // only via --strict-mcp-config
  | { kind: 'network'; hosts: string[] }                                        // never granted to USER_LOCAL/THIRD_PARTY by default
  | { kind: 'memory.read'; keys: string[] } | { kind: 'memory.propose' };       // M8
```

**Effective permissions** = declared ∩ tier maximum ∩ approved. The intersection is computed by
the pure `CapabilityPolicy`. A declared permission above the tier maximum is **dropped and
reported**, never granted.

## 3. Risk classes (initial table; OQ-M7-08)

| Risk | Any of | Approval depth |
|---|---|---|
| CRITICAL | `network` to any host; `process.exec` of an interpreter; `fs.write` without the mandatory excludes; `mcp.load` of a server whose command is a shell | cannot be approved in M7 |
| HIGH | `mcp.load` (any); `tool.allow` of `Bash(*)`-like broad patterns; `process.exec` | per-permission confirmation listing each item |
| MEDIUM | `provider.invoke` with a non-default profile; `tool.allow` of narrow patterns | one confirmation with the permission diff |
| LOW | text-only kinds (`skill`, `prompt`) with no permissions; `tool.deny` | one confirmation |

## 4. Lifecycle state machine (docs/28 §3.2 stages, formalized)

```
            (source lists a candidate)
                 │
                 ▼
   ┌────────► INSPECTED ──evaluate──► EVALUATED ──classify──► CLASSIFIED ──adapt──► ADAPTED ──approve──► REGISTERED
   │             │                        │                                      │                    │   ▲
   │             └── parse error ─────────┴──► REJECTED ◄── unsupported kind ────┘                    │   │ enable
   │                                              (terminal until the content changes)       disable  ▼   │
   │                                                                                               DISABLED
   └──────────── any content-hash change (from ANY state, incl. REGISTERED/DISABLED) ───────────────────┘
                 → tier UNTRUSTED, pinned instances BLOCK with CAPABILITY_DRIFT
```

| Transition | Automatic? | Recorded event |
|---|---|---|
| → INSPECTED | yes (read-only) | `CAPABILITY_INSPECTED {ref, source, fileCount}` |
| INSPECTED → EVALUATED / REJECTED | the checks are automatic; a THIRD_PARTY evaluation requires the human to open the report | `CAPABILITY_EVALUATED {ref, risk, findings}` |
| EVALUATED → CLASSIFIED | yes (pure policy) | `CAPABILITY_CLASSIFIED {ref, tier, effectiveSha256}` |
| CLASSIFIED → ADAPTED | yes, only for kinds with an adapter binding | `CAPABILITY_ADAPTED {ref, binding}` |
| ADAPTED → REGISTERED | **human** for tiers below FIRST_PARTY; automatic for BUILTIN/FIRST_PARTY | `CAPABILITY_REGISTERED {ref, approval}` |
| REGISTERED ⇄ DISABLED | human | `CAPABILITY_DISABLED` / `CAPABILITY_ENABLED` |
| any → INSPECTED (hash drift) | yes | `CAPABILITY_DRIFTED {ref, oldHash, newHash}` |

## 5. Approvals (hash-pinned, host-owned; the ADR-026 pattern)

- An approval binds `(ref, contentHash, effectivePermissionsSha256)`.
- It is obtained only through a **host-owned confirmation**: the interactive CLI prompt, or
  Electron Main's native dialog that lists the permissions **Main computed**. The renderer can
  request but never grant.
- Diff-only: when a new version of an approved id arrives, only the added permissions, commands
  and MCP servers are shown.
- Revocation = DISABLED (audited). Running instances pinned to it BLOCK at their next resolution
  check (the next attempt start); a live execution is not killed.

## 6. External repositories (GitHub or any other source) — evaluation before registration (ADR-035)

1. **Acquisition is the user's action.** The user clones or downloads the repository. AI Bridge
   never fetches, clones, pulls or updates it.
2. **Inspect as data.** `ai-bridge capability inspect <local-dir>` reads files only: at most 2 000
   files and 20 MB in total; symlinks not followed out of the directory; binaries hashed, not
   parsed.
3. **Detect kinds**: AI Bridge manifests; Claude Code skill folders (`SKILL.md` with front matter
   → kind `skill`); MCP config JSON (→ kind `mcp`, recording commands and env **keys** only);
   workflow definitions (→ kind `workflow`, validated with the EXISTING validator). Everything
   else is ignored and listed as "not registrable".
4. **Static findings** (informational, never an execution): executables and scripts; package
   manifests with install hooks (`preinstall`/`postinstall`); shell interpreters as MCP commands;
   URLs/hosts referenced by MCP configs; instructions in skill text that conflict with the profile
   (e.g. "use --dangerously-…"); license file presence; files that are too large or too many.
5. **Evaluation report** (`capabilities/evaluations/<ref>.json`): the detected candidates, the
   findings, the computed tier (THIRD_PARTY), the effective permissions and the risk.
6. **Human decision** per candidate (never per repository in bulk). CRITICAL cannot be approved.
   Approval → REGISTERED **but disabled** until explicitly enabled (THIRD_PARTY default).
7. **Any later change** of the directory → drift → UNTRUSTED (§4).

## 7. Execution profiles and CLI flags (ADR-034)

An agent's permission profile becomes flags **only through a vetted mapping table** held in
BridgeEngine's adapters, never through free-form arguments. **Allowed** (after the M7.0 behavior
verification of the ✱ rows; OQ-M7-03 … 07):

| Profile element | Claude Code flag | Codex flag | Status |
|---|---|---|---|
| permission mode | `--permission-mode acceptEdits` (EXISTING allowlist) | `-s read-only` (EXISTING) | EXISTING |
| tool allow/deny | `--allowedTools`, `--disallowedTools` (the adapter already supports them) | — | PROPOSED |
| built-in tool set | `--tools <list>` ✱ | — | PROPOSED |
| MCP isolation | `--strict-mcp-config` + `--mcp-config <AI Bridge-written file listing only registered servers>` ✱ | — | PROPOSED |
| settings isolation | `--setting-sources project` (or `project,local`) ✱ | `--ignore-user-config`, `--ignore-rules` ✱ | PROPOSED |
| skills off | `--disable-slash-commands` ✱ | — | PROPOSED |
| model pin (agent field) | `--model <id>` ✱ (OQ-M7-09) | `-m <id>` ✱ | PROPOSED |

**Forbidden, in any profile, enforced inside BridgeEngine** (an additive check next to the
EXISTING permission-mode allowlist): `--permission-mode bypassPermissions`,
`--dangerously-skip-permissions`, `--bare` (EXISTING rule), `--plugin-url` (network fetch),
`--plugin-dir` (unregistered code), `--agents <json>` (unregistered sub-agents), `--add-dir`
(widens filesystem scope), `--settings` (could introduce `apiKeyHelper`, i.e. API billing),
`--system-prompt` (would replace the report contract), Codex
`--dangerously-bypass-approvals-and-sandbox`, `-c` with any key outside a vetted list, and
`--ephemeral` for resumable roles (it would break resume).

Resume rule: the profile is persisted with the run (like `maxIterations` and `correlation`), and
`resume()` must reuse it exactly. A resume with a different profile is refused.

## 8. Persistence model

```
<project>/.ai-bridge/capabilities/
  index.json                          snapshot of RegistryEntry[] (AtomicJsonWriter)
  registry.log.jsonl                  append-only, hash-chained audit (the source for index.json)
  manifests/<kind>/<name>@<version>.json   copies of inspected manifests (content-addressed by the hash)
  evaluations/<kind>-<name>@<version>-<hash12>.json   evaluation reports
  mcp/<profile>-<hash12>.json         MCP config files that AI Bridge writes for --mcp-config (derived)
app userData/capabilities/            the same layout for the global scope (OQ-M7-01 precedence)
workflows/instances/<id>/resolution.json   the pinned resolution of the instance (per step), hash in WORKFLOW events
attempts/<step>-<n>/…                 attempt record field `capabilities: {agent, provider, profile, skills, isolation}`
```

Write order: `registry.log.jsonl` append → `index.json` rewrite. On load, a torn last log line is
truncated (the EXISTING event-log rule), and `index.json` is rebuilt from the log if their hashes
disagree.

## 9. Event model

- **Registry log** (per scope): the `CAPABILITY_*` events of §4 in the docs/27 envelope style
  (`seq`, `prevHash`, `hash`, `actor: 'human' | 'system'`, `payload`).
- **Workflow events** (new types, ADR-023): `CAPABILITIES_RESOLVED {stepId, agentRef, profileRef,
  skills[], snapshotSha256}` once at START per step; `CAPABILITY_BLOCKED {stepId, code}` on drift
  or unresolvable. Execution records gain the optional `profile` ref (additive).

## 10. Recovery model

| Situation | Handling |
|---|---|
| Crash during a registry mutation | The log is the truth; `index.json` is rebuilt; a half-written manifest copy is rejected by its hash |
| Crash between resolution and START | The resolution is part of the same decider batch as `START`, so it is either durable with START or absent |
| Resume after a restart | The pinned resolution is reused; if any pinned ref drifted → BLOCKED (`CAPABILITY_DRIFT`); never re-resolved silently |
| An execution interrupted mid-run | EXISTING recovery; `resume()` reuses the persisted profile |
| A registry file deleted by the user | Resolution fails closed (`CAPABILITY_UNRESOLVED`); pinned instances BLOCK |

## 11. Security boundaries

- Only the inspector reads candidate content, and only as data (no `require`, no `eval`, no spawn).
- Skill and prompt text enters prompts only as labelled, untrusted data blocks (the EXISTING
  pattern) with the provenance ref. A skill cannot change flags or permissions.
- MCP servers are started only by the provider, and only those listed in the AI Bridge-written
  `--mcp-config` file under `--strict-mcp-config`. AI Bridge never starts them.
- Flag construction happens only in BridgeEngine's adapters from a profile id, never from
  definition text or the renderer.
- Approvals: host-owned, hash-pinned, diff-only, audited.
- Unverified isolation is labelled `UNVERIFIED`, never shown as enforced.

## 12. Hard limits

| Limit | Value |
|---|---|
| registered entries per scope | 500 |
| manifest size | 64 KB |
| files per capability / bytes per capability | 200 / 5 MB |
| inspection per directory | 2 000 files / 20 MB / symlinks not followed out |
| skills per step | 5; skill text per step ≤ 32 KB (inside the 256 KB task cap) |
| MCP servers per profile | 10 |
| tool patterns per profile | 100 |
| profile flag string (the sha256 input) | 8 KB |
| versions of one id kept REGISTERED | 10 |

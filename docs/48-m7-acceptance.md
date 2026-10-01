# 48 — M7 Capability Registry: Hosts, UI, Testing, Real E2E, Failure Modes, Increments, Acceptance (PROPOSED)

Covers items 14–19 and 25 of the M7 definition (docs/45 §0). Status legend: see docs/41.

## 1. CLI implications (item 14)

| Command | Behavior |
|---|---|
| `ai-bridge capability list [--kind] [--scope project\|global]` | entries with ref, tier, lifecycle, risk |
| `ai-bridge capability inspect <path>` | static inspection of a file or a user-acquired directory (docs/47 §6); writes an evaluation report; **registers nothing** |
| `ai-bridge capability show <ref>` | the manifest, effective permissions and the evaluation findings |
| `ai-bridge capability approve <ref> [--hash <contentHash>]` | interactive confirmation of the permission diff; CRITICAL refused; `--hash` must match |
| `ai-bridge capability enable\|disable <ref>` | audited |
| `ai-bridge workflow validate` (EXISTING) | adds the resolution preview per step (which agent, profile, skills), without executing |

The CLI never downloads anything and never edits a provider's global configuration.

## 2. Electron / Main implications (item 15)

- A new `CapabilityController` in Main (a sibling of WorkflowController; no orchestration logic).
- New IPC channels (the EXISTING pattern): `capability:list`, `capability:get {ref}`,
  `capability:inspect` — this one opens Main's **native folder picker**, so the renderer never
  sends a path (the EXISTING `bridge:selectProject` pattern) — `capability:approve {ref,
  contentHash}` (Main shows a native dialog with the permissions *it* computed),
  `capability:setEnabled {ref, enabled}`.
- The quit rules are unchanged. Registry mutations are atomic and quick; they are not "live work".

## 3. Renderer / UI implications (item 16)

- A **Capabilities** view (a new nav entry): entries grouped by kind, tier badge, lifecycle,
  risk, and an "UNVERIFIED isolation" badge where it applies.
- An evaluation report view: findings, the permission diff, the source path. Approve and enable
  are buttons that call Main (and the native confirmation follows).
- Workflow view: each attempt shows its resolved agent, profile and skills refs (from the attempt
  record), and "constant resolver" for M5/M6 attempts.
- Pure consumer: the renderer never computes tiers, risks or effective permissions.

## 4. Testing strategy (item 17)

| Area | Tests |
|---|---|
| Manifest validator | every field, caps, unknown fields rejected, per-kind payloads |
| Content hash | stable under key order; changes on any byte (incl. CRLF); file order independence |
| Policy | declared ∩ tier max ∩ approval for every tier × permission kind; drops reported |
| Risk | the table of docs/47 §3, row by row |
| Lifecycle | every valid/invalid transition; drift from every state |
| Resolver | pins, ties, incompatibility, provider not ready, disabled/untrusted candidates; determinism (the same snapshot → the same result, 1 000 randomized orders) |
| Constant resolver | **argv byte-identical to M5/M6** for the BUILTIN agents (a regression guard) |
| Profiles | every allowed flag mapping; every forbidden flag refused inside BridgeEngine (incl. crafted manifests); resume refuses a different profile |
| Inspector | hostile directories: symlink escapes, 10 000 files, huge files, install hooks, shell MCP commands; nothing executed (spawn is mocked to throw) |
| Hosts / IPC | payload validation; the renderer cannot pass paths or permissions; the native confirmation is required |
| Replay | M5/M6 golden logs still replay identically (ADR-021) |

## 5. Real E2E strategy (item 18; quota — explicit approval)

| Scenario | Must show |
|---|---|
| C1 constant resolver | an M6 workflow runs unchanged under M7; the argv recorded in the execution records equals M6's |
| C2 MCP isolation | a user-global MCP server configured on the machine; a workflow with `isolation:mcp-strict` → the execution's evidence (the init event if reported, OQ-M7-05) shows no user MCP server; otherwise the attempt record says `UNVERIFIED` |
| C3 tool deny | a profile denying `Bash(curl *)`-like patterns; a task that asks for it → the provider refuses (recorded honestly; a model may simply comply with the instruction not to) |
| C4 third-party skill | a user-cloned repository with a `SKILL.md` → inspect → THIRD_PARTY, disabled → approve + enable → a step with `context.skills` → the task.md has a labelled untrusted block + ref |
| C5 drift | edit an approved skill file → the next attempt BLOCKS with CAPABILITY_DRIFT |

## 6. Failure modes (item 19)

| Failure | Result |
|---|---|
| A capability changed after approval | UNTRUSTED; pinned instances BLOCK (`CAPABILITY_DRIFT`) |
| No candidate satisfies the requirements | BLOCKED `CAPABILITY_UNRESOLVED` before any execution |
| Provider installed but not authenticated | `PROVIDER_NOT_READY` with the EXISTING status reason |
| An isolation flag is not supported by the installed CLI version | the version range excludes the profile → unresolved (never a silent fallback to no isolation) |
| An inspection of a hostile directory | caps hit → REJECTED with findings; nothing executed |
| Registry index corrupted | rebuilt from `registry.log.jsonl`; a broken chain → read-only, resolution blocked |
| A forbidden flag smuggled via a manifest | refused by BridgeEngine's check; the step fails (INVALID_OPTIONS class) |

## 7. Implementation increments (M7.0 – M7.9)

| Inc. | Objective | Depends on |
|---|---|---|
| **M7.0** | Decision closure (ADR-031 … 035) + **behavior verification** of the isolation flags on the installed CLIs (zero-quota where possible; otherwise a minimal approved real run) | M6 release |
| **M7.1** | Manifest v1 validator, content hash, feature tags, policy, risk (all pure) | M7.0 (it can be *developed* in parallel with M6.4+; merged after the M6 release) |
| **M7.2** | Registry store + audit log + lifecycle machine | M7.1 |
| **M7.3** | Sources: builtin, ProviderRegistry wrapper, project/user files | M7.2 |
| **M7.4** | Inspector for local directories (static) + evaluation reports | M7.2 |
| **M7.5** | Resolver + definition fields + decider `RESOLVE_CAPABILITIES` + pinned resolution | M7.3 |
| **M7.6** | Execution profiles: the additive BridgeEngine `profile` + the flag mapping + forbidden flags (an isolated commit, full regression) | M7.5, M7.0 verification |
| **M7.7** | Skills as labelled context in the step-planner | M7.5 |
| **M7.8** | CLI + desktop + UI | M7.4–M7.7 |
| **M7.9** | Real E2E (§5) + release audit | all |

## 8. Acceptance criteria (item 25)

| ID | Criterion |
|---|---|
| AC-M7-01 | A definition without M7 fields produces byte-identical provider argv and an identical outcome to M6 |
| AC-M7-02 | Nothing is loaded unless a step selects it; a test enumerating all flags of every M7 execution shows only resolved capabilities |
| AC-M7-03 | Tiers are assigned by source only; a hash change always yields UNTRUSTED; tiers never rise automatically |
| AC-M7-04 | Effective permissions never exceed the tier maximum; CRITICAL can't be approved |
| AC-M7-05 | Resolution is deterministic, pinned at START, reused by retries, and drift blocks |
| AC-M7-06 | Every forbidden flag is refused inside BridgeEngine regardless of the source |
| AC-M7-07 | Inspection never executes, fetches or installs anything (proven by a spawn/network-throwing test harness) |
| AC-M7-08 | Approvals require a host-owned confirmation; the renderer cannot grant, pass paths or permissions |
| AC-M7-09 | Isolation claims shown in the UI are either verified by recorded evidence or labelled UNVERIFIED |
| AC-M7-10 | The registry audit log verifies (hash chain) and rebuilds `index.json` |
| AC-M7-11 | Real E2E C1, C4, C5 pass; C2/C3 recorded honestly |
| AC-M7-12 | The full regression is green; M5/M6 golden logs replay identically; no M8/M9 feature implemented |

## 9. M7.0 entry gate (READY FOR IMPLEMENTATION, M7)

- [ ] M6 released (AC-M6 all met, committed)
- [ ] ADR-031 … ADR-035 ACCEPTED
- [ ] The isolation-flag behavior is verified on the installed CLI versions (OQ-M7-03/04/05/07), with results recorded
- [ ] OQ-M7-01 and OQ-M7-02 answered
- [ ] A security review entry for E21/E22 in docs/33 (the docs/37 §4 rule)

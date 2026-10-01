# 58 — Cross-Phase ADR Index and Open-Question Register (M6–M9)

**docs/38 stays the authoritative register** of accepted decisions (ADR-001 … ADR-020). This
document lists them for reference and defines the **PROPOSED** ADR-021 … ADR-045. None of the
new ADRs is accepted. Each becomes ACCEPTED only when its phase's `.0` decision closure records
it in docs/38 (the M5.0 procedure).

## 1. Accepted ADRs (reference; the text is in docs/38)

| ADR | Decision | Status |
|---|---|---|
| 001 | The Workflow Engine sits above BridgeEngine | ACCEPTED (M5.0) |
| 002 | Workflow state separate from execution state | ACCEPTED (M5.0) |
| 003 | Verification separate from execution; DONE is a claim | ACCEPTED (M5.0) |
| 004 | Provider-agnostic upper layers; concrete execution until M9 | ACCEPTED (M5.0) |
| 005 | Capabilities are task-selected, deterministically resolved | ACCEPTED (M5.0) |
| 006 | Memory is optional (Null port; human-promoted writes) | ACCEPTED (M5.0) |
| 007 | AI interactions are auditable | ACCEPTED (M5.0) |
| 008 | Local-first file storage, no database | ACCEPTED (M5.0) |
| 009 | Bounded loops with nested hard caps | ACCEPTED (M5.0) |
| 010 | The UI does not own orchestration | ACCEPTED (M5.0) |
| 011 | Separate Workflow Host + per-execution Execution Host (+ lifetime addendum M5.8.1) | ACCEPTED (M5.0) |
| 012 | Retry = new execution; resume = same execution | ACCEPTED (M5.0) |
| 013 | JSON definitions, no expression language (schema v2 for parallelism) | ACCEPTED (M5.0) |
| 014 | Execution files are the source of truth for execution outcomes | ACCEPTED (M5.0) |
| 015 | The Reviewer is evidence, not authority | ACCEPTED (M5.0) |
| 016 | Agents are configurations, not processes | ACCEPTED (M5.0) |
| 017 | Attempt ↔ run correlation (`correlation`, option B) | ACCEPTED (M5.0) |
| 018 | Definitions in `<project>/.ai-bridge/workflows/definitions/` | ACCEPTED (M5.0) |
| 019 | Shared `reports/` kept as-is in M5 | ACCEPTED (M5.0) |
| 020 | M5 scope lock | ACCEPTED (M5.0) |

## 2. Proposed ADRs

### Cross-phase

#### ADR-021 — Decider replay compatibility across versions
- **Status:** PROPOSED (for M6.0)
- **Context:** The store re-derives snapshots by replaying logged inputs through the decider and
  checks that each batch equals the logged one (M5.3). Every later phase changes the decider.
- **Decision:** Every decider change must replay **all** existing logs (fixtures + a captured real
  corpus) byte-identically. New behavior is reachable only through new inputs or definition values
  that older logs cannot contain. A change that alters an existing input's outcome is forbidden;
  it would require a new instance schema with a documented migration.
- **Alternatives:** Version the decider per instance (`deciderVersion`) and keep old deciders.
  Rejected: several decider copies, harder to test. Drop replay verification: rejected, because it
  loses the M5.3 crash repair.
- **Consequences:** A golden-replay suite becomes a standing gate. Some refactors are harder;
  determinism and auditability are preserved.

#### ADR-022 — Definition schema evolution
- **Status:** PROPOSED (for M6.0)
- **Context:** M5 reserved fields for M6–M8. Later phases also need new field names (`criteria`,
  `agent`, `skills`, `context.graph`). M9 needs structural changes. ADR-013 already says
  "parallelism requires schema v2".
- **Decision:** Additive fields (reserved fields gaining meaning, plus new optional names) stay in
  **schema 1**. The validator of each phase accepts them; older builds reject them with
  `RESERVED_FEATURE` or `UNKNOWN_FIELD` (fail closed). **Schema 2** is reserved for structural
  changes (M9 parallel groups). Every build accepts schema 1 forever.
- **Alternatives:** Bump the schema per phase (rejected: churn, no safety gain, since older builds
  already fail closed). A capability-flag field (rejected: an expression-like mechanism).
- **Consequences:** A schema-1 definition's hash never changes meaning. Users see a clear
  "reserved for Mx" error on older builds.

#### ADR-023 — Event and input vocabulary evolution; no downgrade
- **Status:** PROPOSED (for M6.0)
- **Context:** `event-log.ts` rejects unknown event types, and replay rejects unknown inputs. M6
  can use reserved types; M7–M9 need new ones.
- **Decision:** `WORKFLOW_EVENT_TYPES` and the input types are **append-only**. Nothing is renamed
  or removed. An older build that meets a newer type marks the instance BROKEN/read-only (the
  EXISTING behavior). Downgrading instances is **not supported**; no data is lost.
- **Alternatives:** Tolerate unknown types in older readers (rejected: breaks the integrity rule,
  and replay would silently skip decisions).
- **Consequences:** Release notes must state the minimum version per instance. The UI of an older
  build shows such instances as unreadable, not as corrupt data.

### M6 — Verification

#### ADR-024 — Verdict and evidence-level semantics
- **Status:** PROPOSED (M6.0)
- **Context:** docs/24 defines PASS/FAIL/NEEDS_HUMAN and VERIFIED/AI_ATTESTED/NONE. The request
  adds UNKNOWN and needs precise rules for ERROR, `acceptAiOnly` and `acceptMaxIterationsOutcome`.
- **Decision:** docs/42 §6. VERIFIED iff PASS ∧ ≥ 1 required deterministic check PASS ∧ no required
  FAIL/ERROR ∧ quiescence. AI_ATTESTED only with zero required checks and `acceptAiOnly`. UNKNOWN
  is internal only and resolves to a re-run, then NEEDS_HUMAN, **never PASS**. A required ERROR is
  a FAIL, classed as TIMEOUT or ENVIRONMENT. Reviews and humans can only remove a PASS.
- **Alternatives:** Treat ERROR as SKIPPED (rejected: fail-open). Let a reviewer APPROVE lift
  AI_ATTESTED to VERIFIED (rejected: ADR-015). Add HUMAN_ACCEPTED now (deferred, OQ-M6-07).
- **Consequences:** Honest labels. Steps without required checks can never show "verified".

#### ADR-025 — Where and how deterministic checks run
- **Status:** PROPOSED (M6.0)
- **Context:** Checks are commands; the Workflow Host must survive and stop them; Windows
  lifetimes are subtle (M5.8.1).
- **Decision:** The Workflow Host spawns checks through `runProcess`: sequentially, no shell,
  refused interpreters, cwd = project, required timeout, capped and redacted output, tree kill,
  `with-parent` lifetime. The pid + creation time is recorded before a check can outlive a crash.
  Checks never run in Main, in an Execution Host, or in parallel.
- **Alternatives:** A dedicated verification host process (rejected: no added isolation, one more
  lifetime to reconcile). Running checks inside the execution's host (rejected: mixes execution
  and verification, ADR-003).
- **Consequences:** A Workflow Host crash kills direct check children. Grandchildren of non-Node
  intermediates may survive, so recovery reaps by identity (ADR-030).

#### ADR-026 — Command-check approval
- **Status:** PROPOSED (M6.0)
- **Context:** Check commands come from project files the executor can influence; running them is
  arbitrary code execution by design.
- **Decision:** A command check runs only with an approval pinned to `(definitionId,
  definitionHash)` and the exact command list. Approval is granted only by a host-owned
  confirmation (the interactive CLI, or Main's native dialog listing commands read from disk). It
  is audited in a hash-chained log. Starting an unapproved definition is refused and creates
  nothing.
- **Alternatives:** Approve inside the renderer (rejected: a renderer compromise could approve).
  Allow unapproved USER_LOCAL commands (rejected: docs/33 §5).
- **Consequences:** A one-time friction per definition version. Approvals become M7's
  `process.exec` permission.

#### ADR-027 — Step-level Reviewer through a review-only execution mode (R2)
- **Status:** PROPOSED (M6.0; its implementation is gated separately at M6.3)
- **Context:** docs/25 §3.3 options R1/R2/R3. R1 (reuse the inner verdict) would double-count the
  execution claim. R3 duplicates execution wiring. The workflow layer may not spawn CLIs (ADR-001).
- **Decision:** Add **one additive BridgeEngine API**, `review({input, correlation})`. It runs Codex
  once, read-only, under the run lock, with the EXISTING execution record, redaction, cost guard and
  forbidden-flag checks, a minted runId, and correlation `<attemptId>/review/<n>`. It is invoked by
  the Verification Engine through `ReviewPort` in an `independent` Execution Host. The digest
  guard, the fail-closed parser and the citation check are mandatory. If this ADR is rejected,
  `requireReviewer` stays reserved.
- **Alternatives:** R1 (rejected, see Context). R3 (rejected in docs/25). Reusing `start()` with a
  review task (rejected: it would run Claude with edit rights).
- **Consequences:** Session-history and the M4 UI must tolerate review runs (a run kind). One
  extra provider call per reviewed attempt.

#### ADR-028 — Semantic retry policy
- **Status:** PROPOSED (M6.0)
- **Context:** docs/26 §3–§4 define classes, caps and stuck detection. M6 must make them normative.
- **Decision:** `maxAttempts` 1..5 (required field). Retry only for retryable or opted-in classes
  (docs/42 V7). QUOTA, INTEGRITY, COST_GUARD, CONTRACT_ANOMALY and UNKNOWN are never retried.
  CHECK_ENVIRONMENT → WAIT_HUMAN. Stuck → WAIT_HUMAN. Each retry is a new attempt and a new
  execution with an evidence-augmented task (failure summary, labelled reviewer suggestion,
  workspace state). The previous session is never continued and the tree is not reset. Infra
  backoff (3×) does not consume attempts.
- **Alternatives:** Continue the same Claude session (rejected, ADR-012). Reset the tree between
  attempts (deferred: OQ-M6-01, a git mutation).
- **Consequences:** Predictable cost ceilings. Retries see the previous attempt's tree state,
  and the prompt says so.

#### ADR-029 — Read-only workspace evidence; no git mutation through M8
- **Status:** PROPOSED (M6.0)
- **Context:** Checks, tamper detection and the retry context need git facts. The docs/39 M5.5 plan
  was not implemented. Git mutation changes the user's repository.
- **Decision:** A WorkspaceProbe reads HEAD, the porcelain digest, changed paths and per-path
  hashes via `runProcess` (read-only git commands only). AI Bridge performs **no git mutation**
  in M6–M8. M9's mutation is governed by ADR-044.
- **Alternatives:** Checkpoint commits/stashes per attempt (deferred, OQ-M6-01).
- **Consequences:** No rollback between attempts. Evidence-only workspace tracking.

#### ADR-030 — Verification recovery
- **Status:** PROPOSED (M6.0)
- **Context:** Verification can be interrupted in any sub-state (docs/43 §1.2). Checks are
  idempotent by rule; reviews cost quota.
- **Decision:** docs/43 §4. Reap recorded check processes by (pid, creation time); discard partial
  evidence (recorded); re-run verification (at most 2 automatic runs). Adopt a DECIDED record
  whose event is missing. Find reviews by correlation (WATCH/ADOPT; re-run once). REJECTED +
  retry intent are one batch.
- **Alternatives:** Resume verification mid-way (rejected: partial evidence is unsafe to combine).
- **Consequences:** Occasionally repeated checks. Never a duplicate execution.

### M7 — Capability Registry

#### ADR-031 — Capability manifest v1, identity and content-hash pinning
- **Status:** PROPOSED (M7.0)
- **Context:** docs/28 §3.1 sketch; selection and audits need exact identities.
- **Decision:** docs/46. `id = <kind>:<name>`, `ref = id@version#contentHash`; the content hash is
  over the canonical manifest + referenced file hashes (raw bytes). Tier, lifecycle and approvals
  are registry-assigned, never read from the manifest.
- **Alternatives:** Version-only identity (rejected: silent content changes).
- **Consequences:** Any byte change requires re-approval (ADR-032).

#### ADR-032 — Trust tiers assigned by source; hash drift → UNTRUSTED
- **Status:** PROPOSED (M7.0)
- **Context:** docs/28 §3.3, docs/33 §6 proposals.
- **Decision:** docs/47 §1. Five tiers; the tier comes from the source; THIRD_PARTY is disabled by
  default; a hash change drops the tier to UNTRUSTED and blocks pinned instances; tiers never rise
  automatically.
- **Alternatives:** Self-declared trust (rejected). Signature-based trust (out of scope, docs/33 §13).
- **Consequences:** Copying third-party content requires an explicit re-approval.

#### ADR-033 — Explicit, deterministic capability selection; nothing auto-loads
- **Status:** PROPOSED (M7.0)
- **Context:** The request requires no automatic loading; ADR-005 requires task-driven selection.
- **Decision:** docs/46 §6. Steps declare requirements, pins and skill lists. A pure resolver
  decides deterministically. The resolution is pinned per instance at START and reused by retries.
  Anything not selected is not passed to the provider. Without M7 fields, the constant BUILTIN
  resolver reproduces M6 exactly.
- **Alternatives:** Registry-wide defaults that auto-attach skills/MCP (rejected). An LLM choosing
  (rejected, ADR-005).
- **Consequences:** Definitions are more explicit; runs are reproducible.

#### ADR-034 — Execution profiles as an additive start option; forbidden flags
- **Status:** PROPOSED (M7.0; implementation after the flag-behavior verification)
- **Context:** Controlling the provider's tools, MCP servers, settings and skills requires CLI
  flags. The installed CLIs list suitable flags (docs/45 §3), with unverified behavior.
- **Decision:** An optional `profile` on `BridgeStartOptions` / `HostCommand.start` / `review`,
  persisted with the run and reused by `resume()`. Adapters map a profile id to a vetted flag set
  (docs/47 §7). BridgeEngine refuses the forbidden flags regardless of source. Isolation that is
  not verified is labelled UNVERIFIED.
- **Alternatives:** Pass free-form args from manifests (rejected). Edit the user's global CLI
  configuration (rejected).
- **Consequences:** The second additive BridgeEngine change after ADR-017. Profiles are
  version-ranged per CLI version.

#### ADR-035 — External repositories: user-acquired, statically evaluated
- **Status:** PROPOSED (M7.0)
- **Context:** GitHub-hosted skills, MCP configs and workflows are attractive and risky.
- **Decision:** docs/47 §6. AI Bridge never fetches, clones, installs or executes. It inspects a
  user-acquired directory as data within caps, detects registrable kinds, writes an evaluation
  report, and requires a per-candidate human approval. CRITICAL risk cannot be approved.
- **Alternatives:** Built-in cloning / a marketplace (rejected: network + supply chain).
- **Consequences:** A manual acquisition step; a strong supply-chain boundary.

### M8 — Memory / Graphify

#### ADR-036 — Human-curated memory; AI output only as proposals
- **Status:** PROPOSED (M8.0)
- **Context:** ADR-006 makes memory optional and human-promoted; M8 must make it concrete.
- **Decision:** docs/49 §7, docs/51. Entries are Markdown with provenance. Workflows and users
  create proposals. Only a host-confirmed human action promotes. AI-originated text keeps its label
  forever. Secrets are refused at intake.
- **Alternatives:** Auto-summarize runs into memory (rejected: poisoning).
- **Consequences:** Memory grows slowly and stays trustworthy.

#### ADR-037 — The graph is an optional, derived, pinned, read-only index
- **Status:** PROPOSED (M8.0)
- **Context:** Graphify output exists in the dev repo and is stale; it is a Python tool outside
  AI Bridge.
- **Decision:** docs/50. The adapter reads a pinned artifact (sha256 + `built_at_commit` + tree
  digest), flags staleness, returns UNAVAILABLE on any problem, and is used only by the
  ContextAssembler. It is never read by execution, the decider, the reconciler, verification or the
  resolver. Rebuilds are user actions (M8.6 optionally through an M7 tool).
- **Alternatives:** Bundle or auto-run the indexer (rejected: dependency + staleness risk). Make the
  graph authoritative for code facts (rejected: principle 20).
- **Consequences:** The system is fully functional without Graphify; graph context is advisory.

#### ADR-038 — Deterministic context assembly with recorded hashes
- **Status:** PROPOSED (M8.0)
- **Context:** Memory changes prompt text; runs must stay reproducible and auditable.
- **Decision:** docs/51 §4/§8. Declared keys only, a fixed order, caps, labelled untrusted blocks.
  `context.json` + the `CONTEXT_ASSEMBLED` event record the hashes before START (write-ahead).
  Resumes never re-assemble; retries re-assemble and record the difference.
- **Alternatives:** Ranked or embedding retrieval (deferred, OQ-M8-04).
- **Consequences:** Reproducible task texts; memory's influence is visible per attempt.

### M9 — Multi-Agent / Parallel

#### ADR-039 — Parallelism through per-branch worktrees; a single supervisor writer
- **Status:** PROPOSED (M9.0)
- **Context:** One run lock and one current session per project path; one Workflow Host per project.
- **Decision:** Concurrent executions happen only in separate git worktrees (separate project paths,
  BridgeEngine instances, locks and `.ai-bridge/`). The one Workflow Host stays the only writer and
  planner. Concurrency comes from several unchanged ExecutionPorts.
- **Alternatives:** Several executions sharing one tree (rejected: conflicting writes, lock
  violation). Several Workflow Hosts (rejected: multiple writers).
- **Consequences:** Needs git worktrees (ADR-044) and `executionKey` identities (ADR-042).

#### ADR-040 — Definition schema 2: bounded parallel groups and joins
- **Status:** PROPOSED (M9.0)
- **Context:** ADR-013 reserves schema 2 for parallelism; the decider allows one live attempt.
- **Decision:** docs/55 §1. `parallel` groups with branches of ordinary steps, a `join`, a
  `failurePolicy` and `maxConcurrency` (≤ 4); no nesting, no expressions. The decider allows more
  than one live attempt only inside one running group.
- **Alternatives:** A DAG (`needs`) model (rejected for M9: more states, harder recovery).
  Dynamic agent-planned parallelism (rejected).
- **Consequences:** A major decider extension under the ADR-021 replay guard.

#### ADR-041 — Execution adapter interface extraction
- **Status:** PROPOSED (M9.0)
- **Context:** docs/30 §4.3 and docs/32 §3.5 plan it as the single M4-core change for
  multi-provider.
- **Decision:** docs/54 §4. The Orchestrator depends on `ExecutorAdapter`/`ReviewerAdapter`; the
  EXISTING adapters implement them with frozen behavior (identical argv, files, records, tests);
  there is no branching on provider names.
- **Alternatives:** A new parallel orchestrator for other providers (rejected: divergence).
- **Consequences:** The riskiest change of M9: an isolated commit, a full regression, and the M5
  real E2E re-run.

#### ADR-042 — Agent, provider and model identity in records
- **Status:** PROPOSED (M9.0)
- **Context:** `ExecutionRecord.agent` is `'claude' | 'codex'`; runIds are unique only per
  project path.
- **Decision:** docs/54 §1–§2. Execution record v2 with `providerRef`, `agentRef` and `model` + its
  evidence (UNKNOWN when not reported); `executionKey = <worktreeId>:<runId>` everywhere across
  worktrees. v1 records stay readable.
- **Alternatives:** Infer the model from flags or plans (rejected: principle 19).
- **Consequences:** A record schema bump; honest UNKNOWNs in the UI.

#### ADR-043 — Join and merge policy
- **Status:** PROPOSED (M9.0)
- **Context:** Branches change code independently; merging is where silent breakage happens.
- **Decision:** docs/55 §4. The supervisor commits each verified branch on its own branch, merges
  deterministically in a scratch worktree in the declared order, sends any conflict to
  WAITING_HUMAN (never agent-resolved), and verifies the merged tree with M6 before success.
  Integration into the user's branch is a human action.
- **Alternatives:** Sequential patch application (possible under OQ-M9-02). Agent conflict
  resolution (deferred).
- **Consequences:** More human touchpoints on conflicts; no silent merges.

#### ADR-044 — Git mutation is opt-in, namespaced, local and non-destructive
- **Status:** PROPOSED (M9.0)
- **Context:** M9 is the first phase that must create branches, worktrees and commits in the
  user's repository.
- **Decision:** docs/55 §3. A per-project opt-in **and** a definition flag; only `worktree
  add/list/remove`, `commit` (branch worktrees), `merge --no-commit` (scratch worktree) and `diff`;
  the `ai-bridge/<wf>/…` branch namespace; never push/fetch/reset/checkout/stash/rebase on the
  user's worktree; keep-if-dirty.
- **Alternatives:** Copy-based sandboxes without git (rejected: no merge semantics).
  Unrestricted git (rejected).
- **Consequences:** Users see extra local branches and worktrees; the UI lists and discards them.

#### ADR-045 — Cross-agent verification
- **Status:** PROPOSED (M9.0; the M6 reviewer rule is its first instance)
- **Context:** Self-review bias; docs/25 §3.5 already asks for reviewer ≠ executor provider.
- **Decision:** docs/54 §7. The reviewer provider must differ from the executor provider (no
  same-provider fallback); 1–3 reviewers; `ALL_APPROVE` (a minority veto); reviews remain
  evidence, never authority.
- **Alternatives:** Majority vote (rejected: judges accept bad work more readily than they reject
  it, docs/19 P10). Same-provider fresh sessions (rejected, OQ-M6-06).
- **Consequences:** Needs ≥ 2 providers ready for reviewed steps; otherwise NEEDS_HUMAN.

## 3. Open-question register (consolidated)

| ID | Phase | Question (short) | Blocks |
|---|---|---|---|
| OQ-X-01 | cross | M5.10 must pass before any M6 work (the user must authenticate the Claude CLI) | **G0** |
| OQ-X-02 | cross | No downgrade support for newer instances (ADR-023): acceptable? | M6.0 |
| OQ-X-03 | cross | Should docs/38 absorb each accepted ADR at every `.0` closure? (recommended: yes) | M6.0 |
| OQ-X-04 | cross | Keep M7 → M8 order, or swap (M8.1–M8.5 have no M7 dependency) | M7.0 |
| OQ-M6-01 … 12 | M6 | docs/41 §12 | 01, 02, 04, 05, 10 block M6.0 |
| OQ-M7-01 … 09 | M7 | docs/45 §11 | 01, 02, 03, 04, 05, 07 block M7.0/M7.6 |
| OQ-M8-01 … 08 | M8 | docs/49 §12 | 02, 03, 06, 07 block M8.0 |
| OQ-M9-01 … 09 | M9 | docs/53 §12 | 01, 02, 06, 07, 09 block M9.0 |

## 4. ADR ↔ document ↔ phase matrix

| ADR | Primary docs | Phase `.0` that must accept it |
|---|---|---|
| 021–023 | 41 §9, 57 §7, 57 §9 | M6.0 |
| 024–030 | 41–44 | M6.0 |
| 031–035 | 45–48 | M7.0 |
| 036–038 | 49–52 | M8.0 |
| 039–045 | 53–56 | M9.0 (045's reviewer rule is already applied in M6 via docs/42 §7.3) |

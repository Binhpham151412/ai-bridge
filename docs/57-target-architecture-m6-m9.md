# 57 — Target Architecture M5 → M9 (PROPOSED — documentation only)

The cross-phase view of docs 41–56, on top of the accepted architecture of docs 19–40. Tags:
**EXISTING** · **PROPOSED** (this document set) · **FUTURE** (beyond M9, or optional) ·
**OPEN QUESTION** (the ids refer to docs/58 §3).

## 1. Baseline (EXISTING, 2026-09-30)

- M5.1–M5.9 implemented (uncommitted on top of `27fb871`); 862/862 tests; typecheck and build pass.
- **M5.10 real E2E: not passed.** The Claude CLI is not authenticated on the development machine,
  and the user deferred the real-provider scenarios. M5 is therefore **not released**, and M6
  implementation must not start (§8 gate G0).

## 2. Phase model

| Phase | Adds | Core rule it must not break |
|---|---|---|
| M5 (EXISTING) | workflow → execute → OutcomeOnly → AI_ATTESTED | the decider is pure; retry = new execution, resume = same; no duplicate execution |
| M6 (PROPOSED) | deterministic verification → reviewer → PASS/FAIL → bounded retry | only AI Bridge evidence makes VERIFIED; a retry never resumes |
| M7 (PROPOSED) | capabilities, trust, permissions, explicit selection, execution profiles | nothing auto-loads; the tier comes from the source; the constant resolver = M6 behavior |
| M8 (PROPOSED) | project memory, proposals, derived graph, context assembly | memory/graph never source of truth; the system works without them |
| M9 (PROPOSED) | agents, identities, parallel branches in worktrees, join, cross-agent review | the supervisor is deterministic and the single writer; worktree isolation; no LLM manager |

## 3. Target architecture diagram

```
┌─────────────────────────────────────── UI LAYER ───────────────────────────────────────────┐
│ Renderer (pure consumer) EXISTING: Run · Workflows · Journal · Artifacts · Settings · System │
│   + M6 attempt history/evidence/review/approval banner (PROPOSED)                            │
│   + M7 Capabilities view (PROPOSED) · M8 Memory view (PROPOSED) · M9 branch lanes/join (PROPOSED) │
│ Preload (frozen, allowlisted) EXISTING — new functions appended per phase (PROPOSED)         │
├──────────────────────────────────────── HOSTS ─────────────────────────────────────────────┤
│ Electron Main EXISTING: RunController · WorkflowController                                   │
│   + CapabilityController (M7) · MemoryController (M8)  — PROPOSED; native confirmations      │
│ CLI EXISTING (the CLI process = the Workflow Host)  + approve/capability/memory/worktree cmds │
├──────────────────────────────────── WORKFLOW LAYER ─────────────────────────────────────────┤
│ Workflow Host (with-parent) EXISTING · WorkflowEngine + pure decider EXISTING                 │
│   + retry transitions, VERIFICATION_EVIDENCE/REVIEW_ENDED inputs (M6, PROPOSED)                │
│   + RESOLVE_CAPABILITIES + pinned resolution (M7, PROPOSED)                                   │
│   + ContextAssembler in the step-planner (M8, PROPOSED)                                       │
│   + schema-2 groups, WorktreeManager, BranchPorts, JoinCoordinator (M9, PROPOSED)             │
├──────────────────────────────────── VERIFICATION LAYER ──────────────────────────────────────┤
│ VerificationPort EXISTING (OutcomeOnly) → VerificationEngine (M6, PROPOSED):                  │
│   CheckRunner (with-parent checks) · WorkspaceProbe · ApprovalStore · decideVerification      │
│   ReviewPort → review-only execution (ADR-027, PROPOSED, gated) · cross-agent review (M9)     │
├──────────────────────────────────── CAPABILITY LAYER (M7, PROPOSED) ──────────────────────────┤
│ Sources · Inspector (static) · Policy (pure) · Registry store + audit log · Resolver (pure)   │
│ wraps ProviderRegistry (EXISTING, diagnostics)                                                │
├──────────────────────────────────── MEMORY LAYER (M8, PROPOSED, optional) ────────────────────┤
│ MemoryStore · Proposals · MemoryPort (Null default) · GraphIndexAdapter (read-only, pinned)   │
│ ◄── Graphify artifact (external, derived; FUTURE: invoked as an M7 tool, M8.6)                │
├──────────────────────────────────── EXECUTION LAYER ─────────────────────────────────────────┤
│ ExecutionPort EXISTING (ForkedExecutionPort; one Execution Host per execution, independent)   │
│ BridgeEngine + Orchestrator EXISTING — unchanged loop                                         │
│   + review() (M6, ADR-027) · optional `profile` start option (M7, ADR-034)                    │
│   + typed ExecutorAdapter/ReviewerAdapter (M9, ADR-041; behavior frozen)                      │
│   one BridgeEngine per project path; M9: one per worktree                                     │
├──────────────────────────────────── PROVIDER LAYER ──────────────────────────────────────────┤
│ Claude Code CLI (executor) · Codex CLI (reviewer) EXISTING — concrete adapters until M9       │
│   + vetted profile flags (M7) · FUTURE: additional providers through ADR-041/042 (post-M9)    │
├──────────────────────────────────── PERSISTENCE LAYER ───────────────────────────────────────┤
│ .ai-bridge/{config, state, sessions, reports, logs} EXISTING (BridgeEngine-owned)             │
│ .ai-bridge/workflows/{definitions, instances} EXISTING  + approvals, attempt artifacts (M6)   │
│ .ai-bridge/capabilities/ (M7) · .ai-bridge/memory/ (M8) · worktrees registry (M9) — PROPOSED  │
│ app userData: settings EXISTING + capabilities/, memory/ (M7/M8, PROPOSED)                    │
├──────────────────────────────────── EVENT / AUDIT LAYER ─────────────────────────────────────┤
│ run events (logs/events.jsonl) EXISTING · per-instance hash-chained workflow events EXISTING  │
│   + M6 CHECK/REVIEW/RETRY events (reserved types) · approvals.log (M6) · registry.log (M7)    │
│   + memory.log (M8) · CAPABILITIES_RESOLVED / CONTEXT_ASSEMBLED / GROUP & BRANCH events (M7–M9)│
│ Platform (L0) EXISTING: process-runner, AtomicJsonWriter, integrity, redact, canonical JSON   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
OPEN QUESTIONs with an architectural impact: OQ-M6-01 (git checkpoints), OQ-M7-03 (isolation
defaults), OQ-M8-05 (indexer invocation), OQ-M9-01 (worktree placement), OQ-M9-06 (who commits).
```

## 4. Layer-by-layer evolution

| Layer | M5 (EXISTING) | M6 | M7 | M8 | M9 |
|---|---|---|---|---|---|
| Workflow | sequential, 1 attempt/step, pure decider | retries, evidence inputs, `retry` answer | pinned resolution | context assembly | groups, branches, join, worktrees |
| Execution | BridgeEngine, forked hosts, correlation | + `review()` (gated) | + `profile` option | — | + adapter interfaces; per-worktree engines |
| Verification | OutcomeOnly → AI_ATTESTED | deterministic checks, reviewer, VERIFIED | agent-selected reviewer | — | merged-tree verification, cross-agent review |
| Capability | ProviderRegistry (diagnostics) | — | registry, trust, permissions, profiles | the indexer as a tool (optional) | agent identities for branches |
| Memory | none (reserved field rejected) | — | — | store, proposals, graph adapter | per-agent keys (configuration) |
| Provider | Claude + Codex concrete | — | vetted flags | — | interfaces, identity, model evidence |
| Persistence | workflows/, sessions/ | approvals, attempt artifacts | capabilities/ | memory/ | worktree registry, per-worktree `.ai-bridge/` |
| Event/Audit | hash-chained events | uses the reserved types; approvals log | registry log; new types | memory log; CONTEXT_ASSEMBLED | group/branch/worktree types |
| UI | Workflows view | evidence/attempts/approval | Capabilities view | Memory view | branch lanes, join panel |

## 5. Dependency graph (increment level)

```
M5.10 real E2E ─► M5 Release Audit (commit, gate G0)
        │
        ▼
      M6.0 ─► M6.1 ─┬─► M6.2 ─┬─► M6.4 ─► M6.5 ─► M6.6 ─► M6.7 ─► M6.8 ─► M6.9  (M6 Release)
                    └─► M6.3 ─┴─(M6.3-R2 gated by ADR-027; may slip to M6.x)
                                                                         │
      ┌──────────────────────────────────────────────────────────────────┘
      ▼
    M7.0 ─► M7.1 ─► M7.2 ─┬─► M7.3 ─► M7.5 ─┬─► M7.6 ─┐
                          └─► M7.4 ─────────┘  └─► M7.7 ─┴─► M7.8 ─► M7.9  (M7 Release)
                                                                    │
      ┌─────────────────────────────────────────────────────────────┤
      ▼                                                             ▼
    M8.0 ─► M8.1 ─┬─► M8.2 ─┬─► M8.5 ─► M8.7 ─► M8.8 (M8 Release)   M9.0 ─► M9.1 ─► M9.3 ─► M9.4 ─► M9.5 ─► M9.6 ─┐
                  ├─► M8.3 ─┤                                        └─► M9.2 (adapter extraction, early) ──► M9.7 ─┤
                  └─► M8.4 ─┘   M8.6 (optional; needs M7)                                         M9.8 ─► M9.9 ─► M9.10 ─► M9.11 (M9 Release)
```

### 5.1 What can proceed independently, and what must wait

| Work | Can start after | Must wait for | Why |
|---|---|---|---|
| M6 anything | M5 release | — | it extends the M5 decider/validator/engine |
| M7.1 (manifest validator, policy, risk — pure, new module) | M6.1 merged (development only) | the M6 release before merging to main | a separate module, but the phases ship sequentially to keep one moving decider/validator at a time |
| M7.0 flag-behavior verification | M5 release | — | zero or minimal quota; informs ADR-034 early |
| M8.1–M8.5 | M6 release (they need only M5 contracts + M6 for verification-summary proposals) | — | memory touches only the step-planner and new modules; M7 is not required |
| M8.6 (indexer invocation) | — | the M7 release | needs a registered `tool` capability with `process.exec` |
| M9 | — | M6 **and** M7 releases | join verification (M6); agent identity, profiles, resolution (M7) |
| M9.2 (adapter extraction) | the M9.0 closure | — | independent of the parallel work; do it first (the highest-risk core change) |

**Order choice (OPEN QUESTION OQ-X-04):** the phase model lists M7 before M8. Technically M8
could precede M7 (M8.1–M8.5 have no M7 dependency). The recommendation keeps **M7 → M8**,
because M8.6 and memory permissions (`memory.read`/`propose`) are cleaner once the registry
exists. The swap stays possible without an architecture change.

## 6. Implementation order (recommended)

1. **M5.10** real E2E (after the Claude CLI login) → **M5 release audit** → commit (the rollback point).
2. **M6** (M6.0 → M6.9). Include M6.3-R2 only if ADR-027 is accepted.
3. **M7.0 flag verification** can be scheduled any time after the M5 release (it de-risks ADR-034).
4. **M7** (M7.1 → M7.9).
5. **M8** (M8.1 → M8.5, M8.7, M8.8; M8.6 optional).
6. **M9**, starting with **M9.2** (adapter extraction), then M9.1, M9.3 → M9.11.
7. Each phase ends with a release audit (a docs/40-style gate) and a commit before the next `.0` closure.

## 7. What must NOT change (cross-phase invariants)

1. **BridgeEngine is the only execution engine.** The Orchestrator loop semantics stay unchanged.
   The only planned core changes are the additive `review()` (ADR-027), the optional `profile`
   (ADR-034) and the behavior-frozen interface typing (ADR-041).
2. **Execution files are the source of truth for execution facts** (ADR-014). Reconciliation reads
   execution → workflow, never the reverse.
3. **Retry = a new attempt and a new execution** (new runId, fresh session). **Resume = the same
   execution** (ADR-012). A semantic retry never resumes.
4. **Recovery never starts a second execution** for an attempt that has or may have one
   (ADR-017, M5.6). This holds per branch in M9.
5. **The decider is pure and deterministic. Every M5+ log replays identically** under every later
   decider (ADR-021).
6. **One Workflow Host per project and one writer of workflow state**, in every phase including M9.
7. **Process lifetimes:** Workflow Host `with-parent`; Execution Hosts (and review hosts)
   `independent`; CLIs and check processes `with-parent` of their host (M5.8.1, ADR-025).
8. **The renderer is a pure consumer.** Controls and availability are derived in Core. The renderer
   never submits commands, paths, prompts, permissions or approvals; privileged grants need a
   host-owned (native/CLI) confirmation.
9. **VERIFIED only from AI Bridge-generated deterministic evidence.** Model claims, reviews,
   memory and human answers can never raise the evidence level. There is no
   "accept-as-verified" answer (ADR-024).
10. **Fail closed everywhere:** unknown → NEEDS_HUMAN / UNKNOWN; invalid parse → never PASS; missing
    approval → BLOCKED or refused.
11. **Subscription-only billing:** no API-key billing; the forbidden flags (`bypassPermissions`,
    `--dangerously-*`, `--bare`, `--plugin-url`, `--settings`, `--add-dir`, `--agents`) stay
    forbidden.
12. **Local-first:** no mandatory cloud, no database, no network calls by AI Bridge itself, and
    nothing auto-downloaded, installed or updated.
13. **Memory and graph are never source of truth**, and are never read by BridgeEngine, the decider,
    the reconciler, verification or the resolver.
14. **Hard caps at every layer.** The EXISTING values (maxIterations 100, executions 100,
    iterations 1000, duration 72 h, task 256 KB) are never raised silently.
15. **M5 definitions (schema 1) stay valid**, with identical hashes and behavior. Additive fields stay
    in schema 1; structural changes go to schema 2 (ADR-022, ADR-013).
16. **The IPC security pattern** (allowlist, validation, sender check, frozen preload): EXISTING
    channels are never changed, only appended.
17. **Audit-critical records are append-only / hash-chained**, and are never auto-deleted (docs/34).
18. **No JavaScript plugin loading into AI Bridge**, and no LLM workflow controller, at any phase.

## 8. READY FOR IMPLEMENTATION checklist

### Gate G0 — before any M6 code
- [ ] The Claude CLI is authenticated on the test machine (a user action); quota approved
- [ ] M5.10 real E2E PASS: scenarios A–J including the Workflow Host crash (E) and the Electron Main crash (F)
- [ ] M5 release audit written; the working tree committed (the rollback point)
- [ ] The golden corpus of M5 event logs captured (fixtures + the real M5.10 logs) for ADR-021
- [ ] docs 41–58 reviewed by the architect; the proposed ADRs accepted/amended into docs/38 per phase
- [ ] Blocking OQs of M6 answered: OQ-M6-01, 02, 04, 05, 10

### Gates G1–G3 — per phase `.0` (see each acceptance doc)
- [ ] M7.0: docs/48 §9 (incl. the flag-behavior verification)
- [ ] M8.0: docs/52 §9
- [ ] M9.0: docs/56 §9

### Standing rules for every increment
- [ ] typecheck, test and build green; EXISTING tests unchanged unless an accepted ADR says otherwise
- [ ] Golden replay green (ADR-021)
- [ ] New IPC channels covered by the security tests; the smoke test count updated
- [ ] Real E2E only with explicit quota approval, following the M5.10 driver rules (process identity, single-pid kills, polling ≥ 1 s)

## 9. Contradictions and tensions found (documented, not silently resolved)

| # | Finding | Resolution in this set |
|---|---|---|
| T1 | docs/39 M5.5 planned read-only git evidence per attempt; **not implemented** in M5 | Moved to M6.2 (ADR-029); docs/41 §2 |
| T2 | `event-log.ts` rejects unknown event types; later phases add types | ADR-023 (append-only vocabulary; older builds fail closed; no downgrade) |
| T3 | docs/26 says "M6 default maxAttempts 2", but the field is required (M5) | No implicit default; 2 is the recommended template value (docs/43 §6) |
| T4 | docs/24: a required check ERROR → FAIL; retrying an environment error would waste attempts | Keep FAIL (fail-closed), add the class `CHECK_ENVIRONMENT` → WAIT_HUMAN (ADR-024/028) |
| T5 | docs/28 "the reserved `requires` means no migration" vs genuinely new field names (`criteria`, `agent`, `skills`) | ADR-022: additive fields in schema 1 (older builds fail closed); schema 2 only for structural changes (consistent with ADR-013) |
| T6 | runIds are unique per project path, not per M9 workflow | `executionKey = <worktreeId>:<runId>` (docs/54 §2, ADR-042) |
| T7 | docs/25 R1 ("reuse the inner verdict") would double-count the execution claim as review evidence | R1 = no step-level review; `requireReviewer` needs R2 (ADR-027) |
| T8 | The Claude/Codex isolation flags exist in `--help` but their behavior is unverified | M7.0 verification gate; `UNVERIFIED` labels (ADR-034) |
| T9 | A check command's behavior depends on files the executor can edit (`package.json`) | `path-untouched` + the validator warning V8; CHECK_TAMPER (docs/42 §3.3) |

## 10. Risks (cross-phase)

| Risk | Mitigation |
|---|---|
| Starting M6 on an unproven M5 | Gate G0 is mandatory |
| Decider complexity growing phase by phase | ADR-021 golden replay; exhaustive tables per phase |
| Quota consumption growing (retries, reviews, branches) | Caps, the QUOTA class never retried, stuck detection, token budgets, explicit E2E approval |
| Security surface growth (commands, capabilities, worktrees) | Host-owned confirmations, hash pinning, forbidden flags, docs/33 review entries per extension (docs/37 §4) |

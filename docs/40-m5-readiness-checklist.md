# 40 — M5 Readiness Checklist (Gate)

## 1. Purpose

A go/no-go gate that must pass before any M5 code is written. Each check lists its
evidence. The verdict is at the end.

## 2. Current State (evidence gathered 2026-09-28, re-checked at M5.0)

- `main` HEAD = `27fb871` ("feat: add provider diagnostics foundation"), preceded by
  `3a22247` ("feat: refactor desktop UI and session navigation"). The M4.3 Phase 1 and UI
  refactor work from docs/18 is **committed**. The only untracked files are docs 19–40.
- `pnpm typecheck` → exit 0 (both configs). `pnpm test` → **535/535 pass**, 0 fail. Both
  were run on HEAD in the M4.4 checkpoint and again at M5.0 (2026-09-28).
- `pnpm build` and the desktop smoke test (10/10) were last run in the docs/18
  checkpoint on the same code. They were not re-run in these docs-only checkpoints.
- No source, test or package files were changed by the M4.4 or M5.0 checkpoints.
- **M5.0 (Architecture Decision Closure) completed on 2026-09-28.** The architect review
  result was *PASS WITH FIVE DECISIONS TO CLOSE*. All five are recorded in docs/38
  ("M5.0 Decision Closure", ADR-011, ADR-017, ADR-018, ADR-019, ADR-020).

## 3. Checklist

Legend: ✅ satisfied · ⚠️ satisfied with a noted limitation · ❌ not satisfied (blocking).

| # | Area | Check | Status | Evidence |
|---|---|---|---|---|
| A1 | Architecture | Layers, dependency direction and flows documented | ✅ | docs/19 §3–8 |
| A2 | Architecture | Current-state baseline written from code, drift listed | ✅ | docs/20 §12 |
| A3 | Architecture | All 18 critical questions answered | ✅ | docs/19 §10 (Q18's "OPEN QUESTION" superseded by ADR-017, docs/38) |
| A4 | Architecture | ADRs reviewed and signed off by an architect | ✅ (M5.0) | Architect review 2026-09-28: PASS WITH FIVE DECISIONS TO CLOSE; ADR-001–016 accepted as written (docs/38 "M5.0 Decision Closure") |
| A5 | Architecture | Open ADRs affecting M5 closed (ADR-011 process model, ADR-017 correlation) | ✅ (M5.0) | ADR-011 option A accepted; ADR-017 option B accepted, with implementation in M5.4 and fallback reconciliation kept (docs/38) |
| S1 | State | Workflow vs execution state separated, tables defined | ✅ | docs/22 |
| S2 | State | Invalid transitions enumerated | ✅ | docs/22 §4.2, §5 |
| P1 | Persistence | Layout, writers and atomicity rules defined | ✅ | docs/34 §3, docs/27 §3.4 |
| P2 | Persistence | Workflow definitions location decided | ✅ (M5.0) | ADR-018: `<project>/.ai-bridge/workflows/definitions/`, project-local file = source of truth (docs/38, docs/36 §3.7, docs/34 §3) |
| P3 | Persistence | Stance on the shared `reports/` directory accepted | ✅ (M5.0) | ADR-019: `reports/` kept as-is for M5, no report-contract change, the session-history copy is the forensic copy; per-session paths are a possible future migration, not M5 (docs/38, docs/34 §7) |
| M1 | Scope | M5 scope explicitly locked | ✅ (M5.0) | ADR-020 (docs/38); enforced by the M5 validator subset (docs/36 §3.2) |
| R1 | Recovery | Crash matrix for every attempt state defined | ✅ | docs/26 §6 |
| R2 | Recovery | Execution recovery stays in BridgeEngine | ✅ | docs/23 §7.3, ADR-001 |
| E1 | Execution boundary | ExecutionPort contract, ids and ownership defined | ✅ | docs/23 |
| E2 | Execution boundary | BridgeEngine change budget stated (exactly 1 additive optional field: `correlation?: string`, M5.4) | ✅ | ADR-017, docs/23 §8, docs/39 M5.4 |
| V1 | Verification boundary | M5 slot (OutcomeOnly, `AI_ATTESTED`) defined; M6 design exists | ✅ | docs/24 §3.5, ADR-020 |
| V2 | Verification boundary | False-DONE prevention rules defined | ✅ | docs/24 §8, docs/25 §5 |
| EV1 | Events | Workflow event envelope + integrity + journal relationship | ✅ | docs/27 |
| SEC1 | Security | Existing controls preserved; new IPC follows the same pattern | ✅ | docs/33 §2, §7; docs/35 §3.3 |
| SEC2 | Security | Uncontrolled surface documented (the user's global Claude config) | ⚠️ | docs/33 §2. It is a known limitation, not an M5 blocker |
| PR1 | Provider abstraction | Capability matrix from code; M5 needs no provider change | ✅ | docs/30 §3, §4.2 |
| UI1 | UI boundary | Snapshot/controls derived in Core; no renderer logic | ✅ | docs/35 |
| T1 | Testing | Baseline green on HEAD | ✅ | 535/535, typecheck 0 (§2, re-run at M5.0) |
| T2 | Testing | Test plan per increment incl. crash matrix and no-duplicate assertion | ✅ | docs/39 |
| T3 | Testing | Real-E2E policy (quota approval) stated | ✅ | docs/39 M5.10 |
| C42 | M4.2 compatibility | Journal, custom review rounds, execution records untouched | ✅ | docs/19 §10 Q18; docs/39 §3 rule 1 |
| C43 | M4.3 compatibility | `core/providers/*` untouched; Phase 2 (IPC/UI) independent of M5 | ✅ | docs/30 §4.2, docs/37 E1 |
| G1 | Baseline | Foundation committed, so rollback is possible | ✅ | `27fb871` on `main` |

## 4. Non-blocking known limitations carried into M5

- `config.reportMaxBytes` not wired (effective 256 KB); `RECOVERING`, `ITERATION_COMPLETED`
  and `TIMEOUT` are unused; `allowedTools` is unused; duplicate discovery/auth code; docs/04
  drift (docs/20 §12).
- Out-of-scope UI items from docs/18 (Markdown ordered lists, double scrollbars, dark
  theme, mixed labels, the missing task title in the Run header, doctor "exited 1" wording).
- Claude Code runs with the user's global configuration (docs/33 §2).
- `reports/NNN-report.md` is still overwritten by later runs (ADR-019). This is accepted
  for M5.
- Some pre-M5.0 passages in docs 19, 23, 26, 37 and 39 still say "OPEN". docs/38 lists
  each of them and is authoritative ("Supersession note").

## 5. M5.0 blockers — closure record

All five items that blocked M5.1 were closed on 2026-09-28 by documentation only. No
code was changed.

| # | Blocker (pre-M5.0) | Closed by | Resolution |
|---|---|---|---|
| 1 | Architect review and sign-off of docs 19–38 (A4) | Architect review, recorded in docs/38 | PASS WITH FIVE DECISIONS TO CLOSE; ADR-001–016 accepted as written |
| 2 | ADR-011: workflow host process model (A5) | ADR-011 → ACCEPTED | **Option A:** a separate Workflow Host, which owns orchestration and survives an execution STOP; each execution runs in its own Execution Host child with BridgeEngine |
| 3 | ADR-017: correlation option (A5) | ADR-017 → ACCEPTED | **Option B:** `correlation?: string` (attemptId → correlation → BridgeEngine → `RUN_STARTED` → runId); additive and backward compatible; **implementation in M5.4, not now**; fallback reconciliation kept |
| 4 | Workflow definitions location (P2) | ADR-018 → ACCEPTED | `<project>/.ai-bridge/workflows/definitions/`, project-scoped JSON with canonical hashing; the project-local file is the source of truth |
| 5 | `reports/` stance + M5 scope acknowledgement (P3, M1) | ADR-019 + ADR-020 → ACCEPTED | `reports/` kept as-is for M5 (no report-contract change; the session-history copy is forensic; the future migration is not M5). M5 scope locked (§6) |

## 6. M5 scope (locked by ADR-020)

In M5: the Workflow Engine, sequential steps, one execution at a time, a Workflow Host
plus an Execution Host per execution, workflow persistence, reconciliation, workflow
events and journal, CLI and desktop wiring, and a Workflow view (docs/39 M5.1–M5.10).

Explicitly **not** in M5:
- `maxAttempts` = 1. There are **no semantic retries** (M6).
- Verification = **OutcomeOnly**; evidence label = **`AI_ATTESTED`**. There are **no
  deterministic verification checks** (M6).
- **No step-level Reviewer** (M6).
- **No Capability Registry implementation** (M7).
- **No Memory** and **no Graphify** implementation (M8).
- **No multi-agent or parallel execution**, and **no multi-provider execution
  abstraction** (M9).

The unchanged principles that bound M5: the Workflow Engine sits above BridgeEngine;
execution files are the source of truth for execution facts; retry = new execution and
resume = same execution; the renderer is a consumer only; JSON definitions only (no YAML,
no TypeScript definitions, no expression language); no database, cloud execution, API-key
billing or parallel execution.

## 7. Verdict

# READY FOR M5

**Reason (evidence-based):** the technical baseline is committed (`27fb871`), with
typecheck clean and 535/535 tests passing on HEAD (re-run at M5.0). The architecture has
been reviewed (PASS), and every blocking check (A4, A5, P2, P3) plus the scope lock (M1)
is closed in writing in docs/38. No ❌ remains in §3.

**What this verdict authorizes:** starting **M5.1** (the workflow domain model and
definition validator) under docs/39, and nothing beyond the M5 scope in §6. The
BridgeEngine `correlation` field is to be implemented only in **M5.4**, as an isolated
commit. Real Claude/Codex E2E still requires explicit user approval (M5.10).

**M5 implementation has not started.** No workflow code exists in `src/`.

## 8. Responsibilities / Boundaries / Data Flow / Failure Cases

The gate owner is the reviewing architect. The checks are documentary, except T1/G1
(command output). If any check regresses (for example tests fail on a later HEAD, or an
M5 increment exceeds the §6 scope), the verdict reverts to NOT READY until the regression
is resolved.

## 9. Decisions

This gate applies ADR-001–020 (docs/38).

## 10. Open Questions

None block M5. The questions that remain belong to later milestones (docs/38 "Open
Questions (ADR-level)").

## 11. Explicitly Out of Scope

Implementation, M4.3 Phase 2 scheduling, and fixing the known limitations in §4.

## 12. Risks

- The scope creeping into M6+ during M5: the M5 validator rejects reserved fields, and
  ADR-020 is the reference in reviews.
- The single BridgeEngine change (M5.4) regressing M4: an isolated commit, the existing
  tests unchanged, and the smoke test re-run.

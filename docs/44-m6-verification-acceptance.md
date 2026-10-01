# 44 — M6 Verification: Hosts, UI, Testing, Real E2E, Failure Modes, Increments, Acceptance (PROPOSED)

Covers items 14–19 and 25 of the M6 definition (docs/41 §0). Status legend: see docs/41.

## 1. CLI implications (item 14)

The CLI process stays the Workflow Host for `workflow run|resume` (EXISTING, M5.8). Additions:

| Command | Behavior | Notes |
|---|---|---|
| `ai-bridge workflow validate --definition <id>` (EXISTING) | also prints the checks (verbatim argv), the warnings (V3/V8), the criteria, the evidence ceiling (`VERIFIED` possible / `AI_ATTESTED` only), and the approval status | spends no quota; `--dry-run` also renders the retry-context skeleton |
| `ai-bridge workflow approve --definition <id> [--hash <sha256>]` (NEW) | prints every command check (resolved executable, argv, timeout) and asks for interactive confirmation. `--hash` must equal the current definition hash, or it refuses. It never approves in non-interactive mode without `--hash` | writes `approvals.json` + the audit log (ADR-026) |
| `ai-bridge workflow revoke --definition <id>` (NEW) | revokes the approval; running instances block at their next verification (APPROVAL_MISSING) | audited |
| `ai-bridge workflow run` (EXISTING) | refuses to create an instance if a command check lacks approval (`APPROVAL_REQUIRED`); nothing is created | the refusal leaves nothing behind (the EXISTING rule) |
| `ai-bridge workflow status` (EXISTING) | adds per-step attempt history: attempt n, execution id, verdict, evidence level, failure class, retry reason | read-only |
| `ai-bridge workflow answer --workflow <id> --answer retry\|fail\|stop[\|reverify]` (EXISTING command, new answers) | `retry` only when Core offers it | Core-derived options |
| `ai-bridge workflow verification --attempt <attemptId>` (NEW, read-only) | prints the `verification.json` summary and the output tail paths | redacted |

Exit codes follow the EXISTING CLI convention: 0 on success; non-zero for refused or failed
outcomes, with a stable error code on stderr.

## 2. Electron / Main implications (item 15)

- **WorkflowController** (EXISTING) stays orchestration-free. New responsibilities: relay the
  approval flow, and serve the verification reads.
- **New invoke channels**, appended with the EXISTING allowlist, validation and sender-check
  pattern:

| Channel | Payload (validated in Main) | Returns |
|---|---|---|
| `workflow:getVerification` | `{attemptId}` (`ATTEMPT_ID_PATTERN`) | the summary of `verification.json` (redacted) |
| `workflow:getCheckOutput` | `{attemptId, checkId (kebab), stream: 'stdout'\|'stderr'}` | a tail ≤ 256 KB (the EXISTING artifact cap) |
| `workflow:getApproval` | `{definitionId}` | the approval status + the commands **as Main reads them from disk** |
| `workflow:approveDefinition` | `{definitionId, definitionHash}` (**no commands**) | Main re-reads the definition, re-hashes it, shows a **native** `dialog.showMessageBox` listing the commands, and records only on a native confirmation |
| `workflow:answer` (EXISTING) | `answer` enum extended with `retry` (+ `reverify`) | — |

- The native confirmation is the security boundary: a compromised renderer can request an
  approval but cannot grant it (ADR-026).
- The quit rules are unchanged (M5.8.1): a quit with an owned Workflow Host prompts "Hủy" /
  "STOP workflow và thoát". STOP aborts a running verification through the engine (the check tree
  is killed). A Main crash kills the Workflow Host and, with it, running checks (`with-parent`);
  recovery re-runs verification (docs/43 §4).
- `smoke.ts` must count the new preload functions (the EXISTING pattern from M5.8).

## 3. Renderer / UI implications (item 16)

A pure consumer. Every label comes from Core values through fixed tables (the EXISTING
`workflow-summary.ts` approach).

| Surface | Content |
|---|---|
| Step card | attempts `n / maxAttempts`, the current attempt state, the **evidence label** (always visible) |
| Attempt history (new) | one row per attempt: execution id (link to Run/Journal/Artifacts), verdict, evidence level, failure class, retry reason, started/ended |
| Evidence panel (new) | a check table (id, required, status, exit code, duration, "view output" → `workflow:getCheckOutput`); workspace digest changes; quiescence |
| Review panel (new) | decision; criteria with met/citation; the suggestion labelled **"AI-generated, unverified"**; the parse status |
| Approval banner (new) | "This definition runs N commands. Approve…" → Main's native dialog |
| WAITING_HUMAN (EXISTING) | new answer buttons exactly as `controls.canAnswer` lists them |

Wording rules (extending docs/24 §8): "Verified" / "tests passed" appear **only** for
`VERIFIED`. `AI_ATTESTED` keeps its M5 text ("chưa kiểm chứng bằng deterministic checks").
`NONE` is shown as such. The renderer never computes a verdict, a level or a control.

## 4. Testing strategy (item 17)

| Layer | Tests | Style |
|---|---|---|
| Validator | V1–V9 each with a passing and a failing fixture; M5 fixtures unchanged (they must stay valid with identical hashes) | table-driven |
| `decideVerification` | every row of docs/42 §6 incl. UNKNOWN → never PASS; the level matrix (checks × required × acceptAiOnly × review) | pure, exhaustive |
| RetryPolicy | every class × `retryOn` × attempts × budgets × stuck | pure, table-driven |
| CheckRunner | fake executables (node scripts): exit 0/1, timeout, 6 MB output, missing exe, a refused interpreter, a check that writes a file (WARNING / tamper), env scrubbing | real processes, fake commands |
| WorkspaceProbe | temp git repos: unborn HEAD, dirty, renames, ignored files, paths with spaces/unicode | real git, temp dirs |
| Review parser | fuzz and malformed blocks; APPROVE-without-citations → REJECT; unknown citation → UNKNOWN; an injection-bearing report | pure |
| ReviewPort (R2) | fake Codex CLI (the EXISTING fake-CLI pattern); a digest change → discarded; timeout | integration |
| Engine | two steps with fake ports: FAIL → RETRY → attempt 2 has a **new executionId**; `RESUME_EXECUTION` never issued for REJECTED; stop during checks; deadline during checks | integration |
| Crash matrix | kill during each VerificationRun state; between REJECTED and PLANNED(n+1); during review; asserts **zero duplicate executions** (fake-CLI invocation counts) and at most 2 verification runs | the M5.6 pattern |
| Windows orphan reaping | a real check that spawns a grandchild; kill the Workflow Host; recovery reaps by (pid, creation time); no orphan | like `process-lifetime.windows.test.ts` |
| Replay compatibility (ADR-021) | every M5 fixture log and the recorded M5.10 real logs replay byte-identically under the M6 decider | golden files |
| Security | IPC payloads (no command fields accepted), approval requires the native confirmation, path traversal/symlink escapes, redaction of check output | EXISTING security-test style |
| UI | labels per evidence level; no "verified" text for AI_ATTESTED; controls exactly from the snapshot | happy-dom renderer tests |

The full suite must stay green: 862 EXISTING tests unchanged, plus the new ones.

## 5. Real E2E strategy (item 18; quota — explicit approval required)

Run with the driver pattern of `scripts/real/m5.10-workflow-e2e.ts`: the real Electron app, CDP
clicks, native dialogs clicked through UI Automation, process identity = (pid, creation time),
single-process kills only, polling ≥ 1 s, a fresh sandbox per scenario.

| Scenario | Setup | Must show |
|---|---|---|
| V1 happy VERIFIED | a small JS lib with a passing `node --test`; checks: test + `file-exists` + `path-untouched tests/**` | COMPLETED, VERIFIED, evidence rows in the UI |
| V2 FAIL → RETRY → PASS | a deliberately failing test the agent must fix; the task text asks for the minimal fix; `maxAttempts 2` | attempt 1 REJECTED (CHECK_FAILED), `RETRY_DECIDED`, attempt 2 **new runId + new Claude session**, PASS VERIFIED |
| V3 tamper | criteria allow edits only in `src/`; a check protects `tests/**` | if the agent edits tests → CHECK_TAMPER (whether it happens is up to the model; record the result honestly) |
| V4 approval | an unapproved definition | refused at start; approval via the native dialog; then it runs |
| V5 crash during checks | kill the Workflow Host while a check runs | the check process is reaped, verification re-run (`runNo 2`), no duplicate execution |
| V6 review (R2, if accepted) | `requireReviewer` + criteria | REVIEW_COMPLETED, citations shown, the digest unchanged |
| V7 stop during verification | STOP while a long check runs | STOPPED, no orphan |

Quota estimate: about 8–12 Claude calls and 8–12 Codex calls. The checks themselves are local.

## 6. Failure modes (item 19)

| Failure | Detection | Result |
|---|---|---|
| A check command is not installed | spawn ENOENT | FAIL / CHECK_ENVIRONMENT → WAIT_HUMAN (not retried) |
| A check hangs | timeout | tree killed; FAIL / CHECK_TIMEOUT → retryable |
| A check floods its output | the 5 MB cap | OUTPUT_CAPPED → ERROR → FAIL / CHECK_ENVIRONMENT |
| A check modifies the tree | the digest around it | WARNING (OQ-M6-04), or CHECK_TAMPER if it touches protected paths |
| The agent edits the tests or the check config | `path-untouched` | FAIL / CHECK_TAMPER |
| A run starts during verification (CLI user) | quiescence | UNKNOWN → one re-run → NEEDS_HUMAN |
| The definition changes after approval | the hash differs | APPROVAL_MISSING / refused at start |
| The reviewer approves without evidence | the citation check | REJECT |
| The reviewer output is malformed | the parser | NEEDS_HUMAN |
| The reviewer edits files | the digest | discarded → NEEDS_HUMAN |
| The reviewer provider is not ready / quota | NOT_STARTED / QUOTA | NEEDS_HUMAN |
| Workflow Host crash during checks | recovery | reap + re-run (≤ 2) |
| Main crash during checks | the Workflow Host dies (`with-parent`) → checks die | INTERRUPTED; resume re-runs verification |
| Identical failures twice | stuck detection | WAIT_HUMAN |
| Quota exhausted mid-retry | QUOTA class | NEEDS_HUMAN, never retried |
| Deadline during verification | watchdog | STOPPED (DEADLINE) → FAILED |

## 7. Implementation increments (M6.0 – M6.9)

| Inc. | Objective | Depends on | Key tests | Rollback risk |
|---|---|---|---|---|
| **M6.0** | Decision closure: accept or amend ADR-021 … ADR-030; answer the blocking OQs (01, 02, 04, 05, 10) | M5 release | — | none |
| **M6.1** | Verification domain (pure): M6 definition fields + V1–V9; `decideVerification`; evidence types; failureSummary builder; RetryPolicy; the replay-compatibility suite | M6.0 | pure tables; M5 golden replay | very low |
| **M6.2** | WorkspaceProbe + CheckRunner + ApprovalStore; `verification.json`; decider inputs `VERIFICATION_EVIDENCE`; `CHECK_COMPLETED` events | M6.1 | real processes/git in temp dirs; security | low |
| **M6.3** | Reviewer: parser + input builder (pure); **then** ReviewPort R2 + the additive `BridgeEngine.review()`, as an isolated commit gated on ADR-027 | M6.1 (+M6.2 for evidence) | fake Codex; BridgeEngine tests unchanged | medium (BridgeEngine) |
| **M6.4** | Retry: the decider's retry transitions, the step-planner retry context, stuck detection, the `retry` answer | M6.1, M6.2 | engine integration with fake ports | low |
| **M6.5** | Recovery: the VerificationRun crash matrix, identity-based reaping, review adoption, (`resume-execution` answer, OQ-M6-11) | M6.2–M6.4 | the crash matrix; the Windows orphan test | low |
| **M6.6** | CLI + desktop wiring: approve/revoke, the new IPC channels, native confirmation, the smoke count | M6.2, M6.4 | IPC/security tests; smoke | medium (IPC) |
| **M6.7** | UI: attempt history, evidence, review, approval banner, wording rules | M6.6 | renderer tests; real Electron at 1080×700 | low |
| **M6.8** | Real E2E (§5); quota approval | M6.1–M6.7 | §5 | none |
| **M6.9** | Release audit (docs/40-style gate) and commit | M6.8 | full regression | none |

```
M5.10 ─► M5 release audit ─► M6.0 ─► M6.1 ─┬─► M6.2 ─┬─► M6.4 ─► M6.5 ─► M6.6 ─► M6.7 ─► M6.8 ─► M6.9
                                            └─► M6.3 (pure part) ─► M6.3-R2 (gated ADR-027) ──┘
```

M6.3-R2 may slip past M6.9 (then M6 ships with `requireReviewer` still reserved). Nothing else
in M6 depends on it.

## 8. Acceptance criteria (item 25)

M6 is accepted only if all of these hold, with evidence:

| ID | Criterion |
|---|---|
| AC-M6-01 | Every M5 definition validates unchanged (identical hash) and runs with an identical outcome (PASS/AI_ATTESTED for CLAIM_DONE) |
| AC-M6-02 | Every M5 event log (fixtures + real M5.10 logs) replays byte-identically under the M6 decider |
| AC-M6-03 | A step can reach VERIFIED only through ≥ 1 required deterministic check passing; tests prove no path through review, human answer or UNKNOWN reaches VERIFIED |
| AC-M6-04 | A required check FAIL/ERROR can never be overridden (review, `acceptAiOnly`, human answer) |
| AC-M6-05 | A retry always creates a new attempt **and** a new execution (new runId, new Claude session); `RESUME_EXECUTION` is never issued for a REJECTED attempt |
| AC-M6-06 | Attempts ≤ `maxAttempts` ≤ 5; all budgets enforced; stuck detection proven by tests |
| AC-M6-07 | The crash matrix (docs/43 §4) passes with zero duplicate executions and ≤ 2 verification runs per attempt; orphaned check processes are reaped by identity on Windows |
| AC-M6-08 | Command checks run only with a hash-pinned approval obtained through a host-owned confirmation; the renderer cannot approve or supply commands |
| AC-M6-09 | Checks run without a shell, with a timeout, a capped and redacted output, and a tree kill; the refused interpreters are refused |
| AC-M6-10 | The review (if shipped) is read-only (digest-guarded), parsed fail-closed, citation-checked, and never raises the evidence level |
| AC-M6-11 | The UI shows the attempt history, evidence and review; the words "verified"/"tests passed" appear only for VERIFIED |
| AC-M6-12 | The real E2E V1, V2, V4, V5, V7 pass (V3/V6 recorded honestly); zero orphan processes after each |
| AC-M6-13 | The full regression (EXISTING + new) is green; typecheck and build pass; smoke updated |
| AC-M6-14 | No M7/M8/M9 feature is implemented; BridgeEngine is changed only by the ADR-027 addition (if accepted) |

## 9. M6.0 entry gate (READY FOR IMPLEMENTATION, M6)

- [ ] M5.10 real E2E PASS, including the Workflow Host crash (E) and Electron Main crash (F) scenarios
- [ ] M5 release audit done; the baseline committed (rollback point)
- [ ] ADR-021 … ADR-030 ACCEPTED (or amended) in docs/38
- [ ] OQ-M6-01, 02, 04, 05, 10 answered in writing
- [ ] A golden corpus of M5 event logs captured (for AC-M6-02)
- [ ] The M6 real-E2E sandbox design (§5) reviewed; quota approval process confirmed

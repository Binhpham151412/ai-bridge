# 34 — Local Storage and Retention (PROPOSED)

## 1. Purpose

Design the local storage layout for current and future records, classify what is
persistent vs temporary, define raw CLI output handling, retention, rotation, cleanup and
artifact limits, and specify a future Storage Manager, so that `.ai-bridge/` cannot grow
without bound.

## 2. Current State (EXISTING — measured from code)

```
<project>/.ai-bridge/
  config.json                                  small
  state/{current-session.json, lock, pause-request}
  sessions/<runId>/                            per run; never deleted by AI Bridge
    NNN-claude-prompt.md, NNN-chatgpt-input.md, NNN-chatgpt-review.md, NNN-extracted-prompt.md
    NNN-integrity.json, NNN-{claude,codex}-execution.json
    NNN-{claude,codex}-stdout.jsonl (≤50 MB each, redacted), NNN-*-stderr.log
    NNN-claude-report.md, NNN-review.md, session.md, final-report.md   (journal, derived)
  reports/NNN-report.md                        SHARED across runs (overwritten by later runs)
  logs/events.jsonl(.1), ai-bridge.log(.1)     rotated at 10 MB (≈20 MB max each)
  logs/YYYY-MM-DD-session.log                  one per day, never rotated/deleted
app userData: app settings (defaultProjectPath only)
```

Growth today: `sessions/` is unbounded (worst case per iteration ≈ 2 × 50 MB stdout + small
files), and daily session logs are unbounded. `reset()` touches only `state/`.

## 3. Proposed layout (additions only; EXISTING paths unchanged)

```
<project>/.ai-bridge/
  (EXISTING as above)
  state/workflow-lock                                   M5
  workflows/
    definitions/<definitionId>.json                     M5 (source of truth for definitions; ADR-018)
    approvals.json                                      M6 (definition hash approvals)
    instances/<workflowId>/
      definition.json                                   the instance's pinned copy of its definition (M5.3);
                                                        its hash must equal the definitionHash in WORKFLOW_CREATED
      instance.json                                     snapshot (AtomicJsonWriter)
      events.jsonl                                      append-only, hash-chained
      attempts/<stepId>-<n>.json                        attempt records (audit copies, derived from the snapshot)
      attempts/<stepId>-<n>/task.md                     exact task text sent (hash in the record)
      attempts/<stepId>-<n>/verification.json           M6
      attempts/<stepId>-<n>/check-<id>.{stdout,stderr}.log   M6 (capped, redacted)
      workflow.md                                       derived journal
  capabilities/{index.json, manifests/*.json}           M7
  memory/{project/*.md, proposals/*.md}                 M8
app userData/
  capabilities/, memory/                                M7/M8 (global scope)
```

## 4. Record classes

| Class | Examples | Persistence | Retention default (PROPOSED) |
|---|---|---|---|
| **Audit-critical** | attempt records, verification records, workflow events, execution records, integrity files, prompts/task texts, Codex inputs/responses | persistent | kept while referenced by a non-deleted workflow/session; deleted only by explicit user cleanup |
| **Derived** | journals (`session.md`, `workflow.md`, …), indexes | regenerable | may be deleted any time; rebuilt on demand |
| **Raw CLI output** | `*-stdout.jsonl`, `*-stderr.log`, `check-*.log` | persistent but bulky | eligible for cleanup after N days (default 30) **for terminal sessions only**; the execution record keeps the byte counts + sha256 of what was deleted |
| **Operational logs** | `events.jsonl`, `ai-bridge.log`, daily session logs | rotated | EXISTING rotation; PROPOSED: daily session logs kept 30 days |
| **Temporary** | `*.tmp-<pid>-<uuid>` (AtomicJsonWriter), pause marker, lock | transient | stale temp files removed by the Storage Manager scan |
| **Config/approvals** | `config.json`, `approvals.json`, manifests | persistent | never auto-deleted |

## 5. Limits (PROPOSED)

| Limit | Value | Enforcement |
|---|---|---|
| Per-stream CLI output | 50 MB (EXISTING) | runProcess |
| Artifact returned to the UI | 512 KB (EXISTING) / 256 KB tail (EXISTING) | session-history |
| Check output per stream | 5 MB | verification runner |
| Task text per attempt | 256 KB | step-planner (rejects above) |
| Workflow events per instance | ~bounded by the budget caps; soft warning at 10 MB | store |
| Total `.ai-bridge/` size warning | 2 GB (configurable) | Storage Manager report; **warn, never auto-delete** |

## 6. Storage Manager (FUTURE, M5.x or M6)

- `scan()` → a report: size per class, per session and per workflow; stale temp files;
  orphans (sessions not referenced by any workflow are *not* orphans; they are standalone
  runs).
- `plan(policy)` → a list of deletions with bytes, **dry-run by default**.
- `apply(plan)` → deletes only what the plan listed, only for **terminal** runs/instances,
  never while a run lock or workflow lock is held, and records a `STORAGE_CLEANED` entry
  (what, sha256, bytes) in a `logs/storage.jsonl` audit file.
- Never deletes: config, approvals, anything of a non-terminal instance, the current
  session, audit-critical records unless the user explicitly selects "delete session".
- Invoked only by an explicit user action (CLI command / UI button), or by an opt-in
  schedule setting.

## 7. The shared `reports/` directory (DECIDED for M5 — ADR-019)

The EXISTING design writes every run's report to `.ai-bridge/reports/NNN-report.md`, so
workflows (many runs) overwrite reports far more often than today. What is safe today:
the Codex input keeps a verbatim, hash-verified copy (session-history resolves it).

**M5 decision (ADR-019, accepted at M5.0):** option (a). **The existing `reports/`
directory is kept as-is.** BridgeEngine's report contract is not changed in M5, and
`reports/NNN-report.md` may still be overwritten by later runs. The per-session copy
(`sessions/<runId>/NNN-chatgpt-input.md`, resolved and hash-verified by session-history)
is the forensic copy. Workflow records, views and journals reference it by runId, never
`reports/NNN-report.md` by path. Verification in M6 reads the report immediately after
the execution, before any other run can overwrite it (the workflow lock plus the run lock
guarantee this).

Option (b), a BridgeEngine change to write reports under `sessions/<runId>/reports/`
(it changes the report-contract path and needs its own ADR plus migration of the history
readers), remains a possible **future** migration. It is **explicitly not part of M5**.

## 8. Responsibilities / Boundaries

- BridgeEngine keeps writing its files exactly as today. The Storage Manager may delete
  its **raw output** files only for terminal sessions, and it records the deletion. It
  never edits them.
- The WorkflowEngine writes only under `workflows/` and `state/workflow-lock`.

## 9. Data Flow

`writers → class-specific paths → Storage Manager scan → plan → user approval → apply →
storage audit log`.

## 10. Failure Cases

| Case | Handling |
|---|---|
| Disk full during an atomic write | The write throws → the engine stops at the last durable state (never half-state) |
| Cleanup during a run | Refused (lock check) |
| The user deletes files manually | Readers already tolerate missing artifacts (EXISTING `MISSING`/`UNKNOWN` handling); workflow views show "artifact deleted" |
| A torn JSONL line | Skipped on read (EXISTING for events); truncated with an audit note for workflow events |

## 11. Decisions

ADR-008 (local-first storage); ADR-018 (definitions location); ADR-019 (reports/ kept
as-is for M5).

## 12. Open Questions

Default retention days; whether the 2 GB warning is shown in System view. (The reports
directory and the definitions location were closed at M5.0 by ADR-019 and ADR-018.)

## 13. Explicitly Out of Scope

Cloud sync, compression or archiving formats, databases (SQLite etc.). JSON/JSONL/Markdown
files stay the storage format (EXISTING principle "no new database").

## 14. Risks

- Deleting raw output reduces forensic depth: the counts and hashes are kept, and cleanup
  is opt-in.
- Target projects not gitignoring `.ai-bridge/`: the EXISTING doctor then reports
  uncommitted changes. PROPOSED: document it, and optionally suggest a `.gitignore` entry
  (never auto-edit the user's files).

# 51 — M8 Memory: Provenance, State Machines, Persistence, Events, Recovery, Security, Limits (PROPOSED)

Covers items 7 (the memory contracts) and 8–13 of the M8 definition (docs/49 §0). Status legend:
see docs/41.

## 1. Provenance record (on every entry, proposal and retrieved block)

```ts
// Documentation example — NOT in source.
interface Provenance {
  schema: 1;
  origin: 'HUMAN' | 'RUN_ARTIFACT' | 'WORKFLOW_RECORD' | 'VERIFICATION_EVIDENCE' | 'DERIVED_INDEX';
  ref: string;                  // e.g. "human:cli", "run:2026-10-01_003/001-claude-report.md",
                                //      "attempt:wf_2026-10-01_001/implement/2/verification.json",
                                //      "file:src/cli.ts@27fb871", "graph:<artifactSha256>#<nodeId>"
  refSha256: string | null;     // hash of the cited source bytes at capture time; null = UNKNOWN
  capturedAt: string;           // when AI Bridge recorded it
  sourceTime: string | null;    // when the source was produced (run end, commit time); null = UNKNOWN
  aiOriginated: boolean;        // true for anything whose text came from a model (reports, reviews)
  promotedBy: 'human' | null;   // set only on entries
  promotedAt: string | null;
  indexerConfidence: string | number | null;   // only for DERIVED_INDEX, verbatim; else null
}
```

Timestamp semantics: `capturedAt` ≠ `sourceTime`. Both are ISO-8601 UTC from the host clock,
and there is never an inferred time. Confidence semantics: AI Bridge **never** assigns a
confidence. It only carries an indexer-reported value or `null`, and the UI shows `null` as
UNKNOWN.

## 2. Memory entry (Markdown with front matter; human-readable, diffable)

```markdown
---
schema: 1
key: build-commands            # kebab-case, unique per scope
scope: project                 # project | user
tags: [build, test]
provenance: { origin: HUMAN, ref: "human:desktop", capturedAt: "2026-10-02T09:12:00Z", aiOriginated: false, promotedBy: human, promotedAt: "2026-10-02T09:12:00Z" }
validity: ACTIVE               # ACTIVE | SUPERSEDED | RETIRED
supersedes: null
sha256: "<sha256 of the body>"
---
Tests: `pnpm test` (node --test). Typecheck: `pnpm typecheck` (root + renderer configs).
```

## 3. State machines

### 3.1 Proposal

```
PROPOSED ──human promote──► PROMOTED (→ creates/updates an entry)
    │ └──human reject────► REJECTED
    └──source invalidated (the cited ref's hash changed) ──► OBSOLETE
```

### 3.2 Entry

```
ACTIVE ──new version promoted──► SUPERSEDED (kept for audit; the new entry has supersedes: <old sha256>)
   └──human retire──────────────► RETIRED    (never retrieved; kept until the user deletes it)
```

An entry's cited `refSha256` no longer matching its source → the entry stays ACTIVE but is
retrieved with `sourceChanged: true` in its label. Facts written by humans are not invalidated
automatically; they are flagged.

### 3.3 Graph index (docs/50 §3)

```
NOT_PINNED ──human pin──► PINNED(FRESH | STALE | UNKNOWN) ──artifact changed──► NEEDS_REPIN ──human pin──► PINNED
                                    └── unreadable ─────► UNAVAILABLE
```

## 4. Persistence model

```
<project>/.ai-bridge/memory/
  project/<key>.md                 entries (human-readable; optionally exported/committed, OQ-M8-01)
  proposals/<proposalId>.md        pending proposals (same front matter + status)
  index/graph-pin.json             GraphPin (docs/50 §3)
  memory.log.jsonl                 append-only, hash-chained audit (proposed/promoted/rejected/retired/pinned)
app userData/memory/user/<key>.md  long-term (user) entries
workflows/instances/<id>/attempts/<step>-<n>/context.json   per-attempt retrieval record (below)
```

```jsonc
// context.json — what the attempt actually received (reproducibility; ADR-038)
{ "schema": 1, "memory": [ { "key": "build-commands", "scope": "project", "sha256": "…", "bytes": 212, "truncated": false, "provenanceRef": "human:desktop", "sourceChanged": false } ],
  "graph": { "pinSha256": "…", "freshness": "STALE", "reasons": ["TREE_DIRTY"], "query": { /* GraphQuery */ }, "resultSha256": "…", "items": 12 },
  "unavailable": [] , "totalChars": 3120 }
```

Write order: an entry file (atomic rename) → a `memory.log.jsonl` append. Proposals follow the
same order. `context.json` is written **before** `task.md` (both come before `START_EXECUTION`,
as write-ahead, like the EXISTING task file).

## 5. Event model

- **memory.log.jsonl** (per scope): `MEMORY_PROPOSED`, `MEMORY_PROMOTED`, `MEMORY_REJECTED`,
  `MEMORY_RETIRED`, `GRAPH_PINNED` in the docs/27 envelope style (seq, prevHash, hash, actor).
- **Workflow events** (a new type, ADR-023): `CONTEXT_ASSEMBLED {stepId, attemptId,
  memoryKeys[], memorySha256, graphFreshness, graphResultSha256, unavailable[]}`, once per
  attempt, in the batch that plans the attempt. Proposals from a workflow add `MEMORY_PROPOSED
  {proposalId}` to the workflow log as well (a reference).

## 6. Recovery model

Memory is read-only to workflows and has no influence on decisions, so recovery is trivial:

| Situation | Handling |
|---|---|
| Crash while writing an entry/proposal | The temp file is left behind; the log has no event → the file is ignored and cleaned by the Storage Manager scan (docs/34) |
| Crash after `context.json`, before `START_EXECUTION` | The EXISTING LAUNCHING reconciliation; `context.json` is reused only if its hash matches the one recorded in `CONTEXT_ASSEMBLED`; else re-assembled **before** relaunch (nothing ran) |
| Resume of a paused/interrupted execution | No re-assembly (same execution, same task) |
| Retry (a new attempt) | Re-assembled from the **pinned** keys; the resulting hashes are compared with attempt 1's and the difference recorded |
| memory.log broken chain | Memory read-only; retrieval continues from the entry files (they carry their own sha256) with a `LOG_BROKEN` flag |

## 7. Security boundaries

- Only hosts (the CLI, or Main after a native confirmation) promote, retire, pin or delete.
  Workflows can only propose; executions can do nothing.
- Proposal intake runs `redactSecrets`; a proposal still matching secret patterns after redaction
  is refused.
- Retrieved text is always a labelled untrusted block with its provenance line. AI-originated
  entries keep `aiOriginated: true` forever, and their label says so.
- Keys are kebab-case; file names are derived from keys (no caller-supplied paths; the EXISTING
  `RUN_ID_PATTERN` style).
- Long-term memory never leaves the machine; there is no sync.

## 8. MemoryPort (docs/31 §3.3, made concrete)

```ts
interface MemoryPort {
  read(keys: { scope: 'project' | 'user'; key: string }[], budgetChars: number): Promise<MemoryBlock[]>;
  query(q: GraphQuery, budgetChars: number): Promise<GraphQueryResult>;          // docs/50 §4
  propose(p: { key: string; text: string; provenance: Provenance }): Promise<{ proposalId: string } | { refused: 'SECRET' | 'TOO_LARGE' | 'INVALID_KEY' }>;
}
interface MemoryBlock { key: string; scope: string; text: string; provenance: Provenance; sha256: string; truncated: boolean; sourceChanged: boolean }
// NullMemoryPort (default until a project enables memory): read → [], query → UNAVAILABLE(NOT_PINNED), propose → refused.
```

Assembly order in the task text (deterministic): the instruction → the EXISTING step outputs →
memory blocks in the declared key order → graph block → (M6) the retry context. Each has its own
cap, and truncation is recorded.

## 9. Hard limits

| Limit | Value |
|---|---|
| entries per scope | 500 |
| entry body | 8 KB |
| proposal body | 8 KB; pending proposals per project 200 |
| memory keys per step | 10 |
| memory context per step (memory + graph) | 16 KB (the EXISTING `maxContextChars`), inside the 256 KB task cap |
| graph context per step | 8 KB (docs/50 §7) |
| proposals created per workflow | 20 |

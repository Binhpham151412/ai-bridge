# 50 — M8 Graphify Boundary: A Derived, Optional, Pinned Index (PROPOSED — documentation only)

Status legend: see docs/41. ADR-037 (PROPOSED).

## 1. Position in the architecture

```
source of truth                           derived (disposable)                 consumer (optional)
─────────────────                         ───────────────────                   ───────────────────
git tree @ commit + working tree ──►  [Graphify, external tool, run by   ──►  GraphIndexAdapter ──► ContextAssembler ──► task.md
project docs, memory entries           the user (or an M7 tool, M8.6)]         (read-only, pinned)     (labelled, capped)
                                       └► graph.json (+ report, cache)
```

Graphify is **not** part of AI Bridge. It is never bundled, installed or updated by AI Bridge, and
it is never on the path of execution, verification, workflow decisions or recovery.

## 2. What AI Bridge may assume about the artifact

Only what it verifies each time it loads the file. The facts of docs/49 §3 describe the version
observed on 2026-09-30. They are **not** a contract. The adapter therefore:

- parses defensively: an unknown top-level shape → `UNAVAILABLE (FORMAT_UNSUPPORTED)`;
- accepts `nodes[]` / `links[]` with string ids and optional `source_file` / `source_location`;
  ignores unknown fields;
- carries the indexer's `confidence` / `confidence_score` through **verbatim** as
  `indexerConfidence`, never re-interpreted, never computed;
- takes `built_at_commit` if present. If it is absent, commit pinning is UNKNOWN, and the result
  is always `stale: UNKNOWN`.

## 3. Pinning, staleness, invalidation

```ts
interface GraphPin {                      // stored in .ai-bridge/memory/index/graph-pin.json
  artifactPath: string;                   // project-relative, e.g. "graphify-out/graph.json"; containment rules as docs/42 §3.2
  artifactSha256: string; artifactBytes: number;
  builtAtCommit: string | null;           // from the artifact, else null (UNKNOWN)
  pinnedAt: string; pinnedBy: 'human';    // pinning is a host action (CLI / Main)
  adapter: { id: 'graph:node-link'; version: string };
}
type Freshness =
  | { state: 'FRESH' }                                        // builtAtCommit == HEAD and the working tree is clean for indexed paths
  | { state: 'STALE'; reasons: ('HEAD_MOVED' | 'TREE_DIRTY' | 'ARTIFACT_CHANGED')[] }
  | { state: 'UNKNOWN'; reason: 'NO_COMMIT_IN_ARTIFACT' | 'NOT_A_GIT_REPO' }
  | { state: 'UNAVAILABLE'; reason: 'MISSING' | 'UNREADABLE' | 'TOO_LARGE' | 'FORMAT_UNSUPPORTED' | 'NOT_PINNED' };
```

- **Invalidation triggers** (evaluated at every query; cheap): the artifact sha256 differs from the
  pin → `ARTIFACT_CHANGED` (it must be re-pinned by a human before use); HEAD ≠ `builtAtCommit` →
  `HEAD_MOVED`; the porcelain digest shows changes → `TREE_DIRTY`.
- **Policy**: `STALE` results are returned **flagged** by default. A step may declare
  `context.graph.allowStale: false`, and then STALE → no results (OQ-M8-06). UNKNOWN is treated
  as STALE.
- **Rebuild**: never automatic in M8.0–M8.5. The user runs the indexer and then re-pins (CLI/UI).
  M8.6 (optional) lets a registered M7 `tool` capability invoke it, as an explicit user action,
  never while a workflow or run lock is held, never from an execution.

## 4. GraphIndexAdapter contract (documentation example)

```ts
interface GraphIndexAdapter {
  describe(): Promise<{ pin: GraphPin | null; freshness: Freshness; nodes: number; links: number }>;
  query(q: GraphQuery): Promise<GraphQueryResult>;       // read-only; never throws for data problems
}
interface GraphQuery {                                    // deterministic, no free-text ranking in M8
  anchors: { kind: 'file' | 'symbol'; value: string }[];  // e.g. {file: "src/core/workflow/engine.ts"}
  relations?: string[];                                   // filter on the indexer's relation names
  depth: 1 | 2;                                           // neighbourhood depth
  limit: number;                                          // ≤ 20
}
type GraphQueryResult =
  | { status: 'OK'; freshness: Freshness; items: GraphItem[]; truncated: boolean }
  | { status: 'UNAVAILABLE'; freshness: Freshness };
interface GraphItem {
  nodeId: string; label: string; relation: string | null;
  sourceFile: string | null; sourceLocation: string | null;
  indexerConfidence: string | number | null;             // verbatim, or null
  provenance: { artifactSha256: string; builtAtCommit: string | null };
}
```

Ordering is deterministic (by relation, then source file, then node id), so the same pin and
query → the same bytes → the same hash in the attempt record.

## 5. Never an execution dependency (normative)

| Component | May read the graph? |
|---|---|
| BridgeEngine, Orchestrator, adapters | **no** |
| Workflow decider, reconciler, budgets, outcome mapper | **no** |
| Verification engine, reviewer input builder (M6) | **no** (the reviewer judges evidence and the diff, not derived facts) |
| Capability registry and resolver (M7) | **no** |
| Step-planner ContextAssembler | **yes**, only for steps that declare `context.graph` |
| UI (read-only display of index status and a result preview) | **yes** |

Failure behavior: every failure is `UNAVAILABLE` or `STALE`, recorded in the attempt's `context`
record, and the step proceeds without the graph block. The system is fully functional with
Graphify absent, uninstalled, broken or years stale. That is tested by running the whole M8 test
suite with no artifact present.

## 6. Security

- The artifact is **untrusted derived data**. Its text enters prompts only as a labelled block
  `--- BEGIN DERIVED CODE GRAPH @<commit> (stale: …) ---`.
- Redaction (`redactSecrets`) runs on every retrieved label and location. Nodes whose
  `source_file` matches the exclusion globs (default `.env*`, `**/*.pem`, `**/*secret*`,
  `.git/**`, `.ai-bridge/**`) are dropped (OQ-M8-07).
- The artifact path must be inside the project (the docs/42 §3.2 rules). No symlink escape.
- Size cap: 50 MB for the artifact; larger → `UNAVAILABLE (TOO_LARGE)`. Parse time is bounded by
  streaming JSON parsing with a node/link count cap (200 000 / 1 000 000).

## 7. Limits

| Limit | Value |
|---|---|
| artifact size | 50 MB |
| nodes / links parsed | 200 000 / 1 000 000 |
| query depth / results | 2 / 20 |
| graph context per step | 8 KB (inside the step's memory budget, docs/51 §9) |
| pins per project | 1 active (FUTURE: several indexes) |

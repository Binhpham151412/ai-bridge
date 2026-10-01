# 49 — M8 Memory: Architecture (PROPOSED — documentation only)

Extends docs/31 (memory architecture; its layers, MemoryPort sketch and read/write table are
kept). Status legend: see docs/41. PROPOSED ADRs: ADR-036 … ADR-038 (docs/58).

## 0. Section map (the 25 required items for M8)

| # | Item | Where |
|---|---|---|
| 1–6 | Purpose, problem, scope, non-goals, changes, concepts | this doc §1–§7 |
| 7 | Contracts | docs/50 §4 (graph adapter), docs/51 §1 and §8 (provenance, MemoryPort) |
| 8–13 | State machines, persistence, events, recovery, security, limits | docs/51 |
| 14–19, 25 | CLI, Main, UI, testing, real E2E, failure modes, acceptance | docs/52 |
| 20–24 | Compatibility, dependencies, open questions, ADRs | this doc §9–§13 |

## 1. Purpose

Let workflows use **curated project knowledge** (build commands, conventions, decisions, known
pitfalls) and an optional **derived code-knowledge graph**, with full provenance. This must
never make memory or the graph a source of truth for execution or workflow state, and never
make the system depend on them.

## 2. Problem being solved

1. Every execution starts from the task text alone. Knowledge the user already stated ("tests
   need `pnpm test -- --runInBand`", "never touch `legacy/`") must be repeated in each definition.
2. Useful facts appear in run artifacts (reports, verification failures) but are lost to later
   workflows, or would be copied around unlabelled.
3. A code graph (Graphify) exists as a developer tool, but it is not connected. If it were
   connected naively it would inject **stale** facts: the repo's own `graphify-out/graph.json`
   records `built_at_commit = 15d4f9e…` while HEAD is `27fb871` and the working tree has a large
   uncommitted M5 diff (EXISTING fact, 2026-09-30). docs/31 §2 already observed it listing
   deleted components.

## 3. Current state (EXISTING, verified)

- There is no memory subsystem. The M5 validator rejects a non-empty `context.memory` with
  `RESERVED_FEATURE` (M8) (`validator.ts:424`).
- The step-planner assembles the task text from the instruction + declared step outputs (labelled
  blocks, `maxContextChars` 16 KB, `maxTextBytes` 256 KB; `definition.ts`).
- `graphify-out/` (gitignored, in the development repo only) holds `graph.json` in node-link
  form: `{directed, multigraph, graph, nodes[], links[], hyperedges[], built_at_commit}`. Nodes
  carry `id, label, source_file, source_location, community, file_type, …`. Links carry
  `source, target, relation, confidence, confidence_score, source_file, source_location,
  weight, _origin`. The observed relation kinds include `calls, contains, imports,
  imports_from, implements, inherits, references, re_exports, method, indirect_call,
  conceptually_related_to, rationale_for`. It was produced by a Python tool (a `uv` tool
  environment). These are observed facts about **this** artifact version; the format is not a
  contract AI Bridge controls.

## 4. Scope (M8)

- **Project memory**: human-readable Markdown entries with provenance front matter, under
  `.ai-bridge/memory/project/`. Long-term (user) memory lives in app userData.
- **Proposals**: steps (or the user) may *propose* entries; only a human promotes them (ADR-036).
- **MemoryPort** with a Null default (docs/31 §3.3): `read(keys)`, `query(q)` (optional),
  `propose(entry)`.
- **Context assembly**: a step declares `context.memory` keys → labelled, capped, hashed blocks
  in the task text; hashes recorded per attempt (ADR-038).
- **Graph index adapter**: read-only consumption of a derived graph artifact, pinned to a commit
  and tree digest, with staleness detection (ADR-037; docs/50).
- **Invalidation and rebuild semantics.** A rebuild is a user-invoked action. Invoking the
  indexer from AI Bridge is optional and only through an M7 `tool` capability (M8.6).
- CLI, desktop and UI for entries, proposals, promotion and index status (docs/52).

## 5. Explicit non-goals

- No automatic summarization of runs into memory; no automatic promotion.
- No vector database, no embeddings, no network retrieval (docs/31 §10). Deterministic key/tag
  retrieval first; ranked graph queries only through the adapter.
- No memory read by **BridgeEngine, the decider, the reconciler, the verification engine or the
  outcome mapper**. Memory influences only the task text.
- No memory writes from inside an execution (the report contract already forbids other writes
  under `.ai-bridge/`).
- No bundling or installing of Graphify; no Python dependency in AI Bridge.
- No memory of secrets, credentials or environment values.
- No cross-machine sync.

## 6. Architectural changes

```
            Memory Layer (NEW, optional; PROPOSED path src/core/memory/)
 ┌────────────────────────────────────────────────────────────────────────────────┐
 │ MemoryStore (project .md + userData .md, provenance front matter)             │
 │ ProposalQueue (pending proposals; promotion = host action)                    │
 │ GraphIndexAdapter (read-only; pin + staleness; docs/50)  ◄── graph artifact    │
 │ MemoryPort = { read, query, propose }  — default NullMemoryPort                │
 └─────────────────────────────┬──────────────────────────────────────────────────┘
                               │ labelled, capped blocks + provenance + sha256
                               ▼
 Workflow Engine step-planner (EXISTING, extended): ContextAssembler → task.md
 attempt record: context = {memory: [{key, sha256, provenanceRef, truncated}], graph: {pin, stale, results}}
```

| Component | Change | Status |
|---|---|---|
| `src/core/memory/*` | new store, proposals, port, graph adapter | PROPOSED |
| Definition validator | accepts `context.memory` (EXISTING reserved field); new optional `context.graph` query spec | PROPOSED (schema 1, additive) |
| Step-planner | ContextAssembler (deterministic order, caps, labels) | PROPOSED |
| Attempt record | optional `context` field | PROPOSED |
| Hosts / UI | Memory view, proposals, index status | PROPOSED |
| BridgeEngine, decider, reconciler, verification | **no change** | — |

## 7. Domain concepts

| Concept | Meaning |
|---|---|
| **Source artifact** | A file or record memory can cite: a project file at a commit, a run artifact (`sessions/<runId>/…`), a workflow record, a human statement |
| **Canonical state** | The authoritative records: definitions, workflow instances/events, execution files, git. **Memory is never canonical state** |
| **Memory entry** | A human-promoted Markdown note with a key, text and provenance |
| **Proposal** | A pending candidate entry (from a step output, a verification failure, or the user), never used for retrieval until promoted |
| **Promotion** | A human action that turns a proposal into an entry (audited) |
| **Derived index / graph** | A disposable projection over sources (e.g. Graphify's `graph.json`), rebuildable, never authoritative |
| **Node / relation** | The graph's elements, as the indexer reports them; carried through with their `source_file`/`source_location` as provenance |
| **Provenance** | Where a piece of text came from, when, by whom, and with what hash (docs/51 §1) |
| **Confidence** | Only what a source reports (e.g. Graphify's `confidence` fields) or `UNKNOWN`. AI Bridge never computes a confidence from model text |
| **Staleness** | The index was built from a commit/tree different from the current one |
| **Invalidation** | Marking entries or index results unusable because their source changed or a human retired them |
| **Retrieval** | Selecting text for a step: by declared keys (deterministic), then optional graph query results |
| **Context block** | One labelled, capped, hashed section of the task text built from retrieval |

### 7.1 Memory boundaries (what goes where)

| Category | Where it lives | Enters memory? | Who writes | Label when retrieved |
|---|---|---|---|---|
| **Project facts** (commands, conventions, pitfalls) | memory entries (project) | yes, human-promoted | human | `PROJECT MEMORY (human-curated)` |
| **Decisions** (ADRs, design choices) | the project's docs + memory entries **pointing** to them | yes, as a reference + a short summary written by a human | human | `DECISION (reference)` |
| **User preferences** (style, tone, cross-project habits) | long-term memory (userData) | yes, human-promoted | human | `USER PREFERENCE` |
| **Execution history** (runs, reports, reviews) | `sessions/` (canonical) | **references only** (runId + artifact + sha256), never copied text as fact | the system (a proposal) → human | `FROM RUN <runId> (AI-generated report)` |
| **Workflow state** (instances, attempts, verdicts) | `workflows/` (canonical) | **never** as state; a promoted entry may *cite* a terminal instance's journal | — | — |
| **Code knowledge** (structure, calls, imports) | the derived graph only | not as entries; retrieved from the pinned index | the indexer | `DERIVED CODE GRAPH @<commit> (stale: yes/no)` |
| **AI-generated claims** (report text, reviewer suggestions) | proposals only | only after a human promotes them, labelled with their origin forever | a proposal → human | `AI-ORIGINATED, HUMAN-PROMOTED` |

### 7.2 What must NOT enter memory

Secrets, tokens, credentials, cookies, environment values (redaction runs at proposal time, and
a matching proposal is refused); raw CLI stdout/stderr; live workflow/execution state or anything
from `.ai-bridge/state/`; unverified AI claims as facts; content from UNTRUSTED capabilities;
personal data beyond what the user writes; anything larger than the entry cap (docs/51 §9);
instructions addressed to agents that conflict with the permission profile (they are flagged, and
cannot be promoted without an explicit override note).

## 8. Graphify integration in one paragraph (details: docs/50)

Graphify is an **external, optional indexer**. AI Bridge reads its output artifact through a
read-only `GraphIndexAdapter`, pinned by artifact sha256 + `built_at_commit` + the current
tree digest. Results are labelled derived and untrusted, flagged stale when the pins differ, and
used only as optional context. If the artifact is missing, unreadable, too large or stale beyond
policy, the query returns `UNAVAILABLE` and the workflow proceeds unchanged. **No workflow
decision, execution, verification or recovery ever reads the graph.**

## 9. Backward compatibility (item 20)

1. Definitions without `context.memory` behave exactly as before. The NullMemoryPort returns
   nothing, and the task text stays byte-identical (test).
2. The attempt record's `context` field is optional; older attempts lack it.
3. New directories only (`.ai-bridge/memory/`, userData `memory/`).
4. Downgrade: an M7 build rejects definitions with `context.memory` (`RESERVED_FEATURE` M8),
   failing closed.

## 10. Dependencies on previous phases (item 21)

- **M5**: the step-planner, labelled blocks, attempt records, `maxContextChars`.
- **M6**: verification failures as a proposal source (optional); the retry context stays separate
  from memory.
- **M7**: only for M8.6 (invoking the indexer as a registered `tool` with `process.exec`), and for
  `memory.read`/`memory.propose` permissions on agents. **M8.1–M8.5 do not need M7.**

## 11. Dependencies on later phases (item 22)

None. M9 may give specialist agents different memory key sets; that is configuration, not a new
mechanism.

## 12. Open questions (item 23)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| OQ-M8-01 | Commit project memory to git? (`.ai-bridge/` is gitignored in this repo) | The user's choice; offer an export; never auto-edit `.gitignore` | no |
| OQ-M8-02 | Long-term memory location and privacy (userData) | userData `memory/`, local only, listed in the UI with a delete action | M8.1 |
| OQ-M8-03 | `required` memory keys (BLOCKED when missing) vs always optional (docs/31 §7) | Optional only in M8; `required` FUTURE | M8.2 |
| OQ-M8-04 | Embedding retrieval | Deferred (FUTURE) | no |
| OQ-M8-05 | Invoke Graphify from AI Bridge (a Python/`uv` tool) as an M7 tool capability, or user-run only? | User-run only in M8.0–M8.5; M8.6 optional through M7 | M8.6 |
| OQ-M8-06 | Stale-graph policy: flag or refuse? | Flag by default; a per-step `context.graph.allowStale: false` refuses | M8.4 |
| OQ-M8-07 | Secrets inside the derived graph (it indexes code/comments) | Redact at retrieval; an exclusion glob list; never retrieve from `.env*` files | M8.4 |
| OQ-M8-08 | Can a verification failure summary be proposed automatically? | Yes, as a *proposal* only, labelled deterministic, with its attempt ref | M8.3 |

## 13. ADRs required (item 24)

ADR-036 (human-curated memory; AI output only as proposals), ADR-037 (the graph is an optional,
derived, pinned, read-only index, never an execution dependency), ADR-038 (deterministic
context assembly with recorded hashes). All are PROPOSED.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Memory poisoning | Human promotion only; provenance; labels; retire/delete |
| Stale graph facts | Pinning, staleness flags, optional refusal |
| Hidden coupling ("works only with this memory") | Context hashes in attempt records; memory never gates decisions |
| Prompt bloat | Per-step caps inside the EXISTING 256 KB task cap |

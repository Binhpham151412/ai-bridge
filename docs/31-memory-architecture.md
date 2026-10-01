# 31 — Memory Architecture (M8, ARCHITECTURE ONLY — not implemented)

## 1. Purpose

Define the **future boundary** for memory: what a workflow may read, what it may write,
the session, project and long-term layers, and the integration point for Graphify. It also
guarantees that Memory is **not** a dependency of M5, M6 or M7.

## 2. Current State (EXISTING)

- There is no memory subsystem in AI Bridge.
- Durable knowledge that already exists, as by-products: run artifacts and the Development
  Journal (`sessions/<runId>/*.md`), events, and Claude's own session context (inside the
  Claude CLI, resumed via `--resume`). This context is not visible to AI Bridge.
- A `graphify-out/` directory exists in this *development* repository (a knowledge-graph
  tool used by the developer). It is gitignored and unrelated to the product. Its content
  was observed to be stale relative to the code (it lists deleted components). That is a
  concrete example of why a graph must be a rebuildable projection, never the source of
  truth.

## 3. Proposed Design

### 3.1 Layers

| Layer | Scope | Content | Source of truth | Writer | Lifetime |
|---|---|---|---|---|---|
| Execution context | one run | the Claude session / Codex thread conversation | the CLIs (EXISTING) | providers | the CLI's own retention |
| **Session memory** | one workflow instance | step outputs, verification failures, decisions | workflow records (M5, EXISTING by then) | WorkflowEngine | the instance's retention |
| **Project memory** | one project | curated facts: build/test commands, conventions, known pitfalls, decisions | `.ai-bridge/memory/project/*.md` (human-readable, diffable, optionally committed) | **human**, or a human-approved proposal | until edited |
| **Long-term memory** | across projects (user) | general preferences, cross-project lessons | app userData `memory/*.md` | human-approved proposals | until edited |
| **Derived index / graph** | project | a Graphify-style graph or keyword index over project memory + code + journal | **none**: rebuildable from the sources above | the indexer (FUTURE) | disposable |

### 3.2 What a workflow may read / write

| Operation | Allowed | Mechanism |
|---|---|---|
| Read session memory | yes (M5, as declared step outputs; it is *not called* "memory" in M5) | step-planner context sections |
| Read project / long-term memory | yes, **only when the step declares it** (`context.memory: ["project:build-commands"]`) | `MemoryPort.read(keys)` → text sections with provenance, capped |
| Write project / long-term memory | **no direct writes.** A step may emit a *memory proposal* | `MemoryPort.propose(entry)` → `.ai-bridge/memory/proposals/*.md`, pending |
| Promote a proposal | a human only | UI action, logged as a workflow/audit event |
| Read the derived graph | yes, as optional retrieval | `MemoryPort.query()`; results carry provenance and "derived" labels |
| Write the derived graph | the indexer only, never a workflow | rebuild job |

Every memory entry carries provenance: `{source: runId | workflowId | human, at,
sha256}`. Retrieved text is injected into prompts as **labelled untrusted context**, the
same boundary as reports (docs/07 "untrusted content boundary").

### 3.3 MemoryPort (FUTURE EXTENSION, documentation example)

```ts
interface MemoryPort {
  read(keys: string[], budgetChars: number): Promise<{ key: string; text: string; provenance: Provenance; truncated: boolean }[]>;
  query(q: string, k: number): Promise<{ text: string; provenance: Provenance; score: number }[]>;   // optional
  propose(e: { key: string; text: string; provenance: Provenance }): Promise<{ proposalId: string }>;
}
// Default in M5–M7: NullMemoryPort — read → [], query → [], propose → rejected (not configured).
```

### 3.4 Graphify integration point (FUTURE)

- Graphify (or any graph tool) is treated as an **external indexer** producing a derived
  artifact (for example `graph.json`) from the project and memory files. AI Bridge consumes
  it only through `MemoryPort.query` via an adapter.
- Staleness: the index records the source hashes (or the git HEAD) it was built from. A
  query against a stale index returns results flagged `stale: true`, or the adapter
  refuses by policy.
- Graphify never writes to `.ai-bridge/` state, workflows or sessions.

### 3.5 Why Memory is not an M5 dependency

1. The M5 definition format reserves `context.memory`, but the M5 validator **rejects** a
   non-empty value ("memory not available").
2. M5 code has no MemoryPort. It is introduced in M8 with a Null default.
3. Nothing in workflow correctness (state, recovery, verification) may depend on memory
   content. Memory only changes prompt text.

## 4. Responsibilities

The Memory subsystem (M8) owns storage, proposals, promotion and retrieval. It owns no
workflow decisions and no execution. Humans own truth.

## 5. Boundaries

- BridgeEngine never reads memory. If memory influences an execution, it does so only
  through the task text the workflow composes.
- There is no memory write from inside an execution (Claude must not write
  `.ai-bridge/memory/`; the report contract already says "Do not modify any other file
  under .ai-bridge/", EXISTING).

## 6. Data Flow

`step declares context.memory → MemoryPort.read → labelled sections → step-planner → task
text`; `step output → propose → pending proposal → human promote → project memory →
(re)index`.

## 7. Failure Cases

| Case | Handling |
|---|---|
| Memory poisoning (a wrong lesson promoted) | Provenance; entries editable and deletable; proposals never auto-promoted |
| Stale graph | Hash/HEAD pinning; `stale` flag |
| Memory unavailable | Optional by design; the step proceeds without it and records `memory: unavailable` |
| Oversized memory | Per-read budget; truncation recorded |

## 8. Decisions

ADR-006 (memory is optional).

## 9. Open Questions

Embedding-based retrieval (defer: deterministic key/tag retrieval first); committing
project memory to git (the user's choice); a long-term memory location and its privacy.

## 10. Explicitly Out of Scope

Any implementation; automatic summarization of runs into memory; vector databases;
network services.

## 11. Risks

- Hidden coupling: a workflow "works" only with a certain memory state. Mitigation:
  memory content is recorded (hash) in the attempt record, so runs are reproducible to the
  extent memory is.
- Privacy of long-term memory across projects: stays local; no sync.

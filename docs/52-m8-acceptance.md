# 52 — M8 Memory / Graphify: Hosts, UI, Testing, Real E2E, Failure Modes, Increments, Acceptance (PROPOSED)

Covers items 14–19 and 25 of the M8 definition (docs/49 §0). Status legend: see docs/41.

## 1. CLI implications (item 14)

| Command | Behavior |
|---|---|
| `ai-bridge memory list [--scope project\|user]` | entries (key, tags, validity, `aiOriginated`, `sourceChanged`) |
| `ai-bridge memory show <key>` | the entry + provenance |
| `ai-bridge memory add <key> --from-file <path>` | a human entry (the file is read, redacted, validated) |
| `ai-bridge memory proposals` / `promote <id>` / `reject <id>` | human review of proposals (interactive confirmation for promote) |
| `ai-bridge memory retire <key>` | audited |
| `ai-bridge memory graph status` / `graph pin <artifactPath>` | freshness report / pin the current artifact (a human action) |
| `ai-bridge workflow validate --dry-run` (EXISTING) | renders the memory and graph blocks exactly as an attempt would receive them |

No command runs the indexer in M8.0–M8.5.

## 2. Electron / Main implications (item 15)

- A `MemoryController` in Main (no decisions). New IPC channels: `memory:list`, `memory:get
  {scope, key}`, `memory:listProposals`, `memory:promote {proposalId}` (Main native confirmation),
  `memory:reject {proposalId}`, `memory:retire {scope, key}`, `memory:graphStatus`,
  `memory:graphPin` (Main's native file picker, so the renderer never sends a path).
- No live-work implications for quit (memory operations are atomic and short).

## 3. Renderer / UI implications (item 16)

- A **Memory** view: entries by scope with provenance and labels; a proposals queue with
  promote/reject (Main confirms); a graph index card (pin, commit, freshness, reasons).
- The Workflow view: per attempt, the "Context received" list (keys, sizes, truncation, graph
  freshness) from `context.json`, with a link to `task.md`.
- Wording: "derived", "stale", "AI-originated" are always shown where they apply. Memory is never
  presented as verified.

## 4. Testing strategy (item 17)

| Area | Tests |
|---|---|
| Entry / proposal parsing | front matter validation; caps; key rules; sha256 of bodies |
| Redaction intake | secret-like inputs refused; redacted text persisted |
| ContextAssembler | deterministic order; caps; truncation flags; **byte-identical task text for steps without memory** (the M5/M6/M7 regression guard) |
| NullMemoryPort | the default for every EXISTING test; no behavior change |
| Graph adapter | the observed `graph.json` shape (a synthetic fixture), unknown shapes → UNAVAILABLE, huge files → TOO_LARGE, missing commit → UNKNOWN, HEAD moved / tree dirty → STALE, exclusion globs, deterministic result order |
| Independence | the full workflow suite with **no graph artifact and memory disabled** passes unchanged; a test proves no module outside `memory/` + the step-planner imports `memory/**` (an architecture test like `workflow-boundaries.test.ts`) |
| Recovery | a crash between `context.json` and START; a hash mismatch → re-assemble before relaunch |
| Hosts / IPC | payloads; the renderer cannot send paths; promotion needs the native confirmation |

## 5. Real E2E strategy (item 18; quota — explicit approval)

| Scenario | Must show |
|---|---|
| G1 memory context | a project entry "tests run with `node --test`" + a step declaring `context.memory: ["build-commands"]` → `task.md` contains the labelled block; `context.json` hash = `CONTEXT_ASSEMBLED` hash |
| G2 no Graphify | the artifact absent → a step with `context.graph` → `UNAVAILABLE` recorded; the workflow completes normally |
| G3 stale graph | the pin at an older commit → the block labelled `stale: yes (HEAD_MOVED)`; with `allowStale: false` → no block |
| G4 proposal | a step output proposed → it appears in the queue, is **not** retrieved until promoted, then is retrieved labelled AI-originated |

## 6. Failure modes (item 19)

| Failure | Result |
|---|---|
| The graph artifact is missing / corrupt / too large | `UNAVAILABLE`, recorded; the step proceeds |
| The graph is stale | flagged (or omitted under `allowStale: false`) |
| A memory entry cites a changed source | retrieved with `sourceChanged: true` |
| A secret in a proposal | refused at intake |
| A memory directory deleted | retrieval returns nothing for missing keys; recorded as `unavailable` |
| memory.log chain broken | read-only memory; retrieval continues with `LOG_BROKEN` flagged |
| Poisoned entry promoted | visible provenance; retire; M6 deterministic checks still gate DONE |

## 7. Implementation increments (M8.0 – M8.8)

| Inc. | Objective | Depends on |
|---|---|---|
| **M8.0** | Decision closure (ADR-036 … 038); OQ-M8-02, 03, 06, 07 answered | M7 release (or M6 release if M8 is scheduled before M7; see docs/57 §5.1, OQ-X-04) |
| **M8.1** | MemoryStore + entry/proposal formats + memory.log + NullMemoryPort | M8.0 |
| **M8.2** | ContextAssembler + `context.memory` in the validator + `context.json` + the `CONTEXT_ASSEMBLED` event | M8.1 |
| **M8.3** | Proposals from workflow outputs / verification summaries + human promotion flow | M8.1 (M6 for verification-summary proposals) |
| **M8.4** | Graph adapter (read-only), pinning, freshness, exclusion, limits | M8.1 |
| **M8.5** | Graph queries in the context assembly (`context.graph`) | M8.2, M8.4 |
| **M8.6** | (optional) the indexer invocation as an M7 `tool` capability, user-triggered | M7, M8.4 |
| **M8.7** | CLI + desktop + UI | M8.2–M8.5 |
| **M8.8** | Real E2E (§5) + release audit | all |

## 8. Acceptance criteria (item 25)

| ID | Criterion |
|---|---|
| AC-M8-01 | With memory disabled or no `context.memory`, the task text and outcomes are byte-identical to the previous phase |
| AC-M8-02 | No module other than the step-planner and hosts/UI reads memory or the graph (an architecture test) |
| AC-M8-03 | The system passes its full suite and real E2E G2 with Graphify absent |
| AC-M8-04 | Every retrieved block is labelled, capped and provenance-carrying, and its hash is recorded in `context.json` + `CONTEXT_ASSEMBLED` |
| AC-M8-05 | AI-originated text is retrievable only after human promotion, and stays labelled as AI-originated |
| AC-M8-06 | Staleness is detected (commit, tree, artifact hash) and never hidden |
| AC-M8-07 | Secrets are refused at intake and redacted at retrieval; exclusion globs apply to graph results |
| AC-M8-08 | Promotion, retirement and pinning are host actions with audit events; the renderer cannot perform them directly |
| AC-M8-09 | The full regression is green; the M5–M7 golden logs replay identically; no M9 feature implemented |

## 9. M8.0 entry gate (READY FOR IMPLEMENTATION, M8)

- [ ] The previous phase released (M7, or M6 if reordered)
- [ ] ADR-036 … ADR-038 ACCEPTED
- [ ] OQ-M8-02, 03, 06, 07 answered
- [ ] A synthetic graph fixture (no real repository content) prepared for the tests

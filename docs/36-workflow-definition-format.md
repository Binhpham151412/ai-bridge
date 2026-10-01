# 36 — Workflow Definition Format (PROPOSED; no parser is implemented)

## 1. Purpose

Design the declarative workflow definition (`workflow → steps → executor, verification,
retry policy`), decide what is declarative and what is runtime state, and evaluate
JSON / YAML / TypeScript as formats.

## 2. Current State (EXISTING)

- There is no workflow definition. The closest artifact is `.ai-bridge/config.json`,
  validated by `validateConfig`: known fields only, typed, every error reported, nothing
  silently coerced. That style is the model for definition validation.
- The zero-runtime-dependency principle: the project ships no parser libraries.

## 3. Proposed Design

### 3.1 Format decision

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **JSON** | native `JSON.parse`, no dependency; canonical hashing is simple; matches config.json | no comments | **ADOPT** |
| YAML | readable, comments (LoopFlow, GitHub Actions) | needs a dependency; implicit typing pitfalls ("no" → false); anchors complicate hashing | REJECT for M5 (it could be a FUTURE import format converted to JSON) |
| TypeScript | expressive, typed | **executing user code** is a trust boundary violation; not inspectable as data | REJECT for user definitions (fine for BUILTIN definitions compiled into the app) |

A `"$comment"` string field is allowed on any object, to compensate for JSON's lack of
comments. It is ignored by the engine but part of the hash.

### 3.2 Example (documentation example)

```json
{
  "schema": 1,
  "id": "implement-and-verify",
  "version": 1,
  "title": "Implement a feature and verify it",
  "inputs": {
    "feature": { "type": "string", "maxLength": 4000, "required": true }
  },
  "budgets": { "maxDurationMs": 14400000, "maxTotalIterations": 40, "maxExecutions": 6 },
  "steps": [
    {
      "id": "implement",
      "title": "Implement",
      "instruction": "Implement the following feature:\n{{inputs.feature}}",
      "executor": { "role": "executor", "maxIterations": 10, "requires": [] },
      "outputs": ["report.summary"],
      "verification": {
        "checks": [
          { "kind": "command", "id": "typecheck", "command": "pnpm", "args": ["typecheck"], "timeoutMs": 600000, "required": true },
          { "kind": "command", "id": "tests", "command": "pnpm", "args": ["test"], "timeoutMs": 1200000, "required": true },
          { "kind": "path-untouched", "id": "no-test-edits", "glob": "tests/fixtures/**", "required": true }
        ],
        "requireReviewer": false,
        "acceptAiOnly": false,
        "acceptMaxIterationsOutcome": false
      },
      "retry": { "maxAttempts": 2, "retryOn": ["VERIFICATION_FAILED", "REPORT_MISSING_OR_INVALID"] },
      "context": { "fromSteps": [], "memory": [] }
    },
    {
      "id": "document",
      "title": "Update docs",
      "instruction": "Update README for the change summarized below.",
      "executor": { "role": "executor", "maxIterations": 3 },
      "context": { "fromSteps": [{ "step": "implement", "output": "report.summary", "maxChars": 8000 }] },
      "verification": { "checks": [], "acceptAiOnly": true },
      "retry": { "maxAttempts": 1 }
    }
  ]
}
```

**M5 acceptance rules** (strict subset; the rest is reserved):
- `verification.checks` must be empty and `acceptAiOnly` must be `true` (verification is M6).
- `retry.maxAttempts` must be 1 (retries are M6).
- `executor.requires` must be empty (capabilities are M7). `context.memory` must be empty (M8).
- Each reserved field present with a non-default value is rejected with a message naming
  the milestone. It is never silently ignored.

### 3.3 Declarative vs runtime

| Declarative (definition, immutable, hashed) | Runtime (instance/attempt records) |
|---|---|
| steps, their order, instructions, input schema | input values, the composed task text + hash |
| executor role, `maxIterations`, requirements | resolved capability ids + hashes (M7), the effective permission profile |
| verification policy, check commands | evidence, exit codes, outputs, verdicts |
| retry policy, budgets | attempt counts, budget consumption, terminal reason |
| context wiring (which outputs feed which step) | the actual output values (capped, with truncation flags) |
| — | executionIds (runIds), timestamps, events, human answers |

### 3.4 Templating

- Only `{{inputs.<name>}}` and `{{steps.<id>.outputs.<name>}}` placeholders. No
  expressions, conditionals or functions (external pattern P27 rejected).
- Substituted values are inserted as **labelled data blocks** (e.g. `--- BEGIN INPUT feature
  --- … --- END INPUT ---`), not spliced into instruction prose. This reuses the EXISTING
  report-framing defense.
- Output names are a fixed M5 vocabulary: `report.summary` (the `## SUMMARY` section, or
  `NEXT_RECOMMENDATION` if absent), `report.remainingWork`, `report.filesChanged`. They
  are extracted with the EXISTING `extractSection` logic from the journal module (read-only
  reuse, OPEN QUESTION: extract it to a shared helper without behavior change).

### 3.5 Validation (to be implemented in M5.1; described here only)

Validated: `schema` = 1; `id` and step ids kebab-case and unique; `version` a positive
integer; 1 ≤ steps ≤ 50; `maxIterations` 1..100; budgets within the hard caps (docs/26 §7);
no unknown fields; placeholders reference declared inputs or earlier steps' declared
outputs only (no forward references); inputs type/length-checked.
`definitionHash` = sha256 of the canonical JSON (keys sorted, no insignificant whitespace).

### 3.6 Dry run (ADOPT from LoopFlow)

`validate --dry-run` renders every step's task text with sample or actual inputs,
performing **no** CLI calls and no writes except an optional report file. It spends no
quota.

### 3.7 Location (DECIDED — ADR-018)

Definitions are project-scoped:
`<project>/.ai-bridge/workflows/definitions/<definitionId>.json`. The project-local file
is the **source of truth** for a definition; app userData is not the primary store. An
instance pins the `definitionHash` it was started with (§6).

## 4. Responsibilities / Boundaries

Authors (humans) own definitions. The validator owns acceptance. The engine never
modifies a definition, and an instance pins its `definitionHash`.

## 5. Data Flow

`definition file → parse (JSON.parse) → validate → canonicalize + hash → approval check
(M6 for commands) → instance creation`.

## 6. Failure Cases

Invalid JSON, unknown fields, a reserved feature used too early, placeholder errors, or
budgets over the caps: all are rejected with the full error list (the config.ts style).
A definition file changed after instance creation has no effect on the instance (the
pinned hash), and a warning event is written if a resume sees a mismatch.

## 7. Decisions

ADR-013 (JSON definitions, no expression language); ADR-018 (definitions location);
ADR-020 (M5 scope lock, which is the §3.2 acceptance subset).

## 8. Open Questions

A YAML import later (FUTURE, not M5); a shared `extractSection` helper. (The definitions
location was closed at M5.0 by ADR-018.)

## 9. Explicitly Out of Scope

A parser implementation, a schema validator library, branching (`if`), loops over steps,
parallel `needs` graphs (M9).

## 10. Risks

- Feature pressure toward an expression language: rejected by ADR.
- Users expecting checks to run in M5: the M5 validator rejects checks explicitly.

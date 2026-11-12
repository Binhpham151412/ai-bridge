# 67 — The judge command (`ai-bridge judge`)

## 1. Purpose

A one-shot, read-only verdict on a draft, for the GoalForge repository (its package PJ, scenarios S12–S18). GoalForge
sends a draft that already passed its own deterministic checks, plus a rubric; this command asks Codex once and
answers `pass` or `fail`. It is a **different job** from the loop reviewer (docs/25): no Claude, no iterations, no
project, no run lock, no session state. It can be run while `ai-bridge start` is running on any project.

## 2. Command

```bash
ai-bridge judge --request <file|-> [--timeout-ms N] [--model NAME]
```

| Flag | Meaning |
|---|---|
| `--request` | The request JSON: a file path, or `-` for stdin. Required. |
| `--timeout-ms` | Time for Codex, 1000–1800000, default 300000. Past it Codex and its process tree are killed. |
| `--model` | Passed to `codex exec -m` and reported in the verdict. Without it Codex uses its own default and the verdict says `"model": "unknown"` — the CLI does not report which model answered. |

Exit codes: `0` a verdict is on stdout (a `fail` verdict is still a verdict); `2` refused before running (an API key in
the environment, or no `codex` installed); `1` no verdict (bad request, Codex failed or timed out, the answer is not a valid
verdict). stdout carries **only** the verdict, one JSON line; errors are one line on stderr, `ERROR_<CODE>: <message>`
(`BAD_REQUEST`, `BLOCKED_API_KEY`, `CODEX_NOT_FOUND`, `CODEX_FAILED`, `TIMEOUT`, `BAD_RESPONSE`).

## 3. What it does

1. Parses and validates the request (`src/core/judge/judge-contract.ts`); refuses anything over 512 KiB.
2. Refuses to run when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or `CODEX_API_KEY` is set (docs/07),
   naming the variable, never its value.
3. Runs `codex exec` **once, on a fresh thread, in the read-only sandbox, with an empty scratch directory as the working
   directory** (nothing of the user's is readable); the prompt goes in on stdin; the scratch directory is removed afterwards.
4. Takes the answer only if it is **exactly one** fenced `json` block, and checks it against the rubric.

## 4. Contract (shared with GoalForge)

Request, `goalforge/judge-request@1`: `run_id`, `mission_id`, `ticket`, `draft_version`, `iteration`, `draft`, `evidence[]`
(`chunk_id`, `doc_title`, `heading`, `text`), `deterministic` (what the deterministic checks found), `rubric`
(`instructions`, `metrics[]` of `id`, `description`, `gating`).

Verdict, `goalforge/judge-verdict@1`: `verdict` (`pass`|`fail`), `draft_version`, `iteration`, `metrics[]` (`id`, `value`,
`passed`), `reasons[]`, `feedback[]` (`claim_id`, `message`, `action` ∈ `remove_or_replace_with_supported`,
`add_missing_field`, `fix_citation`), `model`, `judge_version` (`ai-bridge-judge@1`).

Fail-closed rules: the metrics are exactly the rubric's; `pass` needs every gating metric passed; `fail` needs a reason;
an unknown action is invalid. The command sets `draft_version` and `iteration` **from the request**, never from the model;
GoalForge checks them again and treats a mismatch as a judge error. The draft, ticket and evidence go into the prompt as
JSON strings inside `BEGIN_DATA`/`END_DATA` blocks, so text in them cannot end a block or pose as an instruction, and the
prompt tells the model that it is data.

## 5. Not verified

- A real run against the installed Codex (`codex exec`, a real sign-in): the tests use `tests/fixtures/fake-codex`. Which
  model and which reasoning effort really answer is **unknown**: the earlier review loop ran a different model and effort
  than its configuration said. Use `--model` and check the Codex session log.
- How well a real model follows the rubric and the one-block rule: only the strict parsing is tested.

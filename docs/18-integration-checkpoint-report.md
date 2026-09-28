# 18 — M4.3 + UI Refactor Integration Checkpoint Report

Date: 2026-09-28 · Branch: `main` (uncommitted working tree) · Scope: typecheck / test
integration only — no features, no UI design changes, no provider architecture changes.

**Result: the combined tree has no integration, typecheck, test, or build regressions. No
source or test change was needed.** The only file this checkpoint adds is this report.

## 1. Initial git status

Taken before any action (`git status --short`):

```
 M README.md
 M scripts/desktop/real-e2e.ts
 M scripts/desktop/smoke.ts
 M src/desktop/main/run-controller.ts
 M src/desktop/renderer/components/ActivityLog.tsx
 M src/desktop/renderer/components/App.tsx
 M src/desktop/renderer/components/ArtifactViewer.tsx
D  src/desktop/renderer/components/Dashboard.tsx
 M src/desktop/renderer/components/ExecutionPanel.tsx
 M src/desktop/renderer/components/JournalPanel.tsx
D  src/desktop/renderer/components/RunPanel.tsx
D  src/desktop/renderer/components/SessionHistory.tsx
 M src/desktop/renderer/components/Settings.tsx
D  src/desktop/renderer/components/SystemCheck.tsx
 M src/desktop/renderer/components/common.tsx
 M src/desktop/renderer/lib/events-store.ts
 M src/desktop/renderer/lib/format.ts
 M src/desktop/renderer/styles.css
 M tests/desktop/renderer/execution.test.tsx
 M tests/desktop/renderer/renderer.test.tsx
?? docs/15-ui-ux-refactor-report.md
?? docs/16-m4.3-provider-manager-foundation.md
?? docs/17-m4.3-provider-foundation-report.md
?? docs/assets/ui-refactor/
?? graphify-out/
?? src/core/providers/
?? src/desktop/renderer/components/{ArtifactsView,CliOutput,JournalView,RunView,SessionPicker,SystemView,TechnicalDetails}.tsx
?? src/desktop/renderer/lib/run-summary.ts
?? src/desktop/renderer/state/{Navigation.tsx,useSessionData.ts}
?? tests/desktop/renderer/{input.ts,ui-refactor.test.tsx}
?? tests/fixtures/fake-provider/
?? tests/providers/
```

`git diff --stat`: 16 tracked files, +1693 / −691. Every tracked modification is on the UI
refactor's own list of changed files (docs/15, "Files Changed"), including the one-string change to
`src/desktop/main/run-controller.ts` (1 line). The provider work is entirely untracked
files (`src/core/providers/`, `tests/providers/`, `tests/fixtures/fake-provider/`,
docs/16–17). No file was edited by both workstreams.

(`graphify-out/` is an unrelated knowledge-graph output directory; untouched.)

## 2. TypeScript error found

**None in the current tree.**

```
pnpm typecheck
  tsc --noEmit                              → exit 0
  tsc --noEmit -p tsconfig.renderer.json    → exit 0
```

The error reported at `tests/providers/claude-code-provider.test.ts:196` does not
reproduce.

## 3. Root cause (of the reported error)

The report came from a stale reading, not from the current tree:

- docs/15 (UI refactor) says the root config had a single error in
  `tests/providers/claude-code-provider.test.ts`, owned by the M4.3 session. The UI session
  took that typecheck result while the provider session was still editing its tests.
- That test file was last modified at 22:13 (2026-09-27). docs/17 (provider report,
  22:20) records `pnpm typecheck` exit 0 for both configs.
- Line 196 now has an explicit annotation,
  `const cases: Record<string, string>[] = [...]`. That annotation lets the next line,
  `{ ...env, FAKE_DIAG_LOG: log }`, typecheck against `diagnose()`'s env parameter.
  Without it, TypeScript infers a union of object-literal types for the array. This is
  the likely original error. The provider session fixed it in its own file before it
  finished.

Classification: an **ordering artifact between the two sessions**. It is not a real
regression, not an M4.3 implementation defect, and not caused by combining the trees.

## 4. Minimal fix

None needed. No source, test, or config file was changed. TypeScript settings were left
alone, and no `@ts-ignore` / `@ts-expect-error` was added.

## 5. Tests before / after

| Run | Result |
|---|---|
| `pnpm test` (combined tree, before any checkpoint action) | **535/535 pass**, 0 fail, 0 skipped (~33 s) |
| `node --test "tests/providers/*.test.ts"` | **59/59 pass** |
| After checkpoint | Unchanged (no code changed) |

535 matches both session reports (docs/15 and docs/17 each report 535/535 against the
shared tree; 59 of those are the provider tests).

## 6. Typecheck result

`pnpm typecheck` → both configs exit 0 (root: `src/`, `tests/`, `scripts/` excluding the
renderer; renderer: `tsconfig.renderer.json`).

## 7. Build result

`pnpm build` → `Built desktop app into dist-desktop`, exit 0.

## 8. Smoke result

`node scripts/desktop/smoke.ts <fresh temp dir>` was run against the dev build in
`dist-desktop`. This uses no Claude/Codex quota: doctor runs only `claude auth status` /
`codex login status`. The project path was an empty temp directory, so nothing was
written into the repo.

**10/10 smoke checks passed:** no Node/Electron globals in the renderer; the frozen
19-function preload API with no invoke/send; CSP blocks the Function constructor; Main
rejects an empty task, extra fields, and a path-traversal runId; navigation away is
blocked; `window.open` is denied; the snapshot comes from Core; the real `doctor()` runs
through IPC → Main → BridgeEngine.

Doctor reported `claude-auth: FAIL` and `git-repository: WARNING`. Both describe the
machine and the temp directory (Claude CLI not logged in at run time; the temp dir is not
a git repo). The smoke check only asserts that doctor runs end-to-end, so neither is a
regression.

`scripts/desktop/real-e2e.ts` was **not** run: it consumes real Claude/Codex quota.

## 9. Files changed by this checkpoint

- `docs/18-integration-checkpoint-report.md` (new, this file)

Nothing else. The build output in `dist-desktop/` was regenerated by `pnpm build`.

## 10. Provider Foundation isolation — verified

- `src/core/providers/` (6 files: `provider-types`, `cli-provider`, `executable-discovery`,
  `claude-code-provider`, `codex-provider`, `provider-registry`) imports only its own
  modules, `../../automation/process-runner.ts`, `../cost-guard.ts`,
  `../security/redact.ts`, and `node:*` built-ins. No renderer, Electron, React, or IPC
  imports.
- Nothing in `src/` or `scripts/` outside `src/core/providers/` imports it. The only
  consumers are `tests/providers/*`.
- No reference to the provider registry (`ProviderRegistry` / `provider-registry`)
  anywhere in `src/desktop/**` or `src/cli.ts`. Electron Main does not create a
  registry, and no IPC channel exposes providers. The smoke check confirms the preload
  surface is still the same fixed 19 functions.

M4.3 Phase 2 (IPC / Main wiring) has not been started.

## 11. UI refactor intact — verified

- Present: `RunView`, `JournalView`, `ArtifactsView`, `SystemView`, `TechnicalDetails`,
  `CliOutput`, `SessionPicker` (components), `Navigation.tsx`, `useSessionData.ts` (state),
  `lib/run-summary.ts`, `styles.css` changes, `tests/desktop/renderer/ui-refactor.test.tsx`.
- `Dashboard.tsx`, `RunPanel.tsx`, `SessionHistory.tsx`, `SystemCheck.tsx` stay deleted (staged `D`).
  Nothing references them. The only name match is the new local `SystemCheckCard`
  function inside `SystemView.tsx`. Build, typecheck, and tests all pass without them, so
  restoring them was not needed.
- The renderer tests pass within the 535, and the smoke selectors (updated by the UI
  session) find the new header/views.

## 12. Remaining known limitations (recorded only, not fixed here)

Out of scope for this checkpoint:

- Markdown ordered-list rendering issue.
- Double scrollbars.
- No dark theme.
- Mixed English/Vietnamese labels.
- Task title missing from the Run header (the task is not part of `BridgeSnapshot`; see docs/15).
- Doctor's "exited 1" wording.
- No Provider Manager UI.
- No provider IPC / Main-process registry (M4.3 Phase 2).
- Workflow Manager — not started.
- Project Memory — not started.

The work from both sessions is still uncommitted. Committing is left to the user.

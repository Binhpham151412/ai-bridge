# 66 — AI Bridge inside Claude Code (plugin)

Status: in development (branch `feat/claude-code-plugin`).

## 1. What and why

The desktop app and CLI spawn `claude` (or OpenCode / Antigravity) as a child process and
pass Codex's next prompt between them. This plugin runs the same loop **inside the Claude
Code session you are already working in**: when Claude finishes a turn, Codex reviews it and
either pushes Claude on with the next prompt, or stops the loop (DONE / NEED_HUMAN).

```text
/bridge <task>  →  Claude works  →  Stop hook  →  codex exec (review)  →  CONTINUE: next prompt fed back to Claude
                                                                       →  DONE / NEED_HUMAN: loop ends, message shown
```

Non-goals (for now): OpenCode / Antigravity hosts, sharing run history with the desktop app.

## 2. How it hooks in (verified against code.claude.com/docs/en/hooks, 2026-10-23)

| Piece | Mechanism |
|---|---|
| `/bridge <task>` | plugin skill `skills/bridge/SKILL.md` (`/bridge` or `/ai-bridge:bridge`) |
| Arming | `UserPromptSubmit` hook: receives the line as typed (`/bridge …`), writes the loop state, adds the report contract to Claude's context (`additionalContext`) |
| `/bridge stop` | same hook; blocks the prompt (Claude never sees it) and marks the loop `STOPPED` |
| Review | `Stop` hook: Claude's final message (`last_assistant_message`; transcript as fallback) → `buildReviewerInput` → `CodexCliAdapter` → `CodexResponseParser`. Its `statusMessage` ("AI Bridge: Codex đang review…") is the spinner line while it runs; in a session without a loop the hook exits at once, so the line only flashes |
| Continue | Stop hook prints `{"decision":"block","reason":"<Codex PROMPT + acknowledge line + report reminder>","systemMessage":"AI Bridge · Codex · vòng N · CONTINUE — …"}`; the reason asks Claude to open its reply with one line saying the round-N review arrived and what it will do next |
| End | no block; `systemMessage` tells the user DONE / NEED_HUMAN (`AI Bridge · Codex · vòng N · STATUS — …`, the side pane's label) or the error |

Reused unchanged from the core: `CodexCliAdapter` (thread resume, read-only sandbox),
`CodexResponseParser` (fails closed on a malformed response), `buildReviewerInput`,
`checkEnvForApiKeys` (the $0 rule: any API key in the env stops the loop), executable discovery
(finds Codex installed by the ChatGPT app).

The report contract is the desktop one adapted to chat: instead of writing `REPORT_FILE`, Claude
ends every final message with the `## TASK / ## CHANGES / ## TESTS / ## ISSUES /
## NEXT_RECOMMENDATION` report (`buildChatReportContract`).

## 3. Rules

- Only an armed session is reviewed. Every other turn, in every project, passes through untouched.
- **Round cap** (10): Codex's CONTINUE on the last allowed round ends the loop as NEED_HUMAN and
  shows the prompt it would have sent. (Claude Code itself also overrides a Stop block after 8
  consecutive continuations **without a tool call**; the counter resets on every tool call.)
- **`/bridge stop` always wins**: a stop (or a new `/bridge`) typed while Codex is reviewing is
  re-read after the review; the hook then neither blocks nor overwrites the newer state.
- **Fail open**: a Codex failure, timeout, malformed response, missing reply or missing Codex ends the
  loop (`ERROR`) with a message. The hook never blocks on an error and always exits 0.
- **Timeouts**: Codex 10 minutes (`DEFAULT_CONFIG.codexTimeoutMs`); the Stop hook's own timeout is
  15 minutes. A hook that hits Claude Code's timeout is discarded, which would end the loop silently.

## 4. State and artifacts

`~/.ai-bridge/claude-code/<claude session id>/` (override: `AI_BRIDGE_CLAUDE_CODE_DIR`):

| File | Content |
|---|---|
| `state.json` | task, project path, status (`RUNNING`/`DONE`/`NEED_HUMAN`/`ERROR`/`STOPPED`), round, Codex thread id, last verdict, `reviewingSince` while Codex runs (a Stop hook killed mid-review leaves it set until the next review, `/bridge stop` or re-arm clears it) |
| `loop-N/NNN-report.md` | Claude's final message that round (`loop-N`: the N-th `/bridge` in this session; a re-arm never overwrites an earlier loop) |
| `loop-N/NNN-codex-input.md` | the reviewer input |
| `loop-N/NNN-codex-review.md` | Codex's full response (review + `AI_BRIDGE_RESPONSE` block) |
| `loop-N/interrupted/NNN-<start>-…` | the files of a review that was killed mid-way (user interrupt): moved here when that round is reviewed again, so the retry keeps the number and overwrites nothing |

## 5. The pane (`ai-bridge-panel`, optional)

A separate plugin (a Claude Code hooks module, `plugins/claude-code-panel/`) that only reads the
files above: status, task, round N / max, "Codex đang review…" while the Stop hook runs (only while the loop is `RUNNING`), the last
verdict and Codex's next prompt, and Codex's review of that round. It opens on `/bridge <task>`
(not on `/bridge stop`), on a session start where the loop is still running, and on
`/bridge-panel`; it re-reads every 2 s while the loop runs. Tests: `claude plugin test
plugins/claude-code-panel` (needs Claude Code ≥ 2.1.308, the version that wrote the mod API).

## 6. Layout

| Path | |
|---|---|
| `src/claude-code/` | hook logic (`bridge-loop.ts`), transcript fallback, hook entry point |
| `plugins/claude-code/` | the plugin: manifest, `skills/bridge`, `hooks/hooks.json`, `dist/` (built, not committed) |
| `plugins/claude-code-panel/` | the pane |
| `.claude-plugin/marketplace.json` | lets Claude Code install both from this repo |
| `scripts/claude-plugin/build.ts` | bundles the hook entry point into `plugins/claude-code/dist/hook.mjs` (the installed plugin is copied out of the repo, so it must be self-contained) |

## 7. Install

```bash
pnpm build:claude-plugin
claude plugin marketplace add "<path to this repo>"
claude plugin install ai-bridge@ai-bridge
claude plugin install ai-bridge-panel@ai-bridge
```

Claude Code copies an installed plugin into `~/.claude/plugins/cache/`: after changing the hook
code, build again and update the plugin. The hooks take effect in sessions started afterwards.

## 8. What was verified (2026-10-23)

- Unit/integration tests with the fake Codex CLI (`tests/claude-code/`), and the pane's tests.
- A real `claude -p … --plugin-dir plugins/claude-code` (2.1.161): the `UserPromptSubmit` hook received
  `/bridge …` as typed and armed the loop. The run went no further: that CLI's sign-in belongs to an
  organization that has turned off Claude Code on subscriptions.
- The built `dist/hook.mjs` driven with real Stop-hook input against the **real Codex CLI**: DONE in one
  round; a second `/bridge` in the same session: CONTINUE (the hook printed `decision: block` with
  Codex's prompt), then a resumed Codex thread answered DONE; `loop-1/` was kept.
- **Not yet verified**: Claude Code acting on the `decision: block` in a live session (documented
  behaviour; first real run in the desktop app will tell), and the pane inside the desktop app.

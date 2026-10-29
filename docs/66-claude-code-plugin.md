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
| Arming | `UserPromptSubmit` hook: receives the line as typed (`/bridge …`), writes the loop state (with the commit checked out, `baseCommit`), adds the report contract to Claude's context (`additionalContext`). `/bridge --vong N <task>` (also `--vòng`, `--rounds`; N from 1 to 30) sets this loop's round cap; anything else is refused |
| Answer (0.4.0) | `/bridge <answer>` while the loop waits on the user (`NEED_HUMAN`) carries **the same loop** on: same Codex thread, checklist and round count, status back to `RUNNING`, the answer kept as `humanReply` for the next review. The context tells Claude it continues the task with that answer. A loop stopped by its round cap gets 3 more rounds (`--vong N`: N more) |
| `/bridge stop` | same hook; blocks the prompt (Claude never sees it) and marks a running or waiting loop `STOPPED` (so the next `/bridge` is a new task) |
| Review | `Stop` hook: Claude's final message (`last_assistant_message`; transcript as fallback) → `buildChatReviewerInput` (with the task as typed and the previous checklist) → `CodexCliAdapter` → `CodexResponseParser`; `parseReviewProgress` reads the checklist from the review. Its `statusMessage` ("AI Bridge: Codex đang review…") is the spinner line while it runs; in a session without a loop the hook exits at once, so the line only flashes |
| Continue | Stop hook prints `{"decision":"block","reason":"<Codex PROMPT + acknowledge line + report contract with Codex's checklist>","systemMessage":"<the round message, §2.1>"}`; the reason asks Claude to open its reply with one line saying the round-N review arrived and what it will do next |
| End | no block; `systemMessage` is the round message (DONE / NEED_HUMAN / round cap, §2.1) or the error |

Reused unchanged from the core: `CodexCliAdapter` (thread resume, read-only sandbox),
`CodexResponseParser` (fails closed on a malformed response),
`checkEnvForApiKeys` (the $0 rule: any API key in the env stops the loop), executable discovery
(finds Codex installed by the ChatGPT app). The desktop's `buildReviewerInput` is left as it is
(session history parses its framing back); the chat has its own `buildChatReviewerInput`.

The report contract is the desktop one adapted to chat: instead of writing `REPORT_FILE`, Claude
ends every final message with a summary for the user, then the `## TASK / ## CHANGES / ## TESTS /
## ISSUES / ## NEXT_RECOMMENDATION` report for the reviewer (`buildChatReportContract`).

### 2.1 How far the task is (0.3.0)

The user follows the loop in the chat, so each round says, in Vietnamese, whether Codex approved
and how far the task is:

| Who | What |
|---|---|
| Codex (`buildChatReviewerInput`) | gets the task as the user typed it, from round 2 its own previous checklist, and the user's answer after a NEED_HUMAN. On a paid plan (§2.2) it also gets the project's changes since the loop started (`git status` + `git diff <baseCommit>`, cut at 30 000 characters; `git-changes.ts`) and checks the report against those and the files themselves: it may read files and run read-only commands in its read-only sandbox, but not the test suite, so the report's test results are claims checked against the code. On the free plan it reviews the report alone. Writes its review in Vietnamese with `## Việc` (the task in one sentence), `## Tiến độ` (3–7 parts, `- [x]` only when done **and** verified; the same parts every round), `## Kết luận` (approved, or what is missing), `## Vấn đề`, `## Việc tiếp theo`; DONE only when every part is `[x]` |
| The Stop hook | keeps `progress` (`{ title, items, verdict }`) in `state.json`; a review without the checklist keeps the last one. Hands the checklist to Claude in the CONTINUE reason |
| Claude (`buildChatReportContract`) | opens the end of its final message with **Tóm tắt cho bạn**: Việc, Tiến độ X/Y phần xong (✓ / ✗ per part, ticked against Codex's checklist; its own 3–7 parts before the first review), Vòng này đã làm, Cần bạn |
| The chat line after each review | `AI Bridge · vòng N/M · <verdict> · X/Y phần xong`, then Codex's conclusion, one `✓`/`✗` line per part, then what happens next, then the quota line (§2.2). Verdicts: `Codex: chưa duyệt, Claude làm tiếp` (CONTINUE), `✅ Codex đã duyệt` (DONE), `⏸ Codex cần bạn` (NEED_HUMAN, followed by what Codex needs), `⏸ Đã hết số vòng` (round cap, followed by the instruction Codex would have sent) |

### 2.2 Codex plan, quota and notifications (0.4.0)

| What | How |
|---|---|
| Plan and quota | After each review the hook reads the log of that Codex thread, `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl`, and takes only the last `rate_limits` (`plan_type`; of the `primary`/`secondary` windows the more used one: `used_percent`, `window_minutes`, `resets_at`) — `codex-account.ts`. The credentials file is never read. Kept in `state.json` (`codexAccount`) and in `codex-account.json` beside the session folders, so the first review of the next loop knows the plan too |
| Checking the code | `AI_BRIDGE_CODEX_CHECK_CODE`: `auto` (default) checks the code only on a known paid plan (anything but `free`); unknown or `free` reviews the report alone, which spends the least quota; `on` / `off` force it. `state.json` keeps `checksCode` for the latest review |
| Quota line | last line of the chat line, e.g. `Codex free · đã dùng 64% hạn mức 30 ngày · đặt lại sau 26 ngày · Codex chỉ đọc báo cáo`; the pane shows it without the reset |
| Notification | when the loop ends (DONE, NEED_HUMAN, round cap, error) the Stop hook raises an OS notification titled "AI Bridge" with the chat line (`notify.ts`): a toast through Windows PowerShell's app id on Windows, `osascript` on macOS, `notify-send` on Linux; not on CONTINUE or `/bridge stop`. The hook waits for the notifier (at most 10 s; about 0.4 s for the toast here) instead of detaching it, as nothing in `src/` outlives its parent (`tests/desktop/process-lifetime.test.ts`). Raised by the hook, not the pane, because a mod's `$.ui.notify` reaches no OS notification in the desktop app (no terminal). `AI_BRIDGE_NOTIFY=off` silences it |

## 3. Rules

- Only an armed session is reviewed. Every other turn, in every project, passes through untouched.
- **Round cap** (10, or `--vong N`): Codex's CONTINUE on the last allowed round ends the loop as
  NEED_HUMAN and shows the prompt it would have sent; `/bridge <answer>` then carries it on. (Claude Code itself also overrides a Stop block after 8
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
| `state.json` | task, project path, status (`RUNNING`/`DONE`/`NEED_HUMAN`/`ERROR`/`STOPPED`), round, Codex thread id, last verdict, `progress` (Codex's checklist and conclusion, §2.1; absent in a state written before 0.3.0), `baseCommit` (HEAD when the loop was armed; null outside git), `humanReply` (the user's answer, until the next review), `codexAccount` and `checksCode` (§2.2), `reviewingSince` while Codex runs (a Stop hook killed mid-review leaves it set until the next review, `/bridge stop` or re-arm clears it) |
| `../codex-account.json` | the Codex plan and quota last read from Codex's log, for every session (§2.2) |
| `loop-N/NNN-report.md` | Claude's final message that round (`loop-N`: the N-th `/bridge` in this session; a re-arm never overwrites an earlier loop) |
| `loop-N/NNN-codex-input.md` | the reviewer input |
| `loop-N/NNN-codex-review.md` | Codex's full response (review + `AI_BRIDGE_RESPONSE` block) |
| `loop-N/interrupted/NNN-<start>-…` | the files of a review that was killed mid-way (user interrupt): moved here when that round is reviewed again, so the retry keeps the number and overwrites nothing |

## 5. The pane (`ai-bridge-panel`, optional)

A separate plugin (a Claude Code hooks module, `plugins/claude-code-panel/`) that reads the
files above: status, the task (Codex's one-line `## Việc` once it wrote one), round N / max,
"Tiến độ: X/Y phần xong" with a ✓/✗ line per part and "Codex: <its conclusion>" (§2.1),
"Codex đang review vòng N… 45 giây" while the Stop hook runs (only while the loop is `RUNNING`), each
verdict in words ("chưa duyệt", "đã duyệt", "cần bạn") with Codex's conclusion as the folded line,
and Codex's next prompt and review of that round. It opens on `/bridge <task>`
(not on `/bridge stop`), on a session start where the loop is still running, and on
`/bridge-panel` (asking for the keyboard, so the task field takes the typing); it re-reads every 2 s while the loop runs. Tests: `claude plugin test
plugins/claude-code-panel` (needs Claude Code ≥ 2.1.308, the version that wrote the mod API).

Driving the loop from the pane (0.3.0):

| Control | What it does |
|---|---|
| Task field (when no loop runs: none yet, DONE, ERROR, STOPPED) | Enter runs `/bridge <task>` through `$.command.run`, as if typed: the same `UserPromptSubmit` hook arms the loop. Beside it, "Số vòng review" (3 / 5 / 10) adds `--vong N` unless 10, the hook's default. The command waits in the queue while Claude works; the pane shows "Đã gửi /bridge …" until a newer loop appears in `state.json`, or says so 30 s after the command ran without arming one. Not drawn on mobile (no text field there): the pane says to type `/bridge` in the chat |
| "Trả lời Codex" (while `NEED_HUMAN`, 0.4.0) | the pane shows "Codex hỏi: <its question>" and the field sends the answer as `/bridge <answer>`, which carries the same loop on; "Đã gửi …" lasts until that loop runs again |
| Dừng vòng lặp (while `RUNNING`) / Kết thúc vòng này (while `NEED_HUMAN`) | writes what `/bridge stop` writes (`status: STOPPED`, `reviewingSince: null`) to `state.json`, only if the file still holds the loop the pane showed. It cannot run `/bridge stop` instead: a plugin's command waits for the session to be idle, which a running loop never is. Claude finishes its current turn; the Stop hook then sees `STOPPED` and ends the loop |
| Copy (each message), Copy prompt (Codex CONTINUE), Copy tất cả | `$.ui.copy` of the whole message (the pane draws at most 20 000 characters of one), Codex's PROMPT alone, or the whole exchange as Markdown (`## Claude · vòng N` / `## Codex · vòng N · STATUS`); a toast says whether it reached the clipboard |

## 6. Layout

| Path | |
|---|---|
| `src/claude-code/` | hook logic (`bridge-loop.ts`), review progress (`progress.ts`), git changes for the reviewer (`git-changes.ts`), transcript fallback, hook entry point |
| `plugins/claude-code/` | the plugin: manifest, `skills/bridge`, `hooks/hooks.json`, `dist/hook.mjs` (built and committed, so an install from GitHub needs no build; `tests/claude-code/dist-build.test.ts` fails until it matches the source) |
| `plugins/claude-code-panel/` | the pane |
| `.claude-plugin/marketplace.json` | lets Claude Code install both from this repo |
| `scripts/claude-plugin/build.ts` | bundles the hook entry point into `plugins/claude-code/dist/hook.mjs` (the installed plugin is copied out of the repo, so it must be self-contained) |

## 7. Install

From GitHub, in one command (the pane needs Claude Code ≥ 2.1.308):

```bash
claude plugin install ai-bridge-panel --marketplace Binhpham151412/ai-bridge
```

`--marketplace` adds the marketplace first (in user settings), and the pane's `plugin.json` lists
`ai-bridge` under `dependencies`, so the hooks are installed with it ("+ 1 dependency: ai-bridge").
Without the pane: `claude plugin install ai-bridge --marketplace Binhpham151412/ai-bridge`. The
README lists what the install cannot bring: Node.js ≥ 22, the Codex CLI signed in with ChatGPT, and
no API key in the environment (§3, the $0 rule).

Update with `claude plugin marketplace update ai-bridge`, then `claude plugin update ai-bridge@ai-bridge`
and `claude plugin update ai-bridge-panel@ai-bridge`. Claude Code copies an installed plugin into
`~/.claude/plugins/cache/`; the hooks take effect in sessions started (or `/reload-plugins`) afterwards.

While developing the plugin, add the checkout instead (`claude plugin marketplace add "<path to this
repo>"`), and after changing `src/claude-code/` run `pnpm build:claude-plugin` and commit
`plugins/claude-code/dist/hook.mjs` with the change.

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
- Pane 0.3.0 (2026-10-25): task field, Stop and Copy covered by `claude plugin test` (24 tests,
  Claude Code 2.1.308) and `claude plugin validate`. **Not yet verified live**: that a `/bridge`
  run by the pane's `$.command.run` reaches the `UserPromptSubmit` settings hook (the mod API
  documents it as running "as if the person typed" it; the pane reports it after 30 s if no loop
  starts), and the clipboard write on the desktop surface.
- Progress (ai-bridge 0.3.0, §2.1): `tests/claude-code/progress.test.ts` and `bridge-stop.test.ts`
  with the fake Codex (chat line, checklist kept in state, handed to Claude and to the next
  review), and the pane's progress tests (27 in all). The built `dist/hook.mjs` driven with real
  Stop-hook input against the **real Codex CLI** (2026-10-25, a `sum(a, b)` task): round 1 wrote the
  review in Vietnamese with a 5-part checklist and the chat line read `vòng 1/10 · Codex: chưa
  duyệt, Claude làm tiếp · 2/5 phần xong`; round 2 (resumed thread, previous checklist handed back)
  kept the same 5 parts and answered `✅ Codex đã duyệt · 5/5 phần xong`. A review without the
  format leaves the loop running as before, without the count. Live in a desktop session
  (2026-10-25): `/bridge` armed with the new contract, Claude wrote "Tóm tắt cho bạn", Codex's
  checklist was parsed into `state.json`.
- 0.4.0 (2026-10-28): `tests/claude-code/` (answer, `--vong`, changes for the reviewer, `git-changes`
  against a real git repository, plan and quota from a Codex log, check-code by plan, notifications,
  the committed build matching a fresh one) and 32 pane tests. With the built hook and the **real
  Codex CLI**:
  - code checking forced on, in a temporary git project where Claude's report claimed a type check
    the code did not have: Codex read the changes and the files, answered `vòng 1/3 · Codex: chưa
    duyệt · 2/4 phần xong` and wrote that the report does not match the code (about 65 s);
  - on the user's free plan (auto): the reviewer input had no changes and the "Review ONLY" rule,
    Codex approved in about 18 s, the chat line ended with `Codex free · đã dùng 64% hạn mức 30 ngày
    · đặt lại sau 26 ngày · Codex chỉ đọc báo cáo`, and the plan went to `codex-account.json`;
  - `/bridge <answer>` on a loop set to NEED_HUMAN carried it on (same loop, thread, checklist,
    round; the answer in `humanReply`);
  - the Windows toast command ran with exit code 0.
  **Not yet verified**: that the toast is seen on screen (the user's eyes), the pane's answer field,
  round picker and "Kết thúc vòng này" in the desktop app; an install from GitHub (needs this branch
  on `main`).

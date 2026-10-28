# 68 — AI Bridge inside OpenCode and Antigravity: plan, design, status

Status: **implemented and run for real** (2026-10-29, OpenCode 1.19.0 and Antigravity `agy` 1.3.4 on
Windows; real Codex reviewer on the ChatGPT free plan). Builds on docs/66 (the Claude Code plugin)
and docs/67 (OpenCode feasibility and prototype). Supersedes docs/67's "throwaway" status.

## 1. What was asked, and the plan

Run the `/bridge` review loop (Codex reviews each turn and sends the next instruction) in the other
two AI CLIs AI Bridge already supports as executors, not only in Claude Code. The plan, in order:

| # | Step | Result |
|---|---|---|
| 1 | Find out what Antigravity offers (hooks, plugins, transcript) | it has Claude-Code-like hooks (§2); feasible |
| 2 | Share what both hosts need: the real Codex/git/quota/notification wiring, and an environment for the review that API keys cannot stop | `src/chat-hosts/review-deps.ts` (§4) |
| 3 | Turn the OpenCode prototype into something installable: sources under `src/chat-hosts/opencode/`, committed bundle, installer, freshness test | done (§5) |
| 4 | Build the Antigravity plugin over the same loop code | `plugins/antigravity/` + `src/chat-hosts/antigravity/` (§3) |
| 5 | Test with fakes, then for real in both tools; one real Codex review each | §6 |
| 6 | Docs and install commands | this file, README, docs/67 |

The loop itself, `src/claude-code/bridge-loop.ts`, is **not touched**; neither is `plugins/claude-code`.
Each host is an adapter that maps its hooks onto `handlePrompt` (arming, `--vong`, `stop`, answering a
NEED_HUMAN) and `handleStop` (the Codex review, the checklist, the quota line, the round cap, the
notification). State per host: `~/.ai-bridge/opencode/` and `~/.ai-bridge/antigravity/`
(`AI_BRIDGE_OPENCODE_DIR`, `AI_BRIDGE_ANTIGRAVITY_DIR`), the same files as docs/66 §4.

## 2. Antigravity: what it offers

Sources: `antigravity.google/docs/hooks`, `antigravity.google/docs/plugins`, `agy --help`,
`agy plugin validate`, and probes on agy 1.3.4 (below).

| Needed (Claude Code mechanism) | Antigravity | Verified |
|---|---|---|
| See `/bridge …` as typed (`UserPromptSubmit`) | **No prompt event.** `PreInvocation` fires before each model call; `invocationNum` is 0 for the first call of a turn (it restarts at 0 in a resumed conversation, and keeps counting across Stop continuations). Its input has no prompt text but has `transcriptPath`: the transcript's last `USER_INPUT` step is the user's message (`<USER_REQUEST>…</USER_REQUEST>`) | yes: `agy -p` and `agy --conversation <id> -p` |
| Add the report contract for the model (`additionalContext`) | `PreInvocation` output `injectSteps: [{ systemMessage: { systemMessage } }]`: a persistent system message in the trajectory (a `SYSTEM_MESSAGE` step) | yes: the model answered in the contract's format |
| Refuse / `/bridge stop` (`decision: "block"`) | **Nothing blocks a prompt.** The hook has the model say the answer (an injected message: reply with exactly this, do nothing else) | yes (`/bridge stop` → the message, no task) |
| The agent finished a turn (`Stop`) | `Stop` hook: `executionNum`, `terminationReason` (`NO_TOOL_CALL` seen), `error`, `fullyIdle` (false while background commands run) | yes |
| Claude's final message (`last_assistant_message`) | **Not in the input.** The transcript's last step: `MODEL` / `PLANNER_RESPONSE` with `content` and no tool call | yes |
| Continue with the next prompt (`decision: "block"` + reason) | `Stop` output `{ "decision": "continue", "reason": … }`: the reason becomes a system message and the loop re-enters; `Stop` fires again with `executionNum` + 1. Anything else lets the agent stop | yes |
| Show the user a message (`systemMessage`) | **None.** The status line goes in the continue reason ("start your reply with this block, exactly as written"); the end of the loop is one more continue turn ("reply with this block and nothing else"), after which the next Stop passes because the loop is no longer running. The OS notification is the loop's own | yes |
| Spinner line while Codex reviews | none | |
| Hook timeout | per handler `timeout` (seconds, default 30): the Stop handler is set to 900 | yes (manifest check) |
| Packaging | a plugin folder with `plugin.json` (`name`, `description`), `hooks.json`, `skills/`; in `.agents/plugins/<name>/` (project), `~/.gemini/config/plugins/<name>/` (all) or `agy plugin install <path>` | project folder and `agy plugin validate`: yes |

Things the probes found that shape the code (agy 1.3.4, Windows):

- **A hook command is not run by a shell and is not unquoted**: `node "C:\a b\x.mjs"` reached node as a path
  with literal quotes. The command is therefore relative (`node ./dist/hook.mjs stop`); the hook runs
  with the **plugin folder as its working directory**. No `PLUGIN_ROOT` variable is set for a hook.
- The transcript is `…/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl` (the docs say
  `transcript.jsonl`; both exist, the hook input names the one to use).
- `agy -p "/bridge …"` is not expanded by agy: the model sees the text (and reads the skill). That is why
  arming reads the transcript instead of relying on a skill, and why the skill is only for discovery.
- Git Bash on Windows turns an argument starting with `/` into a path (`/bridge` →
  `C:/Program Files/Git/bridge`) before agy sees it: set `MSYS_NO_PATHCONV=1` when calling `agy -p "/bridge …"`
  from there. Typing in agy's own prompt, or from PowerShell/cmd, is not affected.

## 3. Antigravity design

```text
/bridge <task>   →  PreInvocation hook (invocationNum 0): transcript → last user message → handlePrompt
                    → injectSteps: report contract (system message)
agent finishes   →  Stop hook: transcript → final message → handleStop (Codex via CodexCliAdapter)
Codex CONTINUE   →  { decision: "continue", reason: status block + Codex's instruction + contract }
Codex DONE / NEED_HUMAN / cap / error → { decision: "continue", reason: "show this block" } once; then the Stop passes
```

| Path | |
|---|---|
| `plugins/antigravity/` | the plugin agy loads: `plugin.json`, `hooks.json`, `skills/bridge/SKILL.md`, `dist/hook.mjs` (built, committed) |
| `src/chat-hosts/antigravity/transcript.ts` | reads the transcript: last user message, final reply |
| `src/chat-hosts/antigravity/hooks.ts` | `handlePreInvocation`, `handleAgyStop` over `bridge-loop.ts`; a cursor file (`prompt-cursor.json`) makes a message arm once |
| `src/chat-hosts/antigravity/hook-entry.ts` | stdin/stdout entry, always exit 0, a failure lets the agent stop |
| `src/chat-hosts/review-deps.ts` | shared with OpenCode (§4) |
| `scripts/chat-hosts/build.ts`, `install.ts` | bundle both plugins; copy one into a project or the user's settings |

## 4. Shared: the review's environment

`checkEnvForApiKeys` stops the Claude Code loop when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY` or `CODEX_API_KEY` is set, because there Claude Code's own billing would change. In
OpenCode such a key is usually the agent's own provider key, and it would have stopped every loop
(docs/67 §5). For the two new hosts the review now runs with **none of those four variables in its
environment** (`reviewerEnv`): the guard has nothing to trip on, and Codex never sees them, so a
ChatGPT-signed-in Codex review stays $0 whatever the agent uses. A test keeps the list in step with
the core guard. The Claude Code plugin is unchanged. (What this does not cover: Codex itself logged in
with an API key through `codex login`; docs/66 does not check that either.)

## 5. OpenCode: what changed since docs/67

- Sources moved to `src/chat-hosts/opencode/` (`bridge.ts`, `entry.ts`); `plugins/opencode/` holds the
  bundle (`dist/ai-bridge.js`, committed, kept current by `tests/chat-hosts/dist-build.test.ts`) and a README.
- The cost-guard point of docs/67 §5 is closed (§4).
- `node scripts/chat-hosts/install.ts opencode --project <dir>` copies the bundle to
  `<dir>/.opencode/plugins/ai-bridge.js`; `--global` to `~/.config/opencode/plugins/`.
- The other points of docs/67 §5 stand: no hook can hold the agent at the stop; headless `opencode run`
  cannot host the loop; the round line is a user-role bubble.

## 6. What was verified

**Tests** (`tests/chat-hosts/`, 43; `tsc --noEmit` clean): the OpenCode adapter (20, docs/67 §6); the Antigravity
transcript parser, both hooks (arming once per message, first model call only, refusals, CONTINUE / DONE /
errors / not-yet-idle / transcript flush wait), the built hook run as agy runs it (stdin/stdout, exit 0,
unreadable input lets the agent stop), the plugin folder's manifest and `hooks.json` shape; the key-free
environment; both committed bundles equal a fresh build; the installer's folders.

**Real Antigravity 1.3.4** (project plugin in `.agents/plugins/ai-bridge/`, `agy -p`; the executor was agy's own
model, Gemini Flash):

- `agy plugin validate`: passed (hooks 1, skills 1).
- Fake Codex: `/bridge --vong 5 …` armed from the transcript; the model followed the contract
  (Tóm tắt cho bạn + report); round 1 and 2 CONTINUE → the model opened with the status block and the
  acknowledge line; round 3 DONE → the closing block (`AI Bridge · vòng 3/5 · ✅ Codex đã duyệt`); state `DONE`, round 3.
  `/bridge stop` in a conversation without a loop → "AI Bridge: no review loop is running in this session."
  `--vong 1` → the round cap ended it (NEED_HUMAN, the instruction Codex would have sent shown);
  `agy --conversation <id> -p "/bridge <answer>"` carried the same loop on (cap 1 → 4, rounds 2–3, DONE).
- **Real Codex** (one run, ChatGPT free plan, report only): `/bridge --vong 2 Describe in one sentence what a
  sum(a, b) function does…` → `vòng 1/2 · ✅ Codex đã duyệt · 3/3 phần xong` and `Codex free · đã dùng 68% hạn
  mức 30 ngày · đặt lại sau 26 ngày · Codex chỉ đọc báo cáo` in the output; 66% → 68% for that review.

**Real OpenCode 1.19.0**: docs/67 §6. The sources moved and the review's environment changed (§4) after those runs;
the unit tests and the bundle test cover both, the live OpenCode run was **not repeated**.

## 7. Not verified

- agy's interactive prompt (TUI), the Antigravity App and IDE (hooks are documented for all three; the
  transcript lives under `antigravity` / `antigravity-ide` there, the hook input names the file) and
  how a status block looks there; OpenCode's TUI and desktop app (docs/67 §6).
- `agy plugin install <path>` and `--global` installs (the project folder was used: installing into
  `~/.gemini/config/plugins/` changes every agy session of the user's, so it was left to them);
  whether hook folders keep working directory = plugin folder when installed that way.
- `agy plugin import claude` (agy can import Claude Code plugins): not tried, it writes agy's settings.
- A real-Codex CONTINUE round in either tool (quota); `fullyIdle: false`, an agent error, a user interrupt in agy
  (whether Stop fires) — the code lets all of these pass without a review, from the documentation, not from a run.
- macOS / Linux; agy or OpenCode versions other than 1.3.4 / 1.19.0.
- The model showing the status block is the model's cooperation (the reason asks for it verbatim): every
  real run did, and the loop's decisions never depend on it.

## 8. Install

```bash
node scripts/chat-hosts/install.ts antigravity --project <dir>   # or: agy plugin install plugins/antigravity
node scripts/chat-hosts/install.ts opencode    --project <dir>
```

Then in the project: `/bridge [--vong N] <task>`, `/bridge <answer>`, `/bridge stop`. Codex must be
installed and signed in (ChatGPT). `AI_BRIDGE_NOTIFY=off`, `AI_BRIDGE_CODEX_CHECK_CODE` work as in docs/66.
After changing `src/chat-hosts/` (or what it imports): `pnpm build:chat-hosts` and commit the bundles.

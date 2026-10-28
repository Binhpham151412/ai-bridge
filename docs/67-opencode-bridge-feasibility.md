# 67 — The AI Bridge review loop inside OpenCode: feasibility and a prototype

Status: **feasible; prototype built and run for real** (2026-10-28, OpenCode 1.19.0 on Windows,
real Codex reviewer on the ChatGPT free plan). Throwaway: not wired into the desktop app, not
packaged, not on a release path. Builds on docs/66 (the Claude Code plugin).

## 1. Answer

Yes. OpenCode's plugin system has everything the Claude Code plugin gets from hooks, and the
loop itself (`src/claude-code/bridge-loop.ts`) is reused **unchanged**: the prototype is a 290-line
adapter (`plugins/opencode/`) that maps OpenCode's hooks onto `handlePrompt` and `handleStop`.

```text
/bridge <task>  →  command.execute.before → handlePrompt (arms the loop, contract added to the prompt)
agent finishes  →  session.idle event     → handleStop   (final message → Codex via CodexCliAdapter)
Codex CONTINUE  →  client.session.promptAsync(next instruction) → the agent works again → idle → …
Codex DONE / NEED_HUMAN / cap / error → chat-only line + toast + OS notification, the loop ends
```

Three differences from Claude Code matter (§5): OpenCode has **no hook that can hold the agent
at the stop** (the review runs while the session is idle, so the user can type meanwhile); a
**headless `opencode run` cannot host the loop** (it exits at the first idle); and **`/bridge stop`
cannot "block the prompt"** — the plugin fails the command and puts the message in the chat itself.

## 2. What was checked

| | |
|---|---|
| OpenCode | CLI 1.19.0 (npm `opencode-ai`, global install: `%APPDATA%\npm\opencode`; 1.19.5 is the latest on npm today). Plugin types `@opencode-ai/plugin` / `@opencode-ai/sdk` 1.19.0 (the `1.14.30` the user's config folder pins has the same hooks; 1.19 adds `dispose` and `metadata`). Source: `github.com/anomalyco/opencode` tag `v1.19.0` (`packages/opencode/src/{session,plugin}`, `packages/tui/src`). Docs: `opencode.ai/docs/plugins` (last updated 2026-10-27) |
| Sign-in on this machine | `opencode auth list` says 8 credentials: per-provider API keys (OpenCode has no account login of its own for most providers; `opencode-provider.ts` reads only this count). Config `~/.config/opencode/opencode.jsonc` defines custom OpenAI-compatible providers; the model last used is `anthropic/claude-sonnet-4-6`. No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` in the environment. The tests used the free hosted model `opencode/big-pickle` (no key, no cost) as the executor |
| ChatGPT | Codex (the reviewer) is signed in with ChatGPT, free plan. OpenCode has a built-in plugin that signs its own OpenAI provider in with ChatGPT (OAuth at `auth.openai.com`, requests to `chatgpt.com/backend-api/codex/responses`: `plugin/openai/codex.ts`, listed in `internalPlugins` in `plugin/index.ts`); **not tried** — if the executor and the reviewer both use ChatGPT sign-in they draw on the same account's limits |

## 3. The capabilities, one by one

| Needed (Claude Code mechanism) | OpenCode | Source | Verified |
|---|---|---|---|
| **(a)** See `/bridge …` as typed (`UserPromptSubmit`) | Plugin hook `command.execute.before` `{ command, sessionID, arguments }`, with `output.parts` (the prompt parts, mutable). `chat.message` also sees every user message, but a command is cleaner: no regex over free text | `Hooks` in `@opencode-ai/plugin` `dist/index.d.ts`; call site `session/prompt.ts` (`plugin.trigger("command.execute.before", …)`) | yes |
| Register `/bridge` (plugin skill) | The `config` hook may add `cfg.command.bridge = { template, description }`; a file `.opencode/commands/bridge.md` would do too. The template's `$ARGUMENTS` is the text after `/bridge` | `plugin/index.ts` calls `hook.config(cfg)` at start; `session/prompt.ts` fills `$ARGUMENTS` | yes: `GET /command` lists it, the web UI's `/` popup shows it with its description. The TUI sends a command with `session.command` (`tui/src/component/prompt/index.tsx`, `void sdk.client.session.command(…)`) |
| Add the report contract for the model only (`additionalContext`) | Push a text part with `synthetic: true` into `output.parts`: sent to the model, not drawn in the chat | `message-v2.ts` (model messages drop only `ignored` parts); TUI draws only non-synthetic text (`routes/session/index.tsx`) | yes: the model answered in the contract's format |
| Refuse / `/bridge stop` (`decision: "block"` on the prompt) | **No clean equivalent.** The command always goes on to prompt the model; the only way to skip it is to throw from the hook, which the server turns into a 500 "Unexpected server error", and the TUI ignores the result of `session.command`. So the plugin writes the message to the chat first (below) and then throws | `Plugin.trigger` runs the hook inside `Effect.promise`: a rejection is a defect | yes through the API and the web UI (no error toast there); TUI by reading the source |
| The agent finished a turn (`Stop`) | `event` hook, `session.idle` (also `session.status` → `idle`). Published by `SessionStatus.set` when the session's runner goes idle; the runner is already removed, so a `promptAsync` from the handler is not refused as busy | `session/status.ts`, `session/run-state.ts`, `plugin/index.ts` | yes. **But** it is fire-and-forget (`void hook.event(…)`): nothing waits for the handler and it cannot hold the agent. Interrupts: `session.error` (`MessageAbortedError`) comes first, then **two** idles (the second after the half-written message is closed) |
| Claude's final message (`last_assistant_message`) | `client.session.messages` → the last assistant message's text parts (not `synthetic` / `ignored`); `info.time.completed` says it is closed, `info.error` that it failed | `@opencode-ai/sdk` | yes |
| Continue with the next prompt (`decision: "block"` + reason) | `client.session.promptAsync({ path: { id }, body: { parts } })`: a new user message that starts the next turn. Codex's instruction is a normal text part, the round line an `ignored` part, the contract and "acknowledge the review" line a `synthetic` part | SDK `Session.promptAsync`; `PromptInput` in `session/prompt.ts` | yes (fake Codex, 3 rounds; real Codex, 1 round) |
| Show the user a message (`systemMessage`) | A chat-only line: `client.session.prompt({ noReply: true, parts: [{ type: "text", text, ignored: true }] })` — drawn as a user bubble in the web UI, in the TUI by the source (`UserMessage` draws every non-synthetic text part), never sent to the model (a user message of only `ignored` parts is dropped from the model's context). Plus `client.tui.showToast` (TUI only; failures are swallowed) and the unchanged OS notification (`notify.ts`) | `message-v2.ts`; `tui/src/routes/session/index.tsx` | yes in the web UI (screenshot of the DONE line with the quota line); toast and TUI not seen |
| The "Codex đang review…" spinner (`statusMessage`) | None. A 30 s info toast instead | | toast not seen |
| Timeouts, process lifetime | The plugin lives as long as the OpenCode server (TUI, desktop app, web, `opencode serve`). No hook timeout; Codex keeps its own 10 minutes | | |
| Packaging | A file in `.opencode/plugins/` (one project) or `~/.config/opencode/plugins/` (all), or an npm package named in `opencode.json` `plugin: []`. OpenCode calls **every export** of the file and throws on a non-function, so the file exports one function. The file is a bundle (it imports `src/`) | docs `opencode.ai/docs/plugins`; `getLegacyPlugins` in `plugin/index.ts` | yes (project plugin folder) |

## 4. Design

**Reused unchanged** (all of `src/claude-code/` and what it uses): `handlePrompt` (arming,
`--vong N`, `stop`, answering a NEED_HUMAN with `/bridge <answer>`, the contract), `handleStop`
(Codex review through `CodexCliAdapter`, thread resume, `CodexResponseParser`, the Vietnamese
checklist and `AI Bridge · vòng N/M · …` line, the round cap, `/bridge stop` winning over a review
in flight, the free-plan "Codex chỉ đọc báo cáo" rule, the quota line from Codex's own log, the
`$0` cost guard, the OS notification), `buildChatReportContract`, `buildChatReviewerInput`.

**New** (`plugins/opencode/bridge.ts`, `entry.ts`; `scripts/opencode-plugin/build.ts` bundles `entry.ts` to `plugins/opencode/dist/ai-bridge.js`):

| Hook | Does |
|---|---|
| `config` | registers `/bridge` |
| `command.execute.before` | `handlePrompt({ session_id: <OpenCode session id>, cwd: <project dir>, prompt: "/bridge " + arguments })`; the arming context becomes a `synthetic` part; a refusal is posted to the chat and thrown |
| `event` | `session.idle` → read the final message → `handleStop` → CONTINUE: `promptAsync`; end: chat line + toast. Also tracks `session.error` (interrupt: no review, the loop stays armed until the user's next turn) and `session.status` busy/idle |

State is the Claude Code plugin's, in its own folder: `~/.ai-bridge/opencode/<session id>/`
(`AI_BRIDGE_OPENCODE_DIR`): `state.json`, `loop-N/NNN-{report,codex-input,codex-review}.md`,
`codex-account.json`. The session ids (`ses_…`) pass the loop's folder-name check.

Two OpenCode behaviours the plugin works around (both seen on 1.19.0):

- **A user message that arrives mid-turn makes OpenCode run one more step after the turn**, even
  a chat-only one the model never sees (a second 800-word answer was generated). So a chat-only
  line for a session whose agent is mid-turn (`/bridge stop` typed while it works) is held until
  the idle event. `/bridge stop` itself acts at once (the command hook runs before OpenCode
  checks whether the session is busy: 47 ms, state `STOPPED`, no review afterwards).
- **An interrupt is not visible in the message at the first idle.** `session.error`
  (`MessageAbortedError`) precedes the idle events, so the plugin remembers it and skips the
  review until the next `session.status` busy.

## 5. Differences from the Claude Code plugin, and open points

- **The review runs while the session is idle.** The user can type meanwhile. An idle during a
  review is ignored (one review per session at a time); the CONTINUE that follows is queued
  behind whatever the user sent. `CodexCliAdapter` has no abort signal, so a review cannot be
  cancelled; `/bridge stop` still wins over its result.
- **`opencode run` cannot host the loop.** `run` leaves at the first `session.idle`
  (`cli/cmd/run.ts`); tried with `opencode run --command bridge …`: the process ended during the
  review and the state stayed `RUNNING`, round 0. The TUI, the desktop app, the web UI and
  `opencode serve` (driven by the SDK, or `opencode run --attach`) keep the plugin alive.
- **The cost guard looks at OpenCode's environment.** `checkEnvForApiKeys` stops the loop when
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` or `CODEX_API_KEY` is set. For
  Claude Code that is right; OpenCode users often keep an API key for the executor in the
  environment, which would stop every loop. Before shipping: guard only what Codex would use
  (`OPENAI_API_KEY`, `CODEX_API_KEY`) and strip the rest from Codex's environment.
- The round line is a **user-role bubble**, not a system message; there is no spinner line.
- `/bridge <new task>` typed while the agent is mid-turn re-arms the loop at once (the hook runs
  before the busy check), so the turn in flight is reviewed against the new task. Not tried.
- Only Windows (OpenCode 1.19.0 from npm) was tried. The plugin is pinned to nothing: OpenCode's
  plugin API is still moving (`experimental.*` hooks; 1.14 → 1.19 added hooks and renamed types).
- A CONTINUE that `promptAsync` fails to send leaves the loop `RUNNING` with a chat line
  "AI Bridge plugin error: …"; the user's next turn gets reviewed.

## 6. What was verified (2026-10-28)

- `tests/opencode-plugin/bridge.test.ts` (20 tests, fake OpenCode client, fake Codex CLI): command
  registration; arming and the synthetic contract; refusals reach the chat and a toast and fail
  the command; CONTINUE parts (round line `ignored`, instruction visible, contract `synthetic`);
  DONE (chat line, toast, notification, nothing sent); final message extraction (hidden and
  synthetic parts out, trailing chat-only lines skipped); interrupt handling; one review at a time;
  a failed turn; the cost guard; a plugin error never thrown into OpenCode; answering a NEED_HUMAN;
  chat lines held while the agent is mid-turn; the bundle is self-contained and exports only the
  plugin. `tsc --noEmit` is clean (the plugin is in `tsconfig.json`'s `include`).
- **Real OpenCode 1.19.0** (`opencode serve` with the bundle in the project's `.opencode/plugins/`,
  driven through the SDK; executor `opencode/big-pickle`):
  - fake Codex: `/bridge` armed the loop and the model followed the contract; round 1 CONTINUE →
    next instruction as a user message → the model opened with the acknowledge line → round 2…
    DONE, 3 rounds; `--vong 1` → the round cap ended it as NEED_HUMAN; `/bridge <answer>` carried
    on (4 rounds, same loop); `/bridge stop` and an empty task refused with the message in the
    chat; an interrupt mid-answer → no review, state `RUNNING`; `/bridge stop` mid-answer →
    stopped in 47 ms, no extra step, no review;
  - **real Codex** (one run, ChatGPT free plan, report only): `/bridge --vong 2 Describe in one
    sentence what a sum(a, b) function does…` → Codex's Vietnamese checklist, `vòng 1/2 · ✅ Codex
    đã duyệt · 2/2 phần xong`, `Codex free · đã dùng 66% hạn mức 30 ngày · đặt lại sau 26 ngày ·
    Codex chỉ đọc báo cáo` in the chat; the quota went from 64% to 66% for that review;
  - the web UI of that server showed `/bridge` in its command popup and the DONE line as a chat
    bubble; `/bridge stop` typed there answered with the refusal bubble and no error toast.
- **Not verified**: the TUI (rendering of the chat-only lines, toasts) and the desktop app; that
  the Windows toast is seen; a real-Codex CONTINUE round and `/bridge <answer>` (only the fake
  Codex ran them; the resume path is the Claude Code plugin's, tried in docs/66 §8); `/bridge
  <task>` mid-turn; macOS / Linux; Antigravity / other OpenCode versions; an OpenCode signed in
  with ChatGPT.

## 7. Try it

```bash
node scripts/opencode-plugin/build.ts                 # → plugins/opencode/dist/ai-bridge.js
mkdir -p <project>/.opencode/plugins && cp plugins/opencode/dist/ai-bridge.js <project>/.opencode/plugins/
cd <project> && opencode                              # then: /bridge --vong 3 <task>
```

Use `~/.config/opencode/plugins/` instead for every project. The same commands as the Claude Code
plugin: `/bridge [--vong N] <task>`, `/bridge <answer>` while Codex waits on you, `/bridge stop`.
Codex must be installed and signed in (ChatGPT); `AI_BRIDGE_OPENCODE_DIR`, `AI_BRIDGE_NOTIFY` and
`AI_BRIDGE_CODEX_CHECK_CODE` work as in docs/66. Nothing is installed globally by the repo.

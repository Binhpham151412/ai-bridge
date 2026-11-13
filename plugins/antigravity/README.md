# AI Bridge for Antigravity (`agy`)

The `/bridge` review loop of the Claude Code plugin, inside Antigravity: Codex reviews the agent's
final message each turn and sends the next instruction until DONE. Design and what was verified:
[docs/68](../../docs/68-opencode-antigravity-plan.md).

```bash
node scripts/chat-hosts/install.ts antigravity --project <dir>   # → <dir>/.agents/plugins/ai-bridge/
agy plugin install plugins/antigravity                           # or: for every project (agy's own installer)
```

Then, in the project: `/bridge [--vong N] <task>`, `/bridge <answer>` while Codex waits on you,
`/bridge stop`. (From Git Bash on Windows, `agy -p "/bridge …"` needs `MSYS_NO_PATHCONV=1`.)

| Path | |
|---|---|
| `plugin.json`, `hooks.json`, `skills/bridge/` | what agy loads: the manifest, the `PreInvocation` and `Stop` hooks (the Stop timeout is 900 s: a Codex review takes a while), the `/bridge` skill |
| `dist/hook.mjs` | the hook command, bundled and committed (`pnpm build:chat-hosts` after changing `src/chat-hosts/`) |
| `../../src/chat-hosts/antigravity/` | the hooks over `src/claude-code/bridge-loop.ts`: arming from the transcript, the review, CONTINUE as `decision: "continue"` |

State: `~/.ai-bridge/antigravity/<conversation id>/` (`AI_BRIDGE_ANTIGRAVITY_DIR`).

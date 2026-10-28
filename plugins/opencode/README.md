# AI Bridge for OpenCode

The `/bridge` review loop of the Claude Code plugin, inside OpenCode: Codex reviews the agent's
final message each turn and sends the next instruction until DONE. Design and what was verified:
[docs/67](../../docs/67-opencode-bridge-feasibility.md) and [docs/68](../../docs/68-opencode-antigravity-plan.md).

```bash
node scripts/chat-hosts/install.ts opencode --project <dir>     # → <dir>/.opencode/plugins/ai-bridge.js
```

(`--global` instead of `--project <dir>` installs it for every project, in `~/.config/opencode/plugins/`.)
Then, in OpenCode (TUI, desktop app or web; not a headless `opencode run`):
`/bridge [--vong N] <task>`, `/bridge <answer>` while Codex waits on you, `/bridge stop`.

| Path | |
|---|---|
| `dist/ai-bridge.js` | the plugin OpenCode loads: one bundled file (built and committed; `pnpm build:chat-hosts` after changing `src/chat-hosts/`) |
| `../../src/chat-hosts/opencode/` | the hooks (`config`, `command.execute.before`, `event`) over `src/claude-code/bridge-loop.ts`, and the plugin function |

State: `~/.ai-bridge/opencode/<session id>/` (`AI_BRIDGE_OPENCODE_DIR`).

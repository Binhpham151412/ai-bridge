# AI Bridge for OpenCode (prototype)

The `/bridge` review loop of the Claude Code plugin, inside OpenCode: Codex reviews the agent's
final message each turn and sends the next instruction until DONE. Design, what was verified and
what was not: [docs/67](../../docs/67-opencode-bridge-feasibility.md).

```bash
node scripts/opencode-plugin/build.ts            # writes plugins/opencode/dist/ai-bridge.js (not committed)
mkdir -p <project>/.opencode/plugins && cp plugins/opencode/dist/ai-bridge.js <project>/.opencode/plugins/
```

Then, in OpenCode (TUI, desktop app or web; not a headless `opencode run`):
`/bridge [--vong N] <task>`, `/bridge <answer>` while Codex waits on you, `/bridge stop`.

| File | |
|---|---|
| `bridge.ts` | the hooks (`config`, `command.execute.before`, `event`) over `src/claude-code/bridge-loop.ts` |
| `entry.ts` | the plugin function OpenCode loads: wires the real Codex, git, notification and state folder (`~/.ai-bridge/opencode`, `AI_BRIDGE_OPENCODE_DIR`) |

// docs/66 — the Claude Code plugin's hook command, bundled to plugins/claude-code/dist/hook.mjs:
//   node hook.mjs prompt   UserPromptSubmit (`/bridge <task>`, `/bridge stop`)
//   node hook.mjs stop     Stop (Codex review)
// Reads the hook input from stdin and prints the hook output, if any, as JSON. Always exits 0:
// exit 2 would block Claude, any other non-zero exit is shown as a hook error.
import { homedir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../adapters/chatgpt/codex-cli-adapter.ts';
import { DEFAULT_CONFIG } from '../core/config/config.ts';
import { createRealExecutableLocator } from '../core/providers/executable-discovery.ts';
import { handlePrompt, handleStop, type HookOutput } from './bridge-loop.ts';
import { readCodexAccount } from './codex-account.ts';
import { changesSince, headCommit } from './git-changes.ts';
import { osNotify } from './notify.ts';

const stateRoot = process.env.AI_BRIDGE_CLAUDE_CODE_DIR || path.join(homedir(), '.ai-bridge', 'claude-code');
const now = () => new Date();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function run(kind: string | undefined): Promise<HookOutput | null> {
  const input = JSON.parse(await readStdin());
  if (kind === 'prompt') return handlePrompt(input, { stateRoot, now, headCommit });
  if (kind === 'stop') {
    return handleStop(input, {
      stateRoot,
      now,
      env: process.env,
      codexTimeoutMs: DEFAULT_CONFIG.codexTimeoutMs,
      changesSince,
      codexAccount: (threadId) => readCodexAccount(process.env.CODEX_HOME || path.join(homedir(), '.codex'), threadId),
      notify: osNotify,
      locateCodex: async () => {
        const exe = await createRealExecutableLocator()('codex');
        return exe === null ? null : new CodexCliAdapter({ executable: exe });
      },
    });
  }
  throw new Error(`unknown hook kind ${JSON.stringify(kind)}`);
}

try {
  const out = await run(process.argv[2]);
  if (out !== null) process.stdout.write(JSON.stringify(out));
} catch (err) {
  process.stdout.write(JSON.stringify({ systemMessage: `AI Bridge hook error: ${err instanceof Error ? err.message : String(err)}` }));
}
process.exitCode = 0;

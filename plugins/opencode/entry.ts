// docs/67 — the OpenCode plugin, bundled to plugins/opencode/dist/ai-bridge.js (scripts/opencode-plugin/build.ts).
// OpenCode calls every export of a plugin file as a plugin and rejects any export that is not a
// function, so this file exports the one plugin and nothing else.
import { homedir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../../src/adapters/chatgpt/codex-cli-adapter.ts';
import { readCodexAccount } from '../../src/claude-code/codex-account.ts';
import { changesSince, headCommit } from '../../src/claude-code/git-changes.ts';
import { osNotify } from '../../src/claude-code/notify.ts';
import { DEFAULT_CONFIG } from '../../src/core/config/config.ts';
import { createRealExecutableLocator } from '../../src/core/providers/executable-discovery.ts';
import { createBridgeHooks, type OpenCodeClient } from './bridge.ts';

const stateRoot = process.env.AI_BRIDGE_OPENCODE_DIR || path.join(homedir(), '.ai-bridge', 'opencode');

export const AiBridge = async ({ client, directory }: { client: OpenCodeClient; directory: string }) =>
  createBridgeHooks({
    client,
    directory,
    stateRoot,
    now: () => new Date(),
    env: process.env,
    codexTimeoutMs: DEFAULT_CONFIG.codexTimeoutMs,
    headCommit,
    changesSince,
    codexAccount: (threadId) => readCodexAccount(process.env.CODEX_HOME || path.join(homedir(), '.codex'), threadId),
    notify: osNotify,
    locateCodex: async () => {
      const exe = await createRealExecutableLocator()('codex');
      return exe === null ? null : new CodexCliAdapter({ executable: exe });
    },
  });

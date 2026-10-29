import { homedir } from 'node:os';
import path from 'node:path';
import { CodexCliAdapter } from '../adapters/chatgpt/codex-cli-adapter.ts';
import type { StopDeps, PromptDeps } from '../claude-code/bridge-loop.ts';
import { readCodexAccount } from '../claude-code/codex-account.ts';
import { changesSince, headCommit } from '../claude-code/git-changes.ts';
import { osNotify } from '../claude-code/notify.ts';
import { DEFAULT_CONFIG } from '../core/config/config.ts';
import { createRealExecutableLocator } from '../core/providers/executable-discovery.ts';

/**
 * docs/68 — what the OpenCode and Antigravity plugins share: the real Codex, git, quota and
 * notification wiring of the review (the Claude Code plugin has its own copy in `hook-entry.ts`,
 * left as it is) and the environment the review runs in.
 */

/**
 * Keys that would make a Codex review bill an API account (src/core/cost-guard.ts) — plus the
 * Anthropic ones the guard also lists. In Claude Code they are the agent's own billing, so the
 * guard stops the loop. In OpenCode and Antigravity a key in the environment is usually the
 * *agent's* provider key, which must not stop a ChatGPT-signed-in Codex review: the review runs
 * without any of them (the guard then has nothing to trip on, and Codex never sees them).
 */
export const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

export function reviewerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of API_KEY_VARS) delete clean[key];
  return clean;
}

/** The state folder of a plugin host: `<override env var>` or `~/.ai-bridge/<host>`. */
export const stateRootOf = (host: string, overrideVar: string, env: NodeJS.ProcessEnv = process.env): string => env[overrideVar] || path.join(homedir(), '.ai-bridge', host);

export type ReviewDeps = Pick<StopDeps, 'env' | 'codexTimeoutMs' | 'locateCodex' | 'changesSince' | 'codexAccount' | 'notify'> & Pick<PromptDeps, 'headCommit'>;

/** The real Codex review wiring, with the review's environment already cleaned of API keys. */
export function realReviewDeps(env: NodeJS.ProcessEnv = process.env): ReviewDeps {
  return {
    env: reviewerEnv(env),
    codexTimeoutMs: DEFAULT_CONFIG.codexTimeoutMs,
    headCommit,
    changesSince,
    codexAccount: (threadId) => readCodexAccount(env.CODEX_HOME || path.join(homedir(), '.codex'), threadId),
    notify: osNotify,
    locateCodex: async () => {
      const exe = await createRealExecutableLocator()('codex');
      return exe === null ? null : new CodexCliAdapter({ executable: exe });
    },
  };
}

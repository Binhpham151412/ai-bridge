// Test double for dist-desktop/run-host.mjs: the real `serveRunHost` + a real
// BridgeEngine, wired to the fake claude/codex CLIs and a passing doctor instead of the
// user's real CLIs. Forked by tests/desktop/run-controller.test.ts exactly the way
// Electron Main forks the production host.
import { fileURLToPath } from 'node:url';
import { BridgeEngine, CRASH_POINTS, type BridgeStartOptions } from '../../../src/core/bridge-engine.ts';
import { DEFAULT_CONFIG } from '../../../src/core/config/config.ts';
import { serveRunHost } from '../../../src/desktop/main/run-host.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fake-codex/fake-codex.mjs', import.meta.url));

function crashInjection(): BridgeStartOptions['crashInjection'] {
  const at = process.env.AI_BRIDGE_CRASH_AT;
  if (!at || !(CRASH_POINTS as readonly string[]).includes(at)) return undefined;
  return { at: at as (typeof CRASH_POINTS)[number], onTrigger: () => process.exit(137) };
}

serveRunHost({
  createEngine: (projectPath) =>
    new BridgeEngine(projectPath, {
      runDoctor: async () => ({
        report: { checks: [{ name: 'fake', status: 'PASS', detail: 'ok' }], overall: 'PASS' },
        claudeExe: process.execPath,
        codexExe: process.execPath,
        config: DEFAULT_CONFIG,
        configErrors: [],
        gitWarning: null,
      }),
      claudeCommandArgsPrefix: [FAKE_CLAUDE],
      codexCommandArgsPrefix: [FAKE_CODEX],
      claudeEnv: { FAKE_CLAUDE_MODE: process.env.FAKE_CLAUDE_MODE ?? 'ok', FAKE_CLAUDE_DELAY_MS: process.env.FAKE_CLAUDE_DELAY_MS ?? '0' },
      codexEnv: { FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE ?? 'sequence' },
    }),
  crashInjection: crashInjection(),
});

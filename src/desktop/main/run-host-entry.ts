import { BridgeEngine, CRASH_POINTS, type BridgeStartOptions } from '../../core/bridge-engine.ts';
import { serveRunHost } from './run-host.ts';

// Bundled as dist-desktop/run-host.mjs and forked by Electron Main (see run-host.ts).
// ELECTRON_RUN_AS_NODE only exists so this file runs on Electron's bundled Node — it
// must never leak into the environment of the claude/codex processes Core spawns.
delete process.env.ELECTRON_RUN_AS_NODE;

function crashInjectionFromEnv(): BridgeStartOptions['crashInjection'] {
  const at = process.env.AI_BRIDGE_CRASH_AT;
  if (!at || !(CRASH_POINTS as readonly string[]).includes(at)) return undefined;
  // Test-only, identical to cli.ts: a real self-crash at a named point so crash
  // recovery can be tested against a genuine interruption. Never set in normal use.
  return { at: at as (typeof CRASH_POINTS)[number], onTrigger: () => process.exit(137) };
}

serveRunHost({ createEngine: (projectPath) => new BridgeEngine(projectPath), crashInjection: crashInjectionFromEnv() });

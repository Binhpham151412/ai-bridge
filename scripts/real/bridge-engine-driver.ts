#!/usr/bin/env node
// Manual real-CLI test driver — NEVER run by `pnpm test`. Calls BridgeEngine directly
// (no cli.ts involvement at all), exactly the way a future Electron main process would,
// per M3.5 spec §11: "Phải dùng Core API. Không gọi CLI command nội bộ để giả lập
// Electron." Consumes real Claude/Codex quota. Only ever point this at a disposable
// sandbox/* project, never the main repo.
//
// Usage:
//   node scripts/real/bridge-engine-driver.ts start <projectPath> <task text...>
//   node scripts/real/bridge-engine-driver.ts resume <projectPath>
//   node scripts/real/bridge-engine-driver.ts pause <projectPath>
//   node scripts/real/bridge-engine-driver.ts status <projectPath>
//
// AI_BRIDGE_CRASH_AT=<point> (start only) forces a real self-crash at that named point.

import { BridgeEngine, CRASH_POINTS } from '../../src/core/bridge-engine.ts';

async function main(): Promise<void> {
  const [, , mode, projectPath, ...rest] = process.argv;
  if (!mode || !projectPath) {
    console.error('Usage: bridge-engine-driver.ts <start|resume|pause|status> <projectPath> [task text...]');
    process.exitCode = 1;
    return;
  }

  const engine = new BridgeEngine(projectPath);

  if (mode === 'start') {
    const task = rest.join(' ');
    const crashAt = process.env.AI_BRIDGE_CRASH_AT;
    const crashInjection =
      crashAt && (CRASH_POINTS as readonly string[]).includes(crashAt)
        ? { at: crashAt as (typeof CRASH_POINTS)[number], onTrigger: () => process.exit(137) }
        : undefined;
    const outcome = await engine.start({ task, crashInjection });
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (mode === 'resume') {
    const outcome = await engine.resume();
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (mode === 'pause') {
    const outcome = await engine.pause();
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }
  if (mode === 'status') {
    const status = await engine.status();
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.error(`Unknown mode: ${mode}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

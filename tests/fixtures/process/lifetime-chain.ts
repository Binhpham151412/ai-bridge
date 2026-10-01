// Process chain for tests/workflow/process-lifetime.windows.test.ts, built ONLY from the
// production primitives whose lifetime is under test:
//
//   test ──forkChildHost (default, like Main → Workflow Host)──► parent (this file)
//   parent ──forkRunHost / forkChildHost({ lifetime })──────────► child  (this file; like a Workflow
//                                                                         Host forking an Execution Host)
//   child ──process-runner runProcess (like an Execution Host ───► cli    (sleep-forever.mjs, the fake
//            spawning Claude/Codex)                                        long-running provider CLI)
//
// Roles and options travel in the environment (the fork helpers pass no argv):
//   LIFETIME_ROLE  parent | child      LIFETIME_INFO  file receiving {parent, child, cli} pids
//   LIFETIME_MODE  default (forkRunHost with no lifetime option — the M4 run host call) |
//                  with-parent | independent
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../../src/automation/process-runner.ts';
import { forkChildHost, forkRunHost } from '../../../src/desktop/main/fork-run-host.ts';
import type { HostLifetime } from '../../../src/desktop/main/process-lifetime.ts';

const SELF = fileURLToPath(import.meta.url);
const SLEEP = fileURLToPath(new URL('./sleep-forever.mjs', import.meta.url));
const role = process.env.LIFETIME_ROLE;
const infoFile = process.env.LIFETIME_INFO ?? '';
const mode = process.env.LIFETIME_MODE ?? 'default';

if (role === 'parent') {
  const env = { ...process.env, LIFETIME_ROLE: 'child' };
  if (mode === 'default') forkRunHost({ scriptPath: SELF, execPath: process.execPath, env });
  else forkChildHost<unknown>({ scriptPath: SELF, execPath: process.execPath, env, lifetime: mode as HostLifetime });
  setInterval(() => {}, 1000);
} else if (role === 'child') {
  const info: { parent: number; child: number; cli: number | null } = { parent: process.ppid, child: process.pid, cli: null };
  void runProcess({
    command: process.execPath,
    args: [SLEEP],
    timeoutMs: 120_000,
    onSpawn: (pid) => {
      info.cli = pid;
      writeFileSync(infoFile, JSON.stringify(info));
    },
  });
  process.on('disconnect', () => {
    // What a host could do once its parent is gone (a late Node warning, a log line): with the
    // 'independent' lifetime this must be harmless.
    process.stderr.write('child: parent gone, still running\n');
    appendFileSync(`${infoFile}.log`, 'disconnect\n');
  });
  setInterval(() => {}, 1000);
}

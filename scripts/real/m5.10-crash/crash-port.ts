// TEST-ONLY (M5.10 B″, docs/59 §22.5/§23). Never imported by src/; bundled only into the crash app.
//
// A decorator of the PRODUCTION ExecutionPort (createExecutionPort → ForkedExecutionPort). With the
// hook disabled it returns the production port object itself — no wrapper at all. Armed, it adds
// exactly one self-exit of the Workflow Host at one point; every other call is delegated unchanged.
// It never throws: the production port swallows observer exceptions (forked-execution-port.ts,
// onHostSpawned/onEvent), so a crash must be a real process exit — process.exit(137), which runs no
// cleanup (src/ registers no exit/beforeExit/disconnect handler), leaving the lock and host record
// behind exactly like a killed Workflow Host.
import type { ExecutionPort } from '../../../src/core/workflow/execution-port.ts';
import { createExecutionPort } from '../../../src/hosts/execution-host-spawn.ts';
import { serveWorkflowHost, type WorkflowHostDeps } from '../../../src/hosts/workflow-host.ts';
import { CRASH_EXIT_CODE, fire, parseCrashConfig, reportCrashConfig, type CrashConfig } from './crash-config.ts';

export type Die = () => never;
const exitProcess: Die = () => process.exit(CRASH_EXIT_CODE);

export function withCrashPoints(port: ExecutionPort, cfg: CrashConfig, die: Die = exitProcess): ExecutionPort {
  if (!cfg.armed) return port;
  return {
    start(request, onEvent, onHostSpawned) {
      // J1 — the engine calls start() only after the ATTEMPT_LAUNCHING batch is committed and task.md
      // is written (engine.ts #apply → #launch); exiting here is before ForkedExecutionPort #run →
      // spawnHost(): no Execution Host exists, no session can exist.
      if (fire(cfg, 'BEFORE_EXECUTION_HOST_FORK')) die();
      // J2 — the first RUN_STARTED (already persisted by BridgeEngine in the Execution Host) is
      // intercepted before the engine's onEvent submits EXECUTION_LINKED.
      const observed =
        cfg.point === 'ON_RUN_STARTED_BEFORE_LINK' && onEvent
          ? (event: Parameters<typeof onEvent>[0]) => {
              if (event.event === 'RUN_STARTED' && fire(cfg, 'ON_RUN_STARTED_BEFORE_LINK')) die();
              onEvent(event);
            }
          : onEvent;
      return port.start(request, observed, onHostSpawned);
    },
    resume: (ref, onEvent, onHostSpawned) => port.resume(ref, onEvent, onHostSpawned),
    pause: () => port.pause(),
    stop: () => port.stop(),
    status: () => port.status(),
    checkRecovery: () => port.checkRecovery(),
    artifacts: (executionId) => port.artifacts(executionId),
    findExecutions: (filter) => port.findExecutions(filter),
  };
}

export interface CrashWorkflowHostOptions {
  /** The Execution Host entry the production port forks (the crash app: the production run-host.mjs). */
  runHostScript: string;
  execPath: string;
  /** The environment the production port gives its Execution Hosts. */
  hostEnv: NodeJS.ProcessEnv;
  /** Where the crash configuration is read from (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Fake-CLI process tests only (tests/workflow/crash-points.windows.test.ts). The crash app passes
   * nothing, so production engine timings apply (preflightGraceMs ≈ 5 min, D3). */
  engine?: WorkflowHostDeps['engine'];
  controlPollMs?: number;
}

/** The Workflow Host exactly as src/hosts/workflow-host-entry.ts builds it — serveWorkflowHost over
 * createExecutionPort — with the production port wrapped by withCrashPoints. */
export function serveCrashWorkflowHost(o: CrashWorkflowHostOptions): CrashConfig {
  const cfg = parseCrashConfig(o.env ?? process.env);
  reportCrashConfig(cfg);
  serveWorkflowHost({
    createDeps: (projectPath) => ({
      projectPath,
      port: withCrashPoints(createExecutionPort({ projectPath, scriptPath: o.runHostScript, execPath: o.execPath, env: o.hostEnv }), cfg),
      ...(o.engine ? { engine: o.engine } : {}),
      ...(o.controlPollMs !== undefined ? { controlPollMs: o.controlPollMs } : {}),
    }),
  });
  return cfg;
}

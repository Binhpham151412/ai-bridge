import { BridgeEngine } from '../core/bridge-engine.ts';
import { forkRunHost } from '../desktop/main/fork-run-host.ts';
import type { HostLifetime } from '../desktop/main/process-lifetime.ts';
import { ForkedExecutionPort } from './forked-execution-port.ts';

/**
 * M5.8.1 — the lifetime of every Execution Host a Workflow Host forks: 'independent' (docs/23 §11,
 * ADR-011). If the Workflow Host dies, the execution it launched keeps running in its own
 * Execution Host (and its CLI with it) until the run ends by itself; the next Workflow Host
 * reconciles it (M5.6: WATCH, then ADOPT — never a relaunch).
 *
 * Ownership stays explicit: the Execution Host is the project's run-lock holder, so any process
 * can stop it — and its CLI process tree — through BridgeEngine.stop(); its life is bounded by
 * the run itself (maxIterations × the per-call CLI timeouts). The Workflow Host itself, and the M4
 * run host, keep the default 'with-parent' lifetime.
 */
export const EXECUTION_HOST_LIFETIME: HostLifetime = 'independent';

export interface ExecutionHostSpawn {
  projectPath: string;
  /** The run-host entry: dist-desktop/run-host.mjs, or src/desktop/main/run-host-entry.ts from source. */
  scriptPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}

/** The production ExecutionPort of a Workflow Host: one Execution Host per start/resume. */
export function createExecutionPort(o: ExecutionHostSpawn): ForkedExecutionPort {
  return new ForkedExecutionPort({
    projectPath: o.projectPath,
    engine: new BridgeEngine(o.projectPath),
    spawnHost: () => forkRunHost({ scriptPath: o.scriptPath, execPath: o.execPath, env: o.env, lifetime: EXECUTION_HOST_LIFETIME }),
  });
}

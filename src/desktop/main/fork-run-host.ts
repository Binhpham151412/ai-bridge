import { fork } from 'node:child_process';
import type { RunHostExit, RunHostProcess } from './run-controller.ts';
import type { HostCommand } from './run-host-protocol.ts';
import { hostSpawnOptions, type HostLifetime } from './process-lifetime.ts';

export interface ForkRunHostOptions {
  scriptPath: string;
  /** Electron's own binary in the app (run as plain Node via ELECTRON_RUN_AS_NODE). */
  execPath: string;
  env: NodeJS.ProcessEnv;
  execArgv?: string[];
  /** M5.8.1 (process-lifetime.ts). Default 'with-parent' — the M4 run host and the Workflow Host
   * keep it; only Execution Hosts forked by a Workflow Host are 'independent'. */
  lifetime?: HostLifetime;
}

const STDERR_TAIL_BYTES = 8 * 1024;

/** A forked host process speaking a JSON IPC protocol whose parent→child messages are `C`. */
export interface ChildHostProcess<C> {
  readonly pid: number | undefined;
  send(message: C): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (exit: RunHostExit) => void): void;
}

export function forkRunHost(options: ForkRunHostOptions): RunHostProcess {
  return forkChildHost<HostCommand>(options);
}

/** M5.8: the same fork for any host protocol — the Workflow Host (src/hosts/workflow-host-entry.ts) reuses it. */
export function forkChildHost<C>(options: ForkRunHostOptions): ChildHostProcess<C> {
  const lifetime = hostSpawnOptions(options.lifetime ?? 'with-parent');
  const child = fork(options.scriptPath, [], {
    execPath: options.execPath,
    execArgv: options.execArgv ?? [],
    env: options.env,
    stdio: lifetime.stdio,
    detached: lifetime.detached,
    serialization: 'json',
    windowsHide: true,
  });

  // Bounded: only the tail is kept, for diagnostics after an unexpected exit ('with-parent'
  // hosts only — an 'independent' host has no stderr pipe to its parent).
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
  });

  const exitListeners: ((exit: RunHostExit) => void)[] = [];
  let exited = false;
  const notifyExit = (code: number | null, signal: string | null): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ code, signal, stderrTail });
  };
  // 'close' (not 'exit') so the stderr tail is complete when listeners read it.
  child.once('close', (code, signal) => notifyExit(code, signal));
  child.once('error', (err) => {
    stderrTail = (stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_BYTES);
    notifyExit(null, null);
  });

  return {
    get pid() {
      return child.pid;
    },
    send(message: C) {
      if (child.connected) child.send(message as object);
    },
    onMessage(listener) {
      child.on('message', listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}

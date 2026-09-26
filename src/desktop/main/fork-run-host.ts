import { fork } from 'node:child_process';
import type { RunHostExit, RunHostProcess } from './run-controller.ts';

export interface ForkRunHostOptions {
  scriptPath: string;
  /** Electron's own binary in the app (run as plain Node via ELECTRON_RUN_AS_NODE). */
  execPath: string;
  env: NodeJS.ProcessEnv;
  execArgv?: string[];
}

const STDERR_TAIL_BYTES = 8 * 1024;

export function forkRunHost(options: ForkRunHostOptions): RunHostProcess {
  const child = fork(options.scriptPath, [], {
    execPath: options.execPath,
    execArgv: options.execArgv ?? [],
    env: options.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    serialization: 'json',
    windowsHide: true,
  });

  // Bounded: only the tail is kept, for diagnostics after an unexpected exit.
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
    send(command) {
      if (child.connected) child.send(command);
    },
    onMessage(listener) {
      child.on('message', listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
  };
}

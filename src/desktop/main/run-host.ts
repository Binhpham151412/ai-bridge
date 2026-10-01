import type { BridgeEngine, BridgeRunOutcome, BridgeStartOptions } from '../../core/bridge-engine.ts';
import type { BridgeEvent } from '../../core/observability/events.ts';
import { isHostCommand, type HostCommand, type HostMessage } from './run-host-protocol.ts';

/**
 * The run host: a dedicated child process (Electron's own Node, via
 * ELECTRON_RUN_AS_NODE) that executes `BridgeEngine.start()`/`resume()` for one run,
 * forwards the engine's live events to Main, reports the typed outcome, and exits.
 *
 * Why not run the loop inside the Electron main process: Core's `stop()` works by
 * killing the process tree of whichever process holds the project's run lock
 * (process-manager → `taskkill /T /F`), and crash injection works by exiting that same
 * process. Running the loop in Electron main would make STOP kill the app itself. In a
 * separate host, the lock holder is exactly what the CLI's lock holder is — one Node
 * process owning one run — so Core's existing stop/crash/recovery semantics apply
 * unchanged and no process logic is duplicated here.
 */

export type HostEngine = Pick<BridgeEngine, 'subscribe' | 'start' | 'resume'>;

export async function runHostCommand(
  command: HostCommand,
  engine: HostEngine,
  onEvent: (event: BridgeEvent) => void,
  crashInjection?: BridgeStartOptions['crashInjection'],
): Promise<BridgeRunOutcome> {
  const unsubscribe = engine.subscribe(onEvent);
  try {
    return command.type === 'start'
      ? await engine.start({ task: command.task, maxIterations: command.maxIterations, correlation: command.correlation, permissionPolicy: command.permissionPolicy, crashInjection })
      : await engine.resume();
  } finally {
    unsubscribe();
  }
}

export interface ServeRunHostOptions {
  createEngine: (projectPath: string) => HostEngine;
  crashInjection?: BridgeStartOptions['crashInjection'];
}

/** Wires runHostCommand to this process's IPC channel: waits for exactly one command,
 * runs it, flushes the outcome, exits. If Main disappears mid-run (app crash), the run
 * keeps going and finishes normally — its state is persisted by Core either way. */
export function serveRunHost(options: ServeRunHostOptions): void {
  const send = (message: HostMessage, done?: () => void): void => {
    if (process.connected && process.send) process.send(message, undefined, {}, () => done?.());
    else done?.();
  };

  process.once('message', (raw: unknown) => {
    if (!isHostCommand(raw)) {
      send({ type: 'failed', message: 'run host received an invalid command' }, () => process.exit(2));
      return;
    }
    const crash = raw.type === 'start' ? options.crashInjection : undefined;
    runHostCommand(raw, options.createEngine(raw.projectPath), (event) => send({ type: 'event', event }), crash).then(
      (outcome) => send({ type: 'outcome', outcome }, () => process.exit(0)),
      (err: unknown) => send({ type: 'failed', message: err instanceof Error ? err.message : String(err) }, () => process.exit(1)),
    );
  });
}

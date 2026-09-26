export interface StopResult {
  ok: boolean;
  reason: 'NOT_RUNNING' | 'GRACEFUL_STOP' | 'FORCE_KILLED' | 'STOP_FAILED';
  pid: number;
}

export interface ProcessManagerDeps {
  isPidAlive: (pid: number) => boolean;
  /** Best-effort signal — on Windows, headless console processes usually ignore this (documented limitation). */
  attemptGraceful: (pid: number) => Promise<void>;
  /** Kills the whole process tree — must only ever target `pid` (the session's own lock-file pid). */
  forceKill: (pid: number) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface RequestStopOptions {
  gracefulTimeoutMs: number;
  pollIntervalMs: number;
}

/**
 * Escalation: if the pid is already dead, done. Otherwise attempt a graceful signal
 * and poll until it exits or the timeout elapses; if it's still alive, force-kill the
 * whole tree and confirm. Never targets any pid other than the one given — the CLI is
 * responsible for only ever passing the pid recorded in this project's own lock file.
 */
export async function requestStop(pid: number, deps: ProcessManagerDeps, options: RequestStopOptions): Promise<StopResult> {
  if (!deps.isPidAlive(pid)) return { ok: true, reason: 'NOT_RUNNING', pid };

  await deps.attemptGraceful(pid);

  const deadline = Date.now() + options.gracefulTimeoutMs;
  while (Date.now() < deadline) {
    if (!deps.isPidAlive(pid)) return { ok: true, reason: 'GRACEFUL_STOP', pid };
    await deps.sleep(options.pollIntervalMs);
  }
  if (!deps.isPidAlive(pid)) return { ok: true, reason: 'GRACEFUL_STOP', pid };

  await deps.forceKill(pid);
  // forceKill (e.g. `taskkill /T /F`) runs asynchronously in the OS — poll for it to
  // actually take effect rather than checking once right away.
  const forceDeadline = Date.now() + options.gracefulTimeoutMs;
  while (Date.now() < forceDeadline) {
    if (!deps.isPidAlive(pid)) return { ok: true, reason: 'FORCE_KILLED', pid };
    await deps.sleep(options.pollIntervalMs);
  }
  if (!deps.isPidAlive(pid)) return { ok: true, reason: 'FORCE_KILLED', pid };

  return { ok: false, reason: 'STOP_FAILED', pid };
}
